import { NextRequest, NextResponse } from "next/server";
import { AsyncLocalStorage } from "node:async_hooks";
import { RequestPrincipal, verifyRecognitionAccessToken } from "./recognitionAuth";

const RECOGNIZE_SERVICE_URL =
  process.env.RECOGNIZE_SERVICE_URL ?? "http://127.0.0.1:4001";
const INTERNAL_API_KEY =
  process.env.RECOGNIZE_INTERNAL_API_KEY ?? "development-secret";
const JWT_SECRET = process.env.AUTH_JWT_SECRET ?? process.env.JWT_SECRET ?? "";
const requestContext = new AsyncLocalStorage<{ search: string; principal: RequestPrincipal }>();

export function requireAdminToken(request: NextRequest) {
  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Authenticated JWT is required" }, { status: 401 });
  }
  const principal = verifyRecognitionAccessToken(authorization.slice("Bearer ".length), JWT_SECRET);
  if (!principal) return NextResponse.json({ error: "JWT is invalid or expired" }, { status: 401 });
  requestContext.enterWith({ search: request.nextUrl.search, principal });

  return null;
}

export async function proxyRecognize(
  path: string,
  init: RequestInit = {}
) {
  const headers = new Headers(init.headers);
  headers.set("x-internal-api-key", INTERNAL_API_KEY);
  const context = requestContext.getStore();
  if (context) {
    headers.set("x-auth-role", context.principal.role);
    headers.set("x-auth-subject", context.principal.username);
    const trackId = new URLSearchParams(context.search).get("track");
    if (trackId) headers.set("x-annotation-track-id", trackId);
  }

  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;
  try {
    const forwardedSearch = context?.search ?? "";
    const targetPath = forwardedSearch && !path.includes("?") ? `${path}${forwardedSearch}` : path;
    response = await fetch(`${RECOGNIZE_SERVICE_URL}${targetPath}`, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Recognize service unavailable";
    return NextResponse.json(
      {
        error: "Recognize service unavailable",
        recognizeServiceUrl: RECOGNIZE_SERVICE_URL,
        detail: message,
      },
      { status: 503 }
    );
  }
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const body = await response.text();

  if (!contentType.toLowerCase().includes("application/json")) {
    return NextResponse.json(
      {
        error: response.ok ? "Recognize response is not JSON" : "Recognize request failed",
        status: response.status,
        detail: stripHtml(body),
      },
      { status: response.ok ? 502 : response.status }
    );
  }

  return new NextResponse(body, {
    status: response.status,
    headers: {
      "content-type": contentType,
    },
  });
}

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}
