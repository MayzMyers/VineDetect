import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../_recognizeProxy";

export async function POST(request: NextRequest) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  const body = await request.text();
  const parsed = body ? JSON.parse(body) : {};
  const endpoint = Array.isArray(parsed.sources)
    ? "/management/generation/batch"
    : "/management/generation/item";

  return proxyRecognize(endpoint, {
    method: "POST",
    body,
  });
}
