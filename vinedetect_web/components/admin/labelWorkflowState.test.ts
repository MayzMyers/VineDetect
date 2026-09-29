import assert from "node:assert/strict";
import test from "node:test";
import type { LabelAnalysisCvConfig, LabelCvJob, LabelCvReviewState, LabelPaletteColor } from "../../lib/admin/api.ts";
import {
  CV_STAGES,
  cvPreviewFingerprint,
  effectiveOcrOverlayRegions,
  getCoreWizardStepStatuses,
  getCvStageStatuses,
  initialCvResumeStep,
  mergeCvPreviewJob,
  moveComponentBetweenElementGroups,
  nextResumeStep,
  type ApprovedCvSnapshot,
  type WizardStepStatus,
} from "./labelWorkflowState.ts";

test("moving a component to a new element preserves a valid hierarchy", () => {
  const groups = [{
    id: "group-1", bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, sourceComponentIds: [10, 11],
    type: "text", status: "unreviewed", source: "auto", provenance: { source: "ocr", grouping: { method: "ocr-overlap" } },
  }] as import("../../lib/admin/api.ts").LabelElement[];
  const next = moveComponentBetweenElementGroups(groups, 10, "new", "group-new");

  assert.deepEqual(next.map((group) => [group.id, group.sourceComponentIds]), [["group-1", [11]], ["group-new", [10]]]);
  assert.equal(next[1]?.type, "unknown");
  assert.equal(next[1]?.provenance?.source, "manual");
});

test("downstream overlays prefer saved reviewed OCR geometry", () => {
  const analysis = {
    textRegions: [{
      id: "generated-1", parentId: null, level: "word",
      bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
      rawText: "old", normalizedText: "old", confidence: 0.8,
      textDirection: "right", glyphOrientation: "upright",
    }],
  } as unknown as import("../../lib/admin/api.ts").LabelAnalysisResult;
  const review = {
    id: "review-1", source: "wine", sourceItemId: "1", ocrRunId: "run-1",
    revision: 2, status: "reviewed", reviewedBy: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    regions: [
      { id: "edited-1", sourceRegionIds: ["generated-1"], level: "word", bbox: { x: 0.35, y: 0.4, width: 0.25, height: 0.12 }, text: "edited", normalizedText: "edited", status: "reviewed", sourceKind: "corrected-generated", textDirection: "right", glyphOrientation: "upright", sortOrder: 0 },
      { id: "rejected-1", sourceRegionIds: [], level: "word", bbox: { x: 0.7, y: 0.7, width: 0.1, height: 0.1 }, text: "removed", normalizedText: "removed", status: "rejected", sourceKind: "manual", textDirection: "right", glyphOrientation: "upright", sortOrder: 1 },
    ],
  } as import("../../lib/admin/api.ts").LabelAnnotationOcrRegionReview;

  const regions = effectiveOcrOverlayRegions(analysis, review);
  assert.equal(regions.length, 1);
  assert.equal(regions[0]?.id, "edited-1");
  assert.deepEqual(regions[0]?.bbox, review.regions[0]?.bbox);
  assert.equal(regions[0]?.rawText, "edited");
});

test("missing OCR review payload does not crash overlay hydration", () => {
  assert.deepEqual(effectiveOcrOverlayRegions(null, {} as never), []);
});

const config: LabelAnalysisCvConfig = {
  schemaVersion: 3,
    threshold: 170,
    invert: false,
    maskSize: 192,
    maskMode: "auto",
  morphologyEnabled: true,
  morphologyOperation: "close",
  morphologyKernelWidth: 3,
  morphologyKernelHeight: 3,
  morphologyIterations: 1,
  morphologyMode: "auto",
  componentFilterPreset: "normal",
  componentMode: "auto",
  componentConnectivity: 4,
  minComponentAreaRatio: 0.0005,
  maxComponentAreaRatio: 0.7,
  maxContourPoints: 256,
  contourDetail: "balanced",
  contourSimplifyRatio: 0.005,
  contourVectorization: "bezier",
  paletteColors: 6,
  paletteMinRatio: 0.01,
};
const review: LabelCvReviewState = { componentDecisions: {}, elements: [] };
const palette: LabelPaletteColor[] = [{ rgb: [20, 30, 40], ratio: 1, source: "detected" }];
const approved: ApprovedCvSnapshot = { config, review, palette };
const checkpoints = Object.fromEntries(CV_STAGES.map((stage) => [stage, {
  status: "valid" as const,
  completedAt: "2026-08-21T00:00:00.000Z",
  inputSignature: stage,
}])) as NonNullable<LabelCvJob["workflow"]>["checkpoints"];

test("saved checkpoints remain saved after refresh hydration", () => {
  const statuses = getCvStageStatuses(checkpoints, approved, config, review, palette);
  assert.deepEqual(statuses, allCvStatuses("saved"));
  assert.equal(nextResumeStep("palette", checkpoints), "summary");
});

test("late preview cannot replace persisted config or workflow", () => {
  const persisted = cvJob({ config, threshold: config.threshold, previewStage: "mask" });
  const preview = cvJob({ config: { ...config, threshold: 220 }, threshold: 220, previewStage: "morphology", workflow: undefined });
  const merged = mergeCvPreviewJob(persisted, preview);
  assert.equal(merged.config.threshold, 170);
  assert.equal(merged.workflow, persisted.workflow);
  assert.equal(merged.previewStage, "morphology");
  assert.equal(merged.preview?.stageMetrics?.threshold, 220);
});

