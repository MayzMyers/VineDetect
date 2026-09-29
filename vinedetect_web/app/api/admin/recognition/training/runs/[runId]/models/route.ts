import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../../_recognizeProxy";

export async function POST(request: NextRequest, context: RouteContext<"/api/admin/recognition/training/runs/[runId]/models">) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { runId } = await context.params;
  return proxyRecognize(`/management/training/runs/${encodeURIComponent(runId)}/models`, { method: "POST", headers: { "Content-Type": request.headers.get("content-type") ?? "application/json" }, body: await request.text() });
}
