import { NextResponse } from "next/server";
import { getMockRecognitionJob } from "@/lib/recognition/mockFullstack";
import { fetchCatalogItemBySlug, getSimilarCatalogWines, toRecognitionProduct } from "@/lib/catalog/referenceCatalogBff";

const RECOGNIZE_SERVICE_URL =
  process.env.RECOGNIZE_SERVICE_URL ?? "http://127.0.0.1:4001";
const API_SERVICE_URL =
  process.env.API_SERVICE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://127.0.0.1:8000";

type RouteContext = { params: Promise<{ jobId: string }> };
type ServiceCandidate = { source: string; sourceItemId: string; score: number };
type ServiceJob = {
  jobId: string;
  sessionId: string;
  status: "queued" | "processing" | "completed" | "failed";
  stage: string;
  result: null | { confidence: number; candidates: ServiceCandidate[] };
  outcome: "match" | "no_match" | "ambiguous" | "need_more_data" | null;
  guidance?: {
    type: "label_top" | "label_bottom" | "label_left" | "label_right" | "closer" | "steadier";
    message?: string;
  } | null;
  error: string | null;
};

export async function GET(_request: Request, context: RouteContext) {
  const { jobId } = await context.params;
  if (!isUuid(jobId)) {
    return NextResponse.json({ error: "Invalid jobId" }, { status: 400 });
  }

  const mockJob = getMockRecognitionJob(jobId);
  if (mockJob) {
    if (mockJob.status === "completed" && mockJob.outcome === "match" && mockJob.product?.catalogKey?.startsWith("svoe_vino:")) {
      try {
        const slug = mockJob.product.catalogKey.slice("svoe_vino:".length);
        const catalogItem = await fetchCatalogItemBySlug(slug);
        if (catalogItem) {
          const similar = await getSimilarCatalogWines(catalogItem, 3);
          return NextResponse.json(
            { ...mockJob, product: toRecognitionProduct(catalogItem), similar },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
      } catch (error) {
        console.warn("Mock result catalog enrichment failed.", error);
      }
    }
    return NextResponse.json(mockJob, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const response = await fetch(`${RECOGNIZE_SERVICE_URL}/recognition/jobs/${jobId}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const job = await response.json() as ServiceJob | { error: string };
    if (!response.ok) return NextResponse.json(job, { status: response.status });

    const typedJob = job as ServiceJob;
    if (
      typedJob.status !== "completed" ||
      !typedJob.result ||
      !["match", "ambiguous"].includes(typedJob.outcome ?? "")
    ) {
      return NextResponse.json(typedJob, { headers: { "Cache-Control": "no-store" } });
    }

    const enriched = await Promise.all(
      typedJob.result.candidates.slice(0, 5).map(enrichCandidate),
    );
    const product = typedJob.outcome === "match" ? enriched[0]?.product ?? null : null;
    const alternativeStart = typedJob.outcome === "match" ? 1 : 0;
    const alternatives = enriched
      .slice(alternativeStart)
      .filter((entry): entry is typeof entry & { product: NonNullable<typeof entry.product> } => entry.product !== null)
      .map((entry) => ({ source: entry.source, sourceItemId: entry.sourceItemId, product: entry.product, confidence: entry.score }));

    return NextResponse.json({
      jobId: typedJob.jobId,
      sessionId: typedJob.sessionId,
      status: typedJob.status,
      stage: typedJob.stage,
      outcome: typedJob.outcome,
      recognition: {
        confidence: typedJob.result.confidence,
        alternatives,
      },
      product,
      alternatives,
      guidance: typedJob.guidance ?? null,
      error: typedJob.error,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Recognition service unavailable" },
      { status: 502 },
    );
  }
}

async function enrichCandidate(candidate: ServiceCandidate) {
  const url = new URL("/api/v1/catalog", API_SERVICE_URL);
  url.searchParams.set("source", candidate.source === "svoe_vino" ? "svoe_vino" : candidate.source === "roskachestvo" ? "roskachestvo" : "all");
  url.searchParams.set("q", candidate.sourceItemId);
  url.searchParams.set("limit", "10");

  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return { ...candidate, product: null };
    const payload = await response.json() as { items?: CatalogItem[] };
    const item = payload.items?.find((entry) =>
      entry.external_id === candidate.sourceItemId ||
      entry.recognitionKey === `${candidate.source}:${candidate.sourceItemId}`
    ) ?? payload.items?.[0];
    return { ...candidate, product: item ? toProduct(item) : null };
  } catch {
    return { ...candidate, product: null };
  }
}

type CatalogItem = {
  local_id?: number | null;
  external_id: string;
  recognitionKey: string;
  title?: string | null;
  manufacturer?: string | null;
  image?: { url?: string | null };
  category?: string | null;
  region?: string | null;
  year?: number | null;
  description?: string | null;
};

function toProduct(item: CatalogItem) {
  return {
    id: item.local_id ?? item.external_id,
    catalogKey: item.recognitionKey,
    slug: item.external_id,
    title: item.title ?? item.external_id,
    producer: item.manufacturer ?? null,
    image: item.image?.url ?? null,
    category: item.category ?? null,
    region: item.region ?? null,
    vintage: item.year ?? null,
    description: item.description ?? null,
  };
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
