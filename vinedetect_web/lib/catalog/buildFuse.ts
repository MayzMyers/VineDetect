import Fuse from "fuse.js";
import type { ClientWineSearchItem, WineCandidate } from "./types";
import { buildSearchText } from "./searchText";

export function buildWineFuse(items: ClientWineSearchItem[]) {
  const searchableItems = items.map((item) => ({
    ...item,
    searchText:
      item.searchText ??
      buildSearchText([
        item.title,
        item.producer,
        item.region,
        item.year,
        item.grapes?.join(" "),
        item.aliases?.join(" "),
        item.color,
        item.sugar,
        item.category,
        item.normalizedText,
      ]),
  }));

  return new Fuse<ClientWineSearchItem>(searchableItems, {
    includeScore: true,
    shouldSort: true,
    ignoreLocation: true,
    threshold: 0.42,
    minMatchCharLength: 3,
    keys: [
      { name: "title", weight: 0.35 },
      { name: "producer", weight: 0.25 },
      { name: "grapes", weight: 0.15 },
      { name: "year", weight: 0.1 },
      { name: "region", weight: 0.06 },
      { name: "aliases", weight: 0.06 },
      { name: "normalizedText", weight: 0.03 },
      { name: "searchText", weight: 0.28 },
    ],
  });
}

export function searchWineCandidates(
  fuse: Fuse<ClientWineSearchItem>,
  query: string,
  limit = 5
): WineCandidate[] {
  if (!query.trim()) return [];

  return fuse.search(query, { limit }).map((result) => ({
    wineId: result.item.id,
    title: result.item.title,
    producer: result.item.producer,
    score: Math.max(0, 1 - (result.score ?? 1)),
    source: "client_fuse",
  }));
}
