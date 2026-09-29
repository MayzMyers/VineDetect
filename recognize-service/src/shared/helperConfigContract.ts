export type HelperConfigRecord = {
  helperId: string;
  algorithm: string;
  configSchemaVersion: number;
  config: Record<string, unknown>;
  role: "conditioning-input";
  provenance: Record<string, unknown>;
  review: Record<string, unknown>;
};

export type HelperConfigContract = {
  schemaVersion: 1;
  records: HelperConfigRecord[];
};

export type WizardStageId = "package" | "label" | "bottle" | "ocr" | "mask" | "morphology" | "components" | "elements" | "contours" | "palette" | "summary";

export type WizardHelperBinding = HelperConfigRecord & {
  card: { source: string; sourceItemId: string };
  wizardStage: WizardStageId;
  persisted: boolean;
};

const HELPER_DEFINITIONS: Record<string, { wizardStage: WizardStageId; algorithm: string; targetRef: string; defaultConfig: Record<string, unknown> }> = {
  "package-scope": { wizardStage: "package", algorithm: "package-smart-lasso-v1", targetRef: "Package.scope", defaultConfig: { schemaVersion: 1, defaultScope: "full-image", coordinateSpace: "source-image", geometry: "quad", processingMode: "preview", previewMaxSize: 420, paddingPercent: 8, silhouetteThreshold: 18, connectivity: 4, simplifyTolerance: 2 } },
  "label-roi-detection": { wizardStage: "label", algorithm: "label-multi-family-consensus-v7", targetRef: "label", defaultConfig: { schemaVersion: 1, previewMaxSide: 720, chromaTolerance: 24, minimumLightness: 105, minRegionWidthRatio: .42, maxRegionWidthRatio: .985, rowGapRatio: .09, minimumBandCoverage: .48, envelopeCoverage: .65, envelopeSizeMultiplier: 1.45 } },
  "bottle-outline": { wizardStage: "bottle", algorithm: "bottle-border-flood-v2", targetRef: "vision.annotations.bottle", defaultConfig: { processingMode: "preview", previewMaxSize: 420, paddingPercent: 8, silhouetteThreshold: 18, connectivity: 4, simplifyTolerance: 2, canny: { blurKernel: 3, low: 40, high: 100 }, morphology: { closeKernel: 5, iterations: 1 } } },
  "label-ocr-cascade": { wizardStage: "ocr", algorithm: "tesseract-cascade-v6", targetRef: "ocrRegions", defaultConfig: { schemaVersion: 1, profileVersion: "tesseract-cascade-v6", engine: "tesseract.js", languages: ["rus", "eng"], adaptiveStop: true, geometryHelpers: ["deskew", "perspective", "rotate-cw", "rotate-ccw"] } },
  "label-rectification": { wizardStage: "ocr", algorithm: "cv-label-rectification-v1", targetRef: "Label.rectification", defaultConfig: { schemaVersion: 1, previewMaxSide: 640, minConfidence: .42, minRetainedArea: .55, maxCornerDisplacement: .35, minCylindricalConfidence: .48, minCylindricalCurvature: .006, maxCylindricalCurvature: .12, detectPerspective: true, detectCylindrical: true } },
  "label-mask": { wizardStage: "mask", algorithm: "binary-mask-variant-search-v1", targetRef: "vision.cvMeta.mask", defaultConfig: { threshold: 170, invert: false, maskSize: 192, maskMode: "auto" } },
  "label-morphology": { wizardStage: "morphology", algorithm: "label-morphology-v1", targetRef: "vision.cvMeta.morphology", defaultConfig: { morphologyEnabled: true, morphologyOperation: "close", morphologyKernelWidth: 3, morphologyKernelHeight: 3, morphologyIterations: 1, morphologyMode: "auto" } },
  "label-components": { wizardStage: "components", algorithm: "connected-components-v2", targetRef: "vision.annotations.componentDecisions", defaultConfig: { componentFilterPreset: "normal", componentMode: "auto", componentConnectivity: 4, minComponentAreaRatio: .0005, maxComponentAreaRatio: .7 } },
  "label-elements": { wizardStage: "elements", algorithm: "element-grouping-v1", targetRef: "vision.annotations.elements", defaultConfig: { groupingPrimary: "ocr-overlap", groupingFallback: "proximity-alignment" } },
  "label-contours": { wizardStage: "contours", algorithm: "component-contours-v2", targetRef: "vision.annotations.contours", defaultConfig: { maxContourPoints: 256, contourDetail: "balanced", contourSimplifyRatio: .005, contourVectorization: "bezier" } },
  "label-palette": { wizardStage: "palette", algorithm: "label-palette-v1", targetRef: "vision.annotations.palette", defaultConfig: { paletteColors: 8, paletteMinRatio: .01 } },
  "label-summary": { wizardStage: "summary", algorithm: "label-summary-v1", targetRef: "summary", defaultConfig: { sourceMatching: "tokenized-catalog-v1", verifiedOcrOnly: true } },
};

