import type { WineCandidate } from "./types.ts";
import { extractOcrKeywords, normalizeMatchText } from "../scanner/liveMatch.ts";

export type RecognitionTagSource =
  | "verified_ocr"
  | "catalog"
  | "alias"
  | "metadata";

export type RecognitionBootstrapTag = {
  value: string;
  weight: number;
  source: RecognitionTagSource;
};

export type RecognitionBootstrapItem = {
  catalogKey: string;
  displayTitle: string;
  producer?: string;
  imageUrl?: string;
  metadata?: {
    producer?: string;
    grapes?: string[];
    region?: string;
    color?: string;
    sweetness?: string;
    vintage?: number;
  };
  tags: RecognitionBootstrapTag[];
};

export type RecognitionBootstrap = {
  schemaVersion: 1;
  version: string;
  generatedAt: string;
  items: RecognitionBootstrapItem[];
};

type CompiledTag = RecognitionBootstrapTag & {
  normalized: string;
  tokens: string[];
};

export type RecognitionBootstrapIndex = {
  version: string;
  items: Array<RecognitionBootstrapItem & { compiledTags: CompiledTag[] }>;
};

const DEFAULT_ASSET_URL = "/mock/recognition-bootstrap.v1.json";
const DEFAULT_KEYWORD_ASSET_URL = "/mock/recognition-keywords.v1.json";

export type RecognitionKeywordAsset = {
  schemaVersion: 1;
  version: string;
  generatedAt: string;
  source: { name: string; sha256: string; itemCount: number };
  keywords: string[];
};

export type RecognitionKeywordIndex = {
  version: string;
  exact: Set<string>;
  byLength: Map<number, string[]>;
};

export async function loadRecognitionBootstrap(
  assetUrl = DEFAULT_ASSET_URL,
  signal?: AbortSignal
): Promise<RecognitionBootstrap> {
  const response = await fetch(assetUrl, { cache: "force-cache", signal });
  if (!response.ok) throw new Error(`Recognition bootstrap failed with HTTP ${response.status}`);

  const payload = await response.json() as RecognitionBootstrap;
  assertRecognitionBootstrap(payload);
  return payload;
}

export async function loadRecognitionKeywords(
  assetUrl = DEFAULT_KEYWORD_ASSET_URL,
  signal?: AbortSignal,
): Promise<RecognitionKeywordAsset> {
  const response = await fetch(assetUrl, { cache: "force-cache", signal });
  if (!response.ok) throw new Error(`Recognition keywords failed with HTTP ${response.status}`);
  const payload = await response.json() as RecognitionKeywordAsset;
  if (
    payload?.schemaVersion !== 1 ||
    typeof payload.version !== "string" ||
    !Array.isArray(payload.keywords) ||
    payload.keywords.some((keyword) => typeof keyword !== "string")
  ) {
    throw new Error("Recognition keyword asset has an invalid schema");
  }
  return payload;
}

export function buildRecognitionKeywordIndex(asset: RecognitionKeywordAsset): RecognitionKeywordIndex {
  const exact = new Set<string>();
  const byLength = new Map<number, string[]>();
  for (const sourceKeyword of asset.keywords) {
    const keyword = normalizeMatchText(sourceKeyword);
    if (!keyword || exact.has(keyword)) continue;
    exact.add(keyword);
    const bucket = byLength.get(keyword.length) ?? [];
    bucket.push(keyword);
    byLength.set(keyword.length, bucket);
  }
  return { version: asset.version, exact, byLength };
}

export function matchRecognitionKeywordTokens(
  index: RecognitionKeywordIndex,
  ocrText: string,
  limit = 8,
): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const queryToken of extractOcrKeywords(normalizeMatchText(ocrText), 16)) {
    let canonical = index.exact.has(queryToken) ? queryToken : null;
    let strongest = canonical ? 1 : 0;
    if (!canonical) {
      const lengthWindow = Math.max(1, Math.ceil(queryToken.length * 0.26));
      for (let length = Math.max(1, queryToken.length - lengthWindow); length <= queryToken.length + lengthWindow; length += 1) {
        for (const keyword of index.byLength.get(length) ?? []) {
          const score = normalizedEditSimilarity(queryToken, keyword);
          if (score > strongest) {
            strongest = score;
            canonical = keyword;
          }
        }
      }
    }
    if (!canonical || strongest < 0.74 || seen.has(canonical)) continue;
    seen.add(canonical);
    matches.push(canonical);
    if (matches.length >= limit) break;
  }
  return matches;
}

