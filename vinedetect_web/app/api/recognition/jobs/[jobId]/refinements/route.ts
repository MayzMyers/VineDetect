import { NextResponse } from "next/server";

const RECOGNIZE_SERVICE_URL = process.env.RECOGNIZE_SERVICE_URL ?? "http://127.0.0.1:4001";
type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, context: Context) {
  const { jobId } = await context.params;
  if (!isUuid(jobId)) return NextResponse.json({ error: "Invalid jobId" }, { status: 400 });
  const form = await request.formData();
  try {
    const response = await fetch(`${RECOGNIZE_SERVICE_URL}/recognition/jobs/${jobId}/refinements`, {
      method: "POST",
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({ error: "Invalid recognize-service response" }));
    return NextResponse.json(payload, { status: response.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Recognition service unavailable" }, { status: 502 });
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
