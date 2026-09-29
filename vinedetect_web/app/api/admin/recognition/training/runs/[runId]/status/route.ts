import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../../_recognizeProxy";

export async function PATCH(request: NextRequest, context: RouteContext<"/api/admin/recognition/training/runs/[runId]/status">) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { runId } = await context.params;
  return proxyRecognize(`/management/training/runs/${encodeURIComponent(runId)}/status`, { method: "PATCH", headers: { "Content-Type": request.headers.get("content-type") ?? "application/json" }, body: await request.text() });
}
