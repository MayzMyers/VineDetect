import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../_recognizeProxy";

export async function GET(request: NextRequest) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  return proxyRecognize("/management/training/runs");
}

export async function POST(request: NextRequest) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  return proxyRecognize("/management/training/runs", { method: "POST", headers: { "Content-Type": request.headers.get("content-type") ?? "application/json" }, body: await request.text() });
}