export function helperIdForWizardStage(stage: unknown): string {
  return typeof stage === "string" && ["mask", "morphology", "components", "elements", "contours", "palette"].includes(stage)
    ? `label-${stage}`
    : "label-summary";
}

export function bindHelperToCard(contract: HelperConfigContract, source: string, sourceItemId: string, helperId: string, persistedOverride?: boolean): WizardHelperBinding {
  const definition = HELPER_DEFINITIONS[helperId] ?? HELPER_DEFINITIONS["label-summary"]!;
  const saved = contract.records.find((record) => record.helperId === helperId);
  const fallback: HelperConfigRecord = {
    helperId,
    algorithm: definition.algorithm,
    configSchemaVersion: 1,
    config: definition.defaultConfig,
    role: "conditioning-input",
    provenance: { source: "default-config", runId: null, savedAt: null, modelVersionId: null },
    review: { status: "unreviewed", targetRef: definition.targetRef },
  };
  return {
    ...(saved ?? fallback),
    card: { source, sourceItemId },
    wizardStage: definition.wizardStage,
    persisted: persistedOverride ?? Boolean(saved),
  };
}

export function bindAllHelpersToCard(contract: HelperConfigContract, source: string, sourceItemId: string): WizardHelperBinding[] {
  return Object.keys(HELPER_DEFINITIONS).map((helperId) => bindHelperToCard(contract, source, sourceItemId, helperId));
}

export function buildHelperConfigContract(visualFeaturesValue: unknown, ocrEvidenceValue?: unknown, ocrRunIdValue?: unknown, labelPredictionValue?: unknown): HelperConfigContract {
  const visualFeatures = objectValue(visualFeaturesValue) ?? {};
  const sourceAnalysis = objectValue(visualFeatures.labelSourceAnalysis) ?? {};
  const bottleDetection = objectValue(sourceAnalysis.bottleDetection) ?? {};
  const cvJob = objectValue(visualFeatures.labelCvJob) ?? {};
  const ocrEvidence = objectValue(ocrEvidenceValue);
  const records: HelperConfigRecord[] = [];

  const labelPrediction = objectValue(labelPredictionValue);
  const predictionAlgorithm = objectValue(labelPrediction?.algorithm);
  const predictionParams = objectValue(predictionAlgorithm?.params);
  if (labelPrediction && predictionAlgorithm && predictionParams) records.push(record({
    helperId: "label-roi-detection",
    algorithm: stringValue(predictionAlgorithm.id) ?? "unknown",
    config: {
      params: predictionParams,
      defaultParams: objectValue(predictionAlgorithm.defaultParams),
      algorithmVersion: stringValue(predictionAlgorithm.version),
    },
    runId: stringValue(labelPrediction.id),
    savedAt: stringValue(labelPrediction.createdAt),
    status: stringValue(labelPrediction.reviewStatus) ?? "reviewed",
    targetRef: "label",
  }));

  const labelDetection = objectValue(sourceAnalysis.winningDetection);
  const labelDetectionConfig = objectValue(labelDetection?.config);
  if (!predictionParams && labelDetectionConfig) records.push(record({
    helperId: "label-roi-detection",
    algorithm: stringValue(sourceAnalysis.algorithm) ?? "unknown",
    config: labelDetectionConfig,
    runId: stringValue(sourceAnalysis.runId),
    savedAt: stringValue(sourceAnalysis.savedAt),
    status: "reviewed",
    targetRef: "label",
  }));

  const bottleConfig = objectValue(bottleDetection.config);
  if (bottleConfig) records.push(record({
    helperId: "bottle-outline",
    algorithm: stringValue(bottleDetection.algorithm) ?? "unknown",
    config: bottleConfig,
    runId: stringValue(sourceAnalysis.runId),
    savedAt: stringValue(sourceAnalysis.savedAt),
    status: stringValue(objectValue(bottleDetection.annotation)?.status) ?? "unreviewed",
    targetRef: "vision.annotations.bottle",
  }));

  if (ocrEvidence) records.push(record({
    helperId: "label-ocr-cascade",
    algorithm: stringValue(ocrEvidence.profileVersion) ?? "ocr-cascade-unknown",
    config: {
      profileVersion: stringValue(ocrEvidence.profileVersion),
      passes: arrayValue(ocrEvidence.passes).map((value) => {
        const pass = objectValue(value) ?? {};
        return pickConfig(pass, ["id", "stage", "region", "preprocess", "psm", "minWidth", "weight", "deskewAngleDegrees", "rotationDegrees"]);
      }),
    },
    runId: stringValue(ocrRunIdValue),
    savedAt: null,
    status: "reviewed",
    targetRef: "ocrRegions",
  }));

  const cvConfig = objectValue(cvJob.config);
  if (cvConfig) records.push(...labelCvHelperRecords(cvJob, cvConfig));
  return { schemaVersion: 1, records };
}

