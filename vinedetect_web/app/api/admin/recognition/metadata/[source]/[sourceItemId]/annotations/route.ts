import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../../_recognizeProxy";

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
    `/management/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/annotations`
  );
}

export async function PUT(request: NextRequest, { params }: Params) {
  const authError = requireAdminToken(request);
  if (authError) return authError;
  const { source, sourceItemId } = await params;
  const body = await request.text();
  return proxyRecognize(
    `/management/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/annotations`,
    { method: "PUT", body }
  );
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const authError = requireAdminToken(request);
  if (authError) return authError;
  const { source, sourceItemId } = await params;
  return proxyRecognize(
    `/management/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/annotations`,
    { method: "DELETE" }
  );
}
