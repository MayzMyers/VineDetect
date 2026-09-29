import { NextRequest } from "next/server";
import { proxyRecognize, requireAdminToken } from "../../../_recognizeProxy";

type Params = {
  params: Promise<{
    jobId: string;
  }>;
};

export async function POST(request: NextRequest, { params }: Params) {
  const authError = requireAdminToken(request);
  if (authError) return authError;

  const { jobId } = await params;
  return proxyRecognize(`/management/recognize-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
}
