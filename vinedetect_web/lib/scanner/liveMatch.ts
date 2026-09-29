const STOP_WORDS = new Set([
  "wine",
  "вино",
  "винный",
  "виноград",
  "белое",
  "красное",
  "сухое",
  "полусухое",
  "полусладкое",
  "брют",
  "алкоголь",
  "объем",
  "россия",
  "russia",
  "product",
  "contains",
]);

export function extractOcrKeywords(text: string, limit = 6): string[] {
  const tokens = text
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .match(/[\p{L}\p{N}]+/gu) ?? [];

  const unique = new Set<string>();

  for (const token of tokens) {
    if (token.length < 3 || STOP_WORDS.has(token) || /^\d{1,3}$/.test(token)) continue;
    unique.add(token);
  }

  return [...unique]
    .sort((left, right) => scoreKeyword(right) - scoreKeyword(left))
    .slice(0, limit);
}

export function normalizeMatchText(text: string) {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function scoreKeyword(token: string) {
  return Math.min(token.length, 14);
}
