import type { Alias, AliasSet, SourceItem } from "../../shared/types.js";

const NORMALIZATION_VERSION = "text-normalize-v1";
const ALIAS_GENERATOR_VERSION = "alias-generator-v1";
const SERVICE_WORDS = new Set([
  "вино",
  "виноградное",
  "алкоголь",
  "сухое",
  "полусухое",
  "полусладкое",
  "сладкое",
  "красное",
  "белое",
  "розовое",
  "россия",
  "год",
]);

export function normalizeText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(value: string) {
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

export function generateAliasSet(sourceItem: SourceItem): AliasSet {
  const aliases: Alias[] = [];

  addAlias(aliases, sourceItem.title, "normalized-title", 1);
  addAlias(aliases, withoutServiceWords(sourceItem.title), "title-without-service-words", 0.95);
  addAlias(aliases, sourceItem.manufacturer, "manufacturer", 0.85);
  addAlias(aliases, sourceItem.category, "category", 0.45);
  addAlias(aliases, sourceItem.region, "region", 0.4);
  addAlias(aliases, sourceItem.year ? String(sourceItem.year) : null, "year", 0.25);
  addAlias(aliases, sourceItem.barcode, "barcode", 1);

  return {
    schemaVersion: 1,
    generatorVersion: ALIAS_GENERATOR_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    aliases: dedupeAliases(aliases),
    generatedAt: new Date().toISOString(),
  };
}

export function normalizedTokensForAliasSet(aliasSet: AliasSet) {
  return Array.from(
    new Set(
      aliasSet.aliases
        .filter((alias) => alias.weight >= 0.4)
        .flatMap((alias) => tokenize(alias.value))
        .filter((token) => !SERVICE_WORDS.has(token)),
    ),
  );
}

function withoutServiceWords(value: string | null) {
  if (!value) return null;
  return tokenize(value)
    .filter((token) => !SERVICE_WORDS.has(token))
    .join(" ");
}

function addAlias(aliases: Alias[], value: string | null, type: Alias["type"], weight: number) {
  const normalized = value ? normalizeText(value) : "";
  if (!normalized) return;
  aliases.push({ value: normalized, type, weight });
}

function dedupeAliases(aliases: Alias[]) {
  const seen = new Set<string>();
  return aliases.filter((alias) => {
    const key = `${alias.type}:${alias.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
