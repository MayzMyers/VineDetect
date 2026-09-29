import type {
  LabelAnalysisResult,
  LabelAnnotationOcrRegionReview,
  LabelAnnotationOcrSnapshot,
  LabelElement,
  LabelAnalysisCvConfig,
  LabelCvJob,
  LabelCvReviewState,
  LabelCvStage,
  LabelPaletteColor,
} from "../../lib/admin/api";

export function moveComponentBetweenElementGroups(
  elements: LabelElement[],
  componentId: number,
  destination: "ungrouped" | "new" | string,
  newGroupId?: string,
): LabelElement[] {
  const source = elements.find((element) => element.sourceComponentIds.includes(componentId));
  let next = elements.flatMap((element) => {
    if (element.id !== source?.id) return [element];
    const sourceComponentIds = element.sourceComponentIds.filter((id) => id !== componentId);
    return sourceComponentIds.length ? [{ ...element, sourceComponentIds }] : [];
  });
  if (destination === "new") {
    if (!newGroupId) throw new Error("newGroupId is required for a new element group");
    next = [...next, {
      id: newGroupId,
      bbox: source?.bbox ?? { x: 0, y: 0, width: 0, height: 0 },
      sourceComponentIds: [componentId],
      type: "unknown",
      status: "unreviewed",
      source: "modified",
      provenance: { source: "manual", grouping: { method: "manual" } },
    }];
  } else if (destination !== "ungrouped") {
    next = next.map((element) => element.id === destination && !element.sourceComponentIds.includes(componentId)
      ? { ...element, sourceComponentIds: [...element.sourceComponentIds, componentId], provenance: { source: "manual", grouping: { method: "manual" } }, groupingMeta: undefined }
      : element);
  }
  return next;
}

export function effectiveOcrOverlayRegions(
  analysis: LabelAnalysisResult | null,
  review: LabelAnnotationOcrRegionReview | null | undefined,
): LabelAnnotationOcrSnapshot["regions"] {
  if (review && Array.isArray(review.regions)) {
    return review.regions
      .filter((region) => region.status === "reviewed")
      .map((region) => ({
        id: region.id,
        parentId: null,
        level: region.level,
        bbox: region.bbox,
        geometry: region.geometry,
        rawText: region.text ?? "",
        normalizedText: region.normalizedText ?? "",
        confidence: null,
        reviewStatus: region.status,
        textDirection: region.textDirection ?? "right",
        glyphOrientation: region.glyphOrientation ?? "upright",
        createdAt: review.createdAt,
      }));
  }

  return (analysis?.textRegions ?? []).map((region) => ({
    ...region,
    textDirection: region.textDirection ?? "right",
    glyphOrientation: region.glyphOrientation ?? "upright",
    reviewStatus: "generated",
    createdAt: "",
  }));
}

export type WizardStepStatus = "saved" | "modified" | "stale" | "missing";
export type ApprovedCvSnapshot = {
  config: LabelAnalysisCvConfig;
  review: LabelCvReviewState;
  palette: LabelPaletteColor[];
};

export const CV_STAGES: LabelCvStage[] = ["mask", "morphology", "components", "elements", "contours", "palette"];

export function cvPreviewFingerprint(config: LabelAnalysisCvConfig, review: LabelCvReviewState) {
  return JSON.stringify({ config, review });
}

export function mergeCvPreviewJob(current: LabelCvJob | null, preview: LabelCvJob): LabelCvJob {
  if (!current?.workflow) return preview;
  return {
    ...current,
    previewStage: preview.previewStage,
    preview: preview.preview,
    updatedAt: preview.updatedAt,
  };
}

export function getCvStageStatuses(
  checkpoints: NonNullable<LabelCvJob["workflow"]>["checkpoints"] | undefined,
  approved: ApprovedCvSnapshot | null,
  config: LabelAnalysisCvConfig,
  review: LabelCvReviewState,
  palette: LabelPaletteColor[],
): Record<LabelCvStage, WizardStepStatus> {
  const result = {} as Record<LabelCvStage, WizardStepStatus>;
  for (const stage of CV_STAGES) {
    const checkpoint = checkpoints?.[stage];
    if (!checkpoint || !approved) {
      result[stage] = "missing";
      continue;
    }
    if (checkpoint.status === "stale") {
      result[stage] = "stale";
      continue;
    }
    if (!sameStageInput(stage, approved.config, approved.review, approved.palette, config, review, palette)) {
      result[stage] = "modified";
      continue;
    }
    const staleDependency = cvStageDependencies(stage).some((dependency) =>
      !sameStageInput(dependency, approved.config, approved.review, approved.palette, config, review, palette));
    result[stage] = staleDependency ? "stale" : "saved";
  }
  return result;
}

export function cvStageDependencies(stage: LabelCvStage): LabelCvStage[] {
  if (stage === "palette" || stage === "mask") return [];
  return (["mask", "morphology", "components", "elements"] as LabelCvStage[])
    .slice(0, { morphology: 1, components: 2, elements: 3, contours: 4 }[stage]);
}

