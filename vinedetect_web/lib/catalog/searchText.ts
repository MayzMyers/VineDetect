const LAT_TO_CYR_CONFUSABLE: Record<string, string> = {
  a: "а",
  b: "в",
  e: "е",
  k: "к",
  m: "м",
  h: "н",
  o: "о",
  p: "р",
  c: "с",
  t: "т",
  x: "х",
  y: "у",
};

const CYR_TO_LAT_CONFUSABLE: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  х: "x",
  у: "y",
};

export function buildSearchText(parts: Array<string | number | undefined | null>) {
  const forms = new Set<string>();

  for (const part of parts) {
    if (part === undefined || part === null) continue;

    const text = String(part)
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;

    forms.add(text);
    forms.add(foldConfusables(text, LAT_TO_CYR_CONFUSABLE));
    forms.add(foldConfusables(text, CYR_TO_LAT_CONFUSABLE));

    for (const token of text.split(/\s+/)) {
      forms.add(token);
      forms.add(foldConfusables(token, LAT_TO_CYR_CONFUSABLE));
      forms.add(foldConfusables(token, CYR_TO_LAT_CONFUSABLE));
    }
  }

  return [...forms].filter((form) => form.length >= 2).join(" ");
}

function foldConfusables(input: string, map: Record<string, string>) {
  return [...input].map((char) => map[char] ?? char).join("");
}
