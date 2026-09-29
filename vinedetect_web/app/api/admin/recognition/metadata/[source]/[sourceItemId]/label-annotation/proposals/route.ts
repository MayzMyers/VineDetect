import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../../../_recognizeProxy";

type Params = {
  params: Promise<{
    source: string;
    sourceItemId: string;
  }>;
};

export async function GET(request: NextRequest, { params }: Params) {
  const authError = requireAdminToken(request);
  if (authError) return authError;
  const { source, sourceItemId } = await params;
  return proxyRecognize(
    `/management/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/label-annotation/proposals`
  );
}
