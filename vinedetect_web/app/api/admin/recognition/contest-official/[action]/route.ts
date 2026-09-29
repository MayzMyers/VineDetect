import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../_recognizeProxy";
type Context = { params: Promise<{ action: string }> };
export async function GET(request: NextRequest, { params }: Context) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { action } = await params;
  if (!["references", "preflight"].includes(action))
    return new Response("Not found", { status: 404 });
  const query = new URLSearchParams();
  if (action === "references") {
    const sourceItemId = request.nextUrl.searchParams.get("sourceItemId");
    if (sourceItemId) query.set("sourceItemId", sourceItemId);
  }
  const suffix = query.size ? `?${query.toString()}` : "";
  return proxyRecognize(`/management/contest-official/${action}${suffix}`);
}
export async function POST(request: NextRequest, { params }: Context) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { action } = await params;
  if (!["drafts", "batch"].includes(action))
    return new Response("Not found", { status: 404 });
  return proxyRecognize(`/management/contest-official/${action}`, {
    method: "POST",
    body: await request.text(),
  });
}
