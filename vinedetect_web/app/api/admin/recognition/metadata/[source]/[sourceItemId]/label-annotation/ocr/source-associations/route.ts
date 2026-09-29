import { proxyRecognize, requireAdminToken } from "../../../../../../_recognizeProxy";
import { NextRequest } from "next/server";

type RouteContext = {
  params: Promise<{ source: string; sourceItemId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { source, sourceItemId } = await context.params;
  return proxyRecognize(
    `/management/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/label-annotation/ocr/source-associations`
  );
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = requireAdminToken(request);
  if (auth) return auth;
  const { source, sourceItemId } = await context.params;
  return proxyRecognize(
    `/management/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/label-annotation/ocr/source-associations`,
    {
      method: "PUT",
      headers: { "Content-Type": request.headers.get("content-type") ?? "application/json" },
      body: await request.text(),
    }
  );
}
