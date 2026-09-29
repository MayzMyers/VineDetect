import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../_recognizeProxy";

type Context = { params: Promise<{ segments: string[] }> };

function targetPath(segments: string[]) {
  return `/management/items/${segments.map(encodeURIComponent).join("/")}`;
}

async function forward(request: NextRequest, context: Context, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { segments } = await context.params;
  const body = method === "GET" || method === "DELETE" ? undefined : await request.text();
  return proxyRecognize(targetPath(segments), { method, body });
}

export function GET(request: NextRequest, context: Context) { return forward(request, context, "GET"); }
export function POST(request: NextRequest, context: Context) { return forward(request, context, "POST"); }
export function PUT(request: NextRequest, context: Context) { return forward(request, context, "PUT"); }
export function PATCH(request: NextRequest, context: Context) { return forward(request, context, "PATCH"); }
export function DELETE(request: NextRequest, context: Context) { return forward(request, context, "DELETE"); }
