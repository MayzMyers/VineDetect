import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "./../_recognizeProxy";

export async function GET(request: NextRequest) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  const searchParams = new URLSearchParams(request.nextUrl.searchParams);
  if (searchParams.get("source") === "all") {
    searchParams.delete("source");
  }

  const query = searchParams.toString();
  return proxyRecognize(`/management/metadata${query ? `?${query}` : ""}`);
}

export async function DELETE(request: NextRequest) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  return proxyRecognize("/management/metadata", {
    method: "DELETE",
    body: await request.text(),
  });
}
