import type { ClientSearchIndexResponse } from "./types";

const STORAGE_KEY = "wine-search-index-v1";

export async function loadSearchIndex(): Promise<ClientSearchIndexResponse> {
  const cached = localStorage.getItem(STORAGE_KEY);

  try {
    const response = await fetch("/api/catalog/search-index", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Failed to load catalog search index");

    const index = (await response.json()) as ClientSearchIndexResponse;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(index));
    return index;
  } catch (error) {
    if (!cached) throw error;

    try {
      return JSON.parse(cached) as ClientSearchIndexResponse;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
      throw error;
    }
  }
}
