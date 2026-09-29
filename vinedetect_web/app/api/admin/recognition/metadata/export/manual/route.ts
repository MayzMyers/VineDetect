import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../_recognizeProxy";

export async function GET(request: NextRequest) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  const source = request.nextUrl.searchParams.get("source");
  const query = source ? `?source=${encodeURIComponent(source)}` : "";
  const response = await proxyRecognize(`/management/metadata/export/manual${query}`);
  const filenameSource = source === "svoe_vino" || source === "roskachestvo" ? source : "all";
  response.headers.set("Content-Disposition", `attachment; filename="manual-metadata-${filenameSource}.json"`);
  return response;
}
