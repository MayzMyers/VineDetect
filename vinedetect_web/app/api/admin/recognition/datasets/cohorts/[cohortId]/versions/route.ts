import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../../_recognizeProxy";

type RouteContext = { params: Promise<{ cohortId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { cohortId } = await context.params;
  return proxyRecognize(`/management/datasets/cohorts/${encodeURIComponent(cohortId)}/versions`, {
    method: "POST",
    headers: { "Content-Type": request.headers.get("content-type") ?? "application/json" },
    body: await request.text(),
  });
}