export function getLocalCvStageWarning(stage: LabelCvStage, statuses: Record<LabelCvStage, WizardStepStatus>) {
  if (statuses[stage] === "modified") return `${formatCvStage(stage)} has local changes that are not approved in item Meta.`;
  if (statuses[stage] === "stale") return `${formatCvStage(stage)} depends on changed or stale upstream data and must be recalculated.`;
  if (statuses[stage] === "missing") return `${formatCvStage(stage)} has no approved checkpoint in item Meta.`;
  const prerequisite = cvStageDependencies(stage).find((item) => statuses[item] !== "saved");
  return prerequisite ? `${formatCvStage(prerequisite)} is ${statuses[prerequisite]}; ${formatCvStage(stage)} cannot be considered current.` : null;
}

export function getLocalCvCompletionWarning(statuses: Record<LabelCvStage, WizardStepStatus>) {
  const incomplete = CV_STAGES.find((stage) => statuses[stage] !== "saved");
  return incomplete ? `${formatCvStage(incomplete)} is ${statuses[incomplete]}. Summary contains an incomplete CV sequence.` : null;
}

export function nextResumeStep(
  lastCompletedStage: LabelCvStage,
  checkpoints: Partial<Record<LabelCvStage, { status: "valid" | "stale" }>>,
): LabelCvStage | "summary" {
  const firstIncomplete = CV_STAGES.find((stage) => checkpoints[stage]?.status !== "valid");
  if (firstIncomplete) return firstIncomplete;
  return lastCompletedStage === "palette" ? "summary" : CV_STAGES[CV_STAGES.indexOf(lastCompletedStage) + 1] ?? "summary";
}

export function initialCvResumeStep(
  currentStep: string,
  lastCompletedStage: LabelCvStage,
  checkpoints: Partial<Record<LabelCvStage, { status: "valid" | "stale" }>>,
): LabelCvStage | "summary" | null {
  return currentStep === "package" ? nextResumeStep(lastCompletedStage, checkpoints) : null;
}

export function getCoreWizardStepStatuses(input: {
  labelSaved: boolean;
  labelDirty: boolean;
  hasBottleDetection: boolean;
  hasBottleAnnotation: boolean;
  bottleSnapshotMatches: boolean;
  ocrDirty: boolean;
  hasOcrReview: boolean;
  hasAnalysis: boolean;
  cvStatuses: Record<LabelCvStage, WizardStepStatus>;
  analysisReviewCurrent: boolean;
  summaryReviewDirty: boolean;
}) {
  const label: WizardStepStatus = input.labelSaved ? "saved" : input.labelDirty ? "modified" : "missing";
  const bottle: WizardStepStatus = !input.hasBottleDetection
    ? "missing"
    : !input.hasBottleAnnotation || !input.bottleSnapshotMatches
      ? "modified"
      : "saved";
  const ocr: WizardStepStatus = input.ocrDirty ? "modified" : input.hasOcrReview ? "saved" : input.hasAnalysis ? "modified" : "missing";
  const inputsSaved = label === "saved"
    && bottle === "saved"
    && ocr === "saved"
    && CV_STAGES.every((stage) => input.cvStatuses[stage] === "saved");
  const summary: WizardStepStatus = !input.hasAnalysis
    ? "missing"
    : !inputsSaved
      ? "stale"
      : input.analysisReviewCurrent && !input.summaryReviewDirty
        ? "saved"
        : "modified";
  return { label, bottle, ocr, summary };
}

function sameStageInput(
  stage: LabelCvStage,
  savedConfig: LabelAnalysisCvConfig,
  savedReview: LabelCvReviewState,
  savedPalette: LabelPaletteColor[],
  config: LabelAnalysisCvConfig,
  review: LabelCvReviewState,
  palette: LabelPaletteColor[],
) {
  return JSON.stringify(cvStageOwnInput(stage, savedConfig, savedReview, savedPalette))
    === JSON.stringify(cvStageOwnInput(stage, config, review, palette));
}

function cvStageOwnInput(stage: LabelCvStage, config: LabelAnalysisCvConfig, review: LabelCvReviewState, palette: LabelPaletteColor[]) {
  if (stage === "mask") return { threshold: config.threshold, invert: config.invert, maskSize: config.maskSize };
  if (stage === "morphology") return { enabled: config.morphologyEnabled, operation: config.morphologyOperation, kernelWidth: config.morphologyKernelWidth, kernelHeight: config.morphologyKernelHeight, iterations: config.morphologyIterations, mode: config.morphologyMode };
  if (stage === "components") return { preset: config.componentFilterPreset, mode: config.componentMode, connectivity: config.componentConnectivity, minArea: config.minComponentAreaRatio, maxArea: config.maxComponentAreaRatio, decisions: review.componentDecisions };
  if (stage === "elements") return { elementsReviewed: review.elementsReviewed === true, elements: review.elements };
  if (stage === "contours") return { elementsReviewed: review.elementsReviewed === true, maxPoints: config.maxContourPoints, detail: config.contourDetail, simplifyRatio: config.contourSimplifyRatio, vectorization: config.contourVectorization };
  return { colors: config.paletteColors, minRatio: config.paletteMinRatio, palette };
}

function formatCvStage(stage: LabelCvStage) {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}
