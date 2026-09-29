export function normalizeOcrText(input: string) {
  const normalized = input
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  return applyCommonOcrFixes(normalized);
}

function applyCommonOcrFixes(text: string) {
  const fixes: Array<[RegExp, string]> = [
    [/fanag0ria/g, "fanagoria"],
    [/cabemet/g, "cabernet"],
    [/kaberne/g, "cabernet"],
    [/saperav1/g, "saperavi"],
    [/2o2([0-9])/g, "202$1"],
    [/202!/g, "2021"],
    [/abrau durso/g, "abrau-durso"],
  ];

  return fixes.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}
