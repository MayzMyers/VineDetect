"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { AnnotationGraphHelperOperation, AnnotationRegionGeometry, AutoLabelConfigV1, BottleDetectionConfig, CatalogIdentityReview, DinoLabelMode, LabelAnalysisCvConfig, LabelAnalysisReview, LabelAnalysisResult, LabelAnalysisWorkspace, LabelAnnotationOcrRegionReview, LabelAnnotationOcrSnapshot, LabelAnnotationState, LabelCatalogCandidate, LabelCvJob, LabelCvReviewState, LabelCvStage, LabelElement, LabelElementRole, LabelElementType, LabelPaletteColor, LabelRectification, LabelSourceAnalysisRun, LabelSourceCandidate, OcrCascadeEvidence, OcrSourceAssociationReview, OcrSourceAssociationWorkspace, PackageDetectionCandidate, PackageDetectionRun, PutCatalogIdentityReview, PutLabelAnnotationOcrRegionReview, PutOcrSourceAssociationReview, QuadGeometry, RecognitionMetaItem, RecognitionRoi, SiglipLabelMode, StageSampleV1, VisionEvidenceRunOptions } from "@/lib/admin/api";
import { ImageWorkspace, type WorkspaceCanvasSize, type WorkspacePoint } from "./image-workspace/ImageWorkspace";
import { MovableViewerDock } from "./image-workspace/MovableViewerDock";
import { OcrRegionEditor } from "./OcrRegionEditor";
import { SourceAssociationEditor } from "./SourceAssociationEditor";
import { CvStageDebugger } from "./CvStageDebugger";
import { BottleContextStage, DEFAULT_BOTTLE_OVERLAYS, type BottleOverlayState } from "./BottleContextStage";
import { WizardExecutionTrace } from "./WizardExecutionTrace";
import { RawJsonBlock } from "./RawJsonBlock";
import { moveQuad, moveQuadCorner, normalizeQuad, pointInQuad, rectangleQuad, sameQuad } from "./image-workspace/quadGeometry";
import { mapQuadUnitPoint } from "./image-workspace/labelRectification";
import {
  CV_STAGES,
  cvPreviewFingerprint,
  effectiveOcrOverlayRegions,
  getCoreWizardStepStatuses,
  getCvStageStatuses,
  initialCvResumeStep,
  getLocalCvCompletionWarning,
  getLocalCvStageWarning,
  moveComponentBetweenElementGroups,
  type ApprovedCvSnapshot,
  type WizardStepStatus,
} from "./labelWorkflowState";
import {
  getObject,
  naturalToCanvasRect,
  numberValue,
  parseNormalizedRect,
  stringValue,
  unwrapCvMeta,
} from "./image-workspace/cvOverlays";

type LabelAnnotationStatus = LabelAnnotationState["status"];

type Props = {
  imageUrl: string | null;
  metadata: RecognitionMetaItem | null;
  annotation: LabelAnnotationState | null;
  title: string;
  saving: boolean;
  onSave: (annotation: LabelAnnotationState) => Promise<void>;
  onSaveAndNext?: (annotation: LabelAnnotationState) => Promise<void>;
  sourceAnalysis?: LabelSourceAnalysisRun | null;
  onRunSourceAnalysis?: (verifiedLabel?: RecognitionRoi, outerConfig?: BottleDetectionConfig, labelConfig?: AutoLabelConfigV1, visionEvidence?: VisionEvidenceRunOptions) => Promise<LabelSourceAnalysisRun | null>;
  onChangeSourceAnalysis?: (state: LabelSourceAnalysisRun | null) => void;
  onSaveSourceAnalysis?: (state: LabelSourceAnalysisRun) => Promise<LabelSourceAnalysisRun | null>;
  analysisWorkspace?: LabelAnalysisWorkspace | null;
  onRunAnalysis?: (config?: LabelAnalysisCvConfig) => Promise<void>;
  onPreviewCvJob?: (stage: LabelCvStage, config: LabelAnalysisCvConfig, review?: LabelCvReviewState) => Promise<LabelCvJob | null>;
  onSaveCvCheckpoint?: (stage: LabelCvStage, config: LabelAnalysisCvConfig, review?: LabelCvReviewState, palette?: LabelPaletteColor[]) => Promise<LabelCvJob | null>;
  onSaveCvJob?: (config: LabelAnalysisCvConfig, palette: LabelPaletteColor[], review?: LabelCvReviewState) => Promise<LabelCvJob | null>;
  cvPreviewing?: boolean;
  onReviewAnalysis?: (status: LabelAnalysisReview["status"], notes: string) => Promise<boolean>;
  canonicalSummaryConfirmation?: boolean;
  ocrRegionReview?: LabelAnnotationOcrRegionReview | null;
  sourceAssociationWorkspace?: OcrSourceAssociationWorkspace | null;
  onSaveOcrRegionReview?: (input: PutLabelAnnotationOcrRegionReview) => Promise<LabelAnnotationOcrRegionReview | null>;
  onSaveSourceAssociationReview?: (input: PutOcrSourceAssociationReview) => Promise<OcrSourceAssociationReview | null>;
  onSaveCatalogIdentityReview?: (input: PutCatalogIdentityReview) => Promise<CatalogIdentityReview | null>;
  queueNav?: {
    nextHref: string | null;
    prevHref: string | null;
    position: number | null;
    total: number | null;
    queue: string | null;
  } | null;
  annotationValidation?: { unresolvedIdentityConflicts: number; suggestedParentRelations: number; readyForCanonicalExport: boolean } | null;
  packageGeometry?: AnnotationRegionGeometry | null;
  onSavePackageScope?: (geometry: QuadGeometry | null, helper?: { packageType: "bottle" | "box"; operation: AnnotationGraphHelperOperation }) => Promise<boolean>;
  onRunPackageHelper?: () => Promise<PackageDetectionRun | null>;
  onOpenLabelBranch?: () => void | boolean | Promise<void | boolean>;
  packageApprovalRequired?: boolean;
  labelBranchCvEnabled?: boolean;
  branchNavigation?: (actions: { activeStage: AnnotationNavigationStep; openPackageStage: () => void; openLabelStage: () => void }) => ReactNode;
  graphStageControls?: (activeStage: AnnotationNavigationStep) => ReactNode;
  graphLabelWorkspace?: ReactNode;
  graphOcrWorkspace?: ReactNode;
  initialStep?: AnnotationNavigationStep;
  onActiveStepChange?: (step: AnnotationNavigationStep) => void;
  navigationRequest?: { id: number; step: AnnotationNavigationStep } | null;
  onNavigationRequestHandled?: (id: number) => void;
  packageComposition?: ReactNode;
  assistantPanel?: ReactNode;
};

type EditMode = "view" | "edit";
export type AnnotationNavigationStep = "package" | "label" | "bottle" | "ocr" | LabelCvStage | "summary";
type AnnotationStep = AnnotationNavigationStep;
type ApprovedBottleSnapshot = { savedAt: string; signature: string };
type StageAlgorithmBinding = { helperId: string; algorithm: string; configSchemaVersion: number; config: Record<string, unknown>; persisted: boolean; status: string; targetRef: string; runId?: string | null };
type CandidateReviewDisplayMode = "unchanged" | "changed" | "manual";
type MaskUiCandidate = {
  id: string;
  family: string;
  strength: string;
  config: Pick<LabelAnalysisCvConfig, "threshold" | "invert" | "maskSize" | "maskMode">;
  score: number | null;
  metrics: Record<string, number>;
  mask: { width: number; height: number; data: string };
};
type MorphologyUiCandidate = {
  id: string;
  family: string;
  strength: string;
  pipeline: NonNullable<LabelAnalysisCvConfig["morphologyPipeline"]>;
  config: Partial<LabelAnalysisCvConfig>;
  score: number | null;
  metrics: Record<string, number>;
  mask: { width: number; height: number; data: string };
  addedMask: { width: number; height: number; data: string };
  removedMask: { width: number; height: number; data: string };
};
type ComponentUiCandidate = {
  id: string;
  config: Pick<LabelAnalysisCvConfig, "componentMode" | "componentConnectivity" | "componentFilterPreset" | "minComponentAreaRatio" | "maxComponentAreaRatio">;
  score: number | null;
  metrics: Record<string, number>;
};
type RoiDragSession =
  | { kind: "draw"; start: WorkspacePoint }
  | { kind: "move"; start: WorkspacePoint; initial: QuadGeometry }
  | { kind: "corner"; cornerIndex: number; initial: QuadGeometry };
export type ZoomLensState = {
  clientX: number;
  clientY: number;
  naturalX: number;
  naturalY: number;
};
const DEFAULT_ANALYSIS_CV_CONFIG: LabelAnalysisCvConfig = {
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
  paletteColors: 8,
  paletteMinRatio: 0.01,
};
type BottlePaletteColor = NonNullable<LabelSourceAnalysisRun["bottleDetection"]>["palette"][number];
type AutoLabelOverlayState = { neutralBands: boolean; cannyEvidence: boolean; envelope: boolean; candidates: boolean };

const DEFAULT_AUTO_LABEL_CONFIG: AutoLabelConfigV1 = {
  schemaVersion: 1, previewMaxSide: 720, chromaTolerance: 24, minimumLightness: 105,
  minRegionWidthRatio: .42, maxRegionWidthRatio: .985, rowGapRatio: .09,
  minimumBandCoverage: .48, envelopeCoverage: .65, envelopeSizeMultiplier: 1.45,
};
const DEFAULT_AUTO_LABEL_OVERLAYS: AutoLabelOverlayState = { neutralBands: true, cannyEvidence: false, envelope: true, candidates: true };

function normalizeAutoLabelConfig(value: Partial<AutoLabelConfigV1> | null | undefined): AutoLabelConfigV1 {
  return { ...DEFAULT_AUTO_LABEL_CONFIG, ...value, schemaVersion: 1 };
}

function packageScopeQuad(value: AnnotationRegionGeometry | null | undefined): QuadGeometry | null {
  if (!value) return null;
  return value.type === "quad" ? value : rectangleQuad(value.bbox);
}

const DEFAULT_BOTTLE_CONFIG: BottleDetectionConfig = { processingMode: "preview", previewMaxSize: 420, paddingPercent: 8, silhouetteThreshold: 18, connectivity: 4, simplifyTolerance: 2, canny: { blurKernel: 3, low: 40, high: 100 }, morphology: { closeKernel: 5, iterations: 1 } };
const DEFAULT_OCR_HELPER_CONFIG: Record<string, unknown> = {
  schemaVersion: 1,
  profileVersion: "tesseract-cascade-v6",
  engine: "tesseract.js",
  languages: ["rus", "eng"],
  adaptiveStop: true,
  geometryHelpers: ["deskew", "perspective"],
  profiles: [
    { id: "full-normalized-sparse", stage: "cheap", region: "full", preprocess: "normalized", psm: "11", minWidth: 800, weight: 1 },
    { id: "full-contrast-block", stage: "cheap", region: "full", preprocess: "contrast", psm: "6", minWidth: 900, weight: .95 },
    { id: "top-contrast-line", stage: "cheap", region: "top", preprocess: "contrast", psm: "7", minWidth: 800, weight: .9 },
    { id: "bottom-normalized-line", stage: "cheap", region: "bottom", preprocess: "normalized", psm: "7", minWidth: 800, weight: .85 },
    { id: "full-threshold-sparse", stage: "deep", region: "full", preprocess: "threshold", psm: "11", minWidth: 1100, weight: .88 },
    { id: "full-invert-block", stage: "deep", region: "full", preprocess: "invert", psm: "6", minWidth: 1000, weight: .82 },
    { id: "center-threshold-block", stage: "deep", region: "center", preprocess: "threshold", psm: "6", minWidth: 1000, weight: .86 },
    { id: "full-clahe-sparse", stage: "rescue", region: "full", preprocess: "clahe", psm: "11", minWidth: 1200, weight: .84 },
    { id: "full-adaptive-threshold-block", stage: "rescue", region: "full", preprocess: "adaptive-threshold", psm: "6", minWidth: 1200, weight: .8 },
    { id: "full-glare-suppressed-sparse", stage: "rescue", region: "full", preprocess: "glare-suppressed", psm: "11", minWidth: 1100, weight: .78 },
    { id: "full-normalized-vertical-block", stage: "orientation", region: "full", preprocess: "normalized", psm: "5", minWidth: 1100, weight: .72 },
    { id: "full-rotate-cw-sparse", stage: "orientation", region: "full", preprocess: "rotate-cw", psm: "11", minWidth: 1100, weight: .84, rotationDegrees: 90 },
    { id: "full-rotate-ccw-sparse", stage: "orientation", region: "full", preprocess: "rotate-ccw", psm: "11", minWidth: 1100, weight: .84, rotationDegrees: -90 },
  ],
};
const bottleMaskLayerCache = new Map<string, HTMLCanvasElement>();

function normalizeBottleConfig(value: Partial<BottleDetectionConfig> | null | undefined): BottleDetectionConfig {
  return {
    processingMode: value?.processingMode ?? DEFAULT_BOTTLE_CONFIG.processingMode,
    previewMaxSize: value?.previewMaxSize ?? DEFAULT_BOTTLE_CONFIG.previewMaxSize,
    paddingPercent: value?.paddingPercent ?? DEFAULT_BOTTLE_CONFIG.paddingPercent,
    silhouetteThreshold: value?.silhouetteThreshold ?? DEFAULT_BOTTLE_CONFIG.silhouetteThreshold,
    connectivity: value?.connectivity === 8 ? 8 : 4,
    simplifyTolerance: value?.simplifyTolerance ?? DEFAULT_BOTTLE_CONFIG.simplifyTolerance,
    canny: { ...DEFAULT_BOTTLE_CONFIG.canny, ...value?.canny },
    morphology: { ...DEFAULT_BOTTLE_CONFIG.morphology, ...value?.morphology },
  };
}

