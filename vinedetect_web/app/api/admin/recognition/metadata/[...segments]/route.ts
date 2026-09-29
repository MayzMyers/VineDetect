import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../_recognizeProxy";

type Params = {
  params: Promise<{
    segments: string[];
  }>;
};

function targetPath(segments: string[]) {
  return `/management/metadata/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

async function forward(request: NextRequest, { params }: Params, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  const { segments } = await params;
  const body = method === "GET" || method === "DELETE" ? undefined : await request.text();
  return proxyRecognize(targetPath(segments), { method, body });
}

export function GET(request: NextRequest, params: Params) { return forward(request, params, "GET"); }
export function POST(request: NextRequest, params: Params) { return forward(request, params, "POST"); }
export function PUT(request: NextRequest, params: Params) { return forward(request, params, "PUT"); }
export function PATCH(request: NextRequest, params: Params) { return forward(request, params, "PATCH"); }
export function DELETE(request: NextRequest, params: Params) { return forward(request, params, "DELETE"); }
