type AnnotationVersionRef = {
  id: string;
  annotationTrackId?: string | null;
};

export function selectDisplayedAnnotationVersionId(
  versions: AnnotationVersionRef[],
  activeVersionId: string | null,
  options: { preferredVersionId?: string | null; officialTrackId?: string | null } = {},
) {
  const preferred = options.preferredVersionId;
  if (preferred && versions.some((version) => version.id === preferred)) return preferred;

  const officialTrackId = options.officialTrackId;
  if (officialTrackId) {
    const officialVersion = versions.find((version) => version.annotationTrackId === officialTrackId);
    if (officialVersion) return officialVersion.id;
  }

  if (activeVersionId && versions.some((version) => version.id === activeVersionId)) return activeVersionId;
  return versions[0]?.id ?? null;
}