export function LabelAnnotationPanel({ imageUrl, metadata, annotation, title, saving, onSave, onSaveAndNext, sourceAnalysis, onRunSourceAnalysis, onChangeSourceAnalysis, onSaveSourceAnalysis, analysisWorkspace, onRunAnalysis, onPreviewCvJob, onSaveCvCheckpoint, onSaveCvJob, cvPreviewing = false, onReviewAnalysis, canonicalSummaryConfirmation = false, ocrRegionReview, sourceAssociationWorkspace, onSaveOcrRegionReview, onSaveSourceAssociationReview, onSaveCatalogIdentityReview, queueNav, annotationValidation, packageGeometry, onSavePackageScope, onRunPackageHelper, onOpenLabelBranch, packageApprovalRequired = false, labelBranchCvEnabled = true, branchNavigation, graphStageControls, graphLabelWorkspace, graphOcrWorkspace, initialStep = "package", onActiveStepChange, navigationRequest, onNavigationRequestHandled, packageComposition, assistantPanel }: Props) {
  const initialAnnotation = useMemo(() => annotation ?? buildLabelAnnotationState(metadata), [annotation, metadata]);
  const analysis = analysisWorkspace?.analysis ?? null;
  const analysisOcrSnapshot = useMemo(
    () => analysis && !analysisWorkspace?.stale ? analysisToOcrSnapshot(analysis) : null,
    [analysis, analysisWorkspace?.stale],
  );
  const [draft, setDraft] = useState<LabelAnnotationState>(initialAnnotation);
  const [workingGeometry, setWorkingGeometry] = useState<QuadGeometry | null>(() => normalizeQuad(initialAnnotation.annotation?.geometry, initialAnnotation.annotation?.roi) ?? normalizeQuad(initialAnnotation.prediction?.geometry, initialAnnotation.prediction?.roi));
  const [workingRectification, setWorkingRectification] = useState<LabelRectification | null>(() => initialAnnotation.annotation?.rectification ?? initialAnnotation.prediction?.rectification ?? null);
  const workingRoi = workingGeometry?.bbox ?? null;
  const setWorkingRoi = useCallback((roi: RecognitionRoi | null) => setWorkingGeometry(roi ? rectangleQuad(roi) : null), []);
  const [labelSavedForBottle, setLabelSavedForBottle] = useState(Boolean(initialAnnotation.annotation?.id));
  const incomingAnnotationFingerprint = useRef(JSON.stringify(initialAnnotation));
  const [mode, setMode] = useState<EditMode>("view");
  const [step, setStep] = useState<AnnotationStep>(() => navigationRequest?.step ?? initialStep);
  const [packageDraft, setPackageDraft] = useState<QuadGeometry | null>(() => packageScopeQuad(packageGeometry));
  const [packageEditing, setPackageEditing] = useState(false);
  const [packageHelperRun, setPackageHelperRun] = useState<PackageDetectionRun | null>(null);
  const [selectedPackageCandidateId, setSelectedPackageCandidateId] = useState<string | null>(null);
  const [packageHelperRunning, setPackageHelperRunning] = useState(false);
  const [roiDrag, setRoiDrag] = useState<RoiDragSession | null>(null);
  const [roiCursor, setRoiCursor] = useState("crosshair");
  const [zoomLens, setZoomLens] = useState<ZoomLensState | null>(null);
  const [activeOcrRegionId, setActiveOcrRegionId] = useState<string | null>(null);
  const [ocrDraftDirty, setOcrDraftDirty] = useState(false);
  const [summaryReviewDirty, setSummaryReviewDirty] = useState(false);
  const [activeSourceCandidateId, setActiveSourceCandidateId] = useState<string | null>(null);
  const [autoLabelConfig, setAutoLabelConfig] = useState<AutoLabelConfigV1>(() => normalizeAutoLabelConfig(sourceAnalysis?.labelDetection?.config));
  const [autoLabelConfigDirty, setAutoLabelConfigDirty] = useState(false);
  const [siglipLabelMode, setSiglipLabelMode] = useState<SiglipLabelMode>(() => sourceAnalysis?.visionEvidenceConfig?.labelMode ?? "off");
  const [dinoLabelMode, setDinoLabelMode] = useState<DinoLabelMode>(() => sourceAnalysis?.visionEvidenceConfig?.dinoMode ?? "off");
  const [autoLabelOverlays, setAutoLabelOverlays] = useState<AutoLabelOverlayState>(DEFAULT_AUTO_LABEL_OVERLAYS);
  const [bottleEyedropperActive, setBottleEyedropperActive] = useState(false);
  const [bottleConfigOverride, setBottleConfig] = useState<BottleDetectionConfig | null>(null);
  const bottleConfig = bottleConfigOverride ?? normalizeBottleConfig(sourceAnalysis?.bottleDetection?.config);
  const [bottleOverlays, setBottleOverlays] = useState<BottleOverlayState>(DEFAULT_BOTTLE_OVERLAYS);
  const [selectedBottleCandidateOverride, setSelectedBottleCandidateId] = useState<string | null | undefined>(undefined);
  const selectedBottleCandidateId = selectedBottleCandidateOverride === undefined
    ? sourceAnalysis?.bottleDetection?.selectedCandidateId ?? null
    : selectedBottleCandidateOverride;
  const [approvedBottleSnapshot, setApprovedBottleSnapshot] = useState<ApprovedBottleSnapshot | null>(() => approvedBottleSnapshotFromState(sourceAnalysis));
  const initialCvConfig = normalizeCvConfig(analysisWorkspace?.cvJob?.config ?? analysisWorkspace?.analysis?.configSnapshot);
  const [cvConfig, setCvConfig] = useState<LabelAnalysisCvConfig>(initialCvConfig);
  const [maskPreviewResult, setMaskPreviewResult] = useState<{ scope: string; fingerprint: string; candidates: MaskUiCandidate[] } | null>(null);
  const [runningMaskPreview, setRunningMaskPreview] = useState(false);
  const [cvReview, setCvReview] = useState<LabelCvReviewState>(() => normalizeCvReview(analysisWorkspace?.cvJob?.review));
  const [approvedCvSnapshot, setApprovedCvSnapshot] = useState<ApprovedCvSnapshot | null>(() => approvedSnapshotFromJob(analysisWorkspace?.cvJob));
  const [selectedComponentIds, setSelectedComponentIds] = useState<number[]>([]);
  const [showRejectedComponents, setShowRejectedComponents] = useState(false);
  const [componentDeletionHistory, setComponentDeletionHistory] = useState<Array<Array<{ id: number; previous: "accepted" | "rejected" | undefined }>>>([]);
  const [hoveredElementId, setHoveredElementId] = useState<string | null>(null);
  const [hoveredElementComponentId, setHoveredElementComponentId] = useState<number | null>(null);
  const initialPalette = analysisWorkspace?.cvJob?.palette ?? [];
  const [palette, setPalette] = useState<LabelPaletteColor[]>(initialPalette.map((color) => ({ ...color, source: ("source" in color ? color.source : undefined) ?? "detected" })));
  const [paletteDirty, setPaletteDirty] = useState(false);
  const [paletteAutoRanScope, setPaletteAutoRanScope] = useState<string | null>(null);
  const [runningPalettePreview, setRunningPalettePreview] = useState(false);
  const [paletteDeletionHistory, setPaletteDeletionHistory] = useState<Array<{ color: LabelPaletteColor; index: number }>>([]);
  const [bottlePaletteDeletionHistory, setBottlePaletteDeletionHistory] = useState<Array<{ color: BottlePaletteColor; index: number }>>([]);
  const [summaryBlockedStages, setSummaryBlockedStages] = useState<LabelCvStage[]>([]);
  const [eyedropperActive, setEyedropperActive] = useState(false);
  const cvStateHydrated = useRef(Boolean(analysisWorkspace?.cvJob?.workflow));
  const resumeApplied = useRef(false);
  const previewCvJobRef = useRef(onPreviewCvJob);
  const runSourceAnalysisRef = useRef(onRunSourceAnalysis);
  const activeStepRef = useRef<AnnotationStep>(step);
  const lastPreviewInputFingerprint = useRef(cvPreviewFingerprint(initialCvConfig, normalizeCvReview(analysisWorkspace?.cvJob?.review)));
  const lastAnalysisOcrRunId = useRef(analysisOcrSnapshot?.ocr.id ?? null);
  const lastApprovedBottleSavedAt = useRef(approvedBottleSnapshot?.savedAt ?? null);
  const lastNavigationRequestId = useRef<number | null>(null);

  useEffect(() => {
    if (!navigationRequest || lastNavigationRequestId.current === navigationRequest.id) return;
    lastNavigationRequestId.current = navigationRequest.id;
    setSummaryBlockedStages([]);
    setStep(navigationRequest.step);
    onNavigationRequestHandled?.(navigationRequest.id);
  }, [navigationRequest, onNavigationRequestHandled]);

  useEffect(() => {
    onActiveStepChange?.(step);
  }, [onActiveStepChange, step]);

  const predictionNatural = draft.prediction?.roi ?? null;
  const reviewedNatural = draft.annotation?.roi ?? null;
  const editableNatural = workingRoi;
  const savedGeometry = normalizeQuad(draft.annotation?.geometry, reviewedNatural) ?? normalizeQuad(draft.prediction?.geometry, predictionNatural);
  const savedRectification = draft.annotation?.rectification ?? draft.prediction?.rectification ?? null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialAnnotation) || !sameQuad(workingGeometry, savedGeometry) || JSON.stringify(workingRectification) !== JSON.stringify(savedRectification);
  const canSaveCurrentBox = Boolean(workingRoi) && (dirty || !reviewedNatural);
  const activeOcrSnapshot = analysisOcrSnapshot;
  const analysisRegions = useMemo(
    () => effectiveOcrOverlayRegions(analysis, ocrRegionReview),
    [analysis, ocrRegionReview],
  );
  const cvFeatures = analysisWorkspace?.cvJob?.preview ?? analysis?.visualFeatures ?? null;
  const maskCandidateScope = `${analysis?.annotationId ?? "none"}:${analysis?.annotationRevision ?? 0}:${analysis?.crop.id ?? "none"}`;
  const reviewedMaskCandidates = maskPreviewResult?.scope === maskCandidateScope ? maskPreviewResult.candidates : [];
  const selectedMaskCandidate = cvConfig.maskMode === "auto"
    ? reviewedMaskCandidates[0] ?? null
    : cvConfig.maskMode === "candidate"
      ? reviewedMaskCandidates.find((candidate) => cvConfig.threshold === candidate.config.threshold && cvConfig.invert === candidate.config.invert && cvConfig.maskSize === candidate.config.maskSize) ?? null
      : null;
  const maskPreviewReady = Boolean(maskPreviewResult?.scope === maskCandidateScope && reviewedMaskCandidates.length);
  const maskCanContinue = cvConfig.maskMode === "manual" || (maskPreviewReady && (
    cvConfig.maskMode === "auto"
      ? maskPreviewResult?.fingerprint === cvPreviewFingerprint(cvConfig, cvReview)
      : reviewedMaskCandidates.some((candidate) => cvConfig.threshold === candidate.config.threshold && cvConfig.invert === candidate.config.invert && cvConfig.maskSize === candidate.config.maskSize)
  ));
  const morphologyCandidates = useMemo(() => morphologyCandidatesFromDebug(cvFeatures?.cvDebug), [cvFeatures?.cvDebug]);
  const componentCandidates = useMemo(() => componentCandidatesFromDebug(cvFeatures?.cvDebug), [cvFeatures?.cvDebug]);
  const cvFeaturesIncludeComponents = cvFeatures?.stage
    ? CV_STAGES.indexOf(cvFeatures.stage) >= CV_STAGES.indexOf("components")
    : false;
  const componentFeatures = useMemo(
    () => cvFeaturesIncludeComponents
      ? cvFeatures?.components ?? []
      : analysis?.visualFeatures.components ?? [],
    [analysis?.visualFeatures, cvFeatures?.components, cvFeaturesIncludeComponents],
  );
  const visibleCvElements = useMemo(
    () => (cvReview.elementsReviewed
      ? materializeReviewedElements(cvReview.elements, componentFeatures)
      : cvFeatures?.elements ?? []).map(normalizeElement),
    [componentFeatures, cvFeatures?.elements, cvReview.elements, cvReview.elementsReviewed],
  );
  const groupedCvElements = visibleCvElements;
  const ungroupedElementComponents = useMemo(() => {
    const groupedIds = new Set(groupedCvElements.flatMap((element) => element.sourceComponentIds));
    return componentFeatures.filter((component) => {
      const decision = cvReview.componentDecisions[String(component.id)];
      const accepted = decision ? decision === "accepted" : component.accepted;
      return accepted && !groupedIds.has(component.id);
    });
  }, [componentFeatures, cvReview.componentDecisions, groupedCvElements]);
  const hoveredElementComponentIds = useMemo(() => {
    if (hoveredElementComponentId !== null) return [hoveredElementComponentId];
    return groupedCvElements.find((element) => element.id === hoveredElementId)?.sourceComponentIds ?? [];
  }, [groupedCvElements, hoveredElementComponentId, hoveredElementId]);
  const cvWorkflow = analysisWorkspace?.cvJob?.workflow;
  const cvStageStatuses = getCvStageStatuses(cvWorkflow?.checkpoints, approvedCvSnapshot, cvConfig, cvReview, palette);
  const currentBottleSignature = bottleStateSignature(sourceAnalysis, bottleConfig, selectedBottleCandidateId);
  const analysisReviewCurrent = Boolean(
    analysis
    && analysisWorkspace?.review?.jobId === analysis.jobId
    && analysisWorkspace.review.configHash === analysis.provenance.configHash,
  );
  const coreStepStatuses = getCoreWizardStepStatuses({
    labelSaved: labelSavedForBottle,
    labelDirty: dirty,
    hasBottleDetection: Boolean(sourceAnalysis?.bottleDetection),
    hasBottleAnnotation: Boolean(sourceAnalysis?.bottleDetection?.annotation),
    bottleSnapshotMatches: approvedBottleSnapshot?.signature === currentBottleSignature,
    ocrDirty: ocrDraftDirty,
    hasOcrReview: Boolean(ocrRegionReview),
    hasAnalysis: Boolean(analysis),
    cvStatuses: cvStageStatuses,
    analysisReviewCurrent,
    summaryReviewDirty,
  });
  const wizardStepStatuses: Partial<Record<AnnotationStep, WizardStepStatus>> = {
    package: sameQuad(packageDraft, packageScopeQuad(packageGeometry)) ? "saved" : "modified",
    ...coreStepStatuses,
    ...cvStageStatuses,
  };
  const cvSequenceWarning = isCvStage(step) ? getLocalCvStageWarning(step, cvStageStatuses) : step === "summary" ? getLocalCvCompletionWarning(cvStageStatuses) : null;
  const algorithmBinding = buildStageAlgorithmBinding(step, draft.prediction, sourceAnalysis, activeOcrSnapshot?.ocr.evidence ?? null, analysisWorkspace?.cvJob ?? null, cvConfig, autoLabelConfig, bottleConfig, analysisReviewCurrent);
  const currentStageSample = analysisWorkspace?.stageSamples.find((sample) => sample.stage === step)
    ?? (step === "label" && draft.stageSample?.stage === "label" ? draft.stageSample : undefined)
    ?? (step === "bottle" && sourceAnalysis?.stageSample?.stage === "bottle" ? sourceAnalysis.stageSample : undefined);
  const liveCandidateSelection = currentCandidateSelection(step, draft, workingGeometry, sourceAnalysis, selectedBottleCandidateId);

  useEffect(() => {
    const fingerprint = JSON.stringify(initialAnnotation);
    if (incomingAnnotationFingerprint.current === fingerprint) return;
    incomingAnnotationFingerprint.current = fingerprint;
    setDraft(initialAnnotation);
    setWorkingGeometry(normalizeQuad(initialAnnotation.annotation?.geometry, initialAnnotation.annotation?.roi) ?? normalizeQuad(initialAnnotation.prediction?.geometry, initialAnnotation.prediction?.roi));
    setWorkingRectification(initialAnnotation.annotation?.rectification ?? initialAnnotation.prediction?.rectification ?? null);
    setLabelSavedForBottle(Boolean(initialAnnotation.annotation?.id));
  }, [initialAnnotation]);

  useEffect(() => {
    const saved = analysisWorkspace?.cvJob;
    if (!saved?.workflow || cvStateHydrated.current) return;
    cvStateHydrated.current = true;
    const savedConfig = normalizeCvConfig(saved.config);
    const savedReview = normalizeCvReview(saved.review);
    lastPreviewInputFingerprint.current = cvPreviewFingerprint(savedConfig, savedReview);
    const timer = window.setTimeout(() => {
      setCvConfig(savedConfig);
      setCvReview(savedReview);
      if (saved.palette) setPalette(saved.palette.map((color) => ({ ...color, source: color.source ?? "detected" })));
      setApprovedCvSnapshot(approvedSnapshotFromJob(saved));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [analysisWorkspace?.cvJob]);

  useEffect(() => {
    const savedAt = sourceAnalysis?.savedAt ?? null;
    if (!savedAt || lastApprovedBottleSavedAt.current === savedAt) return;
    lastApprovedBottleSavedAt.current = savedAt;
    const snapshot = approvedBottleSnapshotFromState(sourceAnalysis);
    const timer = window.setTimeout(() => {
      setApprovedBottleSnapshot(snapshot);
      setBottleConfig(normalizeBottleConfig(sourceAnalysis?.bottleDetection?.config));
      setSelectedBottleCandidateId(sourceAnalysis?.bottleDetection?.selectedCandidateId ?? null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sourceAnalysis]);

  useEffect(() => {
    if (resumeApplied.current) return;
    // Resume is a one-time initial-card action. Once the annotator has opened
    // any stage, a late workflow/preview response must not move the UI.
    if (step !== "package" || (navigationRequest && navigationRequest.step !== "package")) {
      resumeApplied.current = true;
      return;
    }
    if (!cvWorkflow || !labelSavedForBottle || !sourceAnalysis?.bottleDetection?.annotation) return;
    const resumeStep = initialCvResumeStep(step, cvWorkflow.lastCompletedStage, cvWorkflow.checkpoints);
    if (!resumeStep) return;
    resumeApplied.current = true;
    const timer = window.setTimeout(() => setStep(resumeStep), 0);
    return () => window.clearTimeout(timer);
  }, [cvWorkflow, labelSavedForBottle, navigationRequest, sourceAnalysis?.bottleDetection?.annotation, step]);

  useEffect(() => {
    previewCvJobRef.current = onPreviewCvJob;
  }, [onPreviewCvJob]);

  useEffect(() => {
    runSourceAnalysisRef.current = onRunSourceAnalysis;
  }, [onRunSourceAnalysis]);

  useEffect(() => {
    activeStepRef.current = step;
  }, [step]);

  useEffect(() => {
    const fingerprint = cvPreviewFingerprint(cvConfig, cvReview);
    if (fingerprint === lastPreviewInputFingerprint.current) return;
    const previewCvJob = previewCvJobRef.current;
    const activeStep = activeStepRef.current;
    // Auto Mask discovery is an explicit annotator action, not a side effect
    // of opening the stage or selecting a shortlist card.
    if (activeStep === "mask" && cvConfig.maskMode !== "manual") return;
    // Palette extraction also starts explicitly; sliders prepare the next run.
    if (activeStep === "palette") return;
    if (!isCvStage(activeStep) || !analysis || analysisWorkspace?.stale || !previewCvJob) return;
    lastPreviewInputFingerprint.current = fingerprint;
    const timer = window.setTimeout(() => {
      void previewCvJob(activeStep, cvConfig, cvReview);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [analysis, analysisWorkspace?.stale, cvConfig, cvReview]);

  useEffect(() => {
    if (step !== "label" || !autoLabelConfigDirty || !runSourceAnalysisRef.current) return;
    const fingerprint = JSON.stringify(autoLabelConfig);
    const timer = window.setTimeout(() => {
      void runSourceAnalysisRef.current?.(undefined, undefined, autoLabelConfig, { labelMode: siglipLabelMode, dinoMode: dinoLabelMode }).then((result) => {
        if (JSON.stringify(result?.labelDetection?.config) === fingerprint) setAutoLabelConfigDirty(false);
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [autoLabelConfig, autoLabelConfigDirty, dinoLabelMode, siglipLabelMode, step]);

  useEffect(() => {
    const snapshot = analysisOcrSnapshot;
    if (!snapshot) return;
    const runId = snapshot.ocr.id;
    if (lastAnalysisOcrRunId.current === runId) return;
    lastAnalysisOcrRunId.current = runId;
    setActiveOcrRegionId(null);
  }, [analysisOcrSnapshot]);

  const draw = useCallback(
    ({ canvas, image }: { canvas: HTMLCanvasElement; image: HTMLImageElement }) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (step === "bottle") {
        const viewport = getBottleViewport(canvas, image, sourceAnalysis?.bottleDetection?.config.paddingPercent ?? bottleConfig.paddingPercent);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, viewport.x, viewport.y, viewport.width, viewport.height);
      } else ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (step === "package") {
        for (const candidate of packageHelperRun?.candidates ?? []) drawPackageCandidate(ctx, canvas, image, candidate, candidate.id === selectedPackageCandidateId);
        if (packageDraft) drawPackageScope(ctx, canvas, image, packageDraft);
      } else if (step === "label") {
        if (packageGeometry) drawPackageScope(ctx, canvas, image, packageGeometry);
        const conditioningContour = sourceAnalysis?.packageConditioningContext?.contour ?? sourceAnalysis?.packageContext?.contour;
        if ((conditioningContour?.length ?? 0) >= 3) drawAcceptedPackageContour(ctx, canvas, image, conditioningContour!);
        drawAutoLabelDebug(ctx, canvas, image, sourceAnalysis, autoLabelOverlays);
        if (autoLabelOverlays.candidates) for (const candidate of sourceAnalysis?.candidates ?? []) drawSourceCandidate(ctx, candidate, image, canvas, candidate.id === activeSourceCandidateId || candidate.id === draft.prediction?.candidateId);
      }
      if (step === "bottle") drawBottleContext(ctx, canvas, image, sourceAnalysis, selectedBottleCandidateId, bottleOverlays);
      if (workingGeometry && (step !== "bottle" || bottleOverlays.verifiedLabel)) drawQuad(ctx, workingGeometry, image, canvas, "#22c55e", "Label ROI", step === "label" && mode === "edit", step === "bottle" ? getBottleViewport(canvas, image, sourceAnalysis?.bottleDetection?.config.paddingPercent ?? bottleConfig.paddingPercent) : undefined);
    },
    [activeSourceCandidateId, autoLabelOverlays, bottleConfig.paddingPercent, bottleOverlays, draft.prediction?.candidateId, mode, packageDraft, packageGeometry, packageHelperRun, selectedBottleCandidateId, selectedPackageCandidateId, sourceAnalysis, step, workingGeometry]
  );

  async function runPackageHelper() {
    if (!onRunPackageHelper || packageHelperRunning) return;
    setPackageHelperRunning(true);
    try {
      const result = await onRunPackageHelper();
      setPackageHelperRun(result);
      const selectedId = result?.selectedCandidateId ?? result?.candidates[0]?.id ?? null;
      setSelectedPackageCandidateId(selectedId);
      const candidate = result?.candidates.find((item) => item.id === selectedId);
      if (candidate) { setPackageDraft(rectangleQuad(candidate.bbox)); setPackageEditing(false); }
    } finally { setPackageHelperRunning(false); }
  }

  function selectPackageCandidate(candidate: PackageDetectionCandidate) {
    setSelectedPackageCandidateId(candidate.id);
    setPackageDraft(rectangleQuad(candidate.bbox));
    setPackageEditing(false);
  }

  async function savePackageScope(geometry: QuadGeometry | null, useHelperCandidate = false) {
    if (!onSavePackageScope) return;
    const candidate = useHelperCandidate ? packageHelperRun?.candidates.find((item) => item.id === selectedPackageCandidateId) : null;
    const candidateAcceptedUnchanged = Boolean(candidate && geometry && sameQuad(geometry, rectangleQuad(candidate.bbox)));
    const helper = candidate && packageHelperRun ? {
      packageType: candidate.classification.type,
      operation: {
        helperId: packageHelperRun.helper.id,
        helperVersion: packageHelperRun.helper.version,
        initialConfig: packageHelperRun.config as unknown as Record<string, unknown>,
        finalConfig: packageHelperRun.config as unknown as Record<string, unknown>,
        candidates: packageHelperRun.candidates.map((item) => ({ id: item.id, payload: item as unknown as Record<string, unknown>, score: item.score })),
        selectedCandidateId: candidate.id,
        reviewMode: candidateAcceptedUnchanged ? "accepted" as const : "edited" as const,
      },
    } : undefined;
    const saved = await onSavePackageScope(geometry, helper);
    if (!saved) return;
    setPackageDraft(geometry);
    setPackageEditing(false);
  }

  async function approvePackageAndContinue() {
    const approved = await onOpenLabelBranch?.();
    if (approved === false) return;
    setPackageEditing(false);
    setStep("label");
  }

  function useSourceCandidate(candidate: LabelSourceCandidate) {
    const helperRun = [...(sourceAnalysis?.labelStageExecution?.helperRuns ?? [])]
      .reverse()
      .find((run) => run.candidates.some((value) => candidateIdentity(value) === candidate.id));
    setLabelSavedForBottle(false);
    setDraft((current) => ({
      ...current,
      prediction: {
        helperRunId: helperRun?.id,
        candidateId: candidate.id,
        roi: candidate.bbox,
        geometry: rectangleQuad(candidate.bbox),
        confidence: candidate.score,
        algorithm: {
          id: sourceAnalysis?.algorithm ?? "source-label-helper-v1",
          version: String(sourceAnalysis?.version ?? 1),
          params: sourceAnalysis?.labelDetection?.config ?? candidate.detection.config,
          defaultParams: DEFAULT_AUTO_LABEL_CONFIG,
        },
        createdAt: new Date().toISOString(),
      },
      annotation: null,
      status: "needs-review",
      reviewed: false,
      roiEdited: false,
      source: null,
      iou: null,
      labelRoiGt: false,
      updatedAt: new Date().toISOString(),
    }));
    setWorkingRoi(candidate.bbox);
    setWorkingRectification(null);
    setActiveSourceCandidateId(candidate.id);
    setMode("edit");
  }

  function markNoLabel() {
    setLabelSavedForBottle(false);
    setDraft({
      ...draft,
      annotation: null,
      status: "no-label",
      reviewed: false,
      roiEdited: false,
      source: null,
      iou: null,
      labelRoiGt: false,
      updatedAt: new Date().toISOString(),
    });
    setWorkingRoi(null);
    setMode("view");
  }

  function markInvalidImage() {
    setLabelSavedForBottle(false);
    setDraft({
      ...draft,
      annotation: null,
      status: "invalid-image",
      reviewed: false,
      roiEdited: false,
      source: null,
      iou: null,
      labelRoiGt: false,
      updatedAt: new Date().toISOString(),
    });
    setWorkingRoi(null);
    setMode("view");
  }

  async function save() {
    await onSave(annotationForSave(draft, workingGeometry, workingRectification));
    setLabelSavedForBottle(Boolean(workingRoi));
  }

  async function saveAndNext() {
    await (onSaveAndNext ?? onSave)(annotationForSave(draft, workingGeometry, workingRectification));
    setLabelSavedForBottle(Boolean(workingRoi));
    if (draft.status !== "no-label" && draft.status !== "invalid-image") {
      setMode("view");
      if (!onSaveAndNext) setStep("bottle");
    }
  }

  async function saveAndOpenBottle() {
    await (onSaveAndNext ?? onSave)(annotationForSave(draft, workingGeometry, workingRectification));
    setLabelSavedForBottle(true);
    setMode("view");
    if (!onSaveAndNext) setStep("bottle");
  }

  async function runAnalysisFromOcr() {
    await onRunAnalysis?.();
    setActiveOcrRegionId(null);
  }

  async function saveCvJobAndOpenSummary(force = false) {
    if (!labelBranchCvEnabled) {
      setSummaryBlockedStages([]);
      setStep("summary");
      return;
    }
    const blockers = CV_STAGES.filter((stage) => stage !== "palette" && cvStageStatuses[stage] !== "saved");
    if (!force && blockers.length) { setSummaryBlockedStages(blockers); return; }
    const saved = onSaveCvJob ? await onSaveCvJob(cvConfig, palette, cvReview) : null;
    if (onSaveCvJob && !saved) return;
    if (saved) {
      const savedConfig = normalizeCvConfig(saved.config);
      const savedReview = normalizeCvReview(saved.review);
      lastPreviewInputFingerprint.current = cvPreviewFingerprint(savedConfig, savedReview);
      setCvConfig(savedConfig);
      setCvReview(savedReview);
      setApprovedCvSnapshot(approvedSnapshotFromJob(saved));
    }
    setPaletteDirty(false);
    setPaletteDeletionHistory([]);
    setSummaryBlockedStages([]);
    setStep("summary");
  }

  async function saveCvJobOnly() {
    const saved = await onSaveCvJob?.(cvConfig, palette, cvReview);
    if (saved) {
      const savedConfig = normalizeCvConfig(saved.config);
      const savedReview = normalizeCvReview(saved.review);
      lastPreviewInputFingerprint.current = cvPreviewFingerprint(savedConfig, savedReview);
      setCvConfig(savedConfig);
      setCvReview(savedReview);
      setApprovedCvSnapshot(approvedSnapshotFromJob(saved));
      setPaletteDirty(false);
      setPaletteDeletionHistory([]);
    }
    return saved ?? null;
  }

  async function saveCvCheckpointAndContinue(stage: LabelCvStage, nextStep: AnnotationStep, reviewOverride?: LabelCvReviewState) {
    if (stage === "mask" && (!maskCanContinue || cvPreviewing || runningMaskPreview)) return;
    const activeReview = reviewOverride ?? cvReview;
    if (reviewOverride) setCvReview(reviewOverride);
    const saved = onSaveCvCheckpoint ? await onSaveCvCheckpoint(stage, cvConfig, activeReview, stage === "palette" ? palette : undefined) : null;
    if (onSaveCvCheckpoint && !saved) return;
    if (saved) {
      const savedConfig = normalizeCvConfig(saved.config);
      const savedReview = normalizeCvReview(saved.review);
      lastPreviewInputFingerprint.current = cvPreviewFingerprint(savedConfig, savedReview);
      setCvConfig(savedConfig);
      setCvReview(savedReview);
      setApprovedCvSnapshot(approvedSnapshotFromJob(saved));

      if (isCvStage(nextStep) && nextStep !== "palette" && onPreviewCvJob) {
        await onPreviewCvJob(nextStep, savedConfig, savedReview);
      }
    }
    setSummaryBlockedStages([]);
    setStep(nextStep);
  }

  async function runMaskAutoPreview() {
    if (!onPreviewCvJob || !analysis || analysisWorkspace?.stale || runningMaskPreview || cvPreviewing) return;
    const scope = maskCandidateScope;
    const fingerprint = cvPreviewFingerprint(cvConfig, cvReview);
    setMaskPreviewResult(null);
    setRunningMaskPreview(true);
    try {
      const job = await onPreviewCvJob("mask", cvConfig, cvReview);
      if (job?.previewStage === "mask") {
        setMaskPreviewResult({ scope, fingerprint, candidates: maskCandidatesFromDebug(job.preview?.cvDebug) });
        lastPreviewInputFingerprint.current = fingerprint;
      }
    } finally {
      setRunningMaskPreview(false);
    }
  }

  async function runPaletteAutoPreview() {
    if (!onPreviewCvJob || !analysis || analysisWorkspace?.stale || runningPalettePreview || cvPreviewing) return;
    const scope = maskCandidateScope;
    const fingerprint = cvPreviewFingerprint(cvConfig, cvReview);
    setRunningPalettePreview(true);
    try {
      const job = await onPreviewCvJob("palette", cvConfig, cvReview);
      if (job?.previewStage === "palette" && job.preview) {
        setPalette(job.preview.palette.map((color) => ({ ...color, source: "detected" })));
        setPaletteDirty(false);
        setPaletteDeletionHistory([]);
        setPaletteAutoRanScope(scope);
        lastPreviewInputFingerprint.current = fingerprint;
      }
    } finally {
      setRunningPalettePreview(false);
    }
  }

  function updateCvConfig(next: LabelAnalysisCvConfig) {
    if (componentTopologyKey(next) !== componentTopologyKey(cvConfig)) {
      setCvReview({ componentDecisions: {}, elements: [] });
      setSelectedComponentIds([]); setHoveredElementId(null); setHoveredElementComponentId(null);
      setComponentDeletionHistory([]);
    }
    setCvConfig(next);
  }

  function deleteComponents(ids: number[]) {
    const uniqueIds = [...new Set(ids)].filter((id) => cvReview.componentDecisions[String(id)] !== "rejected");
    if (!uniqueIds.length) return;
    setComponentDeletionHistory((current) => [...current, uniqueIds.map((id) => ({ id, previous: cvReview.componentDecisions[String(id)] }))]);
    setSelectedComponentIds((current) => current.filter((id) => !uniqueIds.includes(id)));
    setCvReview((current) => ({
      ...current,
      componentDecisions: { ...current.componentDecisions, ...Object.fromEntries(uniqueIds.map((id) => [String(id), "rejected" as const])) },
    }));
  }

  function acceptComponents(ids: number[]) {
    const uniqueIds = [...new Set(ids)].filter((id) => cvReview.componentDecisions[String(id)] !== "accepted");
    if (!uniqueIds.length) return;
    setSelectedComponentIds((current) => current.filter((id) => !uniqueIds.includes(id)));
    setCvReview((current) => ({
      ...current,
      componentDecisions: { ...current.componentDecisions, ...Object.fromEntries(uniqueIds.map((id) => [String(id), "accepted" as const])) },
    }));
  }

  function undoComponentDeletion() {
    const deleted = componentDeletionHistory[componentDeletionHistory.length - 1];
    if (!deleted?.length) return;
    setComponentDeletionHistory((current) => current.slice(0, -1));
    setCvReview((current) => {
      const componentDecisions = { ...current.componentDecisions };
      for (const entry of deleted) {
        if (entry.previous === undefined) delete componentDecisions[String(entry.id)];
        else componentDecisions[String(entry.id)] = entry.previous;
      }
      return { ...current, componentDecisions };
    });
    setSelectedComponentIds(deleted.map((entry) => entry.id));
  }


  function removeLabelPaletteColor(index: number) {
    const color = palette[index];
    if (!color) return;
    setPaletteDeletionHistory((current) => [...current, { color, index }]);
    setPalette((current) => current.filter((_color, colorIndex) => colorIndex !== index));
    setPaletteDirty(true);
  }

  function undoLabelPaletteDeletion() {
    const deleted = paletteDeletionHistory[paletteDeletionHistory.length - 1];
    if (!deleted) return;
    setPaletteDeletionHistory((current) => current.slice(0, -1));
    setPalette((current) => { const next = [...current]; next.splice(Math.min(deleted.index, next.length), 0, deleted.color); return next; });
    setPaletteDirty(true);
  }

  function replaceBottlePalette(nextPalette: BottlePaletteColor[]) {
    const detection = sourceAnalysis?.bottleDetection;
    if (!sourceAnalysis || !detection) return;
    onChangeSourceAnalysis?.({ ...sourceAnalysis, bottleDetection: { ...detection, palette: nextPalette }, outerObject: sourceAnalysis.outerObject ? { ...sourceAnalysis.outerObject, palette: nextPalette } : null });
  }

  function removeBottlePaletteColor(index: number) {
    const palette = sourceAnalysis?.bottleDetection?.palette ?? [];
    const color = palette[index];
    if (!color) return;
    setBottlePaletteDeletionHistory((current) => [...current, { color, index }]);
    replaceBottlePalette(palette.filter((_color, colorIndex) => colorIndex !== index));
  }

  function undoBottlePaletteDeletion() {
    const deleted = bottlePaletteDeletionHistory[bottlePaletteDeletionHistory.length - 1];
    if (!deleted) return;
    const palette = sourceAnalysis?.bottleDetection?.palette ?? [];
    const next = [...palette]; next.splice(Math.min(deleted.index, next.length), 0, deleted.color);
    setBottlePaletteDeletionHistory((current) => current.slice(0, -1));
    replaceBottlePalette(next);
  }

  function handlePointerDown(point: WorkspacePoint, event: ReactPointerEvent<HTMLCanvasElement>, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    if (bottleEyedropperActive && sourceAnalysis?.bottleDetection) {
      event.preventDefault();
      const natural = bottleCanvasPointToNatural(point, context.canvas, context.image, sourceAnalysis.bottleDetection.config.paddingPercent);
      if (!natural) { setBottleEyedropperActive(false); return; }
      const sample = document.createElement("canvas"); sample.width = 1; sample.height = 1;
      const sampleContext = sample.getContext("2d");
      sampleContext?.drawImage(context.image, natural.x, natural.y, 1, 1, 0, 0, 1, 1);
      const pixel = sampleContext?.getImageData(0, 0, 1, 1).data;
      if (pixel) {
        const rgb = [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0];
        const color = { rgb, lab: rgbToLabClient(rgb), ratio: 0 };
        const nextPalette = [...sourceAnalysis.bottleDetection.palette, color];
        onChangeSourceAnalysis?.({ ...sourceAnalysis, bottleDetection: { ...sourceAnalysis.bottleDetection, palette: nextPalette }, outerObject: sourceAnalysis.outerObject ? { ...sourceAnalysis.outerObject, palette: nextPalette } : null });
      }
      setBottleEyedropperActive(false);
      return;
    }
    if (step === "bottle") return;
    if (step === "package") {
      if (!packageEditing) return;
      event.preventDefault();
      const natural = canvasPointToNatural(point, context.canvas, context.image);
      if (!packageDraft) {
        setRoiDrag({ kind: "draw", start: point });
        setPackageDraft(rectangleQuad({ x: natural.x, y: natural.y, width: 1, height: 1 }));
        return;
      }
      const current = packageDraft ?? rectangleQuad({ x: 0, y: 0, width: context.image.naturalWidth, height: context.image.naturalHeight });
      const hit = hitTestQuad(point, current, context.canvas, context.image);
      if (hit?.cornerIndex !== null && hit?.cornerIndex !== undefined) setRoiDrag({ kind: "corner", cornerIndex: hit.cornerIndex, initial: current });
      else if (hit?.inside) setRoiDrag({ kind: "move", start: point, initial: current });
      else setRoiDrag({ kind: "draw", start: point });
      return;
    }
    if (mode !== "edit") return;
    event.preventDefault();
    setZoomLens(readZoomLensState(point, event, context.canvas, context.image));
    const hit = workingGeometry ? hitTestQuad(point, workingGeometry, context.canvas, context.image) : null;
    if (hit?.cornerIndex !== null && hit?.cornerIndex !== undefined) setRoiDrag({ kind: "corner", cornerIndex: hit.cornerIndex, initial: workingGeometry! });
    else if (hit?.inside) setRoiDrag({ kind: "move", start: point, initial: workingGeometry! });
    else setRoiDrag({ kind: "draw", start: point });
    setWorkingRectification(null);
  }

  function selectBottleCandidate(candidateId: string) {
    const detection = sourceAnalysis?.bottleDetection;
    const candidate = detection?.candidates.find((item) => item.id === candidateId);
    if (!sourceAnalysis || !detection || !candidate) return;
    setSelectedBottleCandidateId(candidateId);
    onChangeSourceAnalysis?.({
      ...sourceAnalysis,
      bottleDetection: { ...detection, selectedCandidateId: candidateId, palette: candidate.palette },
      outerObject: { bbox: candidate.bbox, contour: candidate.contour, palette: candidate.palette, confidence: candidate.score, method: detection.algorithm, config: detection.config, warnings: ["DERIVED_BOTTLE_CANDIDATE; NOT_VERIFIED_BOTTLE_GROUND_TRUTH"] },
    });
  }

  async function finishBottle(status: "verified" | "skipped") {
    const workingState = sourceAnalysis;
    const detection = workingState?.bottleDetection;
    if (!workingState || !detection || !onSaveSourceAnalysis) { setStep("ocr"); return; }
    const candidate = detection.candidates.find((item) => item.id === selectedBottleCandidateId);
    if (status === "verified" && !candidate) return;
    const reviewedPalette = detection.palette;
    const verifiedShape = candidate?.rawContour ?? candidate?.polygon;
    const verifiedBbox = verifiedShape ? polygonNaturalBbox(verifiedShape) : candidate?.bbox;
    const updated: LabelSourceAnalysisRun = {
      ...workingState,
      bottleDetection: {
        ...detection,
        selectedCandidateId: candidate?.id ?? null,
        palette: reviewedPalette,
        annotation: status === "skipped" ? { status, verifiedAt: new Date().toISOString() } : {
          status, shape: verifiedShape!, rawContour: candidate!.rawContour, simplifiedContour: candidate!.simplifiedContour, bbox: verifiedBbox!, source: "auto-confirmed", candidateId: candidate!.id, detectionRunId: workingState.runId, verification: { candidateIoU: 1, bboxIoU: 1, contourDistance: 0 }, verifiedAt: new Date().toISOString(),
        },
      },
      outerObject: status === "verified" && verifiedShape && verifiedBbox ? {
        bbox: verifiedBbox,
        contour: verifiedShape,
        palette: reviewedPalette,
        confidence: candidate?.score ?? 0,
        method: `${detection.algorithm}-reviewed-contour`,
        config: detection.config,
        warnings: ["SOURCE_SPACE_PROJECTION_FROM_REVIEWED_PREVIEW_CONTOUR"],
      } : workingState.outerObject,
    };
    onChangeSourceAnalysis?.(updated);
    const saved = await onSaveSourceAnalysis(updated);
    if (!saved) return;
    setBottlePaletteDeletionHistory([]);
    onChangeSourceAnalysis?.(saved);
    setBottleConfig(normalizeBottleConfig(saved.bottleDetection?.config));
    setSelectedBottleCandidateId(saved.bottleDetection?.selectedCandidateId ?? null);
    const snapshot = approvedBottleSnapshotFromState(saved);
    setApprovedBottleSnapshot(snapshot);
    lastApprovedBottleSavedAt.current = snapshot?.savedAt ?? null;
    setStep("ocr");
  }

  function handlePointerMove(point: WorkspacePoint, event: ReactPointerEvent<HTMLCanvasElement>, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    if (step === "package") {
      if (!packageEditing) return;
      if (!roiDrag) {
        const current = packageDraft ?? rectangleQuad({ x: 0, y: 0, width: context.image.naturalWidth, height: context.image.naturalHeight });
        setRoiCursor(cursorForQuadHit(hitTestQuad(point, current, context.canvas, context.image)));
        return;
      }
      const natural = canvasPointToNatural(point, context.canvas, context.image);
      const full = { x: 0, y: 0, width: context.image.naturalWidth, height: context.image.naturalHeight };
      const bounds = { minX: 0, minY: 0, maxX: full.width, maxY: full.height };
      const geometry = roiDrag.kind === "draw"
        ? rectangleQuad(clampRoiToBounds(canvasPointsToNaturalRect(roiDrag.start, point, context.canvas, context.image), full))
        : roiDrag.kind === "move"
          ? (() => { const start = canvasPointToNatural(roiDrag.start, context.canvas, context.image); return moveQuad(roiDrag.initial, natural.x - start.x, natural.y - start.y, bounds); })()
          : roiDrag.kind === "corner" ? moveQuadCorner(roiDrag.initial, roiDrag.cornerIndex, natural, bounds) : null;
      if (geometry) setPackageDraft(geometry);
      return;
    }
    if (mode !== "edit") return;
    setZoomLens(readZoomLensState(point, event, context.canvas, context.image));
    if (!roiDrag) {
      setRoiCursor(cursorForQuadHit(workingGeometry ? hitTestQuad(point, workingGeometry, context.canvas, context.image) : null));
      return;
    }
    const natural = canvasPointToNatural(point, context.canvas, context.image);
    const scopeBounds = packageGeometry?.bbox ?? { x: 0, y: 0, width: context.image.naturalWidth, height: context.image.naturalHeight };
    const movementBounds = { minX: scopeBounds.x, minY: scopeBounds.y, maxX: scopeBounds.x + scopeBounds.width, maxY: scopeBounds.y + scopeBounds.height };
    const geometry = roiDrag.kind === "draw"
      ? rectangleQuad(clampRoiToBounds(canvasPointsToNaturalRect(roiDrag.start, point, context.canvas, context.image), scopeBounds))
      : roiDrag.kind === "move"
        ? (() => {
            const start = canvasPointToNatural(roiDrag.start, context.canvas, context.image);
            return moveQuad(roiDrag.initial, natural.x - start.x, natural.y - start.y, movementBounds);
          })()
        : moveQuadCorner(roiDrag.initial, roiDrag.cornerIndex, natural, movementBounds);
    if (geometry) setWorkingGeometry(geometry);
    setLabelSavedForBottle(false);
  }

  function handlePointerUp() {
    setRoiDrag(null);
  }

  function handlePointerLeave() {
    setZoomLens(null);
    setRoiDrag(null);
    setRoiCursor("crosshair");
  }

  function handleContextMenu() {
    if (mode !== "edit") return;
    setWorkingRoi(null);
    setDraft((current) => ({ ...current, annotation: null, status: current.prediction ? "needs-review" : "unprocessed", reviewed: false, roiEdited: false, source: null, iou: null, labelRoiGt: false, updatedAt: new Date().toISOString() }));
    setRoiDrag(null);
    setZoomLens(null);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName.toLowerCase();
      if (tagName === "input" || tagName === "textarea" || tagName === "select" || target?.isContentEditable) return;
      if (saving) return;

      const key = event.key.toLowerCase();
      if (key === "e") {
        event.preventDefault();
        setMode("edit");
      } else if (key === "n") {
        event.preventDefault();
        markNoLabel();
      } else if (event.key === "Enter" && canSaveCurrentBox) {
        event.preventDefault();
        void saveAndNext();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  useEffect(() => {
    if (step !== "components" || componentDeletionHistory.length === 0) return;
    function handleUndo(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z" || event.shiftKey || isEditableHotkeyTarget(event.target)) return;
      event.preventDefault();
      undoComponentDeletion();
    }
    window.addEventListener("keydown", handleUndo);
    return () => window.removeEventListener("keydown", handleUndo);
  });

  useEffect(() => {
    const canUndo = step === "palette" ? paletteDeletionHistory.length > 0 : step === "bottle" ? bottlePaletteDeletionHistory.length > 0 : false;
    if (!canUndo) return;
    function handleUndo(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z" || event.shiftKey || isEditableHotkeyTarget(event.target)) return;
      event.preventDefault();
      if (step === "palette") undoLabelPaletteDeletion();
      else if (step === "bottle") undoBottlePaletteDeletion();
    }
    window.addEventListener("keydown", handleUndo);
    return () => window.removeEventListener("keydown", handleUndo);
  });

  const labelBranchBlocked = !labelBranchCvEnabled && !["package", "label", "bottle", "summary"].includes(step);
  const externalGraphLabelActive = step === "label" && Boolean(graphLabelWorkspace);
  const externalGraphOcrActive = step === "ocr" && Boolean(graphOcrWorkspace);

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <AnnotationStepper step={step} statuses={wizardStepStatuses} packageApprovalRequired={packageApprovalRequired} labelBranchCvEnabled={labelBranchCvEnabled} branchNavigation={branchNavigation?.({ activeStage: step, openPackageStage: () => { setSummaryBlockedStages([]); setStep("package"); }, openLabelStage: () => { if (!packageApprovalRequired) { setSummaryBlockedStages([]); setStep("label"); } } })} analysisEnabled={Boolean(sourceAnalysis?.bottleDetection?.annotation)} onStepChange={(nextStep) => { if (nextStep === "summary") void saveCvJobAndOpenSummary(); else { setSummaryBlockedStages([]); setStep(nextStep); } }} />
        {labelBranchBlocked && <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"><strong>No Label selected.</strong><p className="mt-1 text-xs">Create or select a Label before opening its OCR and CV stages.</p></div>}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <details className="text-xs text-zinc-500"><summary className="cursor-pointer font-medium">ⓘ Workflow notes</summary><p className="mt-1 max-w-2xl">Package defines the working scope. Reviewed Label ROI is ground truth; OCR and CV stages operate inside its saved crop.</p></details>
          <span className={statusClassName(draft.status)}>{formatStatus(draft.status)}</span>
        </div>
        {labelBranchBlocked ? null : step === "label" && graphLabelWorkspace ? graphLabelWorkspace : step === "label" && !labelBranchCvEnabled ? (
          <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">Select this Label in the branch bar or choose <strong>+ Add label</strong> to open its ROI editor.</div>
        ) : step === "ocr" && graphOcrWorkspace ? graphOcrWorkspace : step === "ocr" && labelBranchCvEnabled ? (
          <OcrRegionEditor
            key={`ocr-regions:${activeOcrSnapshot?.ocr.id ?? "none"}:${ocrRegionReview?.revision ?? 0}`}
            imageUrl={analysis ? analysisCropUrl(analysis) : imageUrl}
            labelRect={analysis ? { x: 0, y: 0, width: analysis.crop.width, height: analysis.crop.height } : editableNatural}
            snapshot={activeOcrSnapshot}
            review={ocrRegionReview}
            saving={saving}
            onSave={async (input) => {
              const saved = await onSaveOcrRegionReview?.(input) ?? null;
              if (saved) setStep("mask");
              return saved;
            }}
            onDirtyChange={setOcrDraftDirty}
            activeRegionId={activeOcrRegionId}
            onActiveRegionChange={setActiveOcrRegionId}
          />
        ) : step === "ocr" ? (
          <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">Select or create a <strong>Label / VisualRegion</strong>, then open its OCR editor.</div>
        ) : (
        <MovableViewerDock title={`${step} viewer`}>
        {(step === "package" || step === "label" || step === "bottle") && imageUrl ? (
          <>
            <ImageWorkspace
              imageUrl={imageUrl}
              mode={step === "package" || step === "label" ? "annotation" : "pipeline-debug"}
              className="rounded border border-zinc-200 bg-zinc-50 touch-none"
              cursor={bottleEyedropperActive ? "crosshair" : roiCursor}
              draw={draw}
              getCanvasSize={getCanvasSize}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerLeave}
              onContextMenu={(_point, event) => {
                event.preventDefault();
                handleContextMenu();
              }}
            />
            {step === "label" && mode === "edit" && <FloatingZoomLens imageUrl={imageUrl} lens={zoomLens} />}
          </>
        ) : step === "package" || step === "label" || step === "bottle" ? (
          <div className="rounded border border-zinc-200 p-4 text-sm text-zinc-500">No source image.</div>
        ) : step === "mask" || step === "morphology" || step === "components" || step === "elements" || step === "contours" ? (
          analysis ? <CvStageDebugger key={`cv-stage:${step}:${ocrRegionReview?.revision ?? 0}`} imageUrl={analysisCropUrl(analysis)} cropTransformMode={analysis.crop.transformMode ?? "legacy-implicit"} cvMeta={{ cvMeta: cvFeatures?.cvDebug ?? {} }} focusStage={step} maskOverride={step === "mask" ? selectedMaskCandidate?.mask : undefined} maskOverrideLabel={step === "mask" ? selectedMaskCandidate?.id : undefined} normalizedContours={step === "contours" ? cvFeatures?.contours ?? [] : []} normalizedRegions={analysisRegions} ocrRegionSource={ocrRegionReview ? "reviewed" : "generated"} normalizedComponents={componentFeatures} componentDecisions={cvReview.componentDecisions} showRejectedComponents={step === "components" && showRejectedComponents} selectedComponentIds={step === "elements" || step === "contours" ? hoveredElementComponentIds : selectedComponentIds} normalizedElements={step === "elements" || step === "contours" ? groupedCvElements : []} selectedElementId={step === "elements" || step === "contours" ? hoveredElementId : null} onElementHover={step === "contours" ? setHoveredElementId : undefined} onComponentClick={step === "components" ? (componentId) => setSelectedComponentIds((current) => current.includes(componentId) ? current.filter((id) => id !== componentId) : [...current, componentId]) : undefined} onComponentHover={step === "elements" ? (componentId) => { setHoveredElementComponentId(componentId); setHoveredElementId(componentId === null ? null : groupedCvElements.find((element) => element.sourceComponentIds.includes(componentId))?.id ?? null); } : undefined} onComponentDelete={step === "components" ? (componentId) => deleteComponents([componentId]) : undefined} onComponentAccept={step === "components" ? (componentId) => acceptComponents([componentId]) : undefined} /> : null
        ) : step === "palette" ? (
          <CropPreview imageUrl={analysis ? analysisCropUrl(analysis) : imageUrl} rect={analysis ? { x: 0, y: 0, width: analysis.crop.width, height: analysis.crop.height } : editableNatural} onPickColor={eyedropperActive ? (rgb) => {
            setPalette((current) => [...current, { rgb, ratio: null, source: "eyedropper" }]);
            setPaletteDirty(true);
            setEyedropperActive(false);
          } : undefined} />
        ) : analysis ? (
          <CvStageDebugger imageUrl={analysisCropUrl(analysis)} cropTransformMode={analysis.crop.transformMode ?? "legacy-implicit"} cvMeta={{ cvMeta: cvFeatures?.cvDebug ?? {} }} normalizedContours={cvFeatures?.contours ?? []} normalizedRegions={analysisRegions} ocrRegionSource={ocrRegionReview ? "reviewed" : "generated"} />
        ) : (
          <CropPreview imageUrl={imageUrl} rect={editableNatural} regions={analysisRegions} showRegions contours={cvFeatures?.contours ?? []} />
        )}
        </MovableViewerDock>
        )}
        {labelBranchCvEnabled && !externalGraphLabelActive && step === "label" && mode === "edit" && (
          <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
            Drag any corner to shape the convex ROI, drag inside to move it, or drag outside to draw a new rectangle. Invalid self-intersecting/concave edits are ignored. Right click resets the ROI.
          </div>
        )}
      </section>

      <aside className="space-y-4">
        <QueueNavigation queueNav={queueNav} saving={saving} />
        {assistantPanel}
        {graphStageControls?.(step)}
        {step === "summary" && packageComposition}
        {!labelBranchBlocked && !externalGraphLabelActive && !externalGraphOcrActive && <AlgorithmBindingCard binding={algorithmBinding} />}
        {!labelBranchBlocked && !externalGraphLabelActive && !externalGraphOcrActive && step !== "package" && <CandidateSelectionCard sample={currentStageSample} fallback={liveCandidateSelection} />}

        {step === "package" && (
          <PackageScopeStepPanel
            geometry={packageDraft}
            persistedGeometry={packageScopeQuad(packageGeometry)}
            editing={packageEditing}
            saving={saving}
            helperRunning={packageHelperRunning}
            helperRun={packageHelperRun}
            selectedCandidateId={selectedPackageCandidateId}
            onRunHelper={() => void runPackageHelper()}
            onSelectCandidate={selectPackageCandidate}
            onEdit={() => setPackageEditing(true)}
            onSave={() => void savePackageScope(packageDraft, Boolean(packageHelperRun && selectedPackageCandidateId))}
            onReset={() => { setSelectedPackageCandidateId(null); void savePackageScope(null); }}
            onContinue={() => void approvePackageAndContinue()}
          />
        )}

        {!labelBranchBlocked && cvSequenceWarning && (
          <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <div className="font-semibold">Stage dependency warning</div>
            <div className="mt-1">{cvSequenceWarning}</div>
            <div className="mt-1 text-xs">You may inspect or edit this stage, but confirm the stale or missing upstream stages before treating downstream output as current.</div>
          </section>
        )}

        {summaryBlockedStages.length > 0 && (
          <section className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
            <div className="font-semibold">Summary is based on an incomplete CV sequence</div>
            <div className="mt-1">Resolve or approve: {summaryBlockedStages.map(formatCvStage).join(", ")}.</div>
            <div className="mt-3 grid grid-cols-2 gap-2"><button type="button" onClick={() => { const first = summaryBlockedStages[0]; if (first) { setSummaryBlockedStages([]); setStep(first); } }} className="h-9 rounded border border-red-300 bg-white text-xs font-medium">Open first problem</button><button type="button" onClick={() => void saveCvJobAndOpenSummary(true)} className="h-9 rounded bg-red-900 text-xs font-semibold text-white">Continue anyway</button></div>
          </section>
        )}

        {labelBranchCvEnabled && !externalGraphLabelActive && step === "label" && (
          <LabelStepPanel
            title={title}
            rect={editableNatural}
            geometry={workingGeometry}
            status={draft.status}
            imageUrl={imageUrl}
            saving={saving}
            canSaveCurrentBox={canSaveCurrentBox}
            bottleEnabled={labelSavedForBottle}
            onBack={() => setStep("package")}
            onEdit={() => setMode("edit")}
            onNoLabel={markNoLabel}
            onInvalidImage={markInvalidImage}
            onSave={save}
            onSaveAndNext={saveAndNext}
            onSaveAndRunAnalysis={saveAndOpenBottle}
            onContinue={() => { setMode("view"); setStep("bottle"); }}
            sourceAnalysis={sourceAnalysis}
            activeCandidateId={activeSourceCandidateId}
            selectedCandidateId={draft.prediction?.candidateId ?? null}
            selectionMode={liveCandidateSelection?.mode ?? null}
            autoLabelConfig={autoLabelConfig}
            autoLabelConfigDirty={autoLabelConfigDirty}
            siglipLabelMode={siglipLabelMode}
            dinoLabelMode={dinoLabelMode}
            autoLabelOverlays={autoLabelOverlays}
            onAutoLabelConfigChange={(next) => { setAutoLabelConfig(next); setAutoLabelConfigDirty(true); }}
            onSiglipLabelModeChange={setSiglipLabelMode}
            onDinoLabelModeChange={setDinoLabelMode}
            onAutoLabelOverlaysChange={setAutoLabelOverlays}
            onCandidateHover={setActiveSourceCandidateId}
            onUseCandidate={useSourceCandidate}
            onAutoDetect={() => onRunSourceAnalysis ? onRunSourceAnalysis(undefined, undefined, autoLabelConfig, { labelMode: siglipLabelMode, dinoMode: dinoLabelMode }) : Promise.resolve(null)}
          />
        )}

        {step === "bottle" && (
          <BottleContextStage
            state={sourceAnalysis}
            config={bottleConfig}
            overlays={bottleOverlays}
            selectedCandidateId={selectedBottleCandidateId}
            saving={saving}
            eyedropperActive={bottleEyedropperActive}
            onConfigChange={setBottleConfig}
            onOverlayChange={setBottleOverlays}
            onSelectCandidate={selectBottleCandidate}
            onRun={() => {
              setBottlePaletteDeletionHistory([]);
              const verifiedLabel = reviewedNatural ?? (labelSavedForBottle ? workingRoi ?? undefined : undefined);
              return onRunSourceAnalysis
                ? onRunSourceAnalysis(verifiedLabel, { ...bottleConfig, processingMode: "preview" }, autoLabelConfig, { labelMode: siglipLabelMode, dinoMode: dinoLabelMode })
                : Promise.resolve(null);
            }}
            onRemoveColor={removeBottlePaletteColor}
            onUndoColor={undoBottlePaletteDeletion}
            canUndoColor={bottlePaletteDeletionHistory.length > 0}
            onToggleEyedropper={() => setBottleEyedropperActive((current) => !current)}
            onAccept={() => finishBottle("verified")}
            onSkip={() => finishBottle("skipped")}
            onBack={() => setStep("label")}
          />
        )}

        {labelBranchCvEnabled && !externalGraphOcrActive && step === "ocr" && (
          <TextStepPanel
            analysis={analysis}
            analysisStale={Boolean(analysisWorkspace?.stale)}
            ocrRegionReview={ocrRegionReview}
            catalogCandidates={analysisWorkspace?.summary.catalogCandidates ?? analysis?.catalogCandidates ?? []}
            sourceAssociationWorkspace={sourceAssociationWorkspace}
            onRunAnalysis={onRunAnalysis ? runAnalysisFromOcr : undefined}
            onSaveSourceAssociationReview={onSaveSourceAssociationReview}
            catalogIdentityReview={analysisWorkspace?.catalogIdentityReview}
            onSaveCatalogIdentityReview={onSaveCatalogIdentityReview}
            saving={saving}
            onActiveRegionChange={setActiveOcrRegionId}
            onBack={() => setStep("bottle")}
            onContinue={() => setStep("mask")}
          />
        )}

        {labelBranchCvEnabled && step === "mask" && (
          <CvConfigStepPanel
            stage="mask"
            title="Binary mask"
            description={`Separate meaningful foreground from label background before morphology and components. ${formatEffectiveMask(cvFeatures?.cvDebug)}`}
            config={cvConfig}
            maskCandidates={reviewedMaskCandidates}
            previewing={cvPreviewing || runningMaskPreview}
            disabled={!analysis || Boolean(analysisWorkspace?.stale)}
            maskCanContinue={maskCanContinue && !cvPreviewing && !runningMaskPreview}
            onRunMaskPreview={() => void runMaskAutoPreview()}
            onChange={updateCvConfig}
            onReset={() => updateCvConfig(DEFAULT_ANALYSIS_CV_CONFIG)}
            onBack={() => setStep("ocr")}
            onContinue={() => void saveCvCheckpointAndContinue("mask", "morphology")}
          />
        )}

        {labelBranchCvEnabled && step === "morphology" && (
          <CvConfigStepPanel
            stage="morphology"
            title="Morphology"
            description={`Prepare connectivity: green pixels were added, red pixels removed, white foreground stayed unchanged. ${formatEffectiveMorphology(cvFeatures?.cvDebug)}`}
            config={cvConfig}
            morphologyCandidates={morphologyCandidates}
            previewing={cvPreviewing}
            disabled={!analysis || Boolean(analysisWorkspace?.stale)}
            onChange={updateCvConfig}
            onReset={() => updateCvConfig(DEFAULT_ANALYSIS_CV_CONFIG)}
            onBack={() => setStep("mask")}
            onContinue={() => void saveCvCheckpointAndContinue("morphology", "components")}
          />
        )}

        {labelBranchCvEnabled && step === "components" && (
          <ComponentsStepPanel
            components={componentFeatures}
            config={cvConfig}
            candidates={componentCandidates}
            previewing={cvPreviewing}
            disabled={!analysis || Boolean(analysisWorkspace?.stale)}
            decisions={cvReview.componentDecisions}
            selectedIds={selectedComponentIds}
            showRejectedOnCanvas={showRejectedComponents}
            onShowRejectedOnCanvas={setShowRejectedComponents}
            onConfigChange={updateCvConfig}
            onDelete={deleteComponents}
            onAccept={acceptComponents}
            onUndoDelete={undoComponentDeletion}
            canUndoDelete={componentDeletionHistory.length > 0}
            onSelect={(id) => setSelectedComponentIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id])}
            onBack={() => setStep("morphology")}
            onContinue={() => void saveCvCheckpointAndContinue("components", "elements")}
          />
        )}

        {labelBranchCvEnabled && step === "elements" && (
          <ElementsStepPanel
            elements={groupedCvElements}
            ungroupedComponents={ungroupedElementComponents}
            hoveredElementId={hoveredElementId}
            hoveredComponentId={hoveredElementComponentId}
            onHoverElement={setHoveredElementId}
            onHoverComponent={setHoveredElementComponentId}
            onChange={(elements) => setCvReview((current) => ({ ...current, elementsReviewed: true, elements }))}
            onRebuildAutoGroups={() => {
              setHoveredElementId(null); setHoveredElementComponentId(null);
              setCvReview((current) => ({ ...current, elementsReviewed: undefined, elements: [] }));
            }}
            rebuilding={cvPreviewing}
            onBack={() => setStep("components")}
            onContinue={(elements) => {
              const reviewedElements = elements.map((element) => ({ ...elementReviewDraft(element), status: "accepted" as const }));
              void saveCvCheckpointAndContinue("elements", "contours", { ...cvReview, elementsReviewed: true, elements: reviewedElements });
            }}
          />
        )}

        {labelBranchCvEnabled && step === "contours" && (
          <ContoursStepPanel
            elements={groupedCvElements}
            contours={cvFeatures?.contours ?? []}
            config={cvConfig}
            previewing={cvPreviewing}
            disabled={!analysis || Boolean(analysisWorkspace?.stale)}
            onChange={updateCvConfig}
            onReset={() => updateCvConfig(DEFAULT_ANALYSIS_CV_CONFIG)}
            hoveredElementId={hoveredElementId}
            onHoverElement={setHoveredElementId}
            onBack={() => setStep("elements")}
            onContinue={() => void saveCvCheckpointAndContinue("contours", "palette")}
          />
        )}

        {labelBranchCvEnabled && step === "palette" && (
          <PaletteStepPanel
            config={cvConfig}
            palette={palette}
            previewing={cvPreviewing || runningPalettePreview}
            autoRan={paletteAutoRanScope === maskCandidateScope}
            paletteModified={paletteDirty}
            canRunAuto={Boolean(onPreviewCvJob && analysis && !analysisWorkspace?.stale)}
            onRunAuto={() => void runPaletteAutoPreview()}
            eyedropperActive={eyedropperActive}
            onConfigChange={setCvConfig}
            onRemove={removeLabelPaletteColor}
            onUndoRemove={undoLabelPaletteDeletion}
            canUndoRemove={paletteDeletionHistory.length > 0}
            onToggleEyedropper={() => setEyedropperActive((current) => !current)}
            onSave={saveCvJobOnly}
            onBack={() => setStep("contours")}
            onContinue={saveCvJobAndOpenSummary}
            saving={saving}
          />
        )}

        {step === "summary" && (
          <>
            <AnalysisReviewStepPanel
              rect={editableNatural}
              sourceAnalysis={sourceAnalysis}
              workspace={analysisWorkspace}
              saving={saving}
              onBackToLabel={() => setStep("label")}
              onBackToAnalysis={() => setStep("palette")}
              onReview={onReviewAnalysis}
              canonicalConfirmation={canonicalSummaryConfirmation}
              onDirtyChange={setSummaryReviewDirty}
              annotationValidation={annotationValidation}
            />
          </>
        )}
      </aside>
    </section>
  );
}

function AlgorithmBindingCard({ binding }: { binding: StageAlgorithmBinding }) {
  return <section className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-950">
    <div className="flex items-start justify-between gap-3"><div><div className="font-semibold uppercase tracking-wide">Algorithm binding</div><div className="mt-1 font-mono text-[11px]">{binding.helperId} · {binding.algorithm}</div></div><span className={`shrink-0 rounded px-2 py-1 text-[10px] font-bold uppercase ${binding.persisted ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{binding.persisted ? binding.status : "draft"}</span></div>
    <div className="mt-2 text-[11px] text-indigo-700">Target: <span className="font-mono">{binding.targetRef}</span></div>
    <div className="mt-1 text-[11px] text-indigo-700">Config schema: <span className="font-mono">v{binding.configSchemaVersion}</span>{binding.runId ? <> / Run: <span className="font-mono">{binding.runId}</span></> : null}</div>
    <details className="mt-2 rounded border border-indigo-200 bg-white p-2"><summary className="cursor-pointer font-semibold">Read-only helper config</summary><RawJsonBlock value={binding.config} containerClassName="mt-2" className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[10px] leading-4 text-zinc-100" /></details>
  </section>;
}

function CandidateSelectionCard({ sample, fallback }: { sample?: StageSampleV1; fallback: { runId: string | null; candidateId: string | null; mode: CandidateReviewDisplayMode } | null }) {
  const persistedMode = displayReviewMode(sample?.execution.reviewMode ?? null);
  const selection = sample?.execution.selection ?? null;
  const mode = fallback?.mode ?? persistedMode;
  const candidateId = fallback ? fallback.candidateId : selection?.candidateId ?? null;
  const runId = fallback ? fallback.runId : selection?.runId ?? null;
  const run = runId ? sample?.execution.runs.find((item) => item.id === runId) : null;
  return <section className="rounded-lg border border-zinc-200 bg-white p-3 text-xs">
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="font-semibold uppercase tracking-wide text-zinc-700">Annotation origin</div>
        <div className="mt-1 text-zinc-500">{candidateId ? "Helper candidate selected" : mode === "manual" ? "Created by annotator" : "No candidate selected"}</div>
      </div>
      <span className={`shrink-0 rounded px-2 py-1 text-[10px] font-bold uppercase ${candidateReviewModeClass(mode)}`}>{mode ?? "not reviewed"}</span>
    </div>
    {candidateId ? <div className="mt-2 break-all font-mono text-[11px] text-zinc-700">Candidate: {candidateId}</div> : null}
    {runId && !run ? <div className="mt-1 text-[11px] text-zinc-500">Run: <span className="font-mono">{runId}</span></div> : null}
    {run ? <div className="mt-1 text-[11px] text-zinc-500">Run #{run.runIndex} · <span className="font-mono">{run.id}</span></div> : null}
  </section>;
}

function currentCandidateSelection(
  step: AnnotationStep,
  annotation: LabelAnnotationState,
  workingGeometry: QuadGeometry | null,
  sourceAnalysis: LabelSourceAnalysisRun | null | undefined,
  selectedBottleCandidateId: string | null,
): { runId: string | null; candidateId: string | null; mode: CandidateReviewDisplayMode } | null {
  if (step === "label") {
    const candidateId = annotation.prediction?.candidateId ?? annotation.prediction?.id ?? null;
    const runId = annotation.prediction?.helperRunId ?? null;
    if (annotation.source === "auto") return { runId, candidateId, mode: "unchanged" };
    if (annotation.source === "corrected") return { runId, candidateId, mode: "changed" };
    if (annotation.source === "manual") return { runId: null, candidateId: null, mode: "manual" };
    if (annotation.prediction && workingGeometry) return { runId, candidateId, mode: sameQuad(normalizeQuad(annotation.prediction.geometry, annotation.prediction.roi), workingGeometry) ? "unchanged" : "changed" };
    return workingGeometry ? { runId: null, candidateId: null, mode: "manual" } : null;
  }
  if (step === "bottle") {
    const bottleAnnotation = sourceAnalysis?.bottleDetection?.annotation;
    if (bottleAnnotation?.status === "verified") {
      return {
        runId: null, candidateId: bottleAnnotation.candidateId ?? null,
        mode: bottleAnnotation.source === "auto-edited" ? "changed" : bottleAnnotation.source === "manual" ? "manual" : "unchanged",
      };
    }
    return selectedBottleCandidateId ? { runId: null, candidateId: selectedBottleCandidateId, mode: "unchanged" } : null;
  }
  return null;
}

function displayReviewMode(mode: StageSampleV1["execution"]["reviewMode"]): CandidateReviewDisplayMode | null {
  if (mode === "accepted") return "unchanged";
  if (mode === "corrected") return "changed";
  if (mode === "manual") return "manual";
  return null;
}

function candidateIdentity(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" ? candidate.id : typeof candidate.candidateId === "string" ? candidate.candidateId : null;
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0
    ? value as Record<string, unknown>
    : null;
}

function candidateReviewModeClass(mode: CandidateReviewDisplayMode | null) {
  if (mode === "unchanged") return "bg-emerald-100 text-emerald-800";
  if (mode === "changed") return "bg-amber-100 text-amber-800";
  if (mode === "manual") return "bg-sky-100 text-sky-800";
  return "bg-zinc-100 text-zinc-600";
}

function buildStageAlgorithmBinding(step: AnnotationStep, labelPrediction: LabelAnnotationState["prediction"], sourceAnalysis: LabelSourceAnalysisRun | null | undefined, ocrEvidence: OcrCascadeEvidence | null, cvJob: LabelCvJob | null, draftConfig: LabelAnalysisCvConfig, autoLabelConfig: AutoLabelConfigV1, bottleConfig: BottleDetectionConfig, summaryPersisted: boolean): StageAlgorithmBinding {
  if (step === "package") return {
    helperId: "package-scope", algorithm: "manual-package-scope-v1",
    configSchemaVersion: 1, config: { defaultScope: "full-image", coordinateSpace: "source-image", geometry: "quad" },
    persisted: true, status: "bound", targetRef: "Package.scope",
  };
  if (step === "label") {
    const predictionConfig = nonEmptyRecord(labelPrediction?.algorithm.params);
    const runConfig = sourceAnalysis?.labelDetection?.config ?? nonEmptyRecord(sourceAnalysis?.winningDetection?.config);
    const latestRun = sourceAnalysis?.labelStageExecution?.helperRuns.at(-1) ?? null;
    return {
      helperId: "label-roi-detection", algorithm: labelPrediction?.algorithm.id ?? sourceAnalysis?.algorithm ?? "label-hybrid-v2",
      configSchemaVersion: 1, runId: labelPrediction?.helperRunId ?? latestRun?.id ?? null,
      config: labelPrediction ? predictionConfig ?? { availability: "unavailable", reason: "legacy-config-not-captured" } : runConfig ?? autoLabelConfig,
      persisted: Boolean(labelPrediction?.id), status: labelPrediction ? "bound" : sourceAnalysis ? "generated" : "draft", targetRef: "label",
    };
  }
  if (step === "bottle") return {
    helperId: "bottle-outline", algorithm: sourceAnalysis?.bottleDetection?.algorithm ?? "bottle-border-flood-v2",
    configSchemaVersion: 1, runId: sourceAnalysis?.runId ?? null,
    config: sourceAnalysis?.bottleDetection?.config ?? bottleConfig, persisted: Boolean(sourceAnalysis?.savedAt && sourceAnalysis.bottleDetection?.annotation),
    status: sourceAnalysis?.bottleDetection?.annotation?.status ?? "unreviewed", targetRef: "vision.annotations.bottle",
  };
  if (step === "ocr") return {
    helperId: "label-ocr-cascade", algorithm: ocrEvidence?.profileVersion ?? "tesseract-cascade-v6",
    configSchemaVersion: 1,
    config: ocrEvidence ? { profileVersion: ocrEvidence.profileVersion, engine: "tesseract.js", languages: ["rus", "eng"], passes: ocrEvidence.passes.map(ocrPassConfig) } : DEFAULT_OCR_HELPER_CONFIG,
    persisted: Boolean(ocrEvidence), status: ocrEvidence ? "bound" : "draft", targetRef: "ocrRegions",
  };
  const savedConfig = cvJob?.config ?? draftConfig;
  if (step === "summary") return {
    helperId: "label-summary", algorithm: "label-summary-v1",
    configSchemaVersion: 1, runId: cvJob?.analysisJobId ?? null,
    config: { sourceMatching: "tokenized-catalog-v1", verifiedOcrOnly: true },
    persisted: summaryPersisted, status: summaryPersisted ? "reviewed" : "unreviewed", targetRef: "summary",
  };
  const checkpoint = cvJob?.workflow?.checkpoints?.[step];
  const definitions: Record<LabelCvStage, { helperId: string; algorithm: string; targetRef: string }> = {
    mask: { helperId: "label-mask", algorithm: "binary-mask-variant-search-v1", targetRef: "vision.cvMeta.mask" },
    morphology: { helperId: "label-morphology", algorithm: "label-morphology-v1", targetRef: "vision.cvMeta.morphology" },
    components: { helperId: "label-components", algorithm: "connected-components-v2", targetRef: "vision.annotations.componentDecisions" },
    elements: { helperId: "label-elements", algorithm: "element-grouping-v1", targetRef: "vision.annotations.elements" },
    contours: { helperId: "label-contours", algorithm: "component-contours-v2", targetRef: "vision.annotations.contours" },
    palette: { helperId: "label-palette", algorithm: "label-palette-v1", targetRef: "vision.annotations.palette" },
  };
  const definition = definitions[step];
  return { ...definition, configSchemaVersion: 1, runId: cvJob?.analysisJobId ?? null, config: stageHelperConfig(step, savedConfig), persisted: Boolean(checkpoint), status: checkpoint?.status ?? "unreviewed" };
}

function ocrPassConfig(pass: OcrCascadeEvidence["passes"][number]) {
  return { id: pass.id, stage: pass.stage, region: pass.region, preprocess: pass.preprocess, psm: pass.psm, minWidth: pass.minWidth, weight: pass.weight, deskewAngleDegrees: pass.deskewAngleDegrees ?? null, rotationDegrees: pass.rotationDegrees ?? null };
}

function stageHelperConfig(stage: LabelCvStage, config: LabelAnalysisCvConfig): Record<string, unknown> {
  const mask = { threshold: config.threshold, invert: config.invert, maskSize: config.maskSize, maskMode: config.maskMode };
  const morphology = { morphologyEnabled: config.morphologyEnabled, morphologyOperation: config.morphologyOperation, morphologyKernelWidth: config.morphologyKernelWidth, morphologyKernelHeight: config.morphologyKernelHeight, morphologyIterations: config.morphologyIterations, morphologyMode: config.morphologyMode, morphologyPipeline: config.morphologyPipeline ?? null };
  const components = { componentFilterPreset: config.componentFilterPreset, componentMode: config.componentMode, componentConnectivity: config.componentConnectivity, minComponentAreaRatio: config.minComponentAreaRatio, maxComponentAreaRatio: config.maxComponentAreaRatio };
  if (stage === "mask") return mask;
  if (stage === "morphology") return morphology;
  if (stage === "components") return components;
  if (stage === "elements") return { groupingPrimary: "ocr-overlap", groupingFallback: "proximity-alignment" };
  if (stage === "contours") return { maxContourPoints: config.maxContourPoints, contourDetail: config.contourDetail, contourSimplifyRatio: config.contourSimplifyRatio, contourVectorization: config.contourVectorization };
  return { paletteColors: config.paletteColors, paletteMinRatio: config.paletteMinRatio };
}

function AnnotationStepper({ step, statuses, packageApprovalRequired, labelBranchCvEnabled, branchNavigation, analysisEnabled, onStepChange }: { step: AnnotationStep; statuses: Partial<Record<AnnotationStep, WizardStepStatus>>; packageApprovalRequired: boolean; labelBranchCvEnabled: boolean; branchNavigation?: ReactNode; analysisEnabled: boolean; onStepChange: (step: AnnotationStep) => void }) {
  const renderStep = (item: { id: AnnotationStep; label: string }) => {
    const requiresSelectedLabel = !["package", "label", "bottle", "summary"].includes(item.id);
    const requiresAnalysis = ["mask", "morphology", "components", "elements", "contours", "palette"].includes(item.id);
    const disabled = packageApprovalRequired || (requiresSelectedLabel && !labelBranchCvEnabled) || (requiresAnalysis && !analysisEnabled);
    const status = statuses[item.id] ?? "missing";
    const blocked = disabled;
    const summaryStatus = item.id === "summary"
      ? status === "saved" ? "reviewed" : status === "modified" ? "ready" : "not ready"
      : null;
    const disabledTitle = packageApprovalRequired
      ? "Approve the Package stage to create the first annotation version"
      : requiresSelectedLabel && !labelBranchCvEnabled
      ? "Add or select a Label / VisualRegion first"
      : "Run label analysis for the selected Label first";
    return <button key={item.id} type="button" disabled={disabled} onClick={() => onStepChange(item.id)}
      title={disabled ? disabledTitle : `${item.label}: ${status}`}
      className={`inline-flex h-9 items-center gap-2 rounded border px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40 ${step === item.id ? "border-zinc-950 bg-zinc-950 text-white" : stepStatusButtonClass(status)}`}>
      <span>{item.label}</span><span className={`rounded px-1 py-0.5 text-[9px] font-bold uppercase leading-none ${step === item.id ? "bg-white/20 text-white" : blocked ? "bg-zinc-100 text-zinc-500" : summaryStatus === "not ready" ? "bg-zinc-200 text-zinc-700" : summaryStatus === "ready" ? "bg-sky-200 text-sky-900" : stepStatusBadgeClass(status)}`}>{blocked ? "blocked" : summaryStatus ?? status}</span>
    </button>;
  };
  const pipelineSteps: Array<{ id: AnnotationStep; label: string }> = [
    { id: "bottle", label: "3 Object Context" },
    { id: "ocr", label: "4 OCR" }, { id: "mask", label: "5 Mask" },
    { id: "morphology", label: "6 Morphology" }, { id: "components", label: "7 Components" }, { id: "elements", label: "8 Elements" },
    { id: "contours", label: "9 Contours" }, { id: "palette", label: "10 Palette" },
    { id: "summary", label: "11 Summary" },
  ];
  return <div className="mb-4 flex flex-wrap items-center gap-2 rounded border border-zinc-200 bg-zinc-50 p-3">
    {branchNavigation}
    {pipelineSteps.map(renderStep)}
  </div>;
}

function LabelStepPanel({
  title,
  rect,
  geometry,
  status,
  imageUrl,
  saving,
  canSaveCurrentBox,
  bottleEnabled,
  onBack,
  onEdit,
  onNoLabel,
  onInvalidImage,
  onSave,
  onSaveAndNext,
  onSaveAndRunAnalysis,
  onContinue,
  sourceAnalysis,
  activeCandidateId,
  selectedCandidateId,
  selectionMode,
  autoLabelConfig,
  autoLabelConfigDirty,
  siglipLabelMode,
  dinoLabelMode,
  autoLabelOverlays,
  onAutoLabelConfigChange,
  onSiglipLabelModeChange,
  onDinoLabelModeChange,
  onAutoLabelOverlaysChange,
  onCandidateHover,
  onUseCandidate,
  onAutoDetect,
}: {
  title: string;
  rect: RecognitionRoi | null;
  geometry: QuadGeometry | null;
  status: LabelAnnotationStatus;
  imageUrl: string | null;
  saving: boolean;
  canSaveCurrentBox: boolean;
  bottleEnabled: boolean;
  onBack: () => void;
  onEdit: () => void;
  onNoLabel: () => void;
  onInvalidImage: () => void;
  onSave: () => void;
  onSaveAndNext: () => Promise<void>;
  onSaveAndRunAnalysis?: () => Promise<void>;
  onContinue: () => void;
  sourceAnalysis?: LabelSourceAnalysisRun | null;
  activeCandidateId: string | null;
  selectedCandidateId: string | null;
  selectionMode: CandidateReviewDisplayMode | null;
  autoLabelConfig: AutoLabelConfigV1;
  autoLabelConfigDirty: boolean;
  siglipLabelMode: SiglipLabelMode;
  dinoLabelMode: DinoLabelMode;
  autoLabelOverlays: AutoLabelOverlayState;
  onAutoLabelConfigChange: (config: AutoLabelConfigV1) => void;
  onSiglipLabelModeChange: (mode: SiglipLabelMode) => void;
  onDinoLabelModeChange: (mode: DinoLabelMode) => void;
  onAutoLabelOverlaysChange: (overlays: AutoLabelOverlayState) => void;
  onCandidateHover: (id: string | null) => void;
  onUseCandidate: (candidate: LabelSourceCandidate) => void;
  onAutoDetect: () => Promise<LabelSourceAnalysisRun | null | undefined>;
}) {
  const sourceCandidates = Array.isArray(sourceAnalysis?.candidates) ? sourceAnalysis.candidates : [];
  const hasSourceAnalysis = Boolean(sourceAnalysis && Array.isArray(sourceAnalysis.candidates));

  return (
    <>
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="text-sm font-semibold uppercase text-zinc-500">Label ROI</h3>
        <div className="mt-3 grid gap-2 text-sm text-zinc-600">
          <Field label="Item" value={title} />
          <Field label="Current bbox" value={rect ? formatRect(rect) : "-"} />
        </div>
      </section>
      <section className="rounded-lg border border-sky-200 bg-sky-50 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold uppercase text-sky-900">Auto label helper</h3>
          <div className="flex items-center gap-2">
            <select aria-label="SigLIP2 mode" value={siglipLabelMode} onChange={(event) => onSiglipLabelModeChange(event.target.value as SiglipLabelMode)} className="h-8 rounded border border-sky-300 bg-white px-2 text-xs text-zinc-900">
              <option value="off">SigLIP off</option>
              <option value="score-only">SigLIP score only</option>
              <option value="rerank">SigLIP rerank</option>
            </select>
            <select aria-label="DINOv3 mode" value={dinoLabelMode} onChange={(event) => onDinoLabelModeChange(event.target.value as DinoLabelMode)} className="h-8 rounded border border-emerald-300 bg-white px-2 text-xs text-emerald-950">
              <option value="off">DINO off</option>
              <option value="observe">DINO observe</option>
              <option value="refine">DINO refine ROI</option>
            </select>
            <button type="button" onClick={() => void onAutoDetect()} disabled={saving} className="h-8 rounded bg-sky-900 px-3 text-xs font-semibold text-white disabled:opacity-50">Auto detect</button>
          </div>
        </div>
        {sourceAnalysis?.semanticEvidence?.status === "disabled" && sourceAnalysis.semanticEvidence.mode !== "off" && <div className="mt-3 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">SigLIP2 was requested but is disabled by the server feature gate; CV ordering was preserved.</div>}
        {sourceAnalysis?.structuralEvidence?.status === "disabled" && sourceAnalysis.structuralEvidence.mode !== "off" && <div className="mt-3 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">DINOv3 was requested but is disabled by the server feature gate; CV/SigLIP ranking was preserved.</div>}
        <div className="mt-3 grid gap-3 rounded border border-sky-200 bg-white p-3">
          <div className="flex items-center justify-between text-xs text-sky-900"><span className="font-semibold">Detection config</span><span>{autoLabelConfigDirty ? "updating…" : hasSourceAnalysis ? `${sourceCandidates.length} candidate(s)` : "not run"}</span></div>
          {hasSourceAnalysis && <div className={`rounded px-2 py-1 text-[11px] font-semibold ${sourceAnalysis?.labelDetection?.debug.packageAware?.mode === "package-aware" ? "bg-emerald-50 text-emerald-800" : "bg-zinc-100 text-zinc-600"}`}>{sourceAnalysis?.labelDetection?.debug.packageAware?.mode === "package-aware" ? sourceAnalysis.labelDetection.debug.packageAware.source === "accepted-package-helper" ? "Package-aware · accepted smart-lasso contour" : sourceAnalysis.labelDetection.debug.packageAware.source === "runtime-package-helper" ? "Package-aware · runtime smart-lasso contour" : "Package-aware · reviewed Package geometry" : "Standalone · reviewed Package geometry unavailable"}</div>}
          {sourceAnalysis?.semanticEvidence?.status === "available" && <div className="rounded bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-800">SigLIP2 · {sourceAnalysis.semanticEvidence.mode} · {sourceAnalysis.semanticEvidence.conceptSet.id} · cache {sourceAnalysis.semanticEvidence.cache.hits}/{sourceAnalysis.semanticEvidence.cache.hits + sourceAnalysis.semanticEvidence.cache.misses}</div>}
          {sourceAnalysis?.semanticEvidence?.status === "unavailable" && <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">SigLIP2 unavailable · CV ranking preserved · {sourceAnalysis.semanticEvidence.error?.message ?? "service error"}</div>}
          {sourceAnalysis?.labelDetection?.ocrScout?.status === "completed" && <div className="rounded bg-cyan-50 px-2 py-1 text-[11px] font-semibold text-cyan-800">OCR scout · {sourceAnalysis.labelDetection.ocrScout.lineCount ?? 0} lines · {sourceAnalysis.labelDetection.ocrScout.clusterCount ?? 0} Label proposal(s)</div>}
          {sourceAnalysis?.labelDetection?.ocrScout?.status === "unavailable" && <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">OCR scout unavailable · {sourceAnalysis.labelDetection.ocrScout.error ?? "runtime error"}</div>}
          {sourceAnalysis?.structuralEvidence?.status === "available" && <div className="rounded bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-800">DINOv3 · {sourceAnalysis.structuralEvidence.mode} · {sourceAnalysis.structuralEvidence.artifact?.storage?.startsWith("numpy") ? "GPU miner dense.npy" : sourceAnalysis.structuralEvidence.artifact?.cacheHit ? "artifact cache hit" : "new dense artifact"} · {sourceAnalysis.structuralEvidence.preprocessing.inputLongSide}px · ranking unchanged</div>}
          {sourceAnalysis?.structuralEvidence?.status === "unavailable" && <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">DINOv3 unavailable · ranking preserved · {sourceAnalysis.structuralEvidence.error?.message ?? "service error"}</div>}
          {hasSourceAnalysis && !["label-multi-family-consensus-v8"].includes(sourceAnalysis?.algorithm ?? "") && <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-900">Stale Label helper result ({sourceAnalysis?.algorithm}). Run Auto detect to apply package-aware OCR/DINO refinement.</div>}
          <ConfigSlider label="Preview max side" value={autoLabelConfig.previewMaxSide} min={256} max={960} step={32} displayValue={`${autoLabelConfig.previewMaxSide}px`} onChange={(previewMaxSide) => onAutoLabelConfigChange({ ...autoLabelConfig, previewMaxSide })} />
          <ConfigSlider label="Chroma tolerance" value={autoLabelConfig.chromaTolerance} min={4} max={80} onChange={(chromaTolerance) => onAutoLabelConfigChange({ ...autoLabelConfig, chromaTolerance })} />
          <ConfigSlider label="Minimum lightness" value={autoLabelConfig.minimumLightness} min={40} max={240} onChange={(minimumLightness) => onAutoLabelConfigChange({ ...autoLabelConfig, minimumLightness })} />
          <ConfigSlider label="Minimum region width" value={autoLabelConfig.minRegionWidthRatio * 100} min={10} max={90} displayValue={`${Math.round(autoLabelConfig.minRegionWidthRatio * 100)}%`} onChange={(value) => onAutoLabelConfigChange({ ...autoLabelConfig, minRegionWidthRatio: value / 100 })} />
          <ConfigSlider label="Maximum region width" value={autoLabelConfig.maxRegionWidthRatio * 100} min={50} max={100} displayValue={`${Math.round(autoLabelConfig.maxRegionWidthRatio * 100)}%`} onChange={(value) => onAutoLabelConfigChange({ ...autoLabelConfig, maxRegionWidthRatio: value / 100 })} />
          <ConfigSlider label="Row gap tolerance" value={autoLabelConfig.rowGapRatio * 100} min={1} max={30} step={0.5} displayValue={`${(autoLabelConfig.rowGapRatio * 100).toFixed(1)}%`} onChange={(value) => onAutoLabelConfigChange({ ...autoLabelConfig, rowGapRatio: value / 100 })} />
          <ConfigSlider label="Minimum band coverage" value={autoLabelConfig.minimumBandCoverage * 100} min={15} max={95} displayValue={`${Math.round(autoLabelConfig.minimumBandCoverage * 100)}%`} onChange={(value) => onAutoLabelConfigChange({ ...autoLabelConfig, minimumBandCoverage: value / 100 })} />
          <details><summary className="cursor-pointer text-xs font-semibold text-sky-900">Advanced envelope</summary><div className="mt-3 grid gap-3"><ConfigSlider label="Envelope coverage" value={autoLabelConfig.envelopeCoverage * 100} min={20} max={100} displayValue={`${Math.round(autoLabelConfig.envelopeCoverage * 100)}%`} onChange={(value) => onAutoLabelConfigChange({ ...autoLabelConfig, envelopeCoverage: value / 100 })} /><ConfigSlider label="Envelope size multiplier" value={autoLabelConfig.envelopeSizeMultiplier} min={1} max={4} step={0.05} displayValue={`${autoLabelConfig.envelopeSizeMultiplier.toFixed(2)}×`} onChange={(envelopeSizeMultiplier) => onAutoLabelConfigChange({ ...autoLabelConfig, envelopeSizeMultiplier })} /></div></details>
          <button type="button" onClick={() => onAutoLabelConfigChange(DEFAULT_AUTO_LABEL_CONFIG)} className="h-8 rounded border border-sky-300 text-xs font-medium text-sky-900">Reset defaults</button>
        </div>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-sky-900">
          {(Object.keys(autoLabelOverlays) as Array<keyof AutoLabelOverlayState>).map((key) => <label key={key} className="flex items-center gap-1"><input type="checkbox" checked={autoLabelOverlays[key]} onChange={(event) => onAutoLabelOverlaysChange({ ...autoLabelOverlays, [key]: event.target.checked })} /> {formatAutoLabelOverlay(key)}</label>)}
        </div>
        {!hasSourceAnalysis ? <p className="mt-3 text-xs leading-5 text-sky-800">Optional helper. A candidate becomes annotation only after explicit selection.</p> : <div className="mt-3 space-y-2">
          {sourceCandidates.map((candidate, index) => (
            <button key={candidate.id} type="button" onMouseEnter={() => onCandidateHover(candidate.id)} onMouseLeave={() => onCandidateHover(null)} onClick={() => onUseCandidate(candidate)} className={`w-full rounded border p-2 text-left text-xs ${selectedCandidateId === candidate.id ? "border-emerald-600 bg-emerald-50" : activeCandidateId === candidate.id ? "border-sky-700 bg-white" : "border-sky-200 bg-white/70"}`}>
              <span className="flex items-center justify-between gap-2"><span><span className="font-semibold">#{index + 1} · {Math.round(candidate.score * 100)}%</span><span className="ml-2 text-sky-700">{formatRect(candidate.bbox)}</span></span>{selectedCandidateId === candidate.id ? <span className={`rounded px-2 py-1 text-[10px] font-bold uppercase ${candidateReviewModeClass(selectionMode)}`}>selected · {selectionMode ?? "draft"}</span> : null}</span>
              <span className="mt-1 inline-flex rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-700">{candidateEvidenceLabel(candidate)}</span>
              {candidate.variant && <span className="mt-1 inline-flex rounded bg-cyan-50 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-800">ROI variant · {candidate.variant.kind} · group {candidate.variant.groupId.replace("label-roi:", "")}</span>}
              {candidate.geometrySemantic && <span className="mt-1 block text-[10px] font-semibold text-emerald-700">{candidate.geometrySemantic.features.packageZone} zone · contour confidence {Math.round(candidate.geometrySemantic.features.packageZoneConfidence * 100)}% · {candidate.geometrySemantic.role} {Math.round(candidate.geometrySemantic.confidence * 100)}%</span>}
              {candidate.metrics.packageEdgeAffinity !== undefined && <span className="mt-1 block text-[10px] text-zinc-500">package edge {Math.round(candidate.metrics.packageEdgeAffinity * 100)}% · bottom {Math.round((candidate.metrics.packageBottomAffinity ?? 0) * 100)}% · body continuation {Math.round((candidate.metrics.bodyColorContinuation ?? 0) * 100)}% · boundary {Math.round((candidate.metrics.labelBoundaryContrast ?? 0) * 100)}%{candidate.metrics.refinedEdges?.length ? ` · refined ${candidate.metrics.refinedEdges.join("/")}` : ""}</span>}
              {candidate.metrics.boundaryProbe && <span className="mt-1 block text-[10px] text-cyan-800">local boundary probe · {Object.entries(candidate.metrics.boundaryProbe.edges).map(([edge, evidence]) => `${edge} ${evidence.action} ${Math.round(evidence.score * 100)}%`).join(" · ")}{candidate.metrics.boundaryProbe.baseIntrusion > 0 ? ` · base intrusion ${Math.round(candidate.metrics.boundaryProbe.baseIntrusion * 100)}%` : ""}</span>}
              {candidate.semantic && <span className="mt-1 block text-[10px] text-violet-700">CV {(candidate.cvScore ?? candidate.score).toFixed(3)} (#{candidate.ranking?.cvRank ?? "-"}) · semantic {candidate.semantic.semanticScore.toFixed(3)} (#{candidate.ranking?.semanticRank ?? "-"}) · fusion {candidate.fusion?.score.toFixed(3) ?? "-"} (#{candidate.ranking?.fusionRank ?? "-"})</span>}
              {candidate.fusion && <span className="mt-1 block text-[10px] text-violet-600">fusion v2 · CV {Math.round(candidate.fusion.components.cv * 100)}% · SigLIP {Math.round(candidate.fusion.components.semantic * 100)}% · contour/zone {Math.round(candidate.fusion.components.contourGeometry * 100)}%</span>}
              {candidate.semantic && <span className="mt-1 block text-[10px] text-zinc-600">SigLIP2 Base / {candidate.semantic.conceptSet} · label {candidate.semantic.positiveScore.toFixed(3)} · negatives {candidate.semantic.negativeScore.toFixed(3)}</span>}
              {candidate.structural && <span className="mt-1 block text-[10px] text-emerald-700">DINOv3 · coherence {formatPercent(candidate.structural.regionCoherence)} · separation {formatPercent(candidate.structural.foregroundSeparation)} · patches {candidate.structural.insidePatchCount}+{candidate.structural.ringPatchCount}</span>}
            </button>
          ))}
        </div>}
      </section>
      <CropPreview imageUrl={imageUrl} rect={rect} geometry={geometry} rectification={null} />
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="grid gap-2">
          <button type="button" onClick={onBack} className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50">Back to Package</button>
          <button type="button" onClick={onEdit} disabled={saving} className="h-10 rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-50">
              Edit ROI quad
          </button>
          <button type="button" onClick={onNoLabel} disabled={saving} className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50">
            Mark no label
          </button>
          <button type="button" onClick={onInvalidImage} disabled={saving} className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50">
            Invalid image
          </button>
          <button type="button" onClick={onSave} disabled={saving || !canSaveCurrentBox} className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50">
            Save annotation
          </button>
          {(status === "no-label" || status === "invalid-image") && (
            <button type="button" onClick={() => void onSaveAndNext()} disabled={saving} className="h-10 rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-50">
              Save and next
            </button>
          )}
          <button type="button" onClick={() => void onSaveAndRunAnalysis?.()} disabled={saving || !canSaveCurrentBox || !onSaveAndRunAnalysis} className="h-10 rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-50">
            Save annotation and continue to Object Context
          </button>
          <button type="button" onClick={onContinue} disabled={!rect || !bottleEnabled} title={!bottleEnabled ? "Save the reviewed label first" : undefined} className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50">
            Continue to Object Context
          </button>
        </div>
        <div className="mt-3 rounded border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-zinc-500">
          Hotkeys: E edit, N no label, Enter save and next.
        </div>
      </section>
    </>
  );
}

function CvConfigStepPanel({ stage, title, description, config, maskCandidates = [], morphologyCandidates = [], previewing, disabled, maskCanContinue = true, onRunMaskPreview, onChange, onReset, onBack, onContinue }: {
  stage: Exclude<LabelCvStage, "palette">;
  title: string; description: string; config: LabelAnalysisCvConfig; previewing: boolean; disabled: boolean;
  maskCandidates?: MaskUiCandidate[];
  morphologyCandidates?: MorphologyUiCandidate[];
  maskCanContinue?: boolean;
  onRunMaskPreview?: () => void;
  onChange: (config: LabelAnalysisCvConfig) => void; onReset: () => void; onBack: () => void; onContinue: () => void;
}) {
  return <section className="rounded-lg border border-sky-200 bg-sky-50 p-4">
    <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-start gap-3"><div className="min-w-0"><h3 className="text-sm font-semibold uppercase text-sky-900">{title}</h3><p className="mt-1 text-xs leading-5 text-sky-800">{description}</p></div><span className="inline-flex h-6 w-[5.5rem] items-center justify-center whitespace-nowrap rounded border border-sky-200 bg-white text-xs text-sky-800">{previewing ? "Updating..." : "Ready"}</span></div>
    {stage === "mask" && <CvStageControls stage={stage} config={config} disabled={disabled} onChange={onChange} />}
    {stage === "mask" && config.maskMode !== "manual" && <>
      <button type="button" onClick={onRunMaskPreview} disabled={disabled || previewing || !onRunMaskPreview} className="mt-4 h-9 w-full rounded border border-sky-300 bg-white px-3 text-xs font-semibold text-sky-900 disabled:opacity-50">{previewing ? "Building Auto shortlist..." : "Run Auto preview"}</button>
      <MaskCandidateChooser candidates={maskCandidates} config={config} disabled={disabled} onChange={onChange} />
    </>}
    {stage === "morphology" && <MorphologyCandidateChooser candidates={morphologyCandidates} config={config} disabled={disabled} onChange={onChange} />}
    {stage !== "mask" && <CvStageControls stage={stage} config={config} disabled={disabled} onChange={onChange} />}
    <div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={onReset} className="h-9 rounded border border-sky-300 bg-white px-3 text-xs font-medium text-sky-900">Reset defaults</button><button type="button" onClick={onContinue} disabled={disabled || previewing || (stage === "mask" && !maskCanContinue)} title={stage === "mask" && !maskCanContinue ? "Run Auto preview and review its shortlist first, or switch to Manual" : undefined} className="h-9 rounded bg-sky-900 px-3 text-xs font-semibold text-white disabled:opacity-50">Approve &amp; continue</button><button type="button" onClick={onBack} className="col-span-2 h-9 rounded border border-sky-300 bg-white px-3 text-xs font-medium text-sky-900">Back</button></div>
  </section>;
}

function PackageScopeStepPanel({ geometry, persistedGeometry, editing, saving, helperRunning, helperRun, selectedCandidateId, onRunHelper, onSelectCandidate, onEdit, onSave, onReset, onContinue }: {
  geometry: QuadGeometry | null;
  persistedGeometry: QuadGeometry | null;
  editing: boolean;
  saving: boolean;
  helperRunning: boolean;
  helperRun: PackageDetectionRun | null;
  selectedCandidateId: string | null;
  onRunHelper: () => void;
  onSelectCandidate: (candidate: PackageDetectionCandidate) => void;
  onEdit: () => void;
  onSave: () => void;
  onReset: () => void;
  onContinue: () => void;
}) {
  const changed = !sameQuad(geometry, persistedGeometry);
  return <section className="rounded-lg border border-orange-200 bg-orange-50 p-3">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold uppercase text-orange-950">Package scope</h3><details className="text-[11px] text-orange-800"><summary className="cursor-pointer">ⓘ</summary><p className="mt-2 max-w-64 leading-4">Technical working scope for this Package. Full image is valid; an adjusted crop constrains downstream helpers but is not object ground truth.</p></details></div>
    <div className="mt-2 rounded border border-orange-200 bg-white p-3 text-xs text-zinc-700">
      <div className="flex items-center justify-between gap-2"><strong>Current scope</strong><span className="rounded bg-orange-100 px-2 py-1">{geometry ? `${Math.round(geometry.bbox.width)}×${Math.round(geometry.bbox.height)} px` : "Full image"}</span></div>
      {editing && <p className="mt-2 text-zinc-500">Drag inside to move, drag corners to reshape, or drag outside to create a new crop.</p>}
    </div>
    <button type="button" onClick={onRunHelper} disabled={saving || helperRunning} className="mt-3 h-9 w-full rounded border border-orange-400 bg-white px-3 text-xs font-semibold text-orange-950 disabled:opacity-40">{helperRunning ? "Detecting Package candidates..." : helperRun ? "Rerun Auto Helper" : "Run Auto Helper · smart lasso"}</button>
    {helperRun && <div className="mt-3 space-y-2">
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase text-orange-900"><span>Package candidates</span><span>{helperRun.candidates.length}</span></div>
      {helperRun.candidates.length === 0 && <div className="rounded border border-dashed border-orange-300 bg-white p-3 text-xs text-orange-800">No stable package contour found. Use Adjust crop manually.</div>}
      {helperRun.candidates.map((candidate, index) => <button key={candidate.id} type="button" onClick={() => onSelectCandidate(candidate)} className={`w-full rounded border p-3 text-left text-xs ${candidate.id === selectedCandidateId ? "border-violet-600 bg-violet-50 ring-1 ring-violet-200" : "border-orange-200 bg-white hover:border-orange-400"}`}>
        <span className="flex items-center justify-between gap-2"><strong>#{index + 1} · {candidate.classification.type}</strong><span>{Math.round(candidate.score * 100)}% contour · {Math.round(candidate.classification.confidence * 100)}% type</span></span>
        <span className="mt-1 block text-zinc-500">{Math.round(candidate.bbox.width)}×{Math.round(candidate.bbox.height)} px · aspect {candidate.classification.features.aspectRatio.toFixed(2)} · solidity {Math.round(candidate.metrics.solidity * 100)}%</span>
      </button>)}
    </div>}
    <div className="mt-3 grid gap-2">
      {!editing && <button type="button" onClick={onEdit} disabled={saving} className="h-9 rounded border border-orange-300 bg-white font-semibold text-orange-950 disabled:opacity-40">Adjust crop</button>}
      {(editing || selectedCandidateId) && <button type="button" onClick={onSave} disabled={saving || !geometry || (!changed && !selectedCandidateId)} className="h-9 rounded bg-orange-700 font-semibold text-white disabled:opacity-40">{selectedCandidateId ? "Accept candidate, type & crop" : "Save crop"}</button>}
      <button type="button" onClick={onReset} disabled={saving || (!persistedGeometry && !geometry)} className="h-9 rounded border border-orange-300 bg-white font-medium text-orange-900 disabled:opacity-40">Use full image</button>
      <button type="button" onClick={onContinue} disabled={saving || (editing && changed)} title={editing && changed ? "Save or reset the changed crop first" : undefined} className="h-9 rounded bg-zinc-950 font-semibold text-white disabled:opacity-40">Approve Package &amp; continue</button>
    </div>
  </section>;
}

function ContoursStepPanel({ elements, contours, config, previewing, disabled, hoveredElementId, onHoverElement, onChange, onReset, onBack, onContinue }: {
  elements: LabelElement[];
  contours: LabelAnalysisResult["visualFeatures"]["contours"];
  config: LabelAnalysisCvConfig;
  previewing: boolean;
  disabled: boolean;
  hoveredElementId: string | null;
  onHoverElement: (id: string | null) => void;
  onChange: (config: LabelAnalysisCvConfig) => void;
  onReset: () => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  return <section className="rounded-lg border border-teal-200 bg-teal-50 p-4">
    <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-start gap-3"><div><h3 className="text-sm font-semibold uppercase text-teal-900">Contours</h3><p className="mt-1 text-xs leading-5 text-teal-800">Contours remain attached to atomic components inside reviewed elements. Outer rings and holes are traced independently; {config.contourVectorization === "bezier" ? "smooth Bézier paths are fitted automatically" : "simplified polygons are retained"}.</p></div><span className="inline-flex h-6 items-center justify-center rounded border border-teal-200 bg-white text-xs text-teal-800">{previewing ? "Updating..." : "Ready"}</span></div>
    <CvStageControls stage="contours" config={config} disabled={disabled} onChange={onChange} />
    <div className="mt-4 max-h-96 space-y-2 overflow-auto">{elements.length ? elements.map((element, index) => {
      const groupContours = contours.filter((contour) => contour.elementId === element.id);
      const rawPointCount = groupContours.reduce((sum, contour) => sum + (contour.rawPoints?.length ?? 0), 0);
      const simplifiedPointCount = groupContours.reduce((sum, contour) => sum + contour.points.length, 0);
      const deviations = groupContours.flatMap((contour) => typeof contour.shapeDeviation === "number" ? [contour.shapeDeviation] : []);
      const averageDeviation = deviations.length ? deviations.reduce((sum, value) => sum + value, 0) / deviations.length : null;
      return <div key={element.id} onMouseEnter={() => onHoverElement(element.id)} onMouseLeave={() => onHoverElement(null)} className={`rounded border bg-white p-3 text-xs ${hoveredElementId === element.id ? "border-teal-700 ring-2 ring-teal-200" : "border-teal-200"}`}>
        <div className="flex items-start justify-between gap-2"><div><strong>Object {index + 1}</strong><div className="mt-1 text-zinc-600">{element.type}{element.role ? ` / ${element.role}` : ""} · {element.sourceComponentIds.length} components</div></div><span className={`rounded px-2 py-1 ${groupContours.length ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{groupContours.length ? `${groupContours.length} contours` : "No output"}</span></div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-zinc-500"><span>Members: {element.sourceComponentIds.map((id) => `C${id}`).join(" ")}</span><span>Raw: {rawPointCount} pts</span><span>Simplified: {simplifiedPointCount} pts</span>{averageDeviation !== null && <span>Deviation: {averageDeviation.toFixed(3)}</span>}</div>
      </div>;
    }) : <div className="rounded border border-dashed border-teal-300 bg-white p-3 text-xs text-teal-800">No reviewed elements. Return to Elements and create at least one element.</div>}</div>
    <div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={onReset} className="h-9 rounded border border-teal-300 bg-white text-xs font-medium text-teal-900">Reset defaults</button><button type="button" onClick={onContinue} disabled={disabled || !elements.length} className="h-9 rounded bg-teal-900 text-xs font-semibold text-white disabled:opacity-50">Save contours &amp; continue</button><button type="button" onClick={onBack} className="col-span-2 h-9 rounded border border-teal-300 bg-white text-xs font-medium text-teal-900">Back to Elements</button></div>
  </section>;
}

function ComponentsStepPanel({ components, config, candidates, decisions, selectedIds, showRejectedOnCanvas, previewing, disabled, onConfigChange, onDelete, onAccept, onShowRejectedOnCanvas, onUndoDelete, canUndoDelete, onSelect, onBack, onContinue }: {
  components: NonNullable<LabelAnalysisResult["visualFeatures"]["components"]>; config: LabelAnalysisCvConfig;
  candidates: ComponentUiCandidate[];
  decisions: LabelCvReviewState["componentDecisions"]; selectedIds: number[]; previewing: boolean; disabled: boolean;
  showRejectedOnCanvas: boolean;
  onConfigChange: (config: LabelAnalysisCvConfig) => void;
  onDelete: (ids: number[]) => void; onAccept: (ids: number[]) => void; onUndoDelete: () => void; canUndoDelete: boolean;
  onShowRejectedOnCanvas: (show: boolean) => void;
  onSelect: (id: number) => void; onBack: () => void; onContinue: () => void;
}) {
  const reviewStatus = (component: (typeof components)[number]) => decisions[String(component.id)] ?? (component.proposalAccepted ? "accepted" : "rejected");
  const acceptedComponents = components.filter((component) => reviewStatus(component) === "accepted");
  const rejectedComponents = components.filter((component) => reviewStatus(component) === "rejected");
  const selectedAcceptedIds = selectedIds.filter((id) => acceptedComponents.some((component) => component.id === id));
  const selectedRejectedIds = selectedIds.filter((id) => rejectedComponents.some((component) => component.id === id));
  const componentMetrics = (component: (typeof components)[number]) => <>Area {(component.areaRatio * 100).toFixed(2)}% · Aspect {component.aspectRatio.toFixed(2)} · Fill {Math.round(component.fillRatio * 100)}%</>;
  return <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
    <div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold uppercase text-amber-900">Components review</h3><p className="mt-1 text-xs leading-5 text-amber-800">Review detected regions. The cross marks a component as rejected instead of deleting its geometry; rejected regions remain available below and can be restored.</p></div><span className="whitespace-nowrap text-xs text-amber-800">{previewing ? "Updating…" : `${acceptedComponents.length} accepted · ${rejectedComponents.length} rejected`}</span></div>
    <ComponentCandidateChooser candidates={candidates} config={config} disabled={disabled} onChange={onConfigChange} />
    <CvStageControls stage="components" config={config} disabled={disabled} onChange={onConfigChange} />
    <label className="mt-3 flex items-center gap-2 rounded border border-red-200 bg-white px-3 py-2 text-xs font-medium text-red-800"><input type="checkbox" checked={showRejectedOnCanvas} onChange={(event) => onShowRejectedOnCanvas(event.target.checked)} /> Show rejected on canvas <span className="ml-auto rounded bg-red-100 px-2 py-0.5">{rejectedComponents.length}</span></label>
    <div className="mt-3 grid grid-cols-3 gap-2"><button type="button" onClick={() => onAccept(selectedRejectedIds)} disabled={!selectedRejectedIds.length} className="h-9 rounded border border-emerald-300 bg-white text-xs font-medium text-emerald-800 disabled:opacity-40">Restore selected</button><button type="button" onClick={() => onDelete(selectedAcceptedIds)} disabled={!selectedAcceptedIds.length} className="h-9 rounded border border-red-300 bg-white text-xs font-medium text-red-700 disabled:opacity-40">Reject selected</button><button type="button" onClick={onUndoDelete} disabled={!canUndoDelete} className="h-9 rounded border border-amber-300 bg-white text-xs font-medium disabled:opacity-40">Undo reject (Ctrl+Z)</button></div>
    <div className="mt-4 grid gap-4">
      <section><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-800">Accepted · {acceptedComponents.length}</h4><div className="max-h-80 space-y-2 overflow-auto">{acceptedComponents.length === 0 && <div className="rounded border border-emerald-200 bg-white p-3 text-xs text-emerald-800">No accepted components.</div>}{acceptedComponents.slice(0, 250).map((component) => <div key={component.id} className={`grid grid-cols-[minmax(0,1fr)_2rem] items-stretch overflow-hidden rounded border text-xs ${selectedIds.includes(component.id) ? "border-zinc-900 bg-white" : "border-emerald-200 bg-white"}`}><button type="button" onClick={() => onSelect(component.id)} className="grid min-w-0 grid-cols-[3rem_1fr] items-center gap-2 p-2 text-left"><strong>C{component.id}</strong><span>{componentMetrics(component)}</span></button><button type="button" onClick={() => onDelete([component.id])} aria-label={`Reject component C${component.id}`} title="Move to rejected" className="border-l border-red-200 bg-white text-base font-semibold text-red-600 hover:bg-red-50">×</button></div>)}</div>{selectedAcceptedIds.length > 0 && <div className="mt-2 text-[11px] text-emerald-800">{selectedAcceptedIds.length} accepted selected</div>}</section>
      <section><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-800">Rejected · {rejectedComponents.length}</h4><div className="max-h-80 space-y-2 overflow-auto">{rejectedComponents.length === 0 && <div className="rounded border border-red-200 bg-white p-3 text-xs text-red-700">No rejected components.</div>}{rejectedComponents.slice(0, 250).map((component) => <div key={component.id} className={`grid grid-cols-[minmax(0,1fr)_5rem] items-stretch overflow-hidden rounded border text-xs ${selectedIds.includes(component.id) ? "border-zinc-900 bg-white" : "border-red-200 bg-white"}`}><button type="button" onClick={() => onSelect(component.id)} className="grid min-w-0 grid-cols-[3rem_1fr] items-center gap-2 p-2 text-left"><strong>C{component.id}</strong><span>{componentMetrics(component)}</span></button><button type="button" onClick={() => onAccept([component.id])} aria-label={`Restore component C${component.id}`} title="Move to accepted" className="border-l border-emerald-200 bg-white text-xs font-semibold text-emerald-700 hover:bg-emerald-50">Restore</button></div>)}</div>{selectedRejectedIds.length > 0 && <div className="mt-2 text-[11px] text-red-800">{selectedRejectedIds.length} rejected selected</div>}</section>
    </div>
    <div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={onBack} className="h-9 rounded border border-amber-300 bg-white text-xs font-medium">Back</button><button type="button" onClick={onContinue} disabled={disabled} className="h-9 rounded bg-amber-900 text-xs font-semibold text-white disabled:opacity-50">Continue</button></div>
  </section>;
}

function ElementsStepPanel({ elements, ungroupedComponents, hoveredElementId, hoveredComponentId, onHoverElement, onHoverComponent, onChange, onRebuildAutoGroups, rebuilding, onBack, onContinue }: {
  elements: LabelElement[];
  ungroupedComponents: NonNullable<LabelAnalysisResult["visualFeatures"]["components"]>;
  hoveredElementId: string | null;
  hoveredComponentId: number | null;
  onHoverElement: (id: string | null) => void;
  onHoverComponent: (id: number | null) => void;
  onChange: (elements: LabelCvReviewState["elements"]) => void;
  onRebuildAutoGroups: () => void;
  rebuilding: boolean;
  onBack: () => void;
  onContinue: (elements: LabelElement[]) => void;
}) {
  const commit = (next: LabelElement[]) => onChange(next.map(elementReviewDraft));
  const updateType = (elementId: string, type: LabelElementType) => commit(elements.map((element) => element.id === elementId ? { ...element, type } : element));
  const updateRole = (elementId: string, role: LabelElementRole | undefined) => commit(elements.map((element) => element.id === elementId ? { ...element, role } : element));
  const ungroup = (elementId: string) => {
    commit(elements.filter((element) => element.id !== elementId));
    onHoverElement(null); onHoverComponent(null);
  };
  const moveComponent = (componentId: number, destination: string) => {
    const newGroupId = destination === "new" ? `element:manual:${crypto.randomUUID()}` : undefined;
    const next = moveComponentBetweenElementGroups(elements, componentId, destination, newGroupId);
    commit(next);
    onHoverElement(destination !== "new" && destination !== "ungrouped" ? destination : null);
    onHoverComponent(componentId);
  };
  const groupIndexById = new Map(elements.map((element, index) => [element.id, index + 1]));
  const destinationOptions = (componentId: number, currentGroupId?: string) => <>
    <option value={currentGroupId ?? "ungrouped"}>{currentGroupId ? `Element ${groupIndexById.get(currentGroupId)}` : "Unassigned"}</option>
    {currentGroupId && <option value="ungrouped">Move to ungrouped</option>}
    <option value="new">Move to new element</option>
    {elements.filter((element) => element.id !== currentGroupId && !element.sourceComponentIds.includes(componentId)).map((element) => <option key={element.id} value={element.id}>Move to Element {groupIndexById.get(element.id)}</option>)}
  </>;
  const hasIncompleteRegions = ungroupedComponents.length > 0;
  return <section className="rounded-lg border border-violet-200 bg-violet-50 p-4">
    <h3 className="text-sm font-semibold uppercase text-violet-900">Elements</h3>
    <p className="mt-1 text-xs leading-5 text-violet-800">Each semantic object owns one or more atomic components. Original component geometry is preserved; bbox and contours are derived without fusing members into an artificial polygon.</p>
    <button type="button" onClick={onRebuildAutoGroups} disabled={rebuilding} className="mt-3 h-9 w-full rounded border border-violet-300 bg-white text-xs font-semibold text-violet-900 disabled:opacity-50">{rebuilding ? "Rebuilding element proposals..." : "Rebuild element proposals (OCR + proximity)"}</button>
    <div className="mt-4 max-h-[34rem] space-y-4 overflow-auto pr-1">
      <section><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-violet-900">Semantic objects · {elements.length}</h4>
        <div className="space-y-2">{elements.length ? elements.map((element, index) => {
          const groupHovered = hoveredElementId === element.id;
          return <details key={element.id} className={`rounded border bg-white ${groupHovered ? "border-violet-700 ring-2 ring-violet-200" : "border-violet-200"}`} onMouseEnter={() => onHoverElement(element.id)} onMouseLeave={() => { onHoverElement(null); onHoverComponent(null); }}>
            <summary className="cursor-pointer list-none p-3"><div className="flex items-center justify-between gap-2"><strong className="text-xs">Element {index + 1}</strong><span className="text-[11px] text-zinc-500">{element.sourceComponentIds.length} component(s) · {element.provenance?.source ?? element.provenance?.method ?? element.groupingMeta?.method ?? element.source}</span></div><div className="mt-2 grid grid-cols-[1fr_auto] gap-2"><select value={element.type} onClick={(event) => event.stopPropagation()} onChange={(event) => updateType(element.id, event.target.value as LabelElementType)} className="h-8 rounded border border-violet-200 bg-white px-2 text-xs"><ElementTypeOptions /></select><button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); ungroup(element.id); }} className="h-8 rounded border border-red-200 px-3 text-xs font-medium text-red-700">Remove element</button></div></summary>
            <div className="border-t border-violet-100 p-2"><label className="mb-2 grid grid-cols-[4rem_1fr] items-center gap-2 text-xs"><span className="font-medium text-violet-800">Role</span><select value={element.role ?? ""} onChange={(event) => updateRole(element.id, (event.target.value || undefined) as LabelElementRole | undefined)} className="h-8 rounded border border-violet-200 bg-white px-2 text-xs"><ElementRoleOptions /></select></label>{element.sourceComponentIds.map((componentId) => <div key={componentId} onMouseEnter={() => { onHoverElement(element.id); onHoverComponent(componentId); }} onMouseLeave={() => onHoverComponent(null)} className={`mb-1 grid grid-cols-[4rem_1fr] items-center gap-2 rounded p-2 text-xs last:mb-0 ${hoveredComponentId === componentId ? "bg-emerald-100 ring-1 ring-emerald-400" : "bg-zinc-50"}`}><strong>C{componentId}</strong><select value={element.id} onChange={(event) => moveComponent(componentId, event.target.value)} className="h-8 min-w-0 rounded border border-zinc-200 bg-white px-2 text-xs">{destinationOptions(componentId, element.id)}</select></div>)}</div>
          </details>;
        }) : <div className="rounded border border-dashed border-violet-300 bg-white p-3 text-xs text-violet-700">No elements yet.</div>}</div>
      </section>
      <section><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-700">Incomplete / ungrouped · {ungroupedComponents.length}</h4>
        <div className="space-y-1">{ungroupedComponents.length ? ungroupedComponents.map((component) => <div key={component.id} onMouseEnter={() => { onHoverElement(null); onHoverComponent(component.id); }} onMouseLeave={() => onHoverComponent(null)} className={`grid grid-cols-[4rem_1fr] items-center gap-2 rounded border p-2 text-xs ${hoveredComponentId === component.id ? "border-emerald-500 bg-emerald-100" : "border-zinc-200 bg-white"}`}><strong>C{component.id}</strong><select value="ungrouped" onChange={(event) => moveComponent(component.id, event.target.value)} className="h-8 min-w-0 rounded border border-zinc-200 bg-white px-2 text-xs">{destinationOptions(component.id)}</select></div>) : <div className="rounded border border-dashed border-zinc-300 bg-white p-3 text-xs text-zinc-500">All accepted components belong to elements.</div>}</div>
      </section>
    </div>
    {hasIncompleteRegions && <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">Assign every accepted component to a semantic object before continuing. A one-component object is valid.</p>}
    <div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={onBack} className="h-9 rounded border border-violet-300 bg-white text-xs font-medium">Back</button><button type="button" disabled={hasIncompleteRegions} onClick={() => onContinue(elements)} className="h-9 rounded bg-violet-900 text-xs font-semibold text-white disabled:opacity-40">Save objects &amp; generate contours</button></div>
  </section>;
}

function ElementTypeOptions() {
  return <><option value="unknown">Unknown</option><option value="text">Text</option><option value="graphic">Graphic</option><option value="separator">Separator</option><option value="shape">Shape</option></>;
}

function ElementRoleOptions() {
  return <><option value="">No role</option><option value="brand">Brand</option><option value="product_name">Product name</option><option value="variety">Variety</option><option value="producer">Producer</option><option value="year">Year</option><option value="description">Description</option><option value="logo">Logo</option><option value="signature">Signature</option><option value="ornament">Ornament</option><option value="separator">Separator</option><option value="unknown">Unknown</option><option value="other">Other</option></>;
}

function elementReviewDraft(element: LabelElement): LabelCvReviewState["elements"][number] { return { id: element.id, sourceComponentIds: element.sourceComponentIds, type: element.type, role: element.role, status: element.status, text: element.text, provenance: normalizeElementProvenance(element.provenance, element.groupingMeta, element.textRegionId) }; }

function materializeReviewedElements(
  elements: LabelCvReviewState["elements"],
  components: NonNullable<LabelAnalysisResult["visualFeatures"]["components"]>,
): LabelElement[] {
  const componentById = new Map(components.map((component) => [component.id, component]));
  return elements.flatMap((element) => {
    const boxes = element.sourceComponentIds.flatMap((id) => {
      const component = componentById.get(id);
      return component ? [component.bbox] : [];
    });
    if (!boxes.length) return [];
    const left = Math.min(...boxes.map((bbox) => bbox.x));
    const top = Math.min(...boxes.map((bbox) => bbox.y));
    const right = Math.max(...boxes.map((bbox) => bbox.x + bbox.width));
    const bottom = Math.max(...boxes.map((bbox) => bbox.y + bbox.height));
    return [{ ...element, bbox: { x: left, y: top, width: right - left, height: bottom - top }, source: "modified" as const }];
  });
}

function isCvStage(value: AnnotationStep): value is LabelCvStage {
  return CV_STAGES.includes(value as LabelCvStage);
}

function approvedSnapshotFromJob(job: LabelCvJob | null | undefined): ApprovedCvSnapshot | null {
  if (!job?.workflow) return null;
  return { config: normalizeCvConfig(job.config), review: normalizeCvReview(job.review), palette: (job.palette ?? []).map((color) => ({ ...color })) };
}

function approvedBottleSnapshotFromState(state: LabelSourceAnalysisRun | null | undefined): ApprovedBottleSnapshot | null {
  if (!state?.savedAt) return null;
  return {
    savedAt: state.savedAt,
    signature: bottleStateSignature(
      state,
      normalizeBottleConfig(state.bottleDetection?.config),
      state.bottleDetection?.selectedCandidateId ?? null,
    ),
  };
}

function bottleStateSignature(
  state: LabelSourceAnalysisRun | null | undefined,
  config: BottleDetectionConfig,
  selectedCandidateId: string | null,
): string {
  const detection = state?.bottleDetection;
  if (!detection) return "missing";
  return JSON.stringify({
    config,
    selectedCandidateId,
    annotation: detection.annotation,
    palette: detection.palette,
  });
}

function formatCvStage(stage: LabelCvStage) {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

function stepStatusButtonClass(status: WizardStepStatus) {
  if (status === "saved") return "border-emerald-300 bg-emerald-50 hover:bg-emerald-100";
  if (status === "modified") return "border-sky-300 bg-sky-50 hover:bg-sky-100";
  if (status === "stale") return "border-amber-400 bg-amber-50 hover:bg-amber-100";
  return "border-zinc-300 bg-white hover:bg-zinc-50";
}

function stepStatusBadgeClass(status: WizardStepStatus) {
  if (status === "saved") return "bg-emerald-200 text-emerald-900";
  if (status === "modified") return "bg-sky-200 text-sky-900";
  if (status === "stale") return "bg-amber-200 text-amber-950";
  return "bg-zinc-200 text-zinc-700";
}

function isEditableHotkeyTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  const tagName = element?.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || Boolean(element?.isContentEditable);
}

function normalizeCvConfig(value: Partial<LabelAnalysisCvConfig> | null | undefined): LabelAnalysisCvConfig {
  return {
    ...DEFAULT_ANALYSIS_CV_CONFIG,
    ...value,
    // A legacy saved threshold was an explicit manual choice. New configs opt
    // into automatic candidate search through the default above.
    maskMode: value?.maskMode ?? (value ? "manual" : DEFAULT_ANALYSIS_CV_CONFIG.maskMode),
    schemaVersion: 3,
  };
}

function normalizeCvReview(value: LabelCvReviewState | null | undefined): LabelCvReviewState { return { componentDecisions: value?.componentDecisions ?? {}, elements: normalizeElementReviews(value?.elements ?? []), elementsReviewed: value?.elementsReviewed ?? (value?.elements?.length ? true : undefined) }; }

function normalizeElementReviews(elements: LabelCvReviewState["elements"]): LabelCvReviewState["elements"] {
  const claimed = new Set<number>();
  return elements.flatMap((rawElement) => {
    const element = normalizeElementReview(rawElement);
    const sourceComponentIds = element.sourceComponentIds.filter((id) => !claimed.has(id));
    for (const id of sourceComponentIds) claimed.add(id);
    return sourceComponentIds.length ? [{ ...element, sourceComponentIds }] : [];
  });
}

function normalizeElementReview(element: LabelCvReviewState["elements"][number]): LabelCvReviewState["elements"][number] {
  const legacyType = element.type as string;
  const provenance = normalizeElementProvenance(element.provenance, element.groupingMeta, element.textRegionId);
  const { groupingMeta: _groupingMeta, textRegionId: _textRegionId, confidence: _confidence, ...current } = element;
  const normalized = { ...current, provenance };
  if (legacyType === "logo") return { ...normalized, type: "graphic", role: element.role ?? "logo" };
  if (legacyType === "signature") return { ...normalized, type: "graphic", role: element.role ?? "signature" };
  if (["illustration", "border", "badge", "other"].includes(legacyType)) return { ...normalized, type: "graphic", role: element.role ?? "other" };
  return normalized;
}

function normalizeElementProvenance(provenance: LabelElement["provenance"], groupingMeta?: LabelElement["groupingMeta"], textRegionId?: string): LabelElement["provenance"] {
  const sourceRef = provenance?.sourceRef ?? (textRegionId ? { kind: "ocr-region" as const, id: textRegionId } : undefined);
  const grouping = provenance?.grouping
    ? { ...provenance.grouping, confidence: provenance.grouping.confidence ?? provenance.confidence }
    : undefined;
  if (provenance?.source) return { source: provenance.source, sourceRef, grouping };
  if (provenance?.method) return { source: provenance.method, sourceRef, grouping };
  return legacyElementProvenance(groupingMeta, sourceRef);
}

function legacyElementProvenance(value: LabelElement["groupingMeta"], sourceRef?: NonNullable<LabelElement["provenance"]>["sourceRef"]): LabelElement["provenance"] {
  if (!value) return undefined;
  if (value.method === "ocr") return { source: "ocr", sourceRef, grouping: { method: "ocr-overlap", confidence: value.score } };
  if (value.method === "proximity") return { source: "geometry", grouping: { method: "proximity" } };
  if (value.method === "manual") return { source: "manual", grouping: { method: "manual" } };
  if (value.method === "model") return { source: "model", grouping: { method: "model", confidence: value.score } };
  return { source: "geometry", grouping: { method: "proximity", confidence: value.score } };
}

function normalizeElement(element: LabelElement): LabelElement {
  return normalizeElementReview(element) as LabelElement;
}

function componentTopologyKey(config: LabelAnalysisCvConfig) {
  return JSON.stringify({ threshold: config.threshold, invert: config.invert, maskSize: config.maskSize, maskMode: config.maskMode, morphologyEnabled: config.morphologyEnabled, morphologyMode: config.morphologyMode, morphologyOperation: config.morphologyOperation, morphologyKernelWidth: config.morphologyKernelWidth, morphologyKernelHeight: config.morphologyKernelHeight, morphologyIterations: config.morphologyIterations, morphologyPipeline: config.morphologyPipeline ?? null, componentFilterPreset: config.componentFilterPreset, componentConnectivity: config.componentConnectivity, minComponentAreaRatio: config.minComponentAreaRatio, maxComponentAreaRatio: config.maxComponentAreaRatio });
}

function formatEffectiveMorphology(value: unknown) {
  const debug = getObject(value, []); const effective = getObject(debug, ["effectiveMorphologyConfig"]);
  if (!effective) return "Auto chooses a variant by component topology.";
  if (effective.morphologyEnabled === false) return "Selected variant: none.";
  const pipeline = Array.isArray(effective.morphologyPipeline) ? effective.morphologyPipeline.map((value) => getObject(value, [])).filter(Boolean) : [];
  if (Array.isArray(effective.morphologyPipeline) && !pipeline.length) return "Selected pipeline: identity (no transform).";
  if (pipeline.length) return `Selected pipeline: ${pipeline.map((step) => `${stringValue(step?.operation) ?? "?"} ${Array.isArray(step?.kernel) ? step.kernel.join("×") : "?"} × ${numberValue(step?.iterations) ?? 1}`).join(" → ")}.`;
  return `Selected variant: ${stringValue(effective.morphologyOperation) ?? "none"} ${numberValue(effective.morphologyKernelWidth) ?? 0}×${numberValue(effective.morphologyKernelHeight) ?? 0}, ${numberValue(effective.morphologyIterations) ?? 0} iteration(s).`;
}

function formatEffectiveMask(value: unknown) {
  const effective = getObject(value, ["effectiveMaskConfig"]);
  if (!effective) return "Auto explores threshold, polarity and working resolution.";
  return `Selected variant: ${effective.invert ? "light" : "dark"} foreground, threshold ${numberValue(effective.threshold) ?? "?"}, ${numberValue(effective.maskSize) ?? "?"}px.`;
}

function MaskCandidateChooser({ candidates, config, disabled, onChange }: {
  candidates: MaskUiCandidate[];
  config: LabelAnalysisCvConfig;
  disabled?: boolean;
  onChange: (config: LabelAnalysisCvConfig) => void;
}) {
  if (!candidates.length) return <div className="mt-4 rounded border border-sky-200 bg-white p-3 text-xs text-zinc-500">Run Auto preview to build the binary-mask shortlist.</div>;
  return <div className="mt-4">
    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-sky-950"><strong>Auto Helper shortlist</strong><span>{candidates.length} of 30 candidates</span></div>
    <div className="grid gap-2 sm:grid-cols-2">{candidates.map((candidate, index) => {
      const selected = config.maskMode === "auto" ? index === 0 : config.maskMode === "candidate" && config.threshold === candidate.config.threshold && config.invert === candidate.config.invert && config.maskSize === candidate.config.maskSize;
      return <button key={candidate.id} type="button" disabled={disabled} aria-pressed={selected} onClick={() => onChange({ ...config, ...candidate.config, maskMode: "candidate" })}
        className={`overflow-hidden rounded border-2 bg-white text-left transition disabled:opacity-50 ${selected ? "border-violet-600 ring-2 ring-violet-200" : "border-sky-200 hover:border-sky-400"}`}>
        <BinaryMaskPreview mask={candidate.mask} />
        <span className="block p-2">
          <span className="flex items-start justify-between gap-2"><strong className="break-all text-xs text-zinc-900">{candidate.id}</strong><span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${selected ? "bg-violet-100 text-violet-800" : "bg-zinc-100 text-zinc-600"}`}>{selected ? config.maskMode === "auto" ? "Suggested" : "Selected" : candidate.score?.toFixed(3) ?? "-"}</span></span>
          <span className="mt-1 block text-[11px] leading-4 text-zinc-600">{candidate.config.invert ? "light" : "dark"} foreground · threshold {candidate.config.threshold} · {candidate.config.maskSize}px</span>
          <span className="mt-1 grid grid-cols-2 gap-x-2 text-[10px] leading-4 text-zinc-500">
            <span>FG {formatPercent(candidate.metrics.foregroundRatio)}</span><span>CC {candidate.metrics.connectedComponentCount ?? "-"}</span>
            <span>noise {candidate.metrics.smallNoiseCount ?? "-"}</span><span>blob {formatPercent(candidate.metrics.largestBlobRatio)}</span>
            <span>edge {formatPercent(candidate.metrics.edgeTouchRatio)}</span><span>text-like {formatPercent(candidate.metrics.textLikeRegionCoverage)}</span>
            <span>stable keep {formatPercent(candidate.metrics.stablePixelRetention)}</span><span>target {formatPercent(candidate.metrics.dynamicTargetCoverage)}</span>
          </span>
        </span>
      </button>;
    })}</div>
    <p className="mt-2 text-[10px] leading-4 text-zinc-500">White: candidate foreground · dark: background. Selecting a card fixes that exact Auto Helper result; Manual is reserved for direct slider edits.</p>
  </div>;
}

function BinaryMaskPreview({ mask }: { mask: { width: number; height: number; data: string } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return; canvas.width = mask.width; canvas.height = mask.height;
    const context = canvas.getContext("2d"); if (!context) return; const values = decodeMorphologyMask(mask); const pixels = context.createImageData(mask.width, mask.height);
    for (let index = 0; index < values.length; index += 1) {
      const offset = index * 4; const foreground = values[index] === 1;
      pixels.data[offset] = foreground ? 248 : 15; pixels.data[offset + 1] = foreground ? 250 : 23; pixels.data[offset + 2] = foreground ? 252 : 42; pixels.data[offset + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  }, [mask]);
  return <span className="flex h-36 w-full items-center justify-center bg-slate-900"><canvas ref={ref} className="block max-h-full max-w-full [image-rendering:pixelated]" /></span>;
}

function maskCandidatesFromDebug(value: unknown): MaskUiCandidate[] {
  const search = getObject(value, ["maskSearch"]); const values = Array.isArray(search?.candidates) ? search.candidates : [];
  return values.flatMap((raw) => {
    const candidate = getObject(raw, []); const rawConfig = getObject(candidate, ["config"]); const metrics = getObject(candidate, ["metrics"]); const mask = morphologyMaskDescriptor(getObject(candidate, ["mask"]));
    const threshold = numberValue(rawConfig?.threshold); const maskSize = numberValue(rawConfig?.maskSize); const invert = rawConfig?.invert;
    if (!candidate || !stringValue(candidate.id) || !mask || threshold === null || maskSize === null || typeof invert !== "boolean") return [];
    return [{
      id: stringValue(candidate.id)!, family: stringValue(candidate.family) ?? "unknown", strength: stringValue(candidate.strength) ?? "unknown",
      config: { threshold, maskSize, invert, maskMode: "candidate" }, score: numberValue(candidate.score),
      metrics: Object.fromEntries(Object.entries(metrics ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))), mask,
    }];
  });
}

function componentCandidatesFromDebug(value: unknown): ComponentUiCandidate[] {
  const search = getObject(value, ["componentSearch"]); const values = Array.isArray(search?.candidates) ? search.candidates : [];
  return values.flatMap((raw) => {
    const candidate = getObject(raw, []); const rawConfig = getObject(candidate, ["config"]); const metrics = getObject(candidate, ["metrics"]);
    const connectivity = numberValue(rawConfig?.componentConnectivity);
    const preset = stringValue(rawConfig?.componentFilterPreset);
    const minArea = numberValue(rawConfig?.minComponentAreaRatio); const maxArea = numberValue(rawConfig?.maxComponentAreaRatio);
    if (!candidate || !stringValue(candidate.id) || (connectivity !== 4 && connectivity !== 8) || !preset || minArea === null || maxArea === null) return [];
    return [{
      id: stringValue(candidate.id)!,
      config: { componentMode: "candidate", componentConnectivity: connectivity, componentFilterPreset: preset as LabelAnalysisCvConfig["componentFilterPreset"], minComponentAreaRatio: minArea, maxComponentAreaRatio: maxArea },
      score: numberValue(candidate.score),
      metrics: Object.fromEntries(Object.entries(metrics ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))),
    }];
  });
}

function ComponentCandidateChooser({ candidates, config, disabled, onChange }: { candidates: ComponentUiCandidate[]; config: LabelAnalysisCvConfig; disabled?: boolean; onChange: (config: LabelAnalysisCvConfig) => void }) {
  if (!candidates.length) return <div className="mt-4 rounded border border-amber-200 bg-white p-3 text-xs text-zinc-500">Run Auto preview to compare 4-connected and 8-connected component topology.</div>;
  return <div className="mt-4">
    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-amber-950"><strong>Auto Helper shortlist</strong><span>{candidates.length} connectivity candidates</span></div>
    <div className="grid grid-cols-2 gap-2">{candidates.map((candidate, index) => {
      const selected = config.componentMode === "auto" ? index === 0 : config.componentMode === "candidate" && config.componentConnectivity === candidate.config.componentConnectivity;
      return <button key={candidate.id} type="button" disabled={disabled} aria-pressed={selected} onClick={() => onChange({ ...config, ...candidate.config })} className={`rounded border-2 bg-white p-3 text-left transition disabled:opacity-50 ${selected ? "border-violet-600 ring-2 ring-violet-200" : "border-amber-200 hover:border-amber-400"}`}>
        <span className="flex items-start justify-between gap-2"><strong className="text-xs text-zinc-900">{candidate.config.componentConnectivity}-connected</strong><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${selected ? "bg-violet-100 text-violet-800" : "bg-zinc-100 text-zinc-600"}`}>{selected ? config.componentMode === "auto" ? "Suggested" : "Selected" : candidate.score?.toFixed(3) ?? "-"}</span></span>
        <span className="mt-2 grid gap-1 text-[10px] leading-4 text-zinc-500"><span>Components {candidate.metrics.connectedComponentCount ?? "-"} · accepted {candidate.metrics.acceptedComponentCount ?? "-"}</span><span>Fragmentation {formatPercent(candidate.metrics.fragmentation)} · coverage {formatPercent(candidate.metrics.acceptedCoverage)}</span><span>Diagonal merges {candidate.metrics.diagonalMergeCount ?? 0} · largest {formatPercent(candidate.metrics.largestComponentRatio)}</span></span>
      </button>;
    })}</div>
    <p className="mt-2 text-[10px] leading-4 text-zinc-500">Auto recommends 8-connectivity only when diagonal merges reduce fragmentation without creating a dominant blob. Selecting a card fixes that exact topology.</p>
  </div>;
}

function MorphologyCandidateChooser({ candidates, config, disabled, onChange }: {
  candidates: MorphologyUiCandidate[];
  config: LabelAnalysisCvConfig;
  disabled?: boolean;
  onChange: (config: LabelAnalysisCvConfig) => void;
}) {
  if (!candidates.length) return <div className="mt-4 rounded border border-sky-200 bg-white p-3 text-xs text-zinc-500">Run Auto preview to build the morphology shortlist.</div>;
  const selectedPipeline = config.morphologyPipeline ?? (config.morphologyMode === "manual" ? [{ operation: config.morphologyOperation, kernel: [config.morphologyKernelWidth, config.morphologyKernelHeight] as [number, number], iterations: config.morphologyIterations }] : null);
  return <div className="mt-4">
    <div className="mb-2 flex items-center justify-between gap-3 text-xs text-sky-950"><strong>Auto Helper shortlist</strong><span>{candidates.length} of 27 candidates</span></div>
    <div className="grid gap-2 sm:grid-cols-2">{candidates.map((candidate, index) => {
      const selected = selectedPipeline ? JSON.stringify(selectedPipeline) === JSON.stringify(candidate.pipeline) : index === 0;
      const first = candidate.pipeline[0];
      return <button key={candidate.id} type="button" disabled={disabled} aria-pressed={selected} onClick={() => onChange({
        ...config,
        morphologyEnabled: true,
        morphologyMode: "manual",
        morphologyPipeline: candidate.pipeline,
        ...(first ? { morphologyOperation: first.operation, morphologyKernelWidth: first.kernel[0], morphologyKernelHeight: first.kernel[1], morphologyIterations: first.iterations } : {}),
      })} className={`overflow-hidden rounded border-2 bg-white text-left transition disabled:opacity-50 ${selected ? "border-violet-600 ring-2 ring-violet-200" : "border-sky-200 hover:border-sky-400"}`}>
        <MorphologyDiffPreview candidate={candidate} />
        <span className="block p-2">
          <span className="flex items-start justify-between gap-2"><strong className="break-all text-xs text-zinc-900">{candidate.id}</strong><span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${selected ? "bg-violet-100 text-violet-800" : "bg-zinc-100 text-zinc-600"}`}>{selected ? config.morphologyMode === "auto" ? "Suggested" : "Selected" : `${candidate.score?.toFixed(3) ?? "-"}`}</span></span>
          <span className="mt-1 block text-[11px] leading-4 text-zinc-600">{formatMorphologyPipeline(candidate.pipeline)}</span>
          <span className="mt-1 grid grid-cols-2 gap-x-2 text-[10px] leading-4 text-zinc-500">
            <span>CC {candidate.metrics.connectedComponentCount ?? "-"}</span><span>small {candidate.metrics.smallComponentCount ?? "-"}</span>
            <span>ΔFG {formatSignedPercent(candidate.metrics.foregroundDelta)}</span><span>fragment {formatPercent(candidate.metrics.fragmentation)}</span>
            <span>holes {candidate.metrics.holesCount ?? "-"}</span><span>Δboundary {formatSignedPercent(candidate.metrics.boundaryDelta)}</span>
          </span>
        </span>
      </button>;
    })}</div>
    <p className="mt-2 text-[10px] leading-4 text-zinc-500">White: preserved foreground · green: added · red: removed · dark: background. Selecting a card switches to its reproducible pipeline.</p>
  </div>;
}

function MorphologyDiffPreview({ candidate }: { candidate: MorphologyUiCandidate }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const { width, height } = candidate.mask; canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d"); if (!context) return;
    const mask = decodeMorphologyMask(candidate.mask); const added = decodeMorphologyMask(candidate.addedMask); const removed = decodeMorphologyMask(candidate.removedMask);
    const pixels = context.createImageData(width, height);
    for (let index = 0; index < mask.length; index += 1) {
      const offset = index * 4;
      const color = removed[index] ? [239, 68, 68] : added[index] ? [34, 197, 94] : mask[index] ? [248, 250, 252] : [15, 23, 42];
      pixels.data[offset] = color[0]; pixels.data[offset + 1] = color[1]; pixels.data[offset + 2] = color[2]; pixels.data[offset + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  }, [candidate]);
  return <span className="flex h-36 w-full items-center justify-center bg-slate-900"><canvas ref={ref} className="block max-h-full max-w-full [image-rendering:pixelated]" /></span>;
}

function morphologyCandidatesFromDebug(value: unknown): MorphologyUiCandidate[] {
  const search = getObject(value, ["morphologySearch"]); const values = Array.isArray(search?.candidates) ? search.candidates : [];
  return values.flatMap((raw) => {
    const candidate = getObject(raw, []); const config = getObject(candidate, ["config"]); const metrics = getObject(candidate, ["metrics"]);
    const mask = morphologyMaskDescriptor(getObject(candidate, ["mask"]));
    const addedMask = morphologyMaskDescriptor(getObject(candidate, ["addedMask"]));
    const removedMask = morphologyMaskDescriptor(getObject(candidate, ["removedMask"]));
    const pipeline = Array.isArray(candidate?.pipeline) ? candidate.pipeline.flatMap((rawStep) => {
      const step = getObject(rawStep, []); const operation = stringValue(step?.operation); const kernel = Array.isArray(step?.kernel) ? step.kernel.map(numberValue) : [];
      const iterations = numberValue(step?.iterations);
      return operation && ["open", "close", "dilate", "erode"].includes(operation) && kernel.length === 2 && kernel.every((entry) => entry !== null) && iterations
        ? [{ operation: operation as NonNullable<LabelAnalysisCvConfig["morphologyPipeline"]>[number]["operation"], kernel: kernel as [number, number], iterations }]
        : [];
    }) : [];
    if (!candidate || !stringValue(candidate.id) || !mask || !addedMask || !removedMask) return [];
    return [{
      id: stringValue(candidate.id)!, family: stringValue(candidate.family) ?? "unknown", strength: stringValue(candidate.strength) ?? "unknown",
      pipeline, config: (config ?? {}) as Partial<LabelAnalysisCvConfig>, score: numberValue(candidate.score),
      metrics: Object.fromEntries(Object.entries(metrics ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))),
      mask, addedMask, removedMask,
    }];
  });
}

function morphologyMaskDescriptor(value: Record<string, unknown> | null) {
  const width = numberValue(value?.width); const height = numberValue(value?.height); const data = stringValue(value?.data);
  return width && height && data ? { width, height, data } : null;
}

function decodeMorphologyMask(mask: { width: number; height: number; data: string }) {
  try {
    const bytes = Uint8Array.from(atob(mask.data), (character) => character.charCodeAt(0)); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const output = new Uint8Array(mask.width * mask.height); let offset = 0;
    for (let index = 0; index + 7 < bytes.byteLength && offset < output.length; index += 8) {
      const value = view.getUint32(index, true) ? 1 : 0; const length = view.getUint32(index + 4, true);
      output.fill(value, offset, Math.min(output.length, offset + length)); offset += length;
    }
    return output;
  } catch { return new Uint8Array(mask.width * mask.height); }
}

function formatMorphologyPipeline(pipeline: NonNullable<LabelAnalysisCvConfig["morphologyPipeline"]>) {
  return pipeline.length ? pipeline.map((step) => `${step.operation} ${step.kernel[0]}×${step.kernel[1]} × ${step.iterations}`).join(" → ") : "identity · no transform";
}
function formatPercent(value: number | null | undefined) { return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "-"; }
function candidateEvidenceLabel(candidate: LabelSourceCandidate) {
  const passIds = candidate.detection.passIds ?? [];
  const configuredFamilies = Array.isArray(candidate.detection.config.families)
    ? candidate.detection.config.families.filter((value): value is string => typeof value === "string")
    : [];
  const evidence = new Set<string>();
  if (passIds.includes("ocr-scout-layout") || candidate.detection.passId === "ocr-scout-layout") evidence.add("OCR scout");
  if (passIds.includes("dino-boundary-grid") || candidate.variant?.kind === "dino-snapped") evidence.add("DINO ROI");
  else if (passIds.includes("text-density-envelope") || configuredFamilies.includes("text")) evidence.add("text geometry");
  if (passIds.some((id) => id.startsWith("horizontal-") || ["soft", "normal", "hard", "normal-blur5"].includes(id)) || configuredFamilies.includes("edge")) evidence.add("CV edge");
  if (passIds.some((id) => id.startsWith("neutral-") || id.startsWith("color-") || id === "saturated-color-regions" || id === "package-material-deviation") || configuredFamilies.includes("color")) evidence.add("CV color");
  if (candidate.structural?.status === "available") evidence.add("DINO evidence");
  return evidence.size ? [...evidence].join(" + ") : candidate.detection.passId;
}
function formatSignedPercent(value: number | undefined) { return typeof value === "number" ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%` : "-"; }

function CvStageControls({ stage, config, disabled, onChange }: { stage: LabelCvStage; config: LabelAnalysisCvConfig; disabled?: boolean; onChange: (config: LabelAnalysisCvConfig) => void }) {
  const changeManualMorphology = (patch: Partial<LabelAnalysisCvConfig>) => onChange({ ...config, ...patch, morphologyPipeline: undefined });
  return <div className="mt-4 grid gap-3">
    {stage === "mask" && <>
      <SegmentedControl value={config.maskMode === "candidate" ? "auto" : config.maskMode} options={[{ value: "auto", label: "Auto" }, { value: "manual", label: "Manual" }]} onChange={(maskMode) => onChange({ ...config, maskMode })} disabled={disabled} />
      {config.maskMode === "manual" && <details className="rounded border border-sky-200 bg-white p-3"><summary className="cursor-pointer text-xs font-semibold text-sky-900">Advanced binary mask</summary><div className="mt-3 grid gap-3">
        <ConfigSlider label="Binary threshold" value={config.threshold} min={0} max={255} onChange={(threshold) => onChange({ ...config, threshold })} disabled={disabled} />
        <ConfigSlider label="Mask size" value={config.maskSize} min={64} max={512} step={16} onChange={(maskSize) => onChange({ ...config, maskSize })} disabled={disabled} />
        <label className="flex items-center gap-2 text-sm text-sky-950"><input type="checkbox" checked={config.invert} onChange={(event) => onChange({ ...config, invert: event.target.checked })} disabled={disabled} /> Use light features as foreground</label>
      </div></details>}
    </>}
    {stage === "morphology" && <>
      <label className="flex items-center gap-2 text-sm text-sky-950"><input type="checkbox" checked={config.morphologyEnabled} onChange={(event) => changeManualMorphology({ morphologyEnabled: event.target.checked })} disabled={disabled} /> Enable morphology</label>
      <SegmentedControl value={config.morphologyMode} options={[{ value: "auto", label: "Auto" }, { value: "manual", label: "Manual" }]} onChange={(morphologyMode) => changeManualMorphology({ morphologyMode })} disabled={disabled || !config.morphologyEnabled} />
      {config.morphologyMode === "manual" && <details className="rounded border border-sky-200 bg-white p-3"><summary className="cursor-pointer text-xs font-semibold text-sky-900">Advanced morphology</summary><div className="mt-3 grid gap-3">
        <label className="grid gap-1 text-xs font-medium text-sky-900"><span>Operation</span><select value={config.morphologyOperation} disabled={disabled || !config.morphologyEnabled} onChange={(event) => changeManualMorphology({ morphologyOperation: event.target.value as LabelAnalysisCvConfig["morphologyOperation"] })} className="h-9 rounded border border-sky-300 bg-white px-2"><option value="open">Open</option><option value="close">Close</option><option value="dilate">Dilate</option><option value="erode">Erode</option></select></label>
        <ConfigSlider label="Kernel width" value={config.morphologyKernelWidth} min={1} max={21} step={2} onChange={(morphologyKernelWidth) => changeManualMorphology({ morphologyKernelWidth })} disabled={disabled || !config.morphologyEnabled} />
        <ConfigSlider label="Kernel height" value={config.morphologyKernelHeight} min={1} max={21} step={2} onChange={(morphologyKernelHeight) => changeManualMorphology({ morphologyKernelHeight })} disabled={disabled || !config.morphologyEnabled} />
        <ConfigSlider label="Iterations" value={config.morphologyIterations} min={1} max={5} onChange={(morphologyIterations) => changeManualMorphology({ morphologyIterations })} disabled={disabled || !config.morphologyEnabled} />
      </div></details>}
    </>}
    {stage === "components" && <>
      <SegmentedControl value={config.componentMode === "manual" ? "manual" : "auto"} options={[{ value: "auto", label: "Auto" }, { value: "manual", label: "Manual" }]} onChange={(componentMode) => onChange({ ...config, componentMode })} disabled={disabled} />
      {config.componentMode === "manual" && <>
        <SegmentedControl value={String(config.componentConnectivity) as "4" | "8"} options={[{ value: "4", label: "4-connected · text" }, { value: "8", label: "8-connected · graphics" }]} onChange={(value) => onChange({ ...config, componentConnectivity: Number(value) as 4 | 8 })} disabled={disabled} />
        <label className="grid gap-1 text-xs font-medium text-sky-900"><span>Noise filtering</span><select value={config.componentFilterPreset} disabled={disabled} onChange={(event) => onChange({ ...config, componentFilterPreset: event.target.value as LabelAnalysisCvConfig["componentFilterPreset"] })} className="h-9 rounded border border-sky-300 bg-white px-2"><option value="none">None</option><option value="light">Light</option><option value="normal">Normal</option><option value="strong">Strong</option><option value="custom">Custom</option></select></label>
        {config.componentFilterPreset === "custom" && <details open className="rounded border border-sky-200 bg-white p-3"><summary className="cursor-pointer text-xs font-semibold text-sky-900">Advanced area limits</summary><div className="mt-3 grid gap-3"><ConfigSlider label="Minimum area, %" value={config.minComponentAreaRatio * 100} min={0} max={25} step={0.05} onChange={(value) => onChange({ ...config, minComponentAreaRatio: value / 100 })} disabled={disabled} displayValue={`${(config.minComponentAreaRatio * 100).toFixed(2)}%`} /><ConfigSlider label="Maximum area, %" value={config.maxComponentAreaRatio * 100} min={1} max={100} step={1} onChange={(value) => onChange({ ...config, maxComponentAreaRatio: value / 100 })} disabled={disabled} displayValue={`${Math.round(config.maxComponentAreaRatio * 100)}%`} /></div></details>}
      </>}
    </>}
    {stage === "contours" && <><SegmentedControl value={config.contourVectorization} options={[{ value: "bezier", label: "Auto Bézier" }, { value: "polygon", label: "Polygon" }]} onChange={(contourVectorization) => onChange({ ...config, contourVectorization })} disabled={disabled} /><label className="grid gap-1 text-xs font-medium text-sky-900"><span>Shape detail</span><select value={config.contourDetail} disabled={disabled} onChange={(event) => onChange({ ...config, contourDetail: event.target.value as LabelAnalysisCvConfig["contourDetail"] })} className="h-9 rounded border border-sky-300 bg-white px-2"><option value="precise">Precise</option><option value="balanced">Balanced</option><option value="simplified">Simplified</option><option value="custom">Custom</option></select></label>{config.contourDetail === "custom" && <ConfigSlider label="Simplification, % perimeter" value={config.contourSimplifyRatio * 100} min={0.05} max={5} step={0.05} onChange={(value) => onChange({ ...config, contourSimplifyRatio: value / 100 })} disabled={disabled} displayValue={`${(config.contourSimplifyRatio * 100).toFixed(2)}%`} />}<details className="rounded border border-sky-200 bg-white p-3"><summary className="cursor-pointer text-xs font-semibold text-sky-900">Advanced safety limit</summary><div className="mt-3"><ConfigSlider label="Maximum contour points" value={config.maxContourPoints} min={32} max={2048} step={32} onChange={(maxContourPoints) => onChange({ ...config, maxContourPoints })} disabled={disabled} /></div></details></>}
    {stage === "palette" && <>
      <ConfigSlider label="Palette colors" value={config.paletteColors} min={1} max={12} onChange={(paletteColors) => onChange({ ...config, paletteColors })} disabled={disabled} />
      <ConfigSlider label="Minimum color ratio, %" value={config.paletteMinRatio * 100} min={0} max={50} step={0.5} onChange={(value) => onChange({ ...config, paletteMinRatio: value / 100 })} disabled={disabled} displayValue={`${(config.paletteMinRatio * 100).toFixed(1)}%`} />
    </>}
  </div>;
}

function ConfigSlider({ label, value, min, max, step = 1, disabled, displayValue, onChange }: { label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; displayValue?: string; onChange: (value: number) => void }) {
  return <label className="grid gap-1 text-xs font-medium text-sky-900"><span className="flex justify-between"><span>{label}</span><span>{displayValue ?? value}</span></span><input type="range" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function SegmentedControl<T extends string>({ value, options, disabled, onChange }: { value: T; options: Array<{ value: T; label: string }>; disabled?: boolean; onChange: (value: T) => void }) {
  return <div className="grid grid-cols-2 rounded border border-sky-300 bg-white p-1">{options.map((option) => <button key={option.value} type="button" disabled={disabled} onClick={() => onChange(option.value)} className={`h-8 rounded text-xs font-semibold disabled:opacity-40 ${value === option.value ? "bg-sky-900 text-white" : "text-sky-900"}`}>{option.label}</button>)}</div>;
}

function PaletteStepPanel({ config, palette, previewing, autoRan, paletteModified, canRunAuto, eyedropperActive, onRunAuto, onConfigChange, onRemove, onUndoRemove, canUndoRemove, onToggleEyedropper, onSave, onBack, onContinue, saving }: {
  config: LabelAnalysisCvConfig; palette: LabelPaletteColor[]; previewing: boolean; autoRan: boolean; paletteModified: boolean; canRunAuto: boolean; eyedropperActive: boolean;
  onRunAuto: () => void;
  onConfigChange: (config: LabelAnalysisCvConfig) => void; onRemove: (index: number) => void; onUndoRemove: () => void; canUndoRemove: boolean; onToggleEyedropper: () => void;
  onSave: () => void | Promise<LabelCvJob | null> | undefined; onBack: () => void; onContinue: () => void | Promise<void>; saving: boolean;
}) {
  return <section className="rounded-lg border border-violet-200 bg-violet-50 p-4">
    <div className="flex items-center justify-between"><h3 className="text-sm font-semibold uppercase text-violet-900">Palette</h3><span className="text-xs text-violet-800">{previewing ? "updating…" : `${palette.length} colors${paletteModified ? " · modified" : ""}`}</span></div>
    <button type="button" onClick={onRunAuto} disabled={!canRunAuto || previewing || saving} className="mt-3 h-9 w-full rounded border border-violet-300 bg-white px-3 text-xs font-semibold text-violet-900 disabled:opacity-50">{previewing ? "Extracting colors..." : "Run Auto Helper · extract palette"}</button>
    {!palette.length && <p className="mt-3 rounded border border-dashed border-violet-300 bg-white p-3 text-xs leading-5 text-violet-800">{paletteModified ? "Palette is empty after edits. Run Auto Helper again or pick colors manually." : autoRan ? "Auto Helper returned no colors. Lower the minimum color ratio and run it again, or pick colors manually." : "No palette yet. Run Auto Helper to extract colors from the crop, or add them with the eyedropper."}</p>}
    <div className="mt-3 grid gap-2">{palette.map((color, index) => <div key={`${color.rgb.join("-")}:${index}`} className="flex items-center gap-3 rounded border border-violet-200 bg-white p-2"><span className="h-8 w-8 rounded border" style={{ backgroundColor: `rgb(${color.rgb.join(",")})` }} /><span className="flex-1 font-mono text-xs">rgb({color.rgb.join(", ")}){typeof color.ratio === "number" ? ` · ${Math.round(color.ratio * 100)}%` : " · picked"}</span><button type="button" onClick={() => onRemove(index)} className="rounded border px-2 py-1 text-xs">Remove</button></div>)}</div>
    <div className="mt-3 grid grid-cols-2 gap-2"><button type="button" onClick={onToggleEyedropper} className={`h-9 rounded border px-3 text-sm font-medium ${eyedropperActive ? "border-violet-900 bg-violet-900 text-white" : "border-violet-300 bg-white text-violet-900"}`}>{eyedropperActive ? "Click a color in the crop" : "Add with eyedropper"}</button><button type="button" onClick={onUndoRemove} disabled={!canUndoRemove} className="h-9 rounded border border-violet-300 bg-white text-xs font-medium disabled:opacity-40">Undo delete (Ctrl+Z)</button></div>
    <CvStageControls stage="palette" config={config} onChange={onConfigChange} />
    <div className="mt-4 grid grid-cols-2 gap-2"><button type="button" onClick={onBack} className="h-9 rounded border border-violet-300 bg-white text-xs font-medium">Back</button><button type="button" onClick={() => void onSave()} disabled={saving || previewing || !palette.length} className="h-9 rounded bg-violet-900 text-xs font-semibold text-white disabled:opacity-50">Save palette</button><button type="button" onClick={() => void onContinue()} disabled={saving || previewing || !palette.length} className="col-span-2 h-9 rounded border border-violet-300 bg-white text-xs font-medium disabled:opacity-50">Save and continue to summary</button></div>
  </section>;
}

function TextStepPanel({
  analysis,
  analysisStale,
  ocrRegionReview,
  catalogCandidates,
  sourceAssociationWorkspace,
  onRunAnalysis,
  onSaveSourceAssociationReview,
  catalogIdentityReview,
  onSaveCatalogIdentityReview,
  saving,
  onActiveRegionChange,
  onBack,
  onContinue,
}: {
  analysis: LabelAnalysisResult | null;
  analysisStale: boolean;
  ocrRegionReview: LabelAnnotationOcrRegionReview | null | undefined;
  catalogCandidates: LabelCatalogCandidate[];
  sourceAssociationWorkspace: OcrSourceAssociationWorkspace | null | undefined;
  onRunAnalysis?: () => Promise<void>;
  onSaveSourceAssociationReview?: (input: PutOcrSourceAssociationReview) => Promise<OcrSourceAssociationReview | null>;
  catalogIdentityReview: CatalogIdentityReview | null | undefined;
  onSaveCatalogIdentityReview?: (input: PutCatalogIdentityReview) => Promise<CatalogIdentityReview | null>;
  saving: boolean;
  onActiveRegionChange: (id: string | null) => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const analysisReady = Boolean(analysis && !analysisStale);

  return (
    <>
      {!analysisReady ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h3 className="text-sm font-semibold uppercase text-amber-900">Label analysis required</h3>
          <p className="mt-2 text-sm leading-5 text-amber-800">Save the reviewed label ROI and run label analysis to generate the OCR regions for this step.</p>
          <button type="button" onClick={() => void onRunAnalysis?.()} disabled={saving || !onRunAnalysis} className="mt-3 h-10 w-full rounded bg-amber-900 px-4 text-sm font-semibold text-white disabled:opacity-50">
            {saving ? "Running label analysis..." : "Run label analysis"}
          </button>
        </section>
      ) : null}
      {analysisReady ? <CatalogCandidatesPanel key={`catalog-candidates:${ocrRegionReview?.id ?? "none"}:${catalogIdentityReview?.revision ?? 0}`} candidates={catalogCandidates} analysis={analysis} ocrRegionAnnotationSetId={ocrRegionReview?.id ?? null} review={catalogIdentityReview} saving={saving} onSave={onSaveCatalogIdentityReview} onActiveRegionChange={onActiveRegionChange} /> : null}
      {analysisReady ? <SourceAssociationEditor
        key={`source-associations:${sourceAssociationWorkspace?.ocrRegionReview?.id ?? "none"}:${sourceAssociationWorkspace?.review?.revision ?? 0}`}
        workspace={sourceAssociationWorkspace}
        saving={saving}
        onSave={onSaveSourceAssociationReview}
        onActiveRegionChange={onActiveRegionChange}
      /> : null}
      {analysis?.ocr.evidence ? <details className="rounded-lg border border-zinc-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold uppercase text-zinc-500">OCR diagnostics</summary>
        <div className="mt-4"><OcrCascadeEvidencePanel evidence={analysis.ocr.evidence} /></div>
      </details> : null}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onBack} className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50">
            Back to label
          </button>
          <button type="button" onClick={onContinue} className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50">
            Continue to contours
          </button>
        </div>
      </section>
    </>
  );
}

function CatalogCandidatesPanel({ candidates, analysis, ocrRegionAnnotationSetId, review, saving, onSave, onActiveRegionChange }: {
  candidates: LabelCatalogCandidate[];
  analysis: LabelAnalysisResult | null;
  ocrRegionAnnotationSetId: string | null;
  review: CatalogIdentityReview | null | undefined;
  saving: boolean;
  onSave?: (input: PutCatalogIdentityReview) => Promise<CatalogIdentityReview | null>;
  onActiveRegionChange: (id: string | null) => void;
}) {
  const [notes, setNotes] = useState(review?.notes ?? "");
  const reviewIsCurrent = Boolean(
    analysis
    && review?.analysisJobId === analysis.jobId
    && review.ocrRegionAnnotationSetId === ocrRegionAnnotationSetId,
  );
  const saveDecision = (status: CatalogIdentityReview["status"], candidate?: LabelCatalogCandidate) => {
    if (!analysis || !onSave) return;
    void onSave({
      baseRevision: review?.revision ?? 0,
      analysisJobId: analysis.jobId,
      ocrRegionAnnotationSetId,
      status,
      selectedSource: candidate?.source ?? null,
      selectedSourceItemId: candidate?.sourceItemId ?? null,
      candidateSnapshot: candidate ? { ...candidate } : {},
      score: candidate?.score ?? null,
      notes,
    });
  };
  return (
    <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase text-emerald-900">Catalog shortlist</h3>
        <span className="text-xs text-emerald-800">{candidates.length} candidate(s)</span>
      </div>
      {!candidates.length ? <div className="mt-3 text-sm text-emerald-800">No cross-item candidates from current OCR evidence.</div> : <div className="mt-3 max-h-96 space-y-2 overflow-auto">
        {candidates.map((candidate, index) => (
          <div key={`${candidate.source}:${candidate.sourceItemId}`} onMouseEnter={() => onActiveRegionChange(candidate.matches[0]?.ocrRegionId ?? null)} onMouseLeave={() => onActiveRegionChange(null)} className={`rounded border p-3 text-xs ${reviewIsCurrent && review?.selectedSource === candidate.source && review.selectedSourceItemId === candidate.sourceItemId ? "border-sky-600 bg-sky-50" : candidate.isCurrentItem ? "border-emerald-600 bg-white" : "border-emerald-200 bg-white/80"}`}>
            <div className="flex items-start justify-between gap-3">
              <div><span className="font-semibold text-zinc-900">#{index + 1} {candidate.title}</span>{candidate.manufacturer ? <div className="mt-0.5 text-zinc-500">{candidate.manufacturer}</div> : null}</div>
              <div className="shrink-0 text-right"><div className="font-semibold text-emerald-800">{Math.round(candidate.score * 100)}%</div>{candidate.isCurrentItem ? <span className="text-[10px] font-semibold uppercase text-emerald-700">current item</span> : null}</div>
            </div>
            <div className="mt-2 space-y-1">{candidate.matches.slice(0, 4).map((match) => <div key={`${match.ocrRegionId}:${match.sourceField}`} onMouseEnter={() => onActiveRegionChange(match.ocrRegionId)} className="flex justify-between gap-3 text-zinc-600" title={`lexical ${Math.round(match.lexicalScore * 100)}% · semantic ${Math.round(match.semanticCompatibility * 100)}% · ${match.matchKind}`}><span className="truncate">{match.regionText} → {match.sourceField}: {match.sourceValue}</span><span>{Math.round(match.score * 100)}%</span></div>)}</div>
            <button type="button" onClick={() => saveDecision(candidate.isCurrentItem ? "confirmed" : "corrected", candidate)} disabled={saving || !analysis || !onSave} className="mt-3 h-8 w-full rounded border border-emerald-300 bg-white px-3 text-xs font-semibold text-emerald-900 disabled:opacity-50">{candidate.isCurrentItem ? "Confirm current item" : "Select as correction"}</button>
          </div>
        ))}
      </div>}
      <label className="mt-3 grid gap-1 text-xs font-medium text-emerald-900">Decision notes
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} className="rounded border border-emerald-300 bg-white px-2 py-1 font-normal text-zinc-700" />
      </label>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => saveDecision("no-match")} disabled={saving || !analysis || !onSave} className="h-8 rounded border border-emerald-300 bg-white text-xs font-medium disabled:opacity-50">No catalog match</button>
        <button type="button" onClick={() => saveDecision("ambiguous")} disabled={saving || !analysis || !onSave} className="h-8 rounded border border-amber-300 bg-white text-xs font-medium text-amber-800 disabled:opacity-50">Ambiguous</button>
      </div>
      <div className="mt-3 rounded border border-emerald-200 bg-white/80 p-2 text-xs text-zinc-600">{reviewIsCurrent ? `Saved r${review?.revision}: ${review?.status}${review?.selectedSourceItemId ? ` → ${review.selectedSource}:${review.selectedSourceItemId}` : ""}` : review ? `Saved r${review.revision} belongs to older analysis or OCR regions; review the recalculated shortlist again.` : "No reviewed catalog identity yet."}</div>
    </section>
  );
}

function OcrCascadeEvidencePanel({ evidence }: { evidence: OcrCascadeEvidence | null }) {
  if (!evidence) return null;
  const rejectedReasons = evidence.observations
    .filter((observation) => !observation.valid)
    .flatMap((observation) => observation.rejectionReasons)
    .reduce<Record<string, number>>((counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {});
  const consensus = [...evidence.consensusRegions]
    .filter((region) => region.level === "word")
    .sort((left, right) => right.consensus - left.consensus)
    .slice(0, 12);
  return (
    <section className="rounded-lg border border-sky-200 bg-sky-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase text-sky-900">OCR cascade evidence</h3>
        <span className="rounded bg-white px-2 py-1 text-xs text-sky-800">{evidence.completedStage} · {evidence.stopReason}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-zinc-700">
        <Field label="Passes" value={evidence.passes.length} />
        <Field label="Observations" value={`${evidence.quality.validObservationCount} valid / ${evidence.quality.rejectedObservationCount} rejected`} />
        <Field label="Consensus regions" value={`${evidence.quality.consensusRegionCount} / ${evidence.quality.supportedConsensusRegionCount} supported`} />
        <Field label="Average consensus" value={`${Math.round(evidence.quality.averageConsensus * 100)}%`} />
        <Field label="Semantic regions" value={`${evidence.quality.semanticRegionCount ?? 0} / ${evidence.quality.highConfidenceSemanticRegionCount ?? 0} high-confidence`} />
        <Field label="Deskew" value={!evidence.geometry?.evaluated ? "not required" : evidence.geometry.applied ? `${evidence.geometry.angleDegrees}° · ${Math.round(evidence.geometry.confidence * 100)}%` : `not applied · ${Math.round(evidence.geometry.confidence * 100)}%`} />
        <Field label="Perspective" value={!evidence.geometry?.perspective?.evaluated ? "not required" : evidence.geometry.perspective.applied ? `applied · ${Math.round(evidence.geometry.perspective.confidence * 100)}% · distortion ${Math.round(evidence.geometry.perspective.distortion * 100)}%` : `not applied · ${Math.round(evidence.geometry.perspective.confidence * 100)}%`} />
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-semibold text-sky-900">Pass diagnostics</summary>
        <div className="mt-2 space-y-2">
          {evidence.passes.map((pass) => (
            <div key={pass.id} className="rounded border border-sky-200 bg-white p-2 text-xs text-zinc-600">
              <div className="flex flex-wrap justify-between gap-2"><span className="font-semibold text-zinc-900">{pass.id}</span><span>{Math.round(pass.confidence)}% · {pass.runtimeMs} ms</span></div>
              <div className="mt-1">{pass.stage} · {pass.region} · {pass.preprocess}{typeof pass.deskewAngleDegrees === "number" ? ` ${pass.deskewAngleDegrees}°` : ""} · PSM {pass.psm} · {pass.validObservationCount}/{pass.observationCount} valid</div>
            </div>
          ))}
        </div>
      </details>
      {consensus.length ? <div className="mt-3 flex flex-wrap gap-2">{consensus.map((region) => <span key={region.key} className="rounded border border-sky-200 bg-white px-2 py-1 text-xs text-zinc-700" title={`text ${Math.round(region.textConsensus * 100)}% · spatial ${Math.round(region.spatialConsensus * 100)}%`}><span className="font-medium">{region.normalizedText || region.rawText}</span> · {region.support} pass(es) · {Math.round(region.consensus * 100)}%</span>)}</div> : null}
      {Object.keys(rejectedReasons).length ? <div className="mt-3 text-xs text-zinc-600">Rejected: {Object.entries(rejectedReasons).map(([reason, count]) => `${reason} (${count})`).join(", ")}</div> : null}
    </section>
  );
}

function AnalysisReviewStepPanel({
  rect,
  sourceAnalysis,
  workspace,
  saving,
  onBackToLabel,
  onBackToAnalysis,
  onReview,
  canonicalConfirmation,
  onDirtyChange,
  annotationValidation,
}: {
  rect: RecognitionRoi | null;
  sourceAnalysis: LabelSourceAnalysisRun | null | undefined;
  workspace: LabelAnalysisWorkspace | null | undefined;
  saving: boolean;
  onBackToLabel: () => void;
  onBackToAnalysis: () => void;
  onReview?: (status: LabelAnalysisReview["status"], notes: string) => Promise<boolean>;
  canonicalConfirmation?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  annotationValidation?: { unresolvedIdentityConflicts: number; suggestedParentRelations: number; readyForCanonicalExport: boolean } | null;
}) {
  const analysis = workspace?.analysis ?? null;
  const summary = workspace?.summary;
  const [notes, setNotes] = useState(workspace?.review?.notes ?? "");
  const reviewIsCurrent = Boolean(analysis && workspace?.review?.jobId === analysis.jobId && workspace.review.configHash === analysis.provenance.configHash);
  const dirty = !reviewIsCurrent || notes !== (workspace?.review?.notes ?? "");

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const catalogIdentityIsCurrent = Boolean(
    analysis
    && workspace?.catalogIdentityReview?.analysisJobId === analysis.jobId
    && workspace.catalogIdentityReview.ocrRegionAnnotationSetId === workspace.ocrRegionAnnotationSetId,
  );
  const currentCatalogRank = summary?.catalogCandidates.findIndex((candidate) => candidate.isCurrentItem) ?? -1;
  return (
    <>
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="text-sm font-semibold uppercase text-zinc-500">Recalculated summary</h3>
        <div className="mt-3 grid gap-2 text-sm text-zinc-600">
          <Field label="Label ROI" value={rect ? "valid" : "missing"} />
          <Field label="Object Context" value={!sourceAnalysis?.bottleDetection?.annotation ? "not reviewed" : sourceAnalysis.bottleDetection.annotation.status === "skipped" ? "skipped" : `${sourceAnalysis.bottleDetection.annotation.source} · ${sourceAnalysis.bottleDetection.annotation.candidateId}`} />
          <Field label="Bottle candidates" value={sourceAnalysis?.bottleDetection ? `${sourceAnalysis.bottleDetection.candidates.length} · ${sourceAnalysis.bottleDetection.algorithm}` : "not run"} />
          <Field label="Bottle palette" value={sourceAnalysis?.bottleDetection ? `${sourceAnalysis.bottleDetection.palette.length} color(s)` : "-"} />
          <Field label="Analysis" value={!analysis ? "missing" : workspace?.stale ? "stale" : "current"} />
          <Field label="OCR" value={summary?.ocrText ? `${tokenizeText(summary.ocrText).length} token(s)` : "not reviewed"} />
          <Field label="OCR cascade" value={summary?.ocrEvidence ? `${summary.ocrEvidence.completedStage} · ${summary.ocrEvidence.passCount} pass(es) · ${Math.round(summary.ocrEvidence.averageConsensus * 100)}% consensus` : "not available"} />
          <Field label="OCR evidence" value={summary?.ocrEvidence ? `${summary.ocrEvidence.validObservationCount} valid / ${summary.ocrEvidence.rejectedObservationCount} rejected · ${summary.ocrEvidence.supportedConsensusRegionCount}/${summary.ocrEvidence.consensusRegionCount} supported` : "-"} />
          <Field label="OCR semantics" value={summary?.ocrEvidence ? `${summary.ocrEvidence.semanticRegionCount} typed / ${summary.ocrEvidence.highConfidenceSemanticRegionCount} high-confidence` : "-"} />
          <Field label="OCR deskew" value={!summary?.ocrEvidence?.deskewEvaluated ? "not required" : summary.ocrEvidence.deskewApplied ? `${summary.ocrEvidence.deskewAngleDegrees}° · ${Math.round(summary.ocrEvidence.deskewConfidence * 100)}%` : "evaluated, not applied"} />
          <Field label="OCR perspective" value={!summary?.ocrEvidence?.perspectiveEvaluated ? "not required" : summary.ocrEvidence.perspectiveApplied ? `${Math.round(summary.ocrEvidence.perspectiveConfidence * 100)}% · distortion ${Math.round(summary.ocrEvidence.perspectiveDistortion * 100)}%` : "evaluated, not applied"} />
          <Field label="Reviewed regions" value={summary ? summary.reviewedRegionCount : "-"} />
          <Field label="Recalculated / fixed links" value={summary ? `${summary.sourceMatches.length} / ${summary.fixedAssociations.length}` : "-"} />
          <Field label="Catalog shortlist" value={summary ? `${summary.catalogCandidates.length} candidate(s) · current rank ${currentCatalogRank >= 0 ? currentCatalogRank + 1 : "missing"}` : "-"} />
          <Field label="Reviewed components" value={summary ? `${summary.reviewedComponentCount ?? 0}/${summary.componentCount ?? 0}` : "-"} />
          <Field label="Reviewed elements" value={summary ? `${summary.reviewedElementCount ?? 0}/${summary.elementCount ?? 0}` : "-"} />
          <Field label="Palette colors" value={summary ? summary.palette.length : "-"} />
          <Field label="Contour points" value={summary ? summary.contourPointCount : "-"} />
          <Field label="Warnings" value={analysis?.warnings.length ? analysis.warnings.join(", ") : "none"} />
          {!canonicalConfirmation && <Field label="Saved review" value={reviewIsCurrent ? `${workspace?.review?.status} · r${workspace?.review?.revision}` : "missing for this result"} />}
          <Field label="Catalog identity" value={!workspace?.catalogIdentityReview ? "not reviewed" : `${catalogIdentityIsCurrent ? "current" : "stale"} · ${workspace.catalogIdentityReview.status} · r${workspace.catalogIdentityReview.revision}${workspace.catalogIdentityReview.selectedSourceItemId ? ` → ${workspace.catalogIdentityReview.selectedSource}:${workspace.catalogIdentityReview.selectedSourceItemId}` : ""}`} />
          <Field label="OCR identity conflicts" value={annotationValidation ? String(annotationValidation.unresolvedIdentityConflicts) : "not loaded"} />
          <Field label="Suggested OCR parents" value={annotationValidation ? `${annotationValidation.suggestedParentRelations} · optional relation review` : "not loaded"} />
        </div>
      </section>
      <WizardExecutionTrace samples={workspace?.stageSamples ?? []} />
      {summary?.catalogCandidates.length ? (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <h3 className="text-sm font-semibold uppercase text-emerald-900">Recalculated catalog shortlist</h3>
          <div className="mt-3 grid gap-2">
            {summary.catalogCandidates.slice(0, 10).map((candidate, index) => (
              <div key={`${candidate.source}:${candidate.sourceItemId}`} className={`rounded border p-2 text-xs ${candidate.isCurrentItem ? "border-emerald-600 bg-white" : "border-emerald-200 bg-white/80"}`}>
                <div className="flex justify-between gap-2"><span className="font-medium text-zinc-800">#{index + 1} {candidate.title}{candidate.isCurrentItem ? " · current item" : ""}</span><span className="font-semibold text-emerald-800">{Math.round(candidate.score * 100)}%</span></div>
                <div className="mt-1 text-zinc-500">{candidate.matchedRegionCount} OCR region(s) · {candidate.source}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {summary?.sourceMatches.length ? (
        <section className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="text-sm font-semibold uppercase text-zinc-500">Source matches</h3>
          <div className="mt-3 grid gap-2">
            {summary.sourceMatches.slice(0, 12).map((match) => (
              <div key={`${match.ocrRegionAnnotationId}:${match.field}:${match.value}`} className="rounded border border-zinc-200 bg-zinc-50 p-2 text-xs text-zinc-600">
                <span className="font-medium text-zinc-800">{match.regionText}</span> → {match.field}: {match.value} ({Math.round(match.score * 100)}%)
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        {!canonicalConfirmation && <label className="grid gap-2 text-sm font-medium text-zinc-700">
          Review notes
          <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} className="rounded border border-zinc-300 px-3 py-2 text-sm font-normal outline-none focus:border-zinc-600" />
        </label>}
        <div className="grid gap-2">
          <button type="button" onClick={onBackToLabel} className="mt-3 h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50">
            Back to label
          </button>
          <button type="button" onClick={onBackToAnalysis} className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50">
            Back to analysis
          </button>
          {!canonicalConfirmation && <button type="button" onClick={() => void onReview?.("needs-tuning", notes)} disabled={saving || !analysis || workspace?.stale || !onReview} className="h-10 rounded border border-amber-300 px-4 text-sm font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50">
            Save as needs tuning
          </button>}
          {!canonicalConfirmation && <button type="button" onClick={() => void onReview?.("rejected", notes)} disabled={saving || !analysis || workspace?.stale || !onReview} className="h-10 rounded border border-red-300 px-4 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
            Reject result
          </button>}
          {annotationValidation && annotationValidation.unresolvedIdentityConflicts > 0 && <p className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">Resolve {annotationValidation.unresolvedIdentityConflicts} OCR duplicate conflict(s) in the entity constructor before final acceptance.</p>}
          <button type="button" onClick={() => void onReview?.("accepted", notes)} disabled={saving || !analysis || workspace?.stale || !onReview || Boolean(annotationValidation && !annotationValidation.readyForCanonicalExport)} className="h-10 rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-50">
            {canonicalConfirmation ? "Approve version" : "Confirm and save"}
          </button>
        </div>
      </section>
    </>
  );
}

function tokenizeText(text: string) {
  return Array.from(new Set(normalizeForMatch(text).split(/\s+/).filter((token) => token.length >= 2)));
}

function normalizeForMatch(value: string) {
  return value
    .toLowerCase()
    .replace(/[^0-9a-zа-яё]+/giu, " ")
    .trim();
}

function QueueNavigation({ queueNav, saving }: { queueNav?: Props["queueNav"]; saving: boolean }) {
  if (!queueNav || (!queueNav.prevHref && !queueNav.nextHref && !queueNav.position)) return null;
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h3 className="text-sm font-semibold uppercase text-zinc-500">Queue</h3>
      <div className="mt-2 text-sm text-zinc-600">
        {queueNav.position && queueNav.total ? `${queueNav.position.toLocaleString()} / ${queueNav.total.toLocaleString()}` : "Queue item"}
        {queueNav.queue ? <span className="ml-2 text-xs text-zinc-400">{formatQueueName(queueNav.queue)}</span> : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {queueNav.prevHref ? (
          <Link
            href={queueNav.prevHref}
            aria-disabled={saving}
            className={`h-9 rounded border border-zinc-300 px-3 py-2 text-center text-sm font-medium ${saving ? "pointer-events-none opacity-40" : "hover:bg-zinc-50"}`}
          >
            Previous
          </Link>
        ) : (
          <button type="button" disabled className="h-9 rounded border border-zinc-300 px-3 text-sm font-medium opacity-40">
            Previous
          </button>
        )}
        {queueNav.nextHref ? (
          <Link
            href={queueNav.nextHref}
            aria-disabled={saving}
            className={`h-9 rounded border border-zinc-300 px-3 py-2 text-center text-sm font-medium ${saving ? "pointer-events-none opacity-40" : "hover:bg-zinc-50"}`}
          >
            Next
          </Link>
        ) : (
          <button type="button" disabled className="h-9 rounded border border-zinc-300 px-3 text-sm font-medium opacity-40">
            Next
          </button>
        )}
      </div>
    </section>
  );
}

function formatQueueName(value: string) {
  if (value === "needs-review") return "needs review";
  if (value === "missing-proposal") return "missing proposal";
  if (value === "missing") return "no annotation";
  if (value === "no-label") return "no label";
  if (value === "invalid-image") return "invalid image";
  return value;
}

function annotationForSave(draft: LabelAnnotationState, geometry: QuadGeometry | null, rectification: LabelRectification | null): LabelAnnotationState {
  const now = new Date().toISOString();
  if (draft.status === "no-label" || draft.status === "invalid-image") return { ...draft, annotation: null, reviewed: false, roiEdited: false, source: null, iou: null, labelRoiGt: false, updatedAt: now };
  if (!geometry) return { ...draft, annotation: null, status: draft.prediction ? "needs-review" : "unprocessed", reviewed: false, roiEdited: false, source: null, iou: null, labelRoiGt: false, updatedAt: now };
  const roi = geometry.bbox;
  const iou = draft.prediction ? rectIoU(draft.prediction.roi, roi) : null;
  const predictionGeometry = normalizeQuad(draft.prediction?.geometry, draft.prediction?.roi);
  const geometryEdited = predictionGeometry ? !sameQuad(predictionGeometry, geometry) : false;
  return {
    ...draft,
    annotation: { roi, geometry, rectification, reviewedAt: now, reviewedBy: draft.annotation?.reviewedBy },
    status: "reviewed",
    reviewed: true,
    roiEdited: geometryEdited,
    source: draft.prediction ? geometryEdited ? "corrected" : "auto" : "manual",
    iou,
    labelRoiGt: true,
    updatedAt: now,
  };
}

export function buildLabelAnnotationState(metadata: RecognitionMetaItem | null): LabelAnnotationState {
  const saved = parseSavedAnnotation(metadata?.annotations);
  const generated = extractGeneratedLabelRoi(metadata?.visualFeatures);
  return saved ?? {
    schemaVersion: 2,
    prediction: generated,
    annotation: null,
    status: generated ? "needs-review" : "unprocessed",
    reviewed: false,
    roiEdited: false,
    source: null,
    iou: null,
    labelRoiGt: false,
  };
}

function parseSavedAnnotation(annotations: Record<string, unknown> | undefined): LabelAnnotationState | null {
  const annotation = annotations?.labelAnnotation;
  if (!annotation || typeof annotation !== "object") return null;
  const record = annotation as Record<string, unknown>;
  if (record.schemaVersion === 2) return record as LabelAnnotationState;
  if (record.schemaVersion !== 1) return null;
  const generated = record.generated as Record<string, unknown> | undefined;
  const reviewed = record.reviewed as Record<string, unknown> | undefined;
  const prediction = generated?.bbox && typeof generated.bbox === "object" ? {
    roi: generated.bbox as RecognitionRoi,
    confidence: numberValue(generated.confidence),
    algorithm: {
      id: stringValue((generated.detector as Record<string, unknown> | undefined)?.type) ?? "legacy-label-detector",
      version: stringValue((generated.detector as Record<string, unknown> | undefined)?.version) ?? undefined,
      params: { candidateScore: generated.candidateScore, presetId: generated.presetId, presetRevision: generated.presetRevision, configHash: generated.configHash },
    },
    createdAt: stringValue(generated.generatedAt) ?? undefined,
  } : null;
  const roi = reviewed?.bbox && typeof reviewed.bbox === "object" ? reviewed.bbox as RecognitionRoi : null;
  const iou = prediction && roi ? rectIoU(prediction.roi, roi) : null;
  return {
    schemaVersion: 2,
    prediction,
    annotation: roi ? { roi, reviewedAt: stringValue(reviewed?.reviewedAt) ?? undefined, reviewedBy: stringValue(reviewed?.reviewedBy) ?? undefined } : null,
    status: record.status as LabelAnnotationStatus,
    reviewed: Boolean(roi),
    roiEdited: iou !== null && iou < 0.999999,
    source: roi ? prediction ? iou !== null && iou >= 0.999999 ? "auto" : "corrected" : "manual" : null,
    iou,
    labelRoiGt: Boolean(roi),
    updatedAt: stringValue(record.updatedAt) ?? undefined,
  };
}

function extractGeneratedLabelRoi(visualFeatures: Record<string, unknown> | undefined): LabelAnnotationState["prediction"] {
  const root = unwrapCvMeta(visualFeatures);
  if (!root) return null;
  const label = getObject(root, ["label"]);
  const normalized = parseNormalizedRect(label?.roi);
  if (!normalized) return null;
  const source = getObject(root, ["source"]);
  const width = numberValue(source?.width) ?? 1000;
  const height = numberValue(source?.height) ?? 1000;
  const detection = getObject(label, ["detection"]);
  const layout = getObject(label, ["layout"]);
  const diagnostics = getObject(root, ["diagnostics"]);
  const config = getObject(diagnostics, ["config"]);
  return {
    roi: {
      x: Math.round(normalized.x * width),
      y: Math.round(normalized.y * height),
      width: Math.round(normalized.width * width),
      height: Math.round(normalized.height * height),
    },
    algorithm: {
      id: "cv-meta-label-roi",
      version: stringValue(diagnostics?.pipelineVersion) ?? stringValue(root.extractorVersion) ?? "cv-meta-v2",
      params: config ?? {},
    },
    confidence: numberValue(detection?.confidence),
    createdAt: stringValue(root.generatedAt) ?? new Date().toISOString(),
  };
}

type BottleViewport = { x: number; y: number; width: number; height: number; scaleX: number; scaleY: number };

function getBottleViewport(canvas: HTMLCanvasElement, image: HTMLImageElement, paddingPercent: number): BottleViewport {
  const factor = 1 + 2 * Math.max(0, paddingPercent) / 100;
  const width = canvas.width / factor; const height = canvas.height / factor;
  return { x: (canvas.width - width) / 2, y: (canvas.height - height) / 2, width, height, scaleX: width / Math.max(1, image.naturalWidth), scaleY: height / Math.max(1, image.naturalHeight) };
}

function drawOuterObject(ctx: CanvasRenderingContext2D, contour: Array<[number, number]>, image: HTMLImageElement, canvas: HTMLCanvasElement, color = "#7c3aed", dashed = true, viewport = getBottleViewport(canvas, image, 0)) {
  if (contour.length < 2) return;
  ctx.save(); ctx.beginPath(); ctx.moveTo(viewport.x + contour[0]![0] * viewport.scaleX, viewport.y + contour[0]![1] * viewport.scaleY);
  for (const [x, y] of contour.slice(1)) ctx.lineTo(viewport.x + x * viewport.scaleX, viewport.y + y * viewport.scaleY);
  ctx.closePath(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [10, 5] : []); ctx.stroke(); ctx.restore();
}

function drawBottleContext(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, image: HTMLImageElement, state: LabelSourceAnalysisRun | null | undefined, selectedCandidateId: string | null, overlays: BottleOverlayState) {
  const detection = state?.bottleDetection;
  if (!detection) return;
  const viewport = getBottleViewport(canvas, image, detection.config.paddingPercent);
  const selected = detection.candidates.find((candidate) => candidate.id === selectedCandidateId);
  const reviewed = detection.annotation?.status === "verified" ? detection.annotation : null;
  const raster = detection.debug.raster;
  if (raster) {
    if (overlays.background && raster.background) drawBinaryMask(ctx, canvas, raster.background, raster.width, raster.height, [59, 130, 246], 0.45, viewport);
    if (overlays.foreground && raster.foreground) drawBinaryMask(ctx, canvas, raster.foreground, raster.width, raster.height, [34, 197, 94], 0.5, viewport);
    if (overlays.foregroundClosed && raster.foregroundClosed) drawBinaryMask(ctx, canvas, raster.foregroundClosed, raster.width, raster.height, [6, 182, 212], 0.45, viewport);
    if (overlays.edges) drawBinaryMask(ctx, canvas, raster.edges, raster.width, raster.height, [239, 68, 68], 0.8, viewport);
  }
  if (overlays.rejectedContours) for (const contour of detection.debug.rejectedContours ?? []) drawOuterObject(ctx, contour, image, canvas, "rgba(239,68,68,.55)", true, viewport);
  const rawContour = reviewed?.rawContour ?? selected?.rawContour;
  const simplifiedContour = reviewed?.simplifiedContour ?? selected?.simplifiedContour;
  if (overlays.rawContour && rawContour) drawOuterObject(ctx, rawContour, image, canvas, "#ef4444", true, viewport);
  if (overlays.simplifiedContour && simplifiedContour) drawOuterObject(ctx, simplifiedContour, image, canvas, "#f59e0b", true, viewport);
}

function drawBinaryMask(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, encoded: string, width: number, height: number, rgb: [number, number, number], alpha: number, viewport?: BottleViewport) {
  const cacheKey = `${rgb.join("-")}:${alpha}:${encoded}`;
  let layer = bottleMaskLayerCache.get(cacheKey);
  if (!layer) {
    const raw = window.atob(encoded); layer = document.createElement("canvas"); layer.width = width; layer.height = height;
    const layerContext = layer.getContext("2d"); if (!layerContext) return;
    const pixels = layerContext.createImageData(width, height);
    for (let index = 0; index < raw.length; index += 1) if (raw.charCodeAt(index)) { const offset = index * 4; pixels.data[offset] = rgb[0]; pixels.data[offset + 1] = rgb[1]; pixels.data[offset + 2] = rgb[2]; pixels.data[offset + 3] = Math.round(alpha * 255); }
    layerContext.putImageData(pixels, 0, 0); bottleMaskLayerCache.set(cacheKey, layer);
    if (bottleMaskLayerCache.size > 16) bottleMaskLayerCache.delete(bottleMaskLayerCache.keys().next().value ?? "");
  }
  if (viewport) ctx.drawImage(layer, viewport.x, viewport.y, viewport.width, viewport.height);
  else ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
}

function drawSourceCandidate(ctx: CanvasRenderingContext2D, candidate: LabelSourceCandidate, image: HTMLImageElement, canvas: HTMLCanvasElement, active: boolean) {
  const rect = naturalToCanvasRect(candidate.bbox, image, canvas);
  ctx.save();
  ctx.strokeStyle = active ? "#e11d48" : "#0284c7";
  ctx.fillStyle = active ? "rgba(225,29,72,.12)" : "rgba(2,132,199,.05)";
  ctx.lineWidth = active ? 3 : 1.5;
  ctx.setLineDash(active ? [] : [6, 4]);
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function drawAutoLabelDebug(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, image: HTMLImageElement, state: LabelSourceAnalysisRun | null | undefined, overlays: AutoLabelOverlayState) {
  const debug = state?.labelDetection?.debug;
  if (!debug) return;
  if (overlays.neutralBands) for (const band of debug.neutralBands) drawAutoLabelRect(ctx, canvas, image, band.bbox, "#22c55e", `band ${Math.round(band.coverage * 100)}%`, .06, [4, 3]);
  if (overlays.cannyEvidence) for (const evidence of debug.cannyEvidence) drawAutoLabelRect(ctx, canvas, image, evidence.bbox, "#f59e0b", "", .025, [3, 3]);
  if (overlays.envelope && debug.envelope) drawAutoLabelRect(ctx, canvas, image, debug.envelope, "#8b5cf6", "envelope", .04, [8, 4]);
}

function drawAutoLabelRect(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, image: HTMLImageElement, bbox: RecognitionRoi, color: string, label: string, alpha: number, dash: number[]) {
  const rect = naturalToCanvasRect(bbox, image, canvas);
  ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = colorWithAlpha(color, alpha); ctx.lineWidth = 1.5; ctx.setLineDash(dash);
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height); ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  if (label) { ctx.setLineDash([]); ctx.fillStyle = color; ctx.font = "11px sans-serif"; ctx.fillText(label, rect.x + 3, Math.max(12, rect.y + 12)); }
  ctx.restore();
}

function colorWithAlpha(hex: string, alpha: number) {
  const value = Number.parseInt(hex.slice(1), 16); return `rgba(${value >> 16},${(value >> 8) & 255},${value & 255},${alpha})`;
}

function formatAutoLabelOverlay(value: keyof AutoLabelOverlayState) {
  return ({ neutralBands: "Neutral bands", cannyEvidence: "Canny evidence", envelope: "Envelope", candidates: "Candidates" } as const)[value];
}

function drawQuad(
  ctx: CanvasRenderingContext2D,
  geometry: QuadGeometry,
  image: HTMLImageElement,
  canvas: HTMLCanvasElement,
  color: string,
  label: string,
  showHandles = false,
  viewport?: BottleViewport,
) {
  const points = geometry.points.map((point) => viewport
    ? { x: viewport.x + point.x * viewport.scaleX, y: viewport.y + point.y * viewport.scaleY }
    : naturalToCanvasPoint(point, image, canvas));
  ctx.save();
  ctx.beginPath();
  points.forEach((point, index) => index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y));
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.fillStyle = "rgba(34, 197, 94, 0.1)";
  ctx.lineWidth = 3;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = "12px sans-serif";
  const anchor = points[0]!;
  ctx.fillText(label, anchor.x + 5, Math.max(14, anchor.y + 16));
  if (showHandles) {
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (const point of points) {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function readZoomLensState(
  point: WorkspacePoint,
  event: ReactPointerEvent<HTMLCanvasElement>,
  canvas: HTMLCanvasElement,
  image: HTMLImageElement
): ZoomLensState {
  const scaleX = image.naturalWidth / Math.max(1, canvas.width);
  const scaleY = image.naturalHeight / Math.max(1, canvas.height);
  return {
    clientX: event.clientX,
    clientY: event.clientY,
    naturalX: point.x * scaleX,
    naturalY: point.y * scaleY,
  };
}

export function FloatingZoomLens({ imageUrl, lens }: { imageUrl: string; lens: ZoomLensState | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const lensRef = useRef<ZoomLensState | null>(lens);

  useEffect(() => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      imageRef.current = image;
      drawFloatingZoom(canvasRef.current, image, lensRef.current);
    };
    image.src = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    lensRef.current = lens;
    drawFloatingZoom(canvasRef.current, imageRef.current, lens);
  }, [lens]);

  if (!lens) return null;

  const lensSize = 156;
  const padding = 18;
  const viewportWidth = typeof window === "undefined" ? 1200 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
  const fitsRight = lens.clientX + lensSize + padding < viewportWidth;
  const fitsBottom = lens.clientY + lensSize + padding < viewportHeight;
  const left = Math.max(8, Math.min(viewportWidth - lensSize - 8, fitsRight ? lens.clientX + padding : lens.clientX - lensSize - padding));
  const top = Math.max(8, Math.min(viewportHeight - lensSize - 8, fitsBottom ? lens.clientY + padding : lens.clientY - lensSize - padding));

  return (
    <canvas
      ref={canvasRef}
      width={lensSize}
      height={lensSize}
      className="pointer-events-none fixed z-50 rounded border-2 border-zinc-950 bg-white shadow-xl"
      style={{ left, top, width: lensSize, height: lensSize }}
    />
  );
}

function drawFloatingZoom(canvas: HTMLCanvasElement | null, image: HTMLImageElement | null, lens: ZoomLensState | null) {
  if (!canvas || !image || !lens) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const sourceSize = 42;
  const inset = 6;
  const targetSize = canvas.width - inset * 2;
  const virtualX = lens.naturalX - sourceSize / 2;
  const virtualY = lens.naturalY - sourceSize / 2;
  const sourceX = Math.max(0, virtualX);
  const sourceY = Math.max(0, virtualY);
  const sourceRight = Math.min(image.naturalWidth, virtualX + sourceSize);
  const sourceBottom = Math.min(image.naturalHeight, virtualY + sourceSize);
  const sourceWidth = Math.max(0, sourceRight - sourceX);
  const sourceHeight = Math.max(0, sourceBottom - sourceY);
  const scale = targetSize / sourceSize;
  const targetX = inset + (sourceX - virtualX) * scale;
  const targetY = inset + (sourceY - virtualY) * scale;
  const targetWidth = sourceWidth * scale;
  const targetHeight = sourceHeight * scale;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(inset, inset, targetSize, targetSize);
  ctx.strokeStyle = "#e4e4e7";
  ctx.lineWidth = 1;
  for (let x = inset; x <= inset + targetSize; x += targetSize / 6) {
    ctx.beginPath();
    ctx.moveTo(x, inset);
    ctx.lineTo(x, inset + targetSize);
    ctx.stroke();
  }
  for (let y = inset; y <= inset + targetSize; y += targetSize / 6) {
    ctx.beginPath();
    ctx.moveTo(inset, y);
    ctx.lineTo(inset + targetSize, y);
    ctx.stroke();
  }
  if (sourceWidth > 0 && sourceHeight > 0) {
    ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, targetX, targetY, targetWidth, targetHeight);
  }
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(centerX, 8);
  ctx.lineTo(centerX, canvas.height - 8);
  ctx.moveTo(8, centerY);
  ctx.lineTo(canvas.width - 8, centerY);
  ctx.stroke();
}

function analysisToOcrSnapshot(analysis: LabelAnalysisResult): LabelAnnotationOcrSnapshot {
  return {
    crop: {
      id: analysis.crop.id,
      bbox: analysis.crop.sourceRect,
      geometry: normalizeQuad(analysis.crop.sourceGeometry, analysis.crop.sourceRect)!,
      width: analysis.crop.width,
      height: analysis.crop.height,
      assetPath: analysis.crop.assetPath,
      createdAt: "",
    },
    ocr: {
      id: analysis.ocr.runId,
      executionMode: "label-analysis",
      engine: analysis.ocr.engine,
      engineVersion: analysis.ocr.engineVersion,
      configHash: analysis.provenance.configHash,
      rawText: analysis.ocr.rawText,
      normalizedText: analysis.ocr.normalizedText,
      confidence: analysis.ocr.confidence,
      status: "completed",
      runtimeMs: analysis.ocr.runtimeMs,
      error: null,
      evidence: analysis.ocr.evidence,
      createdAt: "",
    },
    regions: effectiveOcrOverlayRegions(analysis, null),
  };
}

function analysisCropUrl(analysis: LabelAnalysisResult) {
  return analysis.crop.assetPath ? `/api/admin/assets/${analysis.crop.assetPath.split("/").map(encodeURIComponent).join("/")}` : null;
}

export function CropPreview({
  imageUrl,
  rect,
  geometry,
  rectification,
  regions = [],
  showRegions = false,
  contours = [],
  activeRegionId = null,
  onActiveRegionChange,
  onPickColor,
}: {
  imageUrl: string | null;
  rect: RecognitionRoi | null;
  geometry?: QuadGeometry | null;
  rectification?: LabelRectification | null;
  regions?: LabelAnnotationOcrSnapshot["regions"];
  showRegions?: boolean;
  contours?: Array<{ kind: "binary-boundary"; points: Array<[number, number]> }>;
  activeRegionId?: string | null;
  onActiveRegionChange?: (id: string | null) => void;
  onPickColor?: (rgb: [number, number, number]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageUrl || !rect) return;

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const sourceX = Math.max(0, Math.min(image.naturalWidth - 1, rect.x));
      const sourceY = Math.max(0, Math.min(image.naturalHeight - 1, rect.y));
      const sourceWidth = Math.max(1, Math.min(image.naturalWidth - sourceX, rect.width));
      const sourceHeight = Math.max(1, Math.min(image.naturalHeight - sourceY, rect.height));
      const normalizedGeometry = normalizeQuad(geometry, rect);
      const [topLeft, topRight, bottomRight, bottomLeft] = normalizedGeometry?.points ?? [];
      const rectifiedWidth = topLeft && topRight && bottomRight && bottomLeft
        ? (Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y) + Math.hypot(bottomRight.x - bottomLeft.x, bottomRight.y - bottomLeft.y)) / 2
        : sourceWidth;
      const rectifiedHeight = topLeft && topRight && bottomRight && bottomLeft
        ? (Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y) + Math.hypot(bottomRight.x - topRight.x, bottomRight.y - topRight.y)) / 2
        : sourceHeight;
      const aspect = rectifiedHeight / Math.max(1, rectifiedWidth);
      canvas.width = 320;
      canvas.height = Math.max(80, Math.round(canvas.width * aspect));
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (normalizedGeometry) drawRectifiedQuadPreview(ctx, canvas, image, normalizedGeometry, rectification);
      else ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      if (showRegions) drawOcrRegions(ctx, canvas, regions, activeRegionId);
      drawAnalysisContours(ctx, canvas, contours);
    };
    image.src = imageUrl;
  }, [activeRegionId, contours, geometry, imageUrl, rect, rectification, regions, showRegions]);

  function normalizedPointer(event: ReactMouseEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / Math.max(1, bounds.width), y: (event.clientY - bounds.top) / Math.max(1, bounds.height) };
  }

  function handleMouseMove(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (!onActiveRegionChange) return;
    const point = normalizedPointer(event);
    const hit = [...regions].reverse().find((region) => {
      const bbox = parseRegionBbox(region.bbox);
      return bbox && point.x >= bbox.x && point.x <= bbox.x + bbox.width && point.y >= bbox.y && point.y <= bbox.y + bbox.height;
    });
    onActiveRegionChange(hit?.id ?? null);
  }

  function handleClick(event: ReactMouseEvent<HTMLCanvasElement>) {
    if (!onPickColor) return;
    const canvas = event.currentTarget;
    const point = normalizedPointer(event);
    const pixel = canvas.getContext("2d")?.getImageData(Math.min(canvas.width - 1, Math.max(0, Math.floor(point.x * canvas.width))), Math.min(canvas.height - 1, Math.max(0, Math.floor(point.y * canvas.height))), 1, 1).data;
    if (pixel) onPickColor([pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0]);
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h3 className="text-sm font-semibold uppercase text-zinc-500">Crop preview</h3>
      {imageUrl && rect ? (
        <canvas ref={canvasRef} onMouseMove={handleMouseMove} onMouseLeave={() => onActiveRegionChange?.(null)} onClick={handleClick} className={`mt-3 w-full rounded border border-zinc-200 bg-zinc-50 ${onPickColor ? "cursor-crosshair" : ""}`} />
      ) : (
        <div className="mt-3 rounded border border-zinc-200 p-3 text-sm text-zinc-500">
          Draw a label ROI to preview the crop.
        </div>
      )}
    </section>
  );
}

function drawRectifiedQuadPreview(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  geometry: QuadGeometry,
  rectification?: LabelRectification | null,
) {
  const bbox = geometry.bbox;
  const sourceWidth = Math.max(1, Math.round(bbox.width));
  const sourceHeight = Math.max(1, Math.round(bbox.height));
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = sourceWidth;
  sourceCanvas.height = sourceHeight;
  const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!sourceContext) return;
  sourceContext.drawImage(image, bbox.x, bbox.y, bbox.width, bbox.height, 0, 0, sourceWidth, sourceHeight);
  const sourcePixels = sourceContext.getImageData(0, 0, sourceWidth, sourceHeight);
  const output = ctx.createImageData(canvas.width, canvas.height);
  const corners = geometry.points.map((point) => ({
    x: (point.x - bbox.x) / Math.max(1, bbox.width),
    y: (point.y - bbox.y) / Math.max(1, bbox.height),
  })) as QuadGeometry["points"];

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const unit = mapLabelRectificationUnitPoint(rectification, x / Math.max(1, canvas.width - 1), y / Math.max(1, canvas.height - 1));
      const source = mapQuadUnitPoint(corners, unit.x, unit.y);
      const sourceX = Math.max(0, Math.min(sourceWidth - 1, Math.round(source.x * (sourceWidth - 1))));
      const sourceY = Math.max(0, Math.min(sourceHeight - 1, Math.round(source.y * (sourceHeight - 1))));
      const from = (sourceY * sourceWidth + sourceX) * 4;
      const to = (y * canvas.width + x) * 4;
      output.data[to] = sourcePixels.data[from] ?? 255;
      output.data[to + 1] = sourcePixels.data[from + 1] ?? 255;
      output.data[to + 2] = sourcePixels.data[from + 2] ?? 255;
      output.data[to + 3] = sourcePixels.data[from + 3] ?? 255;
    }
  }
  ctx.putImageData(output, 0, 0);
}

function mapLabelRectificationUnitPoint(rectification: LabelRectification | null | undefined, u: number, v: number) {
  if (rectification?.type !== "guided-cylindrical") return { x: u, y: v };
  const rows = rectification.transform.rows;
  const columns = rectification.transform.columns;
  let top = rows[0]!, bottom = rows[rows.length - 1]!;
  for (let index = 0; index < rows.length - 1; index += 1) {
    if (v >= rows[index]!.v && v <= rows[index + 1]!.v) { top = rows[index]!; bottom = rows[index + 1]!; break; }
  }
  const mix = top === bottom ? 0 : (v - top.v) / Math.max(1e-6, bottom.v - top.v);
  const a = guidePathPoint(top.points, columns, u), b = guidePathPoint(bottom.points, columns, u);
  return { x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix };
}

function guidePathPoint(points: Array<{ x: number; y: number }>, columns: number[], u: number) {
  const found = columns.findIndex((column) => column >= u);
  if (found <= 0) return points[0]!;
  const index = Math.min(points.length - 2, found - 1);
  const mix = (u - columns[index]!) / Math.max(1e-6, columns[index + 1]! - columns[index]!);
  return { x: points[index]!.x + (points[index + 1]!.x - points[index]!.x) * mix, y: points[index]!.y + (points[index + 1]!.y - points[index]!.y) * mix };
}

function drawAnalysisContours(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, contours: Array<{ points: Array<[number, number]>; bezier?: { start: [number, number]; segments: Array<{ control1: [number, number]; control2: [number, number]; end: [number, number] }> } | null; ringKind?: "outer" | "hole" }>) {
  ctx.save();
  ctx.strokeStyle = "#f43f5e";
  ctx.lineWidth = 2;
  for (const contour of contours) {
    if (!contour.points.length) continue;
    ctx.beginPath();
    const start = contour.bezier?.start ?? contour.points[0]!;
    ctx.moveTo(start[0] * canvas.width, start[1] * canvas.height);
    if (contour.bezier) for (const segment of contour.bezier.segments) ctx.bezierCurveTo(segment.control1[0] * canvas.width, segment.control1[1] * canvas.height, segment.control2[0] * canvas.width, segment.control2[1] * canvas.height, segment.end[0] * canvas.width, segment.end[1] * canvas.height);
    else for (const [x, y] of contour.points.slice(1)) ctx.lineTo(x * canvas.width, y * canvas.height);
    ctx.closePath();
    ctx.setLineDash(contour.ringKind === "hole" ? [4, 3] : []);
    ctx.stroke();
  }
  ctx.restore();
}

function drawOcrRegions(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, regions: LabelAnnotationOcrSnapshot["regions"], activeRegionId: string | null) {
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.font = "10px sans-serif";
  for (const region of regions) {
    const bbox = parseRegionBbox(region.bbox);
    if (!bbox) continue;
    const x = bbox.x * canvas.width;
    const y = bbox.y * canvas.height;
    const width = bbox.width * canvas.width;
    const height = bbox.height * canvas.height;
    const lowConfidence = region.confidence !== null && region.confidence < 55;
    const active = region.id === activeRegionId;
    ctx.lineWidth = active ? 3 : 1.5;
    ctx.strokeStyle = active ? "#e11d48" : lowConfidence ? "#f59e0b" : "#0ea5e9";
    ctx.fillStyle = active ? "rgba(225, 29, 72, 0.18)" : lowConfidence ? "rgba(245, 158, 11, 0.12)" : "rgba(14, 165, 233, 0.1)";
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
    if (active) {
      const label = region.normalizedText || region.rawText || "(empty)";
      const labelWidth = Math.min(canvas.width - x, ctx.measureText(label).width + 8);
      const labelY = Math.max(0, y - 16);
      ctx.fillStyle = "rgba(24, 24, 27, 0.9)";
      ctx.fillRect(x, labelY, labelWidth, 15);
      ctx.fillStyle = "white";
      ctx.fillText(label, x + 4, labelY + 11, Math.max(1, labelWidth - 8));
    }
  }
  ctx.restore();
}

function parseRegionBbox(value: Record<string, unknown>): RecognitionRoi | null {
  const x = numberValue(value.x);
  const y = numberValue(value.y);
  const width = numberValue(value.width);
  const height = numberValue(value.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function canvasPointsToNaturalRect(start: WorkspacePoint, end: WorkspacePoint, canvas: HTMLCanvasElement, image: HTMLImageElement): RecognitionRoi {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);
  const scaleX = image.naturalWidth / Math.max(1, canvas.width);
  const scaleY = image.naturalHeight / Math.max(1, canvas.height);
  return {
    x: Math.round(left * scaleX),
    y: Math.round(top * scaleY),
    width: Math.max(1, Math.round((right - left) * scaleX)),
    height: Math.max(1, Math.round((bottom - top) * scaleY)),
  };
}

function hitTestQuad(point: WorkspacePoint, geometry: QuadGeometry, canvas: HTMLCanvasElement, image: HTMLImageElement) {
  const near = 10;
  const canvasPoints = geometry.points.map((corner) => naturalToCanvasPoint(corner, image, canvas));
  const cornerIndex = canvasPoints.findIndex((corner) => Math.hypot(point.x - corner.x, point.y - corner.y) <= near);
  const natural = canvasPointToNatural(point, canvas, image);
  return { cornerIndex: cornerIndex >= 0 ? cornerIndex : null, inside: pointInQuad(natural, geometry) };
}

function cursorForQuadHit(hit: ReturnType<typeof hitTestQuad> | null) {
  if (!hit) return "crosshair";
  if (hit.cornerIndex !== null) return "crosshair";
  return hit.inside ? "move" : "crosshair";
}

function naturalToCanvasPoint(point: { x: number; y: number }, image: HTMLImageElement, canvas: HTMLCanvasElement) {
  return { x: point.x * canvas.width / Math.max(1, image.naturalWidth), y: point.y * canvas.height / Math.max(1, image.naturalHeight) };
}

function canvasPointToNatural(point: WorkspacePoint, canvas: HTMLCanvasElement, image: HTMLImageElement) {
  return {
    x: point.x * image.naturalWidth / Math.max(1, canvas.width),
    y: point.y * image.naturalHeight / Math.max(1, canvas.height),
  };
}

function bottleCanvasPointToNatural(point: WorkspacePoint, canvas: HTMLCanvasElement, image: HTMLImageElement, paddingPercent: number) {
  const viewport = getBottleViewport(canvas, image, paddingPercent);
  if (point.x < viewport.x || point.y < viewport.y || point.x > viewport.x + viewport.width || point.y > viewport.y + viewport.height) return null;
  return { x: (point.x - viewport.x) / viewport.scaleX, y: (point.y - viewport.y) / viewport.scaleY };
}

function polygonNaturalBbox(polygon: Array<[number, number]>): RecognitionRoi {
  const xs = polygon.map(([x]) => x); const ys = polygon.map(([, y]) => y);
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(Math.max(...xs) - x), height: Math.round(Math.max(...ys) - y) };
}

function rgbToLabClient(rgb: number[]) {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel > 0.04045 ? ((channel + 0.055) / 1.055) ** 2.4 : channel / 12.92;
  });
  const x = ((r ?? 0) * 0.4124 + (g ?? 0) * 0.3576 + (b ?? 0) * 0.1805) / 0.95047;
  const y = (r ?? 0) * 0.2126 + (g ?? 0) * 0.7152 + (b ?? 0) * 0.0722;
  const z = ((r ?? 0) * 0.0193 + (g ?? 0) * 0.1192 + (b ?? 0) * 0.9505) / 1.08883;
  const transform = (value: number) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  return [
    Math.round((116 * transform(y) - 16) * 10) / 10,
    Math.round((500 * (transform(x) - transform(y))) * 10) / 10,
    Math.round((200 * (transform(y) - transform(z))) * 10) / 10,
  ];
}

function getCanvasSize(hostWidth: number, image: HTMLImageElement): WorkspaceCanvasSize {
  const aspect = image.naturalHeight / Math.max(1, image.naturalWidth);
  const viewportHeight = typeof window === "undefined" ? 900 : window.innerHeight;
  const maxHeight = Math.max(520, Math.min(820, viewportHeight - 220));
  const maxWidth = Math.max(1, Math.floor(hostWidth));
  const widthByHeight = Math.floor(maxHeight / Math.max(0.01, aspect));
  const width = Math.max(1, Math.min(maxWidth, widthByHeight));
  return { width, height: Math.max(1, Math.round(width * aspect)) };
}

function statusClassName(status: LabelAnnotationStatus) {
  const base = "rounded px-2 py-1 text-xs font-medium";
  if (status === "reviewed") return `${base} bg-emerald-50 text-emerald-700`;
  if (status === "no-label") return `${base} bg-zinc-100 text-zinc-700`;
  if (status === "needs-review" || status === "generated") return `${base} bg-amber-50 text-amber-700`;
  if (status === "invalid-image") return `${base} bg-red-50 text-red-700`;
  return `${base} bg-zinc-100 text-zinc-600`;
}

function formatStatus(status: LabelAnnotationStatus) {
  if (status === "needs-review") return "Needs review";
  if (status === "no-label") return "No label";
  if (status === "invalid-image") return "Invalid image";
  return status;
}

function formatRect(rect: RecognitionRoi) {
  return `${rect.x}, ${rect.y}, ${rect.width} x ${rect.height}`;
}

function drawPackageCandidate(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, image: HTMLImageElement, candidate: PackageDetectionCandidate, selected: boolean) {
  if (candidate.contour.length < 3) return;
  context.save();
  context.beginPath();
  candidate.contour.forEach(([x, y], index) => {
    const point = naturalToCanvasPoint({ x, y }, image, canvas);
    if (index === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y);
  });
  context.closePath();
  context.strokeStyle = selected ? "#7c3aed" : "#0ea5e9";
  context.lineWidth = selected ? 3 : 1.5;
  context.setLineDash(selected ? [] : [6, 4]);
  context.stroke();
  context.fillStyle = selected ? "rgba(124, 58, 237, 0.08)" : "rgba(14, 165, 233, 0.035)";
  context.fill();
  context.restore();
}

function drawAcceptedPackageContour(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, image: HTMLImageElement, contour: Array<[number, number]>) {
  context.save();
  context.beginPath();
  contour.forEach(([x, y], index) => {
    const point = naturalToCanvasPoint({ x, y }, image, canvas);
    if (index === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y);
  });
  context.closePath();
  context.strokeStyle = "#16a34a";
  context.lineWidth = 2;
  context.setLineDash([10, 5]);
  context.stroke();
  context.restore();
}

function drawPackageScope(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, image: HTMLImageElement, geometry: AnnotationRegionGeometry) {
  const points = geometry.points.map((point) => ({ x: point.x * canvas.width / image.naturalWidth, y: point.y * canvas.height / image.naturalHeight }));
  if (points.length < 3) return;
  context.save();
  context.fillStyle = "rgba(15, 23, 42, 0.3)";
  context.beginPath();
  context.rect(0, 0, canvas.width, canvas.height);
  context.moveTo(points[0]!.x, points[0]!.y);
  points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
  context.closePath();
  context.fill("evenodd");
  context.strokeStyle = "#f97316";
  context.lineWidth = 2;
  context.setLineDash([8, 5]);
  context.beginPath();
  context.moveTo(points[0]!.x, points[0]!.y);
  points.slice(1).forEach((point) => context.lineTo(point.x, point.y));
  context.closePath();
  context.stroke();
  context.restore();
}

function clampRoiToBounds(roi: RecognitionRoi, bounds: RecognitionRoi): RecognitionRoi {
  const left = Math.max(bounds.x, Math.min(roi.x, roi.x + roi.width));
  const top = Math.max(bounds.y, Math.min(roi.y, roi.y + roi.height));
  const right = Math.min(bounds.x + bounds.width, Math.max(roi.x, roi.x + roi.width));
  const bottom = Math.min(bounds.y + bounds.height, Math.max(roi.y, roi.y + roi.height));
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function rectIoU(left: RecognitionRoi, right: RecognitionRoi) {
  const intersectionWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const intersectionHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = intersectionWidth * intersectionHeight;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? Math.round(intersection / union * 1_000_000) / 1_000_000 : 0;
}

function Field({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase text-zinc-400">{label}</div>
      <div className="mt-1 break-words text-sm text-zinc-700">{value === null || value === undefined || value === "" ? "-" : String(value)}</div>
    </div>
  );
}
