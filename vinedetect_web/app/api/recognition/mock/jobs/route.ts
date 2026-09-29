import { NextResponse } from "next/server";
import { createMockRecognitionJob, describeMockRecognitionJob, type MockRecognitionScenario } from "@/lib/recognition/mockFullstack";

export async function POST(request: Request) {
  const form = await request.formData();
  const image = form.get("image");
  const sessionId = form.get("sessionId");
  const scenario = form.get("scenario");
  const catalogKey = form.get("catalogKey");
  const catalogCandidate = parseCatalogCandidate(form.get("catalogCandidate"));
  const tokens = parseTokens(form.get("tokens"));
  if (!(image instanceof File) || typeof sessionId !== "string" || tokens.length === 0) {
    return NextResponse.json({ error: "image, sessionId and tokens are required" }, { status: 400 });
  }
  if (!isScenario(scenario)) {
    return NextResponse.json({ error: "Unknown mock scenario" }, { status: 400 });
  }

  const { job, reused } = createMockRecognitionJob({
    sessionId,
    scenario,
    tokens,
    catalogKey: typeof catalogKey === "string" && catalogKey.trim() ? catalogKey.trim() : undefined,
    catalogCandidate,
    image: { name: image.name, type: image.type, size: image.size },
  });
  return NextResponse.json(
    { jobId: job.jobId, status: "queued", reused, mockTiming: describeMockRecognitionJob(job) },
    { status: reused ? 200 : 202, headers: { "Cache-Control": "no-store" } },
  );
}

function parseTokens(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
  } catch { return []; }
}

function parseCatalogCandidate(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return undefined;
  try {
    const candidate = JSON.parse(value) as Record<string, unknown>;
    if (typeof candidate.wineId !== "string" || typeof candidate.title !== "string") return undefined;
    return {
      wineId: candidate.wineId,
      title: candidate.title,
      producer: typeof candidate.producer === "string" ? candidate.producer : undefined,
      imageUrl: typeof candidate.imageUrl === "string" ? candidate.imageUrl : undefined,
    };
  } catch {
    return undefined;
  }
}

function isScenario(value: FormDataEntryValue | null): value is MockRecognitionScenario {
  return value === "match" || value === "no_match" || value === "ambiguous" || value === "guidance" || value === "failure";
}
