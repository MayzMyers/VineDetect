import type { SourceItem } from "./types.js";

export const OFFICIAL_CONTEST_VERSION = "lct-rshb-2026-09-15";
export type OfficialReference = {
  source: "svoe_vino";
  sourceItemId: string;
  catalogItemId: string;
  officialSlug: string;
  wineId: string;
  referenceAssetId: string;
  referencePath: string;
  referenceSha256: string;
  width: number;
  height: number;
  method: string;
  provenance: Record<string, unknown>;
};
export type OfficialTarget = OfficialReference & {
  annotationTrackId: string;
  packageId: string;
  annotationVersionId: string;
};
export function isManagedContestPath(value: string) {
  const match =
    /^contest\/lct-rshb-2026-09-15\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})\.(webp|png|jpg|jpeg)$/.exec(
      value,
    );
  return Boolean(match && match[2]!.startsWith(match[1]!));
}
export function assertReferenceMatches(
  expected: OfficialReference,
  actual: OfficialReference,
) {
  for (const key of [
    "source",
    "sourceItemId",
    "catalogItemId",
    "wineId",
    "referenceAssetId",
    "referencePath",
    "referenceSha256",
    "width",
    "height",
    "method",
  ] as const) {
    if (expected[key] !== actual[key])
      throw new Error(`Official reference changed: ${key}`);
  }
  if (
    !isManagedContestPath(actual.referencePath) ||
    !actual.referencePath.includes(`/${actual.referenceSha256}.`)
  )
    throw new Error("Invalid managed official reference");
}
export function sourceAssetRef(item: SourceItem): string | null {
  if (item.officialReference) {
    if (item.sourceAssetRef !== item.officialReference.referencePath)
      throw new Error(
        "Official source asset binding is missing or inconsistent",
      );
    return item.sourceAssetRef;
  }
  return item.sourceAssetRef ?? item.imageUrls[0] ?? null;
}
