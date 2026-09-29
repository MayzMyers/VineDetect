import type { LiveCatalogSearchResponse, LiveCatalogSuggestionsResponse } from "./types";

export async function searchLiveCatalog(
  query: string,
  signal?: AbortSignal
): Promise<LiveCatalogSearchResponse> {
  const searchParams = new URLSearchParams({ q: query });
  const response = await fetch(`/api/catalog/search?${searchParams.toString()}`, {
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `Catalog search failed with HTTP ${response.status}`);
  }

  return response.json() as Promise<LiveCatalogSearchResponse>;
}

export async function searchLiveCatalogSuggestions(input: {
  query?: string;
  seedCatalogKey?: string;
  excludeCatalogKeys?: string[];
  signal?: AbortSignal;
}): Promise<LiveCatalogSuggestionsResponse> {
  const searchParams = new URLSearchParams();
  if (input.query) searchParams.set("q", input.query);
  if (input.seedCatalogKey) searchParams.set("seed", input.seedCatalogKey);
  for (const catalogKey of input.excludeCatalogKeys ?? []) {
    searchParams.append("exclude", catalogKey);
  }

  const response = await fetch(`/api/catalog/suggestions?${searchParams.toString()}`, {
    cache: "no-store",
    signal: input.signal,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? `Catalog suggestions failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<LiveCatalogSuggestionsResponse>;
}
