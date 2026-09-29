import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../_recognizeProxy";

export async function GET(
  request: NextRequest,
  context: RouteContext<"/api/admin/recognition/presets/[presetId]/revisions">
) {
  const authError = requireAdminToken(request);
  if (authError) return authError;
  const { presetId } = await context.params;

  return proxyRecognize(`/management/pipeline-presets/${encodeURIComponent(presetId)}/revisions`);
}

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/admin/recognition/presets/[presetId]/revisions">
) {
  const authError = requireAdminToken(request);
  if (authError) return authError;
  const { presetId } = await context.params;

  return proxyRecognize(`/management/pipeline-presets/${encodeURIComponent(presetId)}/revisions`, {
    method: "POST",
    body: await request.text(),
  });
}
