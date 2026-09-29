import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../../_recognizeProxy";

export async function PATCH(request: NextRequest, context: RouteContext<"/api/admin/recognition/training/models/[modelId]/status">) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { modelId } = await context.params;
  return proxyRecognize(`/management/training/models/${encodeURIComponent(modelId)}/status`, { method: "PATCH", headers: { "Content-Type": request.headers.get("content-type") ?? "application/json" }, body: await request.text() });
}
