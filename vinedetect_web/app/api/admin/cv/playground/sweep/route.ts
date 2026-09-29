import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../recognition/_recognizeProxy";

export async function POST(request: NextRequest) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  const body = await request.text();
  return proxyRecognize("/management/cv/playground/sweep", {
    method: "POST",
    body,
  });
}
