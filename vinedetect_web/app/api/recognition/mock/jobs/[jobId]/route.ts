import { NextResponse } from "next/server";
import { getMockRecognitionJob } from "@/lib/recognition/mockFullstack";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, context: Context) {
  const { jobId } = await context.params;
  const job = getMockRecognitionJob(jobId);
  if (!job) return NextResponse.json({ error: "Mock job not found" }, { status: 404 });
  return NextResponse.json(job, { headers: { "Cache-Control": "no-store" } });
}
