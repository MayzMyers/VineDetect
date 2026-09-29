import type { LabelAnalysisTextRegion, SourceItem, SourceName } from "../../shared/types.js";
import { normalizeOcrText } from "./normalize.js";
import { semanticSourceCompatibility, type OcrSemanticClassification, type OcrSemanticType } from "./semantic.js";

export type CatalogFieldMatch = {
  ocrRegionId: string;
  regionText: string;
  semanticType: OcrSemanticType;
  sourceField: string;
  sourceValue: string;
  lexicalScore: number;
  semanticCompatibility: number;
  score: number;
  matchKind: "exact" | "contains" | "token-overlap" | "fuzzy";
};

export type CatalogCandidate = {
  source: SourceName;
  sourceItemId: string;
  title: string;
  manufacturer: string | null;
  score: number;
  matchedRegionCount: number;
  isCurrentItem: boolean;
  matches: CatalogFieldMatch[];
};

export function buildCatalogSearchInput(regions: LabelAnalysisTextRegion[]) {
  const useful = regions.filter((region) => (region.normalizedText || region.rawText).trim()
    && (region.semantic?.confidence ?? 0) >= 0.55);
  const phrases = useful.map((region) => normalizeOcrText(region.normalizedText || region.rawText)).filter((value) => value.length >= 3);
  const tokens = phrases.flatMap((value) => value.split(/\s+/)).filter((value) => value.length >= 3 && !STOP_TOKENS.has(value));
  return {
    terms: [...new Set([...phrases, ...tokens])].slice(0, 16),
    years: [...new Set(useful.filter((region) => region.semantic?.type === "vintage").map((region) => normalizeOcrText(region.normalizedText || region.rawText)))],
    barcodes: [...new Set(useful.filter((region) => region.semantic?.type === "barcode").map((region) => normalizeOcrText(region.normalizedText || region.rawText).replace(/\D/g, "")))],
  };
}

export function rankCatalogCandidates(
  regions: LabelAnalysisTextRegion[],
  items: SourceItem[],
  current: { source: SourceName; sourceItemId: string },
  limit = 10,
): CatalogCandidate[] {
  const ranked = items.map((item) => rankItem(regions, item, current))
    .filter((candidate) => candidate.matches.length > 0 || candidate.isCurrentItem)
    .sort((left, right) => right.score - left.score || right.matchedRegionCount - left.matchedRegionCount || left.title.localeCompare(right.title, "ru"));
  const shortlist = ranked.slice(0, limit);
  const currentCandidate = ranked.find((candidate) => candidate.isCurrentItem);
  if (currentCandidate && !shortlist.some((candidate) => candidate.isCurrentItem)) shortlist.push(currentCandidate);
  return shortlist;
}

