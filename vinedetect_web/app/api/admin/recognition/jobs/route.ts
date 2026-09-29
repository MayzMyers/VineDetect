import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../_recognizeProxy";

export async function GET(request: NextRequest) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  return proxyRecognize(`/management/recognize-jobs${request.nextUrl.search}`);
}

export async function POST(request: NextRequest) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  const body = await request.text();
  return proxyRecognize("/management/recognize-jobs", {
    method: "POST",
    body,
  });
}
