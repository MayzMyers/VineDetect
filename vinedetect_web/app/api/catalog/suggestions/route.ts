import { NextRequest, NextResponse } from "next/server";
import { getMockRecognitionSuggestions } from "@/lib/catalog/mockRecognitionSuggestions";
import { fetchCatalogItemBySlug, getSimilarCatalogWines } from "@/lib/catalog/referenceCatalogBff";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim().slice(0, 240) ?? "";
  const seedCatalogKey = request.nextUrl.searchParams.get("seed")?.trim().slice(0, 300) || undefined;
  const excluded = request.nextUrl.searchParams
    .getAll("exclude")
    .map((value) => value.trim().slice(0, 300))
    .filter(Boolean);

  if (!query && !seedCatalogKey) {
    return NextResponse.json(
      { error: "Either q or seed is required" },
      { status: 400 }
    );
  }

  if (seedCatalogKey?.startsWith("svoe_vino:")) {
    try {
      const slug = seedCatalogKey.slice("svoe_vino:".length);
      const seed = await fetchCatalogItemBySlug(slug);
      if (seed) {
        const excludedSet = new Set([seedCatalogKey, ...excluded]);
        const suggestions = (await getSimilarCatalogWines(seed, 6))
          .filter((candidate) => !excludedSet.has(candidate.wineId))
          .slice(0, 3);
        return NextResponse.json(
          { query, seedCatalogKey, source: "catalog-metadata", suggestions },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
    } catch (error) {
      console.warn("Catalog similarity lookup failed; falling back to bootstrap suggestions.", error);
    }
  }

  const result = getMockRecognitionSuggestions({
    ocrText: query || undefined,
    seedCatalogKey,
    excludeCatalogKeys: excluded,
    limit: 5,
  });

  return NextResponse.json(
    {
      query,
      seedCatalogKey,
      bootstrapVersion: result.version,
      suggestions: result.suggestions,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
