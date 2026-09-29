import type { RecognitionJobSnapshot, RecognitionProduct } from "./recognitionFlow.ts";
import type { WineCandidate } from "../catalog/types.ts";

export type RecognitionTagCloud = { version: string; tags: string[] };

export class RecognitionApiError extends Error {
  constructor(
    message: string,
    readonly code: "UPLOAD_ERROR" | "JOB_EXPIRED" | "NETWORK_ERROR" | "INVALID_RESPONSE" | "RECOGNITION_TIMEOUT" | "SERVICE_BUSY",
  ) {
    super(message);
    this.name = "RecognitionApiError";
  }
}

export async function loadRecognitionTags(signal?: AbortSignal) {
  const response = await fetch("/api/recognition/tags", { cache: "force-cache", signal });
  if (!response.ok) throw new Error(`Recognition tags failed with HTTP ${response.status}`);
  return response.json() as Promise<RecognitionTagCloud>;
}

export async function createRecognitionJob(input: {
  image: Blob;
  tokens: string[];
  sessionId: string;
  catalogKey?: string;
  catalogCandidate?: WineCandidate;
  signal?: AbortSignal;
}) {
  const form = new FormData();
  form.append("image", input.image, "camera-frame.jpg");
  form.append("tokens", JSON.stringify(input.tokens));
  form.append("sessionId", input.sessionId);
  if (input.catalogKey) form.append("catalogKey", input.catalogKey);
  if (input.catalogCandidate) form.append("catalogCandidate", JSON.stringify(input.catalogCandidate));
  const response = await fetch("/api/recognition/jobs", {
    method: "POST",
    body: form,
    signal: input.signal,
  });
  const payload = await response.json().catch(() => null) as {
    jobId?: string;
    status?: string;
    reused?: boolean;
    error?: string;
  } | null;
  if (!response.ok || !payload?.jobId) {
    throw new RecognitionApiError(
      payload?.error ?? `Recognition job failed with HTTP ${response.status}`,
      response.status >= 500 ? "NETWORK_ERROR" : "UPLOAD_ERROR",
    );
  }
  return payload as { jobId: string; status: "queued" | "processing"; reused: boolean };
}

export async function getRecognitionJob(jobId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/recognition/jobs/${encodeURIComponent(jobId)}`, {
    cache: "no-store",
    signal,
  });
  const payload = await response.json().catch(() => null) as (RecognitionJobSnapshot & { error?: string }) | null;
  if (!response.ok || !payload) {
    throw new RecognitionApiError(
      payload?.error ?? `Recognition status failed with HTTP ${response.status}`,
      response.status === 404 ? "JOB_EXPIRED" : "NETWORK_ERROR",
    );
  }
  return payload;
}

export async function refineRecognitionJob(input: {
  jobId: string;
  image: Blob;
  tokens: string[];
  signal?: AbortSignal;
}) {
  const form = new FormData();
  form.append("image", input.image, "camera-refinement.jpg");
  form.append("tokens", JSON.stringify(input.tokens));
  const response = await fetch(`/api/recognition/jobs/${encodeURIComponent(input.jobId)}/refinements`, {
    method: "POST",
    body: form,
    signal: input.signal,
  });
  const payload = await response.json().catch(() => null) as { jobId?: string; sessionId?: string; status?: string; reused?: boolean; error?: string } | null;
  if (!response.ok || !payload?.jobId) {
    throw new RecognitionApiError(payload?.error ?? `Recognition refinement failed with HTTP ${response.status}`, response.status >= 500 ? "NETWORK_ERROR" : "UPLOAD_ERROR");
  }
  return payload as { jobId: string; sessionId: string; status: "queued" | "processing"; reused: boolean };
}

export async function selectRecognitionAlternative(input: {
  jobId: string;
  source: string;
  sourceItemId: string;
  signal?: AbortSignal;
}) {
  const response = await fetch(`/api/recognition/jobs/${encodeURIComponent(input.jobId)}/selection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: input.source, sourceItemId: input.sourceItemId }),
    signal: input.signal,
  });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) {
    throw new RecognitionApiError(payload?.error ?? `Alternative selection failed with HTTP ${response.status}`, response.status >= 500 ? "NETWORK_ERROR" : "UPLOAD_ERROR");
  }
}

export type RecognitionImageResult = { slug: string; product: RecognitionProduct };

/** Send the original photo bytes; no client OCR or candidate may select the result. */
export async function predictRecognitionImage(image: Blob, signal?: AbortSignal): Promise<RecognitionImageResult> {
  const form = new FormData();
  const filename = typeof File !== "undefined" && image instanceof File ? image.name : "camera-frame.jpg";
  form.append("image", image, filename);
  const response = await fetch("/api/recognition/jobs", { method: "POST", body: form, signal });
  const payload = await response.json().catch(() => null) as (Partial<RecognitionImageResult> & { error?: string }) | null;
  if (!response.ok) {
    const code = response.status === 504 ? "RECOGNITION_TIMEOUT"
      : response.status === 409 || response.status === 429 ? "SERVICE_BUSY"
      : response.status >= 500 ? "NETWORK_ERROR" : "UPLOAD_ERROR";
    throw new RecognitionApiError(payload?.error ?? `Recognition failed with HTTP ${response.status}`, code);
  }
  if (
    !payload || typeof payload.slug !== "string" || !payload.slug ||
    !payload.product || payload.product.slug !== payload.slug ||
    payload.product.catalogKey !== `svoe_vino:${payload.slug}` ||
    typeof payload.product.title !== "string"
  ) {
    throw new RecognitionApiError("Recognition result does not match its catalog card", "INVALID_RESPONSE");
  }
  return payload as RecognitionImageResult;
}
