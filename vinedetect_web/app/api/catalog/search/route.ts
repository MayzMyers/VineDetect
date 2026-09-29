import { NextRequest, NextResponse } from "next/server";
import type { CatalogItem, CatalogResponse } from "@/lib/admin/api";
import type { WineCandidate } from "@/lib/catalog/types";
import { getMockRecognitionSuggestions } from "@/lib/catalog/mockRecognitionSuggestions";
import { resolveReferenceCatalogCandidate } from "@/lib/catalog/referenceCatalogBff";
import { extractOcrKeywords, normalizeMatchText } from "@/lib/scanner/liveMatch";

const API_SERVICE_URL =
  process.env.API_SERVICE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://127.0.0.1:8000";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim().slice(0, 240) ?? "";
  const keywords = extractOcrKeywords(query);

  if (keywords.length === 0) {
    return NextResponse.json({ query, keywords, candidates: [], suggestions: [] });
  }

  if (process.env.RECOGNITION_RUNTIME === "mock") {
    try {
      const resolved = await resolveReferenceCatalogCandidate(keywords);
      if (resolved) {
        return NextResponse.json(
          {
            query,
            keywords,
            candidates: [resolved.candidate],
            suggestions: [],
            referenceMatch: {
              slug: resolved.reference.slug,
              matchedTokens: resolved.reference.matchedTokens,
              confidence: resolved.reference.confidence,
            },
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
    } catch (error) {
      console.warn("Reference mock lookup failed; falling back to catalog keyword search.", error);
    }
  }

  try {
    const resultSets = await Promise.all(keywords.map(fetchCatalogKeyword));
    const candidates = rankCandidates(resultSets.flat(), keywords);
    const suggestions = candidates.length === 0
      ? getMockRecognitionSuggestions({ ocrText: query, limit: 5 }).suggestions
      : [];

    return NextResponse.json(
      { query, keywords, candidates, suggestions },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Catalog search failed";
    const suggestions = getMockRecognitionSuggestions({ ocrText: query, limit: 5 }).suggestions;
    return NextResponse.json(
      { query, keywords, candidates: [], suggestions, verificationError: message },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
}

async function fetchCatalogKeyword(keyword: string) {
  const url = new URL("/api/v1/catalog", API_SERVICE_URL);
  url.searchParams.set("source", "all");
  url.searchParams.set("q", keyword);
  url.searchParams.set("limit", "12");

  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error(`Catalog API returned HTTP ${response.status}`);
  }

  const payload = await response.json() as CatalogResponse;
  return payload.items;
}

function rankCandidates(items: CatalogItem[], keywords: string[]): WineCandidate[] {
  const uniqueItems = new Map<string, CatalogItem>();
  for (const item of items) uniqueItems.set(item.recognitionKey, item);

  const totalWeight = keywords.reduce((sum, keyword) => sum + keyword.length, 0);

  return [...uniqueItems.values()]
    .map((item) => {
      const searchable = normalizeMatchText([
        item.title,
        item.manufacturer,
        item.category,
        item.region,
        item.year,
        item.barcode,
      ].filter(Boolean).join(" "));
      const matched = keywords.filter((keyword) => searchable.includes(keyword));
      const matchedWeight = matched.reduce((sum, keyword) => sum + keyword.length, 0);
      const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
      const hitBonus = Math.min(0.12, matched.length * 0.04);

      return {
        wineId: item.recognitionKey,
        title: item.title ?? item.recognitionKey,
        producer: item.manufacturer ?? undefined,
        score: Math.min(0.99, 0.3 + coverage * 0.58 + hitBonus),
        source: "database_keyword" as const,
        catalogSource: item.source,
        imageUrl: clientCatalogImageUrl(item.image) ?? undefined,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function clientCatalogImageUrl(image: CatalogItem["image"]) {
  const localPath = image.local_path?.trim().replaceAll("\\", "/");
  if (localPath && !localPath.split("/").includes("..")) {
    return `/api/catalog/image?path=${encodeURIComponent(localPath)}`;
  }
  return image.url;
}