function labelCvHelperRecords(cvJob: Record<string, unknown>, config: Record<string, unknown>): HelperConfigRecord[] {
  const common = (helperId: string, algorithm: string, stageConfig: Record<string, unknown>, targetRef: string, stage?: string) => record({
    helperId,
    algorithm,
    config: stageConfig,
    runId: stringValue(cvJob.analysisJobId),
    savedAt: stringValue(cvJob.reviewedAt),
    status: stage ? checkpointStatus(cvJob, stage) : objectValue(cvJob.review) ? "reviewed" : "unreviewed",
    targetRef,
  });
  return [
    common("label-mask", "binary-mask-variant-search-v1", pickConfig(config, ["threshold", "invert", "maskSize", "maskMode"]), "vision.cvMeta.mask", "mask"),
    common("label-morphology", "label-morphology-v1", pickConfig(config, ["morphologyEnabled", "morphologyOperation", "morphologyKernelWidth", "morphologyKernelHeight", "morphologyIterations", "morphologyMode", "morphologyPipeline"]), "vision.cvMeta.morphology", "morphology"),
    common("label-components", "connected-components-v2", pickConfig(config, ["componentFilterPreset", "componentMode", "componentConnectivity", "minComponentAreaRatio", "maxComponentAreaRatio"]), "vision.annotations.componentDecisions", "components"),
    common("label-elements", "element-grouping-v1", { groupingPrimary: "ocr-overlap", groupingFallback: "proximity-alignment" }, "vision.annotations.elements", "elements"),
    common("label-contours", "component-contours-v2", pickConfig(config, ["maxContourPoints", "contourDetail", "contourSimplifyRatio", "contourVectorization"]), "vision.annotations.contours", "contours"),
    common("label-palette", "label-palette-v1", pickConfig(config, ["paletteColors", "paletteMinRatio"]), "vision.annotations.palette", "palette"),
    common("label-summary", "label-summary-v1", { sourceMatching: "tokenized-catalog-v1", verifiedOcrOnly: true }, "summary"),
  ];
}

function record(input: { helperId: string; algorithm: string; config: Record<string, unknown>; runId: string | null; savedAt: string | null; status: string; targetRef: string }): HelperConfigRecord {
  return {
    helperId: input.helperId,
    algorithm: input.algorithm,
    configSchemaVersion: 1,
    config: input.config,
    role: "conditioning-input",
    provenance: { source: "reviewed-run", runId: input.runId, savedAt: input.savedAt, modelVersionId: null },
    review: { status: input.status, targetRef: input.targetRef },
  };
}

function checkpointStatus(cvJob: Record<string, unknown>, stage: string) {
  return stringValue(objectValue(objectValue(objectValue(cvJob.workflow)?.checkpoints)?.[stage])?.status) ?? "unreviewed";
}

function pickConfig(source: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
