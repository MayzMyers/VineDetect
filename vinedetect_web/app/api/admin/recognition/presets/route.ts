import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../_recognizeProxy";

export async function GET(request: NextRequest) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  return proxyRecognize(`/management/pipeline-presets${request.nextUrl.search}`);
}

export async function POST(request: NextRequest) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  return proxyRecognize("/management/pipeline-presets", {
    method: "POST",
    body: await request.text(),
  });
}
