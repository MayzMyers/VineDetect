import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { env } from "../config/env.js";
import type { LabelSemanticFeatures, SemanticEvidenceV1, SiglipCandidateScores, SiglipMode } from "./semanticEvidence.js";

type Rect = { x: number; y: number; width: number; height: number };
type Candidate = {
  id: string; bbox: Rect; score: number;
  geometrySemantic?: {
    confidence?: number; verdict?: "likely" | "unlikely";
    features?: { packageZoneConfidence?: number };
  };
};
type RankedCandidate<T extends Candidate> = T & {
  cvScore: number;
  ranking: { cvRank: number; semanticRank: number | null; fusionRank: number };
  semantic?: LabelSemanticFeatures;
  fusion?: {
    score: number; version: "label-fusion-v2";
    components: { cv: number; semantic: number; contourGeometry: number };
    weights: { cv: .5; semantic: .35; contourGeometry: .15 };
  };
};
type BatchResponse = { model: string; revision: string; candidates: SiglipCandidateScores[] };

const scoreCache = new Map<string, SiglipCandidateScores>();

export async function enrichLabelCandidatesWithSiglip<T extends Candidate>(input: {
  imagePath: string;
  candidates: T[];
  mode?: SiglipMode;
  enabled?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ candidates: Array<RankedCandidate<T>>; evidence: SemanticEvidenceV1 }> {
  const mode = input.mode ?? env.SIGLIP_MODE;
  const baseEvidence = evidenceBase(mode);
  const cvRanked = input.candidates.slice(0, 4).map((candidate, index) => ({ candidate, cvRank: index + 1 }));
  if (!(input.enabled ?? env.SIGLIP_ENABLED) || !env.SIGLIP_LABEL_RERANK || mode === "off" || mode === "proposals" || env.SIGLIP_REGION_PROPOSALS || !cvRanked.length) {
    return {
      candidates: input.candidates.map((candidate, index) => ({ ...candidate, cvScore: candidate.score, ranking: { cvRank: index + 1, semanticRank: null, fusionRank: index + 1 } })),
      evidence: { ...baseEvidence, status: "disabled", results: [], cache: { hits: 0, misses: 0 } },
    };
  }
  try {
    const sourceHash = createHash("sha256").update(await readFile(input.imagePath)).digest("hex");
    const cached = new Map<string, SiglipCandidateScores>();
    const misses: Array<{ candidate: T; key: string }> = [];
    for (const { candidate } of cvRanked) {
      const key = cacheKey(sourceHash, candidate.bbox);
      const value = scoreCache.get(key);
      if (value) cached.set(candidate.id, { ...value, id: candidate.id });
      else misses.push({ candidate, key });
    }
    if (misses.length) {
      const candidates = await Promise.all(misses.map(async ({ candidate }) => ({
        id: candidate.id,
        imageBase64: (await candidateCrop(input.imagePath, candidate.bbox)).toString("base64"),
      })));
      const response = await scoreBatch(candidates, input.fetchImpl ?? fetch);
      const byId = new Map(response.candidates.map((item) => [item.id, item]));
      for (const miss of misses) {
        const result = byId.get(miss.candidate.id);
        if (!result) throw new Error(`SigLIP response omitted candidate ${miss.candidate.id}`);
        cacheSet(miss.key, result);
        cached.set(result.id, result);
      }
    }
    const results = cvRanked.map(({ candidate }) => cached.get(candidate.id)).filter((value): value is SiglipCandidateScores => Boolean(value));
    const enrichedTop = fuse(cvRanked.map(({ candidate, cvRank }) => ({ candidate, cvRank, result: cached.get(candidate.id)! })), mode);
    const remainder = input.candidates.slice(4).map((candidate, index) => ({
      ...candidate, cvScore: candidate.score,
      ranking: { cvRank: index + 5, semanticRank: null, fusionRank: index + 5 },
    }));
    return {
      candidates: [...enrichedTop, ...remainder],
      evidence: { ...baseEvidence, status: "available", results, cache: { hits: cached.size - misses.length, misses: misses.length } },
    };
  } catch (error) {
    return {
      candidates: input.candidates.map((candidate, index) => ({ ...candidate, cvScore: candidate.score, ranking: { cvRank: index + 1, semanticRank: null, fusionRank: index + 1 } })),
      evidence: {
        ...baseEvidence, status: "unavailable", results: [], cache: { hits: 0, misses: cvRanked.length },
        error: { code: errorCode(error), message: boundedMessage(error) },
      },
    };
  }
}

function fuse<T extends Candidate>(items: Array<{ candidate: T; cvRank: number; result: SiglipCandidateScores }>, mode: SiglipMode): Array<RankedCandidate<T>> {
  const cvNormalized = normalize(items.map((item) => item.candidate.score));
  const semanticNormalized = normalize(items.map((item) => item.result.semanticScore));
  const contourGeometryNormalized = normalize(items.map((item) => contourGeometryPrior(item.candidate)));
  const semanticRanks = rank(items.map((item) => item.result.semanticScore));
  const fused = items.map((item, index) => ({
    ...item.candidate,
    cvScore: item.candidate.score,
    semantic: {
      ...item.result, provider: "siglip2" as const, modelId: env.SIGLIP_MODEL,
      modelRevision: env.SIGLIP_MODEL_REVISION, conceptSet: "wine-label-v1" as const,
    },
    fusion: {
      score: round(.5 * cvNormalized[index]! + .35 * semanticNormalized[index]! + .15 * contourGeometryNormalized[index]!),
      version: "label-fusion-v2" as const,
      components: { cv: round(cvNormalized[index]!), semantic: round(semanticNormalized[index]!), contourGeometry: round(contourGeometryNormalized[index]!) },
      weights: { cv: .5 as const, semantic: .35 as const, contourGeometry: .15 as const },
    },
    ranking: { cvRank: item.cvRank, semanticRank: semanticRanks[index]!, fusionRank: 0 },
  }));
  const fusionRanks = rank(fused.map((item) => item.fusion.score));
  const ranked = fused.map((item, index) => ({ ...item, ranking: { ...item.ranking, fusionRank: fusionRanks[index]! } }));
  return mode === "rerank"
    ? ranked.sort((left, right) => left.ranking.fusionRank - right.ranking.fusionRank).map((item) => ({ ...item, score: item.fusion.score }))
    : ranked;
}

function contourGeometryPrior(candidate: Candidate) {
  const labelRoleConfidence = finite(candidate.geometrySemantic?.confidence) ?? .5;
  const zoneConfidence = finite(candidate.geometrySemantic?.features?.packageZoneConfidence) ?? .5;
  const verdictFactor = candidate.geometrySemantic?.verdict === "unlikely" ? .72 : 1;
  return clamp01((labelRoleConfidence * .68 + zoneConfidence * .32) * verdictFactor);
}

async function scoreBatch(candidates: Array<{ id: string; imageBase64: string }>, fetchImpl: typeof fetch): Promise<BatchResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.SIGLIP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${env.SIGLIP_SERVICE_URL}/v1/siglip/score-batch`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", ...(env.SIGLIP_SERVICE_TOKEN ? { authorization: `Bearer ${env.SIGLIP_SERVICE_TOKEN}` } : {}) },
      body: JSON.stringify({ model: env.SIGLIP_MODEL, revision: env.SIGLIP_MODEL_REVISION, conceptSet: "wine-label-v1", candidates }),
    });
    if (!response.ok) throw new Error(`SigLIP service returned HTTP ${response.status}`);
    return validateResponse(await response.json(), candidates.map((item) => item.id));
  } finally { clearTimeout(timeout); }
}

function validateResponse(value: unknown, expectedIds: string[]): BatchResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SigLIP response is not an object");
  const item = value as Record<string, unknown>;
  if (item.model !== env.SIGLIP_MODEL || item.revision !== env.SIGLIP_MODEL_REVISION || !Array.isArray(item.candidates)) throw new Error("SigLIP response provenance mismatch");
  const candidates = item.candidates.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("SigLIP candidate result is invalid");
    const result = raw as Record<string, unknown>;
    const id = typeof result.id === "string" ? result.id : "";
    const positiveScore = finite(result.positiveScore), negativeScore = finite(result.negativeScore), semanticScore = finite(result.semanticScore);
    const scores = result.scores && typeof result.scores === "object" && !Array.isArray(result.scores) ? result.scores as Record<string, unknown> : {};
    if (!expectedIds.includes(id) || positiveScore === null || negativeScore === null || semanticScore === null || Object.values(scores).some((score) => finite(score) === null)) throw new Error("SigLIP candidate result failed validation");
    return { id, positiveScore, negativeScore, semanticScore, scores: Object.fromEntries(Object.entries(scores).map(([key, score]) => [key, finite(score)!])) };
  });
  if (new Set(candidates.map((candidate) => candidate.id)).size !== expectedIds.length || candidates.length !== expectedIds.length) throw new Error("SigLIP response candidate IDs do not match request");
  return { model: String(item.model), revision: String(item.revision), candidates };
}

async function candidateCrop(imagePath: string, bbox: Rect) {
  const metadata = await sharp(imagePath, { failOn: "none" }).rotate().metadata();
  const width = metadata.width ?? 1, height = metadata.height ?? 1;
  const left = Math.max(0, Math.min(width - 1, Math.floor(bbox.x)));
  const top = Math.max(0, Math.min(height - 1, Math.floor(bbox.y)));
  const cropWidth = Math.max(1, Math.min(width - left, Math.ceil(bbox.x + bbox.width) - left));
  const cropHeight = Math.max(1, Math.min(height - top, Math.ceil(bbox.y + bbox.height) - top));
  return sharp(imagePath, { failOn: "none" }).rotate().extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(256, 256, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } }).removeAlpha().jpeg({ quality: 92 }).toBuffer();
}

function cacheKey(sourceHash: string, bbox: Rect) {
  return createHash("sha256").update(JSON.stringify({ sourceHash, bbox, model: env.SIGLIP_MODEL, revision: env.SIGLIP_MODEL_REVISION, preprocess: "candidate-crop-v1", conceptSet: "wine-label-v1@1" })).digest("hex");
}
function cacheSet(key: string, value: SiglipCandidateScores) {
  if (scoreCache.size >= 2_000) {
    const oldest = scoreCache.keys().next().value;
    if (oldest) scoreCache.delete(oldest);
  }
  scoreCache.set(key, value);
}
function evidenceBase(mode: SiglipMode): Omit<SemanticEvidenceV1, "status" | "results" | "cache"> { return {
  schemaVersion: 1, provider: "siglip2", mode,
  model: { id: env.SIGLIP_MODEL, revision: env.SIGLIP_MODEL_REVISION },
  preprocessing: { resize: 256, mode: "candidate-crop", version: "candidate-crop-v1" },
  conceptSet: { id: "wine-label-v1", version: 1 },
  fusion: { version: "label-fusion-v2", cvWeight: .5, semanticWeight: .35, contourGeometryWeight: .15 },
}; }
function normalize(values: number[]) { const min = Math.min(...values), max = Math.max(...values); return max === min ? values.map(() => .5) : values.map((value) => (value - min) / (max - min)); }
function rank(values: number[]) { const ordered = values.map((value, index) => ({ value, index })).sort((left, right) => right.value - left.value || left.index - right.index); const result = new Array<number>(values.length); ordered.forEach((item, index) => { result[item.index] = index + 1; }); return result; }
function finite(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function clamp01(value: number) { return Math.max(0, Math.min(1, value)); }
function round(value: number) { return Math.round(value * 10_000) / 10_000; }
function errorCode(error: unknown) { return error instanceof DOMException && error.name === "AbortError" ? "timeout" : "service_unavailable"; }
function boundedMessage(error: unknown) { const message = error instanceof Error ? error.message : "Unknown SigLIP failure"; return message.slice(0, 300); }