test("preview fingerprint changes only when config or review changes", () => {
  const fingerprint = cvPreviewFingerprint(config, review);
  assert.equal(cvPreviewFingerprint(config, review), fingerprint);
  assert.notEqual(cvPreviewFingerprint({ ...config, threshold: 100 }, review), fingerprint);
  assert.notEqual(cvPreviewFingerprint(config, { ...review, componentDecisions: { "1": "accepted" } }), fingerprint);
});

test("changing mask invalidates its dependent stages but not palette", () => {
  const statuses = getCvStageStatuses(checkpoints, approved, { ...config, threshold: 171 }, review, palette);
  assert.equal(statuses.mask, "modified");
  assert.equal(statuses.morphology, "stale");
  assert.equal(statuses.components, "stale");
  assert.equal(statuses.elements, "stale");
  assert.equal(statuses.contours, "stale");
  assert.equal(statuses.palette, "saved");
});

test("component review changes invalidate elements and contours only", () => {
  const changedReview: LabelCvReviewState = { ...review, componentDecisions: { "7": "rejected" } };
  const statuses = getCvStageStatuses(checkpoints, approved, config, changedReview, palette);
  assert.equal(statuses.mask, "saved");
  assert.equal(statuses.morphology, "saved");
  assert.equal(statuses.components, "modified");
  assert.equal(statuses.elements, "stale");
  assert.equal(statuses.contours, "stale");
  assert.equal(statuses.palette, "saved");
});

test("server-stale and missing checkpoints take precedence", () => {
  const partial = {
    ...checkpoints,
    morphology: { ...checkpoints.morphology!, status: "stale" as const },
    elements: undefined,
  };
  const statuses = getCvStageStatuses(partial, approved, config, review, palette);
  assert.equal(statuses.morphology, "stale");
  assert.equal(statuses.elements, "missing");
  assert.equal(nextResumeStep("components", partial), "morphology");
});

test("late CV workflow hydration resumes only on the initial package screen", () => {
  const partial = { ...checkpoints, mask: { ...checkpoints.mask!, status: "valid" as const }, morphology: undefined };
  assert.equal(initialCvResumeStep("package", "mask", partial), "morphology");
  assert.equal(initialCvResumeStep("mask", "mask", partial), null);
  assert.equal(initialCvResumeStep("morphology", "mask", partial), null);
});

test("OCR and Bottle drafts keep Summary stale until explicitly persisted", () => {
  const cvStatuses = allCvStatuses("saved");
  const bottleDraft = getCoreWizardStepStatuses({
    labelSaved: true,
    labelDirty: false,
    hasBottleDetection: true,
    hasBottleAnnotation: true,
    bottleSnapshotMatches: false,
    ocrDirty: false,
    hasOcrReview: true,
    hasAnalysis: true,
    cvStatuses,
    analysisReviewCurrent: true,
    summaryReviewDirty: false,
  });
  assert.equal(bottleDraft.bottle, "modified");
  assert.equal(bottleDraft.summary, "stale");

  const ocrDraft = getCoreWizardStepStatuses({
    labelSaved: true,
    labelDirty: false,
    hasBottleDetection: true,
    hasBottleAnnotation: true,
    bottleSnapshotMatches: true,
    ocrDirty: true,
    hasOcrReview: true,
    hasAnalysis: true,
    cvStatuses,
    analysisReviewCurrent: true,
    summaryReviewDirty: false,
  });
  assert.equal(ocrDraft.ocr, "modified");
  assert.equal(ocrDraft.summary, "stale");
});

test("Summary is modified before review, saved after review, and modified after note edits", () => {
  const base = {
    labelSaved: true,
    labelDirty: false,
    hasBottleDetection: true,
    hasBottleAnnotation: true,
    bottleSnapshotMatches: true,
    ocrDirty: false,
    hasOcrReview: true,
    hasAnalysis: true,
    cvStatuses: allCvStatuses("saved"),
  };
  assert.equal(getCoreWizardStepStatuses({ ...base, analysisReviewCurrent: false, summaryReviewDirty: false }).summary, "modified");
  assert.equal(getCoreWizardStepStatuses({ ...base, analysisReviewCurrent: true, summaryReviewDirty: false }).summary, "saved");
  assert.equal(getCoreWizardStepStatuses({ ...base, analysisReviewCurrent: true, summaryReviewDirty: true }).summary, "modified");
});

function allCvStatuses(status: WizardStepStatus): Record<(typeof CV_STAGES)[number], WizardStepStatus> {
  return Object.fromEntries(CV_STAGES.map((stage) => [stage, status])) as Record<(typeof CV_STAGES)[number], WizardStepStatus>;
}

function cvJob(input: {
  config: LabelAnalysisCvConfig;
  threshold: number;
  previewStage: NonNullable<LabelCvJob["previewStage"]>;
  workflow?: LabelCvJob["workflow"];
}): LabelCvJob {
  return {
    schemaVersion: 3,
    annotationId: "annotation",
    annotationRevision: 1,
    analysisJobId: "analysis",
    config: input.config,
    previewStage: input.previewStage,
    preview: {
      palette: [],
      quality: { entropy: null, sharpness: null },
      contours: [],
      cvDebug: {},
      stage: input.previewStage,
      stageMetrics: { threshold: input.threshold },
    },
    review,
    palette,
    workflow: input.workflow === undefined && input.previewStage === "mask" ? {
      schemaVersion: 1,
      lastCompletedStage: "mask",
      checkpoints,
      updatedAt: "2026-08-21T00:00:00.000Z",
    } : input.workflow,
    updatedAt: "2026-08-21T00:00:01.000Z",
  };
}
