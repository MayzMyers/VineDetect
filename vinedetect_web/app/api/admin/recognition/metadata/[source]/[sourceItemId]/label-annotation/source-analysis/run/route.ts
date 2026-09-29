import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../../../../_recognizeProxy";

export async function POST(request: NextRequest, context: { params: Promise<{ source: string; sourceItemId: string }> }) {
  const authError = requireAdminToken(request);
  if (authError) return authError;
  const { source, sourceItemId } = await context.params;
  return proxyRecognize(`/management/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/label-annotation/source-analysis/run`, { method: "POST", body: await request.text() });
}
