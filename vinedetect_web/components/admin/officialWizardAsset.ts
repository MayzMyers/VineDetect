export function officialWizardAsset(
  packageAsset: string | null | undefined,
  trackAsset: string | null | undefined,
  historical: string | undefined,
): string | null {
  if (
    packageAsset?.startsWith("contest/") ||
    trackAsset?.startsWith("contest/")
  )
    return packageAsset && packageAsset === trackAsset ? packageAsset : null;
  return packageAsset ?? trackAsset ?? historical ?? null;
}

export function officialWizardVersionEditable(
  version: {
    id: string;
    status: string;
    origin: string;
    annotationTrackId: string | null;
  } | null,
  activeVersionId: string | null,
  trackId: string | null,
  trackAsset: string | null | undefined,
) {
  if (!version || !["draft", "review_required"].includes(version.status))
    return false;
  if (trackAsset?.startsWith("contest/"))
    return (
      version.origin === "contest-official" &&
      version.annotationTrackId === trackId
    );
  return version.id === activeVersionId;
}
