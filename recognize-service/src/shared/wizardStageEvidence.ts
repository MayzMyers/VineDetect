export function ocrStageInput(snapshotValue: unknown) {
  const snapshot = objectValue(snapshotValue);
  const crop = objectValue(snapshot.crop);
  return {
    cropId: crop.id ?? null,
    bbox: crop.bbox ?? null,
    geometry: crop.geometry ?? null,
    width: crop.width ?? null,
    height: crop.height ?? null,
    assetPath: crop.assetPath ?? null,
  };
}

export function ocrStageParams(snapshotValue: unknown) {
  const snapshot = objectValue(snapshotValue);
  const ocr = objectValue(snapshot.ocr);
  const evidence = objectValue(ocr.evidence);
  return {
    profileVersion: evidence.profileVersion ?? ocr.executionMode ?? null,
    engine: ocr.engine ?? null,
    engineVersion: ocr.engineVersion ?? null,
    passes: arrayValue(evidence.passes).map((value) => {
      const pass = objectValue(value);
      return pick(pass, ["id", "stage", "region", "preprocess", "psm", "minWidth", "weight", "deskewAngleDegrees", "rotationDegrees"]);
    }),
  };
}

export function ocrStageAutoOutput(snapshotValue: unknown) {
  const snapshot = objectValue(snapshotValue);
  const ocr = objectValue(snapshot.ocr);
  return {
    ocrRunId: ocr.id ?? null,
    rawText: ocr.rawText ?? null,
    normalizedText: ocr.normalizedText ?? null,
    confidence: ocr.confidence ?? null,
    status: ocr.status ?? null,
    regions: arrayValue(snapshot.regions),
  };
}

export function ocrIntermediateStates(snapshotValue: unknown) {
  const snapshot = objectValue(snapshotValue);
  const evidence = objectValue(objectValue(snapshot.ocr).evidence);
  const passes = arrayValue(evidence.passes).slice(0, 30).map(objectValue);
  const profileVersion = String(evidence.profileVersion ?? "ocr-cascade-unknown");
  return [
    { id: "ocr.cascade", parentId: null, sequence: 0, status: "completed" as const, algorithm: profileVersion, summary: { completedStage: evidence.completedStage ?? null, stopReason: evidence.stopReason ?? null } },
    ...passes.map((pass, index) => ({
      id: `ocr.pass.${index + 1}`, parentId: "ocr.cascade", sequence: index + 1, status: "completed" as const,
      algorithm: String(pass.id ?? `pass-${index + 1}`),
      summary: pick(pass, ["stage", "region", "preprocess", "confidence", "runtimeMs", "observationCount", "validObservationCount"]),
    })),
    { id: "ocr.consensus", parentId: "ocr.cascade", sequence: passes.length + 1, status: "completed" as const, algorithm: "ocr-consensus-v1", summary: objectValue(evidence.quality) },
  ];
}

export function ocrStageReviewedOutput(snapshotValue: unknown, reviewValue: unknown) {
  const autoOutput = ocrStageAutoOutput(snapshotValue);
  const review = objectValue(reviewValue);
  return {
    ...autoOutput,
    reviewId: review.id ?? null,
    reviewRevision: review.revision ?? null,
    reviewStatus: review.status ?? null,
    regions: arrayValue(review.regions),
    compositions: arrayValue(review.compositions),
    reviewOperations: arrayValue(review.reviewOperations),
  };
}

export function summaryStageInput(value: unknown) {
  const context = objectValue(value);
  return pick(context, ["labelAnnotationId", "labelRevision", "analysisJobId", "ocrRegionAnnotationSetId", "cvWorkflowUpdatedAt"]);
}

export function summaryStageParams() {
  return { sourceMatching: "tokenized-catalog-v1", verifiedOcrOnly: true };
}

export function summaryStageOutput(summaryValue: unknown) {
  const summary = objectValue(summaryValue);
  const { computedAt: _computedAt, ...stableSummary } = summary;
  return stableSummary;
}

export function ocrAlgorithm(snapshotValue: unknown) {
  const snapshot = objectValue(snapshotValue);
  const ocr = objectValue(snapshot.ocr);
  const evidence = objectValue(ocr.evidence);
  return {
    id: String(evidence.profileVersion ?? ocr.executionMode ?? "ocr-cascade-unknown"),
    version: typeof ocr.engineVersion === "string" ? ocr.engineVersion : null,
  };
}

function pick(source: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