function rankItem(regions: LabelAnalysisTextRegion[], item: SourceItem, current: { source: SourceName; sourceItemId: string }): CatalogCandidate {
  const values = sourceValues(item);
  const evidenceClusters = clusterEvidence(regions);
  const clusterByRegionId = new Map(evidenceClusters.flatMap((cluster) => cluster.regions.map((region) => [region.id, cluster] as const)));
  const matches = regions.flatMap((region) => {
    const regionText = region.normalizedText || region.rawText;
    if (!regionText.trim()) return [];
    const semantic: OcrSemanticClassification = region.semantic ?? { type: "unknown", confidence: 0.35, reasons: [] };
    return values.map(({ field, value }) => {
      const lexical = lexicalMatch(regionText, value, field);
      if (!lexical) return null;
      const compatibility = semanticSourceCompatibility(semantic, field);
      if (semantic.confidence >= 0.75 && compatibility < 0.35) return null;
      const evidenceWeight = 0.55 + Math.max(0, Math.min(1, (region.confidence ?? 0) / 100)) * 0.25 + semantic.confidence * 0.2;
      const score = clamp01(lexical.score * (0.7 + compatibility * 0.3) * evidenceWeight);
      return { ocrRegionId: region.id, regionText, semanticType: semantic.type, sourceField: field, sourceValue: value,
        lexicalScore: lexical.score, semanticCompatibility: compatibility, score, matchKind: lexical.matchKind } satisfies CatalogFieldMatch;
    }).filter((match): match is CatalogFieldMatch => match !== null)
      .sort((left, right) => right.score - left.score).slice(0, 2);
  }).sort((left, right) => right.score - left.score);
  const bestByEvidence = new Map<string, CatalogFieldMatch>();
  for (const match of matches) {
    const key = clusterByRegionId.get(match.ocrRegionId)?.id ?? match.ocrRegionId;
    if ((bestByEvidence.get(key)?.score ?? -1) < match.score) bestByEvidence.set(key, match);
  }
  const selected = [...bestByEvidence.values()].sort((left, right) => right.score - left.score).slice(0, 8);
  const totalEvidenceWeight = evidenceClusters.reduce((sum, cluster) => sum + cluster.weight, 0);
  const coveredScore = selected.reduce((sum, match) => sum + match.score * (clusterByRegionId.get(match.ocrRegionId)?.weight ?? semanticDiscrimination(match.semanticType)), 0)
    / Math.max(0.0001, totalEvidenceWeight);
  const strongest = selected[0]?.score ?? 0;
  const exactBoost = selected.some((match) => match.matchKind === "exact" && match.semanticType === "barcode") ? 0.12
    : selected.some((match) => match.matchKind === "exact" && match.semanticType === "vintage") ? 0.01 : 0;
  const score = selected.length ? clamp01(coveredScore * 0.88 + strongest * 0.12 + exactBoost) : 0;
  return {
    source: item.source, sourceItemId: item.sourceItemId, title: item.title, manufacturer: item.manufacturer,
    score, matchedRegionCount: selected.length, isCurrentItem: item.source === current.source && item.sourceItemId === current.sourceItemId,
    matches: selected,
  };
}

function sourceValues(item: SourceItem) {
  return [
    { field: "title", value: item.title }, { field: "manufacturer", value: item.manufacturer ?? "" },
    { field: "category", value: item.category ?? "" }, { field: "region", value: item.region ?? "" },
    { field: "year", value: item.year === null ? "" : String(item.year) }, { field: "barcode", value: item.barcode ?? "" },
    { field: "color", value: item.color ?? "" }, { field: "description", value: item.description ?? "" },
  ].filter(({ value }) => value.trim());
}

function lexicalMatch(leftValue: string, rightValue: string, sourceField: string): { score: number; matchKind: CatalogFieldMatch["matchKind"] } | null {
  const left = normalizeOcrText(leftValue); const right = normalizeOcrText(rightValue);
  if (!left || !right) return null;
  const variants = [...new Set([left, transliterateRussian(left)])].flatMap((leftVariant) =>
    [...new Set([right, transliterateRussian(right)])].map((rightVariant) => lexicalNormalized(leftVariant, rightVariant, sourceField)));
  return variants.filter((match): match is NonNullable<typeof match> => match !== null)
    .sort((leftMatch, rightMatch) => rightMatch.score - leftMatch.score)[0] ?? null;
}

function lexicalNormalized(left: string, right: string, sourceField: string): { score: number; matchKind: CatalogFieldMatch["matchKind"] } | null {
  if (left === right) return { score: 1, matchKind: "exact" };
  const leftTokens = tokenSet(left); const rightTokens = tokenSet(right);
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  if (intersection && (leftTokens.size === 1 || rightTokens.size === 1)) {
    return { score: 0.98, matchKind: "exact" };
  }
  if (left.includes(right) || right.includes(left)) {
    const ratio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    const minimumRatio = sourceField === "title" || sourceField === "description" || sourceField === "category" ? 0.18 : 0.4;
    return ratio >= minimumRatio ? { score: Math.min(0.96, 0.62 + ratio * 0.34), matchKind: "contains" } : null;
  }
  if (intersection) {
    const evidenceCoverage = intersection / leftTokens.size;
    const sourcePrecision = intersection / rightTokens.size;
    const score = evidenceCoverage * 0.82 + sourcePrecision * 0.18;
    if (evidenceCoverage >= 0.5 && score >= 0.35) return { score, matchKind: "token-overlap" };
  }
  if (left.length < 4 || right.length < 4 || Math.max(left.length, right.length) > 80) return null;
  const similarity = 1 - levenshtein(left, right) / Math.max(left.length, right.length);
  return similarity >= 0.58 ? { score: similarity * 0.86, matchKind: "fuzzy" } : null;
}

