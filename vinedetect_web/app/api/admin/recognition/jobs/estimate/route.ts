import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../_recognizeProxy";

export async function GET(request: NextRequest) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  return proxyRecognize(`/management/recognize-jobs/estimate${request.nextUrl.search}`);
}
