import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../../_recognizeProxy";

type Context = { params: Promise<{ source: string; sourceItemId: string }> };

export async function GET(request: NextRequest, context: Context) {
  const auth = requireAdminToken(request); if (auth) return auth;
  const { source, sourceItemId } = await context.params;
  return proxyRecognize(`/management/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/annotation-tracks`);
}

export async function POST(request: NextRequest, context: Context) {
  const auth = requireAdminToken(request); if (auth) return auth;
  const { source, sourceItemId } = await context.params;
  return proxyRecognize(
    `/management/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/annotation-tracks`,
    { method: "POST", body: await request.text() },
  );
}
