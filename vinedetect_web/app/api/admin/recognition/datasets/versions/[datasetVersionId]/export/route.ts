import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../../_recognizeProxy";

type RouteContext = { params: Promise<{ datasetVersionId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { datasetVersionId } = await context.params;
  return proxyRecognize(`/management/datasets/versions/${encodeURIComponent(datasetVersionId)}/export`, { method: "POST" });
}
