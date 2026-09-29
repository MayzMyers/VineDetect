export type ClientWineSearchItem = {
  id: string;
  title: string;
  producer?: string;
  region?: string;
  year?: number;
  grapes?: string[];
  color?: string;
  sugar?: string;
  category?: string;
  aliases?: string[];
  normalizedText: string;
  searchText?: string;
};

export type ClientSearchIndexResponse = {
  version: string;
  updatedAt: string;
  itemCount: number;
  items: ClientWineSearchItem[];
};

export type WineCandidate = {
  wineId: string;
  title: string;
  producer?: string;
  score: number;
  source: "client_fuse" | "bootstrap_tags" | "bootstrap_suggestion" | "database_keyword";
  catalogSource?: string;
  imageUrl?: string;
  matchedTags?: string[];
  suggestionReason?: "ocr_similarity" | "metadata_similarity" | "combined";
  matchedMetadata?: string[];
};

export type LiveCatalogSearchResponse = {
  query: string;
  keywords: string[];
  candidates: WineCandidate[];
  suggestions: WineCandidate[];
  verificationError?: string;
  referenceMatch?: { slug: string; matchedTokens: string[]; confidence: number };
};

export type LiveCatalogSuggestionsResponse = {
  query: string;
  seedCatalogKey?: string;
  suggestions: WineCandidate[];
};
