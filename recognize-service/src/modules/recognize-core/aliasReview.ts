import type { SourceAssociationReview } from "../../db/source-association.repository.js";
import type { SourceItem } from "../../shared/types.js";
import { generateAliasSet, normalizeText } from "./text.js";

export type AliasCandidate = {
  candidateKey: string;
  value: string;
  normalizedValue: string;
  aliasType: "source-title" | "source-field" | "ocr-associated" | "composite";
  score: number;
  sourceAssociationIds: string[];
  components: Record<string, unknown>;
};

export function buildAliasCandidates(sourceItem: SourceItem, associationReview: SourceAssociationReview | null) {
  const candidates: AliasCandidate[] = [];
  const sourceAliases = generateAliasSet(sourceItem).aliases;
  for (const alias of sourceAliases) {
    addCandidate(candidates, {
      value: alias.value,
      aliasType: alias.type === "normalized-title" || alias.type === "title-without-service-words" ? "source-title" : "source-field",
      score: alias.weight,
      sourceAssociationIds: [],
      components: { sourceAliasType: alias.type },
    });
  }

  for (const association of associationReview?.associations ?? []) {
    if (association.status !== "reviewed") continue;
    addCandidate(candidates, {
      value: association.regionTextSnapshot,
      aliasType: "ocr-associated",
      score: Math.max(0.55, association.score ?? 0.7),
      sourceAssociationIds: [association.id],
      components: { sourceField: association.sourceField, sourceValue: association.sourceValue },
    });
  }

  const compositeParts = [sourceItem.manufacturer, sourceItem.title, sourceItem.year ? String(sourceItem.year) : null].filter((value): value is string => Boolean(value));
  if (compositeParts.length >= 2) {
    addCandidate(candidates, {
      value: compositeParts.join(" "),
      aliasType: "composite",
      score: 0.9,
      sourceAssociationIds: [],
      components: { fields: ["manufacturer", "title", ...(sourceItem.year ? ["year"] : [])] },
    });
  }

  return candidates.sort((left, right) => right.score - left.score || left.value.localeCompare(right.value));
}

function addCandidate(candidates: AliasCandidate[], input: Omit<AliasCandidate, "candidateKey" | "normalizedValue">) {
  const normalizedValue = normalizeText(input.value);
  if (!normalizedValue) return;
  const existing = candidates.find((candidate) => candidate.normalizedValue === normalizedValue);
  if (existing) {
    existing.score = Math.max(existing.score, input.score);
    existing.sourceAssociationIds = [...new Set([...existing.sourceAssociationIds, ...input.sourceAssociationIds])];
    existing.components = { ...existing.components, ...input.components };
    return;
  }
  candidates.push({
    ...input,
    value: normalizedValue,
    normalizedValue,
    candidateKey: `${input.aliasType}:${normalizedValue}`,
  });
}