export function buildRecognitionBootstrapIndex(
  bootstrap: RecognitionBootstrap
): RecognitionBootstrapIndex {
  return {
    version: bootstrap.version,
    items: bootstrap.items.map((item) => ({
      ...item,
      compiledTags: item.tags.map((tag) => {
        const normalized = normalizeMatchText(tag.value);
        return { ...tag, normalized, tokens: normalized.split(" ").filter(Boolean) };
      }),
    })),
  };
}

export function matchRecognitionBootstrap(
  index: RecognitionBootstrapIndex,
  ocrText: string,
  limit = 5
): WineCandidate[] {
  const normalizedQuery = normalizeMatchText(ocrText);
  const queryTokens = extractOcrKeywords(normalizedQuery, 10);
  if (queryTokens.length === 0) return [];

  return index.items
    .map((item) => scoreBootstrapItem(item, normalizedQuery, queryTokens))
    .filter((candidate): candidate is WineCandidate => candidate !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function matchRecognitionBootstrapTokens(
  index: RecognitionBootstrapIndex,
  ocrText: string,
  limit = 8
): string[] {
  const queryTokens = extractOcrKeywords(normalizeMatchText(ocrText), 16);
  const matches = queryTokens
    .map((queryToken) => {
      let strongest: { canonical: string; score: number; weight: number } | null = null;
      for (const item of index.items) {
        for (const tag of item.compiledTags) {
          for (const tagToken of tag.tokens) {
            const score = normalizedEditSimilarity(queryToken, tagToken);
            if (
              !strongest ||
              score > strongest.score ||
              (score === strongest.score && tag.weight > strongest.weight)
            ) {
              strongest = { canonical: tagToken, score, weight: tag.weight };
            }
          }
        }
      }
      return strongest;
    })
    .filter((match): match is NonNullable<typeof match> => Boolean(match && match.score >= 0.74));

  return [...new Set(matches.map(({ canonical }) => canonical))].slice(0, limit);
}

export function selectRecognitionHypothesis(candidates: WineCandidate[]) {
  const top = candidates[0];
  if (!top || top.score < 0.5) return null;
  const runnerUp = candidates[1];
  const hasMultipleSignals = (top.matchedTags?.length ?? 0) >= 2;
  const isSeparated = !runnerUp || top.score - runnerUp.score >= 0.08;
  return hasMultipleSignals || isSeparated ? top : null;
}

export function suggestRecognitionBootstrap(
  index: RecognitionBootstrapIndex,
  options: {
    ocrText?: string;
    seedCatalogKey?: string;
    excludeCatalogKeys?: string[];
    limit?: number;
  }
): WineCandidate[] {
  const excluded = new Set(options.excludeCatalogKeys ?? []);
  if (options.seedCatalogKey) excluded.add(options.seedCatalogKey);

  const ocrMatches = options.ocrText
    ? matchRecognitionBootstrap(index, options.ocrText, index.items.length)
    : [];
  const ocrScores = new Map(ocrMatches.map((candidate) => [candidate.wineId, candidate]));
  const seed = options.seedCatalogKey
    ? index.items.find((item) => item.catalogKey === options.seedCatalogKey)
    : undefined;

  return index.items
    .filter((item) => !excluded.has(item.catalogKey))
    .map((item) => {
      const ocrCandidate = ocrScores.get(item.catalogKey);
      const metadataMatch = seed ? scoreMetadataSimilarity(seed, item) : null;
      const ocrScore = ocrCandidate?.score ?? 0;
      const metadataScore = metadataMatch?.score ?? 0;
      const score = seed
        ? clamp(metadataScore * 0.68 + ocrScore * 0.32, 0, 0.96)
        : clamp(ocrScore * 0.94, 0, 0.94);

      if (score < 0.24) return null;

      const reason: NonNullable<WineCandidate["suggestionReason"]> = metadataScore > 0 && ocrScore > 0
        ? "combined"
        : metadataScore > 0
          ? "metadata_similarity"
          : "ocr_similarity";

      return {
        wineId: item.catalogKey,
        title: item.displayTitle,
        producer: item.producer,
        imageUrl: item.imageUrl,
        score,
        source: "bootstrap_suggestion" as const,
        suggestionReason: reason,
        matchedTags: ocrCandidate?.matchedTags,
        matchedMetadata: metadataMatch?.matches,
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit ?? 5);
}

function scoreBootstrapItem(
  item: RecognitionBootstrapIndex["items"][number],
  normalizedQuery: string,
  queryTokens: string[]
): WineCandidate | null {
  const tokenScores = queryTokens.map((queryToken) => {
    let bestScore = 0;
    let bestTag = "";

    for (const tag of item.compiledTags) {
      const similarity = Math.max(
        ...tag.tokens.map((tagToken) => tokenSimilarity(queryToken, tagToken)),
        normalizedQuery.includes(tag.normalized) ? 1 : 0
      );
      const weightedScore = similarity * clamp(tag.weight, 0, 1);
      if (weightedScore > bestScore) {
        bestScore = weightedScore;
        bestTag = tag.value;
      }
    }

    return { score: bestScore, tag: bestTag };
  });

  const meaningfulMatches = tokenScores.filter(({ score }) => score >= 0.52);
  if (meaningfulMatches.length === 0) return null;

  const coverage = tokenScores.reduce((sum, match) => sum + match.score, 0) / queryTokens.length;
  const strongest = Math.max(...tokenScores.map(({ score }) => score));
  const multiTokenBonus = Math.min(0.12, Math.max(0, meaningfulMatches.length - 1) * 0.06);
  const score = clamp(coverage * 0.62 + strongest * 0.32 + multiTokenBonus, 0, 0.99);
  if (score < 0.38) return null;

  return {
    wineId: item.catalogKey,
    title: item.displayTitle,
    producer: item.producer,
    imageUrl: item.imageUrl,
    score,
    source: "bootstrap_tags",
    matchedTags: [...new Set(meaningfulMatches.map(({ tag }) => tag).filter(Boolean))],
  };
}

function scoreMetadataSimilarity(
  seed: RecognitionBootstrapIndex["items"][number],
  candidate: RecognitionBootstrapIndex["items"][number]
) {
  const matches: string[] = [];
  let score = 0;

  if (sameText(seed.metadata?.producer ?? seed.producer, candidate.metadata?.producer ?? candidate.producer)) {
    score += 0.4;
    matches.push("producer");
  }

  const grapeOverlap = arrayOverlap(seed.metadata?.grapes, candidate.metadata?.grapes);
  if (grapeOverlap > 0) {
    score += grapeOverlap * 0.25;
    matches.push("grapes");
  }

  for (const [field, weight] of [
    ["region", 0.12],
    ["color", 0.1],
    ["sweetness", 0.08],
  ] as const) {
    if (sameText(seed.metadata?.[field], candidate.metadata?.[field])) {
      score += weight;
      matches.push(field);
    }
  }

  if (seed.metadata?.vintage && seed.metadata.vintage === candidate.metadata?.vintage) {
    score += 0.05;
    matches.push("vintage");
  }

  const tagOverlap = arrayOverlap(
    seed.compiledTags.flatMap((tag) => tag.tokens),
    candidate.compiledTags.flatMap((tag) => tag.tokens)
  );
  if (tagOverlap > 0) {
    score += tagOverlap * 0.12;
    matches.push("visual tags");
  }

  return { score: clamp(score, 0, 1), matches };
}

function sameText(left?: string, right?: string) {
  return Boolean(left && right && normalizeMatchText(left) === normalizeMatchText(right));
}

function arrayOverlap(left?: string[], right?: string[]) {
  if (!left?.length || !right?.length) return 0;
  const normalizedLeft = new Set(left.map(normalizeMatchText));
  const normalizedRight = new Set(right.map(normalizeMatchText));
  const intersection = [...normalizedLeft].filter((value) => normalizedRight.has(value)).length;
  return intersection / Math.max(normalizedLeft.size, normalizedRight.size);
}

function tokenSimilarity(left: string, right: string) {
  if (left === right) return 1;
  if (Math.min(left.length, right.length) >= 4 && (left.startsWith(right) || right.startsWith(left))) {
    return 0.82;
  }
  return diceCoefficient(left, right);
}

function diceCoefficient(left: string, right: string) {
  if (left.length < 2 || right.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const pair = left.slice(index, index + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }

  let intersection = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const pair = right.slice(index, index + 2);
    const count = pairs.get(pair) ?? 0;
    if (count > 0) {
      intersection += 1;
      pairs.set(pair, count - 1);
    }
  }

  return (2 * intersection) / (left.length + right.length - 2);
}

function normalizedEditSimilarity(left: string, right: string) {
  if (left === right) return 1;
  const width = right.length + 1;
  let previous = Array.from({ length: width }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(current[rightIndex - 1] + 1, previous[rightIndex] + 1, substitution);
    }
    previous = current;
  }
  const distance = previous[right.length] ?? Math.max(left.length, right.length);
  return 1 - distance / Math.max(left.length, right.length, 1);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertRecognitionBootstrap(payload: RecognitionBootstrap): asserts payload is RecognitionBootstrap {
  if (
    !payload ||
    payload.schemaVersion !== 1 ||
    typeof payload.version !== "string" ||
    !Array.isArray(payload.items) ||
    payload.items.some((item) =>
      !item ||
      typeof item.catalogKey !== "string" ||
      typeof item.displayTitle !== "string" ||
      !Array.isArray(item.tags)
    )
  ) {
    throw new Error("Recognition bootstrap asset has an invalid schema");
  }
}
