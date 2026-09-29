export type RecognitionReference = {
  slug: string;
  keywords: string[];
};

export type RecognitionReferencesResponse = {
  schemaVersion: "references/1";
  items: RecognitionReference[];
};

export function parseRecognitionReferences(value: unknown): RecognitionReferencesResponse {
  if (
    !value || typeof value !== "object" ||
    !("schemaVersion" in value) || value.schemaVersion !== "references/1" ||
    !("items" in value) || !Array.isArray(value.items) ||
    !value.items.every((item: unknown) =>
      item !== null && typeof item === "object" &&
      "slug" in item && typeof item.slug === "string" &&
      "keywords" in item && Array.isArray(item.keywords) &&
      item.keywords.every((keyword: unknown) => typeof keyword === "string")
    )
  ) {
    throw new Error("Invalid recognition references response");
  }

  // Preserve the saved keywords exactly; this client does not derive aliases.
  return value as RecognitionReferencesResponse;
}

export async function loadRecognitionReferences(
  signal?: AbortSignal,
): Promise<RecognitionReferencesResponse> {
  const response = await fetch("/api/recognition/references", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to load recognition references (${response.status})`);
  }
  return parseRecognitionReferences(await response.json());
}
