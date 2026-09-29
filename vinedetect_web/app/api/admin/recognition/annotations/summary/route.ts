import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../_recognizeProxy";

export async function GET(request: NextRequest) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  return proxyRecognize(`/management/annotations/summary${request.nextUrl.search}`);
}
