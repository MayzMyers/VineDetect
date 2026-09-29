import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../../../_recognizeProxy";

type RouteContext = { params: Promise<{ source: string; sourceItemId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { source, sourceItemId } = await context.params;
  return proxyRecognize(
    `/management/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/label-annotation/aliases`
  );
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { source, sourceItemId } = await context.params;
  return proxyRecognize(
    `/management/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/label-annotation/aliases`,
    {
      method: "PUT",
      headers: { "Content-Type": request.headers.get("content-type") ?? "application/json" },
      body: await request.text(),
    }
  );
}
