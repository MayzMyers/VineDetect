import type { MetaItemRow } from "../../db/meta.repository.js";
import type { OcrRegionReviewDto } from "../../db/ocr.repository.js";
import { sourceValueKey } from "../../db/source-association.repository.js";
import type { SourceItem } from "../../shared/types.js";
import { normalizeOcrText } from "./normalize.js";
import { classifyOcrSemantic, semanticSourceCompatibility, type OcrSemanticType } from "./semantic.js";

export type MatchSourceValue = { field: string; value: string; valueKind: "full" | "token" };
export type SourceMatchCandidate = MatchSourceValue & {
  ocrRegionAnnotationId: string;
  regionText: string;
  score: number;
  matchKind: "exact" | "contains" | "token-overlap";
};

export type GeneratedSourceMatchCandidate = MatchSourceValue & {
  ocrRegionId: string;
  regionText: string;
  score: number;
  matchKind: "exact" | "contains" | "token-overlap";
  lexicalScore: number;
  semanticType: OcrSemanticType;
  semanticConfidence: number;
  semanticCompatibility: number;
};

export function buildSourceValues(sourceItem: SourceItem, metadata: MetaItemRow | null): MatchSourceValue[] {
  const rawValues: Array<{ field: string; value: string }> = [
    { field: "title", value: sourceItem.title },
    { field: "manufacturer", value: sourceItem.manufacturer ?? "" },
    { field: "category", value: sourceItem.category ?? "" },
    { field: "region", value: sourceItem.region ?? "" },
    { field: "year", value: sourceItem.year === null ? "" : String(sourceItem.year) },
    { field: "barcode", value: sourceItem.barcode ?? "" },
    { field: "color", value: sourceItem.color ?? "" },
    { field: "description", value: sourceItem.description ?? "" },
    ...(metadata?.aliases ?? []).map((value) => ({ field: "alias", value })),
    ...(metadata?.normalized_tokens ?? []).map((value) => ({ field: "normalized-token", value })),
  ];
  const tokenizedFields = new Set(["title", "manufacturer", "category", "region", "color", "alias", "normalized-token"]);
  const values: MatchSourceValue[] = rawValues.flatMap(({ field, value }) => [
    { field, value, valueKind: "full" as const },
    ...(tokenizedFields.has(field) ? sourceTokens(value).map((token) => ({ field, value: token, valueKind: "token" as const })) : []),
  ]);
  const seen = new Set<string>();
  return values.filter(({ field, value }) => {
    if (!value.trim()) return false;
    const key = sourceValueKey(field, value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildSourceMatchCandidates(
  regionReview: OcrRegionReviewDto | null,
  sourceValues: MatchSourceValue[],
): SourceMatchCandidate[] {
  if (!regionReview) return [];
  return regionReview.regions
    .filter((region): region is typeof region & { text: string } => region.status === "reviewed" && region.transcriptionStatus === "verified" && Boolean(region.text?.trim()))
    .flatMap((region) => sourceValues
      .map((sourceValue) => {
        const match = scoreMatch(region.text, sourceValue.value);
        return match ? {
          ...sourceValue,
          ocrRegionAnnotationId: region.id,
          regionText: region.text,
          ...match,
        } : null;
      })
      .filter((candidate): candidate is SourceMatchCandidate => candidate !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, 6));
}

export function buildGeneratedSourceMatchCandidates(
  regions: Array<{ id: string; level: string; normalizedText: string; rawText: string; bbox?: Record<string, unknown> }>,
  sourceValues: MatchSourceValue[],
): GeneratedSourceMatchCandidate[] {
  return regions
    .filter((region) => (region.level === "line" || region.level === "word") && (region.normalizedText || region.rawText).trim())
    .flatMap((region) => {
      const regionText = region.normalizedText || region.rawText;
      const semantic = classifyOcrSemantic(region.rawText || region.normalizedText, region.level as "line" | "word", normalizedBox(region.bbox));
      const narrowedSources = sourceValues.filter((sourceValue) => semantic.confidence < 0.75
        || semanticSourceCompatibility(semantic, sourceValue.field) >= 0.35);
      return narrowedSources.map((sourceValue) => {
        const match = scoreMatch(regionText, sourceValue.value);
        if (!match) return null;
        const semanticCompatibility = semanticSourceCompatibility(semantic, sourceValue.field);
        const score = Math.min(1, match.score * (0.72 + semanticCompatibility * 0.28));
        return {
          ...sourceValue,
          ocrRegionId: region.id,
          regionText,
          score,
          matchKind: match.matchKind,
          lexicalScore: match.score,
          semanticType: semantic.type,
          semanticConfidence: semantic.confidence,
          semanticCompatibility,
        };
      }).filter((candidate): candidate is GeneratedSourceMatchCandidate => candidate !== null)
        .sort((left, right) => right.score - left.score)
        .slice(0, 6);
    });
}

function sourceTokens(value: string) {
  return [...new Set(normalizeOcrText(value).split(/\s+/).filter((token) => token.length >= 2))].slice(0, 32);
}

function normalizedBox(value: Record<string, unknown> | undefined) {
  if (!value) return undefined;
  const x = numberValue(value.x); const y = numberValue(value.y);
  const width = numberValue(value.width); const height = numberValue(value.height);
  return x === null || y === null || width === null || height === null ? undefined : { x, y, width, height };
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scoreMatch(regionText: string, sourceValue: string): Pick<SourceMatchCandidate, "score" | "matchKind"> | null {
  const region = normalizeOcrText(regionText);
  const source = normalizeOcrText(sourceValue);
  if (!region || !source) return null;
  if (region === source) return { score: 1, matchKind: "exact" };
  if (source.includes(region) || region.includes(source)) {
    const ratio = Math.min(region.length, source.length) / Math.max(region.length, source.length);
    return { score: Math.min(0.96, 0.65 + ratio * 0.3), matchKind: "contains" };
  }
  const regionTokens = tokenSet(region);
  const sourceTokens = tokenSet(source);
  const intersection = [...regionTokens].filter((token) => sourceTokens.has(token)).length;
  if (!intersection) return null;
  const score = intersection / new Set([...regionTokens, ...sourceTokens]).size;
  return score >= 0.25 ? { score, matchKind: "token-overlap" } : null;
}

function tokenSet(value: string) {
  return new Set(value.split(/\s+/).filter((token) => token.length >= 2));
}
