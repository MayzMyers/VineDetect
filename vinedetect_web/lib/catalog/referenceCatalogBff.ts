import "server-only";

import referenceAsset from "@/public/mock/recognition-references.v1.json";
import type { WineCandidate } from "./types";
import type { RecognitionProduct } from "../scanner/recognitionFlow";

const API_SERVICE_URL = process.env.API_SERVICE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

type ReferenceEntry = { slug: string; tokens: string[] };
type CatalogItem = {
  source: string;
  external_id: string;
  recognitionKey: string;
  local_id?: number | null;
  title?: string | null;
  manufacturer?: string | null;
  category?: string | null;
  region?: string | null;
  year?: number | null;
  rating?: string | null;
  description?: string | null;
  image?: { url?: string | null; local_path?: string | null };
  dish_items?: CatalogDishItem[];
};

type CatalogDishItem = {
  name: string;
  image?: { url?: string | null; altText?: string | null } | null;
};

type CatalogWineDetail = {
  dish_items?: CatalogDishItem[];
};

const entries = (referenceAsset.entries as ReferenceEntry[]).map((entry) => ({
  slug: entry.slug,
  tokens: new Set(entry.tokens),
}));
const documentFrequency = new Map<string, number>();
for (const entry of entries) {
  for (const token of entry.tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
}
const resolvedCatalogCache = new Map<string, Promise<CatalogItem | null>>();
const wineDetailCache = new Map<number, Promise<CatalogWineDetail | null>>();
const similarCatalogCache = new Map<string, Promise<WineCandidate[]>>();

export function matchReferenceSlug(sourceTokens: string[]) {
  const tokens = [...new Set(sourceTokens.map(normalize).filter(Boolean))];
  if (tokens.length === 0) return null;

  const ranked = entries
    .map((entry) => {
      const matchedTokens = tokens.filter((token) => entry.tokens.has(token));
      const score = matchedTokens.reduce((sum, token) => {
        const frequency = documentFrequency.get(token) ?? entries.length;
        return sum + Math.log((entries.length + 1) / (frequency + 1)) + 1;
      }, 0);
      return { slug: entry.slug, matchedTokens, score };
    })
    .filter((entry) => entry.matchedTokens.length > 0)
    .sort((left, right) => right.score - left.score || right.matchedTokens.length - left.matchedTokens.length || left.slug.localeCompare(right.slug));

  const top = ranked[0];
  if (!top) return null;
  const onlyTokenFrequency = top.matchedTokens.length === 1 ? documentFrequency.get(top.matchedTokens[0]) ?? entries.length : 0;
  if (top.matchedTokens.length === 1 && onlyTokenFrequency > 24) return null;

  const runnerUp = ranked[1];
  const confidence = runnerUp && runnerUp.score > 0
    ? Math.min(0.99, 0.58 + Math.max(0, top.score - runnerUp.score) / top.score * 0.35)
    : 0.94;
  return { ...top, confidence };
}

export async function resolveReferenceCatalogCandidate(tokens: string[]) {
  const reference = matchReferenceSlug(tokens);
  if (!reference) return null;
  const item = await fetchCatalogItemBySlug(reference.slug);
  if (!item) return null;
  return { reference, item, candidate: toCandidate(item, reference.confidence, reference.matchedTokens) };
}

export async function fetchCatalogItemBySlug(slug: string) {
  let pending = resolvedCatalogCache.get(slug);
  if (!pending) {
    pending = fetchCatalog({ source: "svoe_vino", query: slug, limit: 12 })
      .then(async (items) => {
        const item = items.find((candidate) => candidate.external_id === slug || candidate.recognitionKey === `svoe_vino:${slug}`) ?? null;
        if (!item?.local_id) return item;
        const detail = await fetchWineDetail(item.local_id);
        if (!detail) resolvedCatalogCache.delete(slug);
        return detail ? { ...item, dish_items: detail.dish_items ?? [] } : item;
      })
      .catch((error) => {
        resolvedCatalogCache.delete(slug);
        throw error;
      });
    resolvedCatalogCache.set(slug, pending);
  }
  return pending;
}

export async function getSimilarCatalogWines(seed: CatalogItem, limit = 3) {
  const cacheKey = `${seed.recognitionKey}:${limit}`;
  let pending = similarCatalogCache.get(cacheKey);
  if (!pending) {
    pending = collectSimilarCatalogWines(seed, limit).catch((error) => {
      similarCatalogCache.delete(cacheKey);
      throw error;
    });
    similarCatalogCache.set(cacheKey, pending);
  }
  return pending;
}

export function toRecognitionProduct(item: CatalogItem): RecognitionProduct {
  return {
    id: item.local_id ?? item.external_id,
    catalogKey: item.recognitionKey,
    slug: item.external_id,
    title: item.title ?? item.external_id,
    producer: item.manufacturer ?? null,
    image: catalogImageUrl(item.image),
    category: item.category ?? null,
    region: item.region ?? null,
    vintage: item.year ?? null,
    description: item.description ?? null,
    dishes: (item.dish_items ?? []).map((dish) => ({
      name: dish.name,
      image: dishAssetUrl(dish.image?.url),
      alt: dish.image?.altText ?? dish.name,
    })),
  };
}

async function collectSimilarCatalogWines(seed: CatalogItem, limit: number) {
  const queries = [...new Set([seed.category, seed.region, seed.manufacturer].map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
  const resultSets = queries.length > 0
    ? await Promise.all(queries.map((query) => fetchCatalog({ source: "svoe_vino", query, limit: 50 })))
    : [await fetchCatalog({ source: "svoe_vino", limit: 100 })];
  const unique = new Map<string, CatalogItem>();
  for (const item of resultSets.flat()) {
    if (item.recognitionKey !== seed.recognitionKey) unique.set(item.recognitionKey, item);
  }

  return [...unique.values()]
    .map((item) => ({ item, score: similarityScore(seed, item) }))
    .sort((left, right) => right.score - left.score || (left.item.title ?? "").localeCompare(right.item.title ?? "", "ru"))
    .slice(0, limit)
    .map(({ item, score }) => toCandidate(item, score, []));
}

async function fetchCatalog(input: { source: "svoe_vino" | "all"; query?: string; limit: number }) {
  const url = new URL("/api/v1/catalog", API_SERVICE_URL);
  url.searchParams.set("source", input.source);
  url.searchParams.set("limit", String(input.limit));
  if (input.query) url.searchParams.set("q", input.query);
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Catalog API returned HTTP ${response.status}`);
  const payload = await response.json() as { items?: CatalogItem[] };
  return payload.items ?? [];
}

function toCandidate(item: CatalogItem, score: number, matchedTags: string[]): WineCandidate {
  return {
    wineId: item.recognitionKey,
    title: item.title ?? item.external_id,
    producer: item.manufacturer ?? undefined,
    imageUrl: catalogImageUrl(item.image) ?? undefined,
    score: Math.min(0.99, Math.max(0, score)),
    source: "database_keyword",
    catalogSource: item.source,
    matchedTags,
    suggestionReason: matchedTags.length > 0 ? "ocr_similarity" : "metadata_similarity",
    matchedMetadata: matchedTags.length > 0 ? undefined : [item.category, item.region].filter((value): value is string => Boolean(value)),
  };
}

async function fetchWineDetail(localId: number) {
  let pending = wineDetailCache.get(localId);
  if (!pending) {
    const url = new URL(`/api/v1/wines/${localId}`, API_SERVICE_URL);
    pending = fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) })
      .then(async (response) => {
        if (!response.ok) {
          wineDetailCache.delete(localId);
          return null;
        }
        return await response.json() as CatalogWineDetail;
      })
      .catch(() => {
        wineDetailCache.delete(localId);
        return null;
      });
    wineDetailCache.set(localId, pending);
  }
  return pending;
}

function catalogImageUrl(image?: CatalogItem["image"]) {
  const localPath = image?.local_path?.trim().replaceAll("\\", "/");
  if (localPath && !localPath.split("/").includes("..")) {
    return `/api/catalog/image?path=${encodeURIComponent(localPath)}`;
  }
  return image?.url ?? null;
}

function dishAssetUrl(sourceUrl?: string | null) {
  if (!sourceUrl) return null;
  try {
    const parsed = new URL(sourceUrl, "http://local");
    const fileName = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");
    if (parsed.pathname.startsWith("/uploads/") && /^[a-zA-Z0-9._-]+$/.test(fileName)) {
      return `/assets/dishes/${fileName}`;
    }
  } catch {
    return sourceUrl;
  }
  return sourceUrl;
}

function similarityScore(seed: CatalogItem, candidate: CatalogItem) {
  let score = 0.12;
  if (same(seed.category, candidate.category)) score += 0.42;
  if (same(seed.region, candidate.region)) score += 0.2;
  if (same(seed.manufacturer, candidate.manufacturer)) score += 0.1;
  score += titleTokenSimilarity(seed.title, candidate.title) * 0.16;
  return Math.min(0.96, score);
}

function titleTokenSimilarity(left?: string | null, right?: string | null) {
  const leftTokens = new Set(normalize(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalize(right).split(" ").filter(Boolean));
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  return shared / union.size;
}

function same(left?: string | null, right?: string | null) {
  return Boolean(left && right && normalize(left) === normalize(right));
}

function normalize(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