function transliterateRussian(value: string) {
  return [...value].map((character) => CYRILLIC_LATIN[character] ?? character).join("");
}

function tokenSet(value: string) { return new Set(value.split(/[\s-]+/).filter((token) => token.length >= 2)); }

function clusterEvidence(regions: LabelAnalysisTextRegion[]) {
  const useful = regions.filter((region) => normalizeOcrText(region.normalizedText || region.rawText));
  const parent = useful.map((_region, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const join = (left: number, right: number) => {
    const leftRoot = find(left); const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  for (let left = 0; left < useful.length; left += 1) {
    for (let right = left + 1; right < useful.length; right += 1) {
      if (sameEvidence(useful[left], useful[right])) join(left, right);
    }
  }
  const grouped = new Map<number, LabelAnalysisTextRegion[]>();
  useful.forEach((region, index) => grouped.set(find(index), [...(grouped.get(find(index)) ?? []), region]));
  return [...grouped.values()].map((clusterRegions, index) => ({
    id: `evidence-${index}`,
    regions: clusterRegions,
    weight: Math.max(...clusterRegions.map((region) => semanticDiscrimination(region.semantic?.type ?? "unknown"))),
  }));
}

function sameEvidence(left: LabelAnalysisTextRegion, right: LabelAnalysisTextRegion) {
  const leftText = normalizeOcrText(left.normalizedText || left.rawText);
  const rightText = normalizeOcrText(right.normalizedText || right.rawText);
  if (leftText === rightText) return true;
  const leftTokens = tokenSet(leftText); const rightTokens = tokenSet(rightText);
  const tokensNested = [...leftTokens].every((token) => rightTokens.has(token))
    || [...rightTokens].every((token) => leftTokens.has(token));
  return tokensNested && overlapOverSmaller(left.bbox, right.bbox) >= 0.65;
}

function overlapOverSmaller(left: LabelAnalysisTextRegion["bbox"], right: LabelAnalysisTextRegion["bbox"]) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = width * height;
  return intersection / Math.max(0.000001, Math.min(left.width * left.height, right.width * right.height));
}
function levenshtein(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) current[column] = left[row - 1] === right[column - 1]
      ? previous[column - 1] : Math.min(previous[column - 1], previous[column], current[column - 1]) + 1;
    for (let column = 0; column < current.length; column += 1) previous[column] = current[column];
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}
function clamp01(value: number) { return Math.max(0, Math.min(1, Math.round(value * 10000) / 10000)); }

function semanticDiscrimination(type: OcrSemanticType) {
  if (type === "barcode") return 1.5;
  if (type === "producer" || type === "product-name") return 1.1;
  if (type === "region") return 0.8;
  if (type === "classification" || type === "volume" || type === "alcohol") return 0.55;
  if (type === "vintage") return 0.28;
  if (type === "color") return 0.2;
  if (type === "free-text") return 0.65;
  return 0.4;
}

const STOP_TOKENS = new Set(["wine", "vino", "\u0432\u0438\u043d\u043e", "dry", "\u0441\u0443\u0445\u043e\u0435", "\u043a\u0440\u0430\u0441\u043d\u043e\u0435", "\u0431\u0435\u043b\u043e\u0435"]);
const CYRILLIC_LATIN: Record<string, string> = {
  "\u0430": "a", "\u0431": "b", "\u0432": "v", "\u0433": "g", "\u0434": "d", "\u0435": "e", "\u0451": "e", "\u0436": "zh", "\u0437": "z", "\u0438": "i", "\u0439": "y",
  "\u043a": "k", "\u043b": "l", "\u043c": "m", "\u043d": "n", "\u043e": "o", "\u043f": "p", "\u0440": "r", "\u0441": "s", "\u0442": "t", "\u0443": "u", "\u0444": "f",
  "\u0445": "kh", "\u0446": "ts", "\u0447": "ch", "\u0448": "sh", "\u0449": "sch", "\u044a": "", "\u044b": "y", "\u044c": "", "\u044d": "e", "\u044e": "yu", "\u044f": "ya",
};
