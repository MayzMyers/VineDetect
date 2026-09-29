export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

const RECOGNITION_PIPELINE_VERSION = "cv-meta-v2-debug-layers";

export type TokenResponse = {
  access_token: string;
  token_type: string;
  username: string;
  role: "admin" | "annotator" | "ml-service";
};

export type WineSummary = {
  id: number;
  slug: string;
  title: string;
  category_name: string | null;
  manufacturer_name: string | null;
  region_name: string | null;
  public_rating: string | number | null;
  image_url: string | null;
  color: string | null;
  alcohol: string | number | null;
  source: string | null;
  external_id: string | null;
};

export type WineImage = {
  id: number;
  kind: string;
  url: string;
  local_path: string | null;
  download_status: string | null;
  content_type: string | null;
  size_bytes: number | null;
};

export type WineDetail = WineSummary & {
  manufacturer_slug: string | null;
  temperature: string | null;
  description: string | null;
  image_alt: string | null;
  source_url: string | null;
  source_updated_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  grapes: string[];
  dishes: string[];
  dish_items?: Array<{
    name: string;
    image: { url: string | null; altText: string | null } | null;
  }>;
  barcodes: string[];
  images: WineImage[];
};

export type WineListResponse = {
  items: WineSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type CatalogImage = {
  url: string | null;
  local_path: string | null;
  content_type: string | null;
  size_bytes: number | null;
};

export type CatalogItem = {
  source: "svoe_vino" | "roskachestvo" | string;
  external_id: string;
  recognitionKey: string;
  local_id: number | null;
  title: string | null;
  manufacturer: string | null;
  category: string | null;
  region: string | null;
  year: number | null;
  rating: string | null;
  barcode: string | null;
  description: string | null;
  source_url: string | null;
  image: CatalogImage;
};

export type CatalogResponse = {
  items: CatalogItem[];
  source: string;
  limit: number;
  offset: number;
  count: number;
};

export type WineListParams = {
  query?: string;
  region?: string;
  category?: string;
  manufacturer?: string;
  limit?: number;
  offset?: number;
};

export type CatalogListParams = {
  q?: string;
  source?: "all" | "svoe_vino" | "roskachestvo";
  limit?: number;
  offset?: number;
};

export type RecognitionColor = {
  hex: string;
  count?: number;
  source?: "palette" | "pipette" | "manual";
};

export type RecognitionRoi = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RecognitionMetadata = {
  tags: string[];
  roi: RecognitionRoi | null;
  palette: RecognitionColor[];
  excluded_colors: RecognitionColor[];
  notes: string | null;
};

export type ManualCvAnnotationPayload = {
  schemaVersion: 1;
  sourceHash?: string;
  basedOnPipelineVersion?: string;
  regions: Array<Record<string, unknown>>;
  palettes: Array<Record<string, unknown>>;
  colorSamples: Array<Record<string, unknown>>;
  decisions: Array<Record<string, unknown>>;
  annotationVersion?: number;
  updatedAt?: string;
};

export type RecognitionMetaItem = {
  id: string;
  source: string;
  sourceItemId: string;
  sourceTitle: string | null;
  sourceProducer: string | null;
  imageUrls: string[];
  aliases: string[];
  normalizedTokens: string[];
  visualFeatures: Record<string, unknown>;
  annotations: Record<string, unknown>;
  status: string;
  generationVersion: number;
  sourceHash: string | null;
  updatedAt: string;
};

export type WizardStage = "package" | "label" | "bottle" | "ocr" | "mask" | "morphology" | "components" | "elements" | "contours" | "palette" | "summary";
export type StageCapturedValue = Record<string, unknown> | { availability: "unavailable"; reason: "not-captured" | "not-persisted" | "not-reviewed" | "not-applicable" };
export type StageSampleV1 = {
  schemaVersion: 1;
  cardId: string;
  card: { source: string; sourceItemId: string };
  stage: WizardStage;
  stageInput: StageCapturedValue;
  helper: { id: string; algorithm?: string; version?: string };
  execution: {
    runs: Array<{
      id: string; runIndex: number; config: Record<string, unknown>; candidates: unknown[];
      output: Record<string, unknown>; artifact?: Record<string, unknown> | null; createdAt?: string;
      intermediateStates: Array<{
        id: string; parentId: string | null; sequence: number; status: "pending" | "completed" | "failed";
        algorithm: string | null; summary: Record<string, unknown>;
      }>;
    }>;
    selection: { runId: string; candidateId: string } | null;
    reviewMode: "accepted" | "corrected" | "manual" | null;
    defaultParams?: Record<string, unknown>;
    initialParams: StageCapturedValue;
    finalParams: StageCapturedValue;
    autoOutput?: StageCapturedValue;
    reviewedOutput: StageCapturedValue;
    proposal?: {
      executor: "human" | "llm" | "local_ml" | "system";
      interactionMode?: "auto" | "manual" | "mixed";
      planId?: string;
      llmDecision?: { mode: "accepted_helper" | "modified_helper" | "manual_created"; executor: "llm" };
      review?: LlmProposalReview;
    };
  };
  humanCorrection: {
    reviewed: boolean;
    paramsEdited: boolean | null;
    outputEdited: boolean | null;
    changedFields: string[];
    reviewedAt?: string;
  };
  provenance: { adapter: string; persisted: boolean; migrationGap: boolean };
};

export type LlmReviewVerdict = "llm_correct" | "llm_false_accept" | "llm_false_correction" | "llm_partially_correct";
export type LlmFinalEditor = "helper" | "llm" | "human" | "local_ml";
export type LlmProposalReview = {
  reviewedBy: "human" | "llm" | "local_ml";
  reviewerSubject?: string;
  finalEditor: LlmFinalEditor;
  verdict: LlmReviewVerdict;
  reviewedAt: string;
};

export type WizardCorrectionPlanOperation = {
  operationId?: string;
  stage: WizardStage;
  labelId?: string;
  command: string;
  target?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  proposedOutput?: Record<string, unknown>;
};

export type WizardCorrectionPlan = {
  id: string;
  source: string;
  sourceItemId: string;
  annotationTrackId: string;
  executor: "human" | "llm" | "local_ml" | "system";
  interactionMode: "auto" | "manual" | "mixed";
  llmDecision: { mode: "accepted_helper" | "modified_helper" | "manual_created"; executor: "llm" } | null;
  controller: Record<string, unknown>;
  proposedOutput: Record<string, unknown>;
  operations: WizardCorrectionPlanOperation[];
  continueOnError: boolean;
  validation: Record<string, unknown>;
  status: "validated" | "applying" | "applied" | "partially_applied" | "failed";
  result: { applied?: number; failures?: number; operations?: Array<Record<string, unknown>> } | null;
  createdAt: string;
  appliedAt: string | null;
};

export type LlmControllerPlanResponse = {
  schemaVersion: 1;
  adapter: "wizard-llm-http-v1" | "wizard-stage-llm-http-v1";
  endpointConfigured: true;
  status: "planned" | "no-action";
  visionContextId: string | null;
  visualContext: Record<string, unknown> | null;
  controller: Record<string, unknown>;
  interactionMode: "auto" | "manual" | "mixed";
  proposedOutput?: Record<string, unknown>;
  reason?: string;
  plan: WizardCorrectionPlan | null;
  llmSessionId?: string;
  stageRun?: LlmStageRun | null;
  transportError?: Record<string, unknown> | null;
};

export type LlmStageRun = {
  id: string;
  sessionId: string;
  stage: WizardStage;
  labelId: string | null;
  status: "queued" | "running" | "completed" | "human_required" | "failed" | "cancelled";
  iterationCount: number;
  inputArtifactIds: string[];
  inputContextSnapshot: Record<string, unknown>;
  decisions: unknown[];
  correctionPlanId: string | null;
  providerResponseId: string | null;
  providerRequestId: string | null;
  transportError: Record<string, unknown>;
  usage: Record<string, unknown>;
  latencyMs: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type LlmSession = {
  id: string;
  source: string;
  sourceItemId: string;
  annotationTrackId: string;
  provider: string;
  providerConversationId: string | null;
  model: string;
  modelSnapshot: string | null;
  adapterVersion: string;
  promptVersion: string;
  wizardDefinitionVersion: string;
  status: "created" | "active" | "blocked" | "completed" | "failed" | "cancelled";
  globalContext: Record<string, unknown>;
  currentStage: WizardStage | null;
  contextEvents: unknown[];
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  stageRuns: LlmStageRun[];
};

export type RecognitionPoint = { x: number; y: number };
export type QuadGeometry = {
  type: "quad";
  points: [RecognitionPoint, RecognitionPoint, RecognitionPoint, RecognitionPoint];
  /** Derived enclosing rectangle retained for bbox-only consumers. */
  bbox: RecognitionRoi;
};

export type WizardStageExecution = {
  id: string;
  source: string;
  sourceItemId: string;
  stage: WizardStage;
  revision: number;
  helperId: string;
  algorithm: string;
  algorithmVersion: string | null;
  status: "started" | "reviewed" | "superseded";
  stageInput: Record<string, unknown> | null;
  defaultParams: Record<string, unknown> | null;
  initialParams: Record<string, unknown> | null;
  autoOutput: Record<string, unknown> | null;
  finalParams: Record<string, unknown> | null;
  reviewedOutput: Record<string, unknown> | null;
  humanCorrection: Record<string, unknown>;
  helperRuns: Array<{
    id: string; stageExecutionId: string; runIndex: number; config: Record<string, unknown>;
    candidates: unknown[]; output: Record<string, unknown>; artifact: Record<string, unknown> | null;
    intermediateStates: Array<{ id: string; parentId: string | null; sequence: number; status: "pending" | "completed" | "failed"; algorithm: string | null; summary: Record<string, unknown> }>;
    createdAt: string;
  }>;
  selection: { runId: string; candidateId: string } | null;
  reviewMode: "accepted" | "corrected" | "manual" | null;
  startedAt: string;
  reviewedAt: string | null;
  updatedAt: string;
};

export type LabelAnnotationState = {
  schemaVersion: 2;
  prediction: {
    id?: string;
    helperRunId?: string;
    candidateId?: string;
    roi: RecognitionRoi;
    geometry?: QuadGeometry;
    rectification?: LabelRectification | null;
    confidence?: number | null;
    algorithm: {
      id: string;
      version?: string;
      params?: Record<string, unknown>;
      defaultParams?: Record<string, unknown>;
    };
    createdAt?: string;
  } | null;
  annotation: {
    id?: string;
    revision?: number;
    roi: RecognitionRoi;
    geometry?: QuadGeometry;
    rectification?: LabelRectification | null;
    reviewedAt?: string;
    reviewedBy?: string;
  } | null;
  status: "unprocessed" | "generated" | "needs-review" | "reviewed" | "no-label" | "invalid-image";
  reviewed: boolean;
  roiEdited: boolean;
  source: "auto" | "corrected" | "manual" | null;
  iou: number | null;
  labelRoiGt: boolean;
  updatedAt?: string;
  stageSample?: StageSampleV1;
  stageExecution?: WizardStageExecution;
};

export type LabelRectificationPoint = { x: number; y: number };
export type LabelCylindricalGuides = { centerLine: LabelRectificationPoint[]; horizontalGuides: LabelRectificationPoint[][]; leftBoundary: LabelRectificationPoint[]; rightBoundary: LabelRectificationPoint[] };
export type LabelRectification =
  | { type: "perspective"; transform: { schemaVersion: 1; model: "quad-homography-v1" } }
  | { type: "guided-cylindrical"; guides: LabelCylindricalGuides; controls: { signedCurvature: number; horizontalScale: number }; transform: { schemaVersion: 1; model: "guided-grid-v1"; coordinateSpace: "label-perspective-normalized"; columns: number[]; rows: Array<{ v: number; points: LabelRectificationPoint[] }>; curvature: number; surfaceWidth: number } };

export type AnnotationTrack = {
  id: string;
  source: string;
  sourceItemId: string;
  ordinal: number;
  name: string;
  sourceAssetRef: string | null;
  targetRegion: Record<string, unknown> | null;
  status: "draft" | "in-progress" | "reviewed" | "archived";
  preview: { imageUrl: string | null; bbox: Record<string, unknown> | null };
  completedStages: number;
  executionActor: { type: "human" | "ml-agent" | "hybrid" | null; sources: string[] };
  createdAt: string;
  updatedAt: string;
};

export type AnnotationRegionGeometry = QuadGeometry | {
  type: "polygon";
  points: Array<{ x: number; y: number }>;
  bbox: RecognitionRoi;
};

export type AnnotationGraphOcr = {
  id: string;
  packageId: string;
  labelId: string;
  legacyManaged: boolean;
  geometry: QuadGeometry;
  coordinateSpace:
    | { type: "label-rectified"; units: "normalized"; labelId: string; cropRevision: number | null; width: number | null; height: number | null }
    | { type: "unavailable"; reason: string };
  regionStatus: "reviewed" | "rejected";
  transcription: { text: string | null; status: "verified" | "partial" | "unreadable" };
  layout: OcrLayout;
  rectification: OcrRectification | null;
  confidence: number | null;
  parentRelation: { packageId: string; labelId: string; source: "auto" | "human"; status: "suggested" | "reviewed"; suggestedLabelId: string | null };
  meta: AnnotationGraphMeta[];
};

export type AnnotationGraphOcrComposition = {
  id: string;
  labelId: string;
  memberIds: string[];
  text: string | null;
  transcriptionStatus: "verified" | "partial" | "unreadable";
  sortOrder: number;
  origin: "human" | "llm" | "legacy";
  sourceOperationId: string | null;
  createdAt: string;
};

export type OcrLayout = {
  type: "word" | "string";
  flow: "linear" | "curved";
  baselineAngleDeg: number;
  baseline: RecognitionPoint[] | null;
  characterOrientation: "aligned" | "tangent-aligned" | "upright" | "mixed";
};

export type OcrRectification =
  | { type: "rotation"; angleDeg: number }
  | { type: "affine"; matrix: number[] }
  | { type: "perspective"; homography: number[] }
  | { type: "curved"; path: RecognitionPoint[]; params?: Record<string, number> };

export type AnnotationGraphMeta = {
  id: string;
  targetType: "item" | "package" | "label" | "ocr" | "meta";
  targetId: string | null;
  note: string;
  tags: string[];
  source: "human" | "auto";
};

export type AnnotationGraphOperation = {
  id: string;
  operationType: string;
  result: { type: "package" | "label" | "ocr" | "meta"; id: string } | null;
  results: Array<{ type: "package" | "label" | "ocr" | "meta"; id: string; deletedAt?: string | null }>;
  scope: { type: "package" | "label"; id: string } | null;
  helper: { id: string; version: string | null };
  reviewMode: "accepted" | "edited" | "manual";
  selectedCandidateId: string | null;
  candidateReviews: Array<{
    candidateId: string; state: "accepted" | "edited" | "rejected" | "merged"; resultEntityId: string | null; resultEntityIds: string[];
    finalPackageId: string | null; finalLabelId: string | null;
    reviewedGeometry: QuadGeometry | null; reviewedTranscription: string | null;
    reviewedRegionStatus: AnnotationGraphOcr["regionStatus"] | null;
    reviewedTranscriptionStatus: AnnotationGraphOcr["transcription"]["status"] | null;
    reviewedLayout: AnnotationGraphOcr["layout"] | null;
    reviewedRectification: AnnotationGraphOcr["rectification"];
  }>;
  reviewOperations: Array<{
    type: "merge";
    inputCandidateIds: string[];
    outputEntity: { type: "label"; id: string };
    outputGeometry: AnnotationRegionGeometry;
    mode: "automatic" | "manual" | "mixed";
  }>;
  roiReviewGraph: {
    schemaVersion: 1;
    nodes: Array<{
      id: string;
      origin: "autodetect" | "derived" | "manual" | "canonical";
      geometry: AnnotationRegionGeometry;
      candidateId?: string;
      entity?: { type: "label"; id: string };
    }>;
    operations: Array<
      | { type: "edit"; actor: "autodetect" | "llm" | "human" | "local_ml" | "system" | "unknown"; input: string; output: string }
      | { type: "merge"; actor: "autodetect" | "llm" | "human" | "local_ml" | "system" | "unknown"; inputs: string[]; output: string; mode: "automatic" | "manual" | "mixed" }
      | { type: "reject"; actor: "autodetect" | "llm" | "human" | "local_ml" | "system" | "unknown"; input: string }
      | { type: "approve"; actor: "autodetect" | "llm" | "human" | "local_ml" | "system" | "unknown"; input: string; outputEntity: { type: "label"; id: string } }
    >;
    reviewedOutputIds: string[];
  } | null;
  status: "draft" | "reviewed" | "failed";
  helperOutput: Record<string, unknown> | null;
  candidates: AutoOcrCandidate[];
  initialConfig: Record<string, unknown>;
  finalConfig: Record<string, unknown>;
  previousEntitySnapshot: Record<string, unknown> | null;
  resultingEntitySnapshot: Record<string, unknown> | null;
  resultDeletedAt: string | null;
  createdAt: string;
};

export type AnnotationGraph = {
  schemaVersion: 9;
  item: { source: string; sourceItemId: string };
  packages: Array<{
    id: string;
    legacyAnnotationTrackId: string | null;
    sourceAssetRef: string | null;
    scope: { geometry: AnnotationRegionGeometry | null; source: "default-full-image" | "auto" | "human" | "legacy-unclassified"; trainingRole: "helper-input" };
    packageType: { value: "bottle" | "tube" | "box" | "other" | "unknown"; status: "unreviewed" | "reviewed"; source: "human" | "auto" | null; reviewedAt: string | null };
    objectContext: { geometry: AnnotationRegionGeometry | null; status: "missing" | "suggested" | "reviewed" | "rejected"; source: "human" | "auto" | null; reviewedAt: string | null; trainingRole: "segmentation-gt" };
    /** @deprecated Compatibility alias for scope.geometry. */
    geometry: AnnotationRegionGeometry | null;
    status: "draft" | "reviewed";
    labels: Array<{
      id: string;
      legacyManaged: boolean;
      origin: "human" | "helper" | "legacy" | "migrated_from_direct_ocr";
      geometryReviewStatus: "suggested" | "reviewed" | "rejected";
      visualRegionKind: { value: "physical-label" | "direct-print" | "text-only" | "graphic-only" | "mixed" | "other" | "unknown"; status: "unreviewed" | "reviewed" };
      geometry: AnnotationRegionGeometry;
      rectification: LabelRectification | null;
      revision: number;
      status: "draft" | "reviewed";
      cv: { crop: Record<string, unknown> | null; job: Record<string, unknown> | null };
      ocr: AnnotationGraphOcr[];
      ocrCompositions?: AnnotationGraphOcrComposition[];
      meta: AnnotationGraphMeta[];
    }>;
    /** @deprecated Always empty in schema v7. */
    ocr: AnnotationGraphOcr[];
    meta: AnnotationGraphMeta[];
  }>;
  meta: AnnotationGraphMeta[];
  operations: AnnotationGraphOperation[];
  validation: { unresolvedIdentityConflicts: number; suggestedParentRelations: number; readyForCanonicalExport: boolean };
};

export type AnnotationGraphHelperOperation = {
  helperId: string;
  helperVersion?: string;
  initialConfig?: Record<string, unknown>;
  finalConfig?: Record<string, unknown>;
  candidates?: Array<{ id: string; payload: Record<string, unknown>; score?: number | null }>;
  selectedCandidateId?: string | null;
  reviewMode: "accepted" | "edited" | "manual";
};

export type LabelAnalysisReview = {
  id: string;
  source: string;
  sourceItemId: string;
  annotationId: string;
  annotationRevision: number;
  jobId: string;
  configHash: string;
  revision: number;
  status: "accepted" | "needs-tuning" | "rejected";
  notes: string;
  reviewedBy: string | null;
  createdAt: string;
};

export type LabelSourceCandidate = {
  id: string; bbox: RecognitionRoi; polygon: Array<[number, number]>; score: number;
  variant?: { groupId: string; kind: "tight" | "boundary-probed" | "dino-snapped"; mutuallyExclusive: true; areaDeltaRatio: number };
  cvScore?: number;
  ranking?: { cvRank: number; semanticRank: number | null; fusionRank: number };
  semantic?: {
    provider: "siglip2"; modelId: string; modelRevision: string; conceptSet: "wine-label-v1";
    positiveScore: number; negativeScore: number; semanticScore: number; scores: Record<string, number>;
  };
  structural?: {
    provider: "dinov3"; modelId: string; modelRevision: string; artifactId: string;
    id: string; status: "available" | "insufficient";
    regionCoherence: number | null; foregroundSeparation: number | null;
    insidePatchCount: number; ringPatchCount: number;
  };
  fusion?: {
    score: number; version: "label-fusion-v2";
    components: { cv: number; semantic: number; contourGeometry: number };
    weights: { cv: number; semantic: number; contourGeometry: number };
  };
  geometrySemantic?: {
    schemaVersion: 1; algorithm: "bottle-label-geometry-v2"; role: "front-label" | "neck-label";
    verdict: "likely" | "unlikely"; confidence: number;
    features: {
      normalizedCenterY: number; horizontalCentrality: number; localPackageWidthRatio: number;
      packageAreaRatio: number; packageHeightRatio: number; relativeCandidateArea: number; aspectRatio: number;
      independentAlternatives: number; containedAlternatives: number;
      packageZone: "neck" | "shoulder" | "body" | "base"; packageZoneConfidence: number;
    };
  };
  metrics: {
    edgeSupport: number; rectangularity: number; solidity: number; stability: number; areaRatio: number;
    packageEdgeAffinity?: number; bodyColorContinuation?: number; labelBoundaryContrast?: number;
    packageBottomAffinity?: number; sideInsetFromPackageContour?: number;
    packageEdgeAffinities?: { top: number; right: number; bottom: number; left: number };
    refinedEdges?: Array<"top" | "right" | "bottom" | "left">;
    boundaryProbe?: {
      algorithm: "package-local-boundary-probe-v1";
      edges: Partial<Record<"top" | "right" | "bottom" | "left", {
        action: "expand" | "keep" | "contract";
        position: number; score: number; contrast: number; coverage: number;
        outsideBodySimilarity: number; insideBodyDifference: number;
        textLikeDrop: number; sideTermination: number;
        discardedTextLike: number; retainedTextLike: number;
      }>>;
      baseIntrusion: number;
    };
  };
  detection: { passId: string; passIds?: string[]; config: Record<string, unknown> };
  verifiedIoU?: number | null;
};

export type AutoLabelConfigV1 = {
  schemaVersion: 1;
  previewMaxSide: number;
  chromaTolerance: number;
  minimumLightness: number;
  minRegionWidthRatio: number;
  maxRegionWidthRatio: number;
  rowGapRatio: number;
  minimumBandCoverage: number;
  envelopeCoverage: number;
  envelopeSizeMultiplier: number;
};

export type BottleDetectionConfig = {
  processingMode: "preview" | "final";
  previewMaxSize: number;
  paddingPercent: number;
  silhouetteThreshold: number;
  connectivity: 4 | 8;
  simplifyTolerance: number;
  canny: { blurKernel: 3 | 5; low: number; high: number };
  morphology: { closeKernel: 0 | 3 | 5 | 7; iterations: number };
};

export type BottleBezierSegment = {
  p0: [number, number]; c1: [number, number]; c2: [number, number]; p1: [number, number];
};

export type BottleBezierCurve = {
  kind: "closed-cubic-bezier";
  coordinateSpace: "natural";
  closed: true;
  segmentCount: number;
  segments: BottleBezierSegment[];
  fit: { sourcePointCount: number; rmsError: number; maxError: number };
  edited?: boolean;
};

export type BottleContourCandidate = {
  id: string;
  contour: Array<[number, number]>;
  polygon: Array<[number, number]>;
  rawContour?: Array<[number, number]>;
  simplifiedContour?: Array<[number, number]>;
  curve?: BottleBezierCurve;
  bbox: RecognitionRoi;
  score: number;
  recommended: boolean;
  origin: "foreground" | "canny" | "silhouette" | "edge-closed-fill" | "background-distance" | "combined-fill" | "border-flood" | "edge-fallback";
  palette: Array<{ rgb: number[]; lab: number[]; ratio: number }>;
  metrics: {
    areaRatio: number; labelContainment: number; foregroundSupport: number; edgeSupport?: number; closedness: number; solidity: number;
    borderContact: { top: boolean; bottom: boolean; left: boolean; right: boolean };
    centerOffset: number; contourStatus: "closed" | "partiallyClosed" | "cropInterrupted";
    curveFitValid?: boolean; curveBboxIoU?: number; curveMaxDeviation?: number;
  };
};

export type PackageDetectionCandidate = BottleContourCandidate & {
  classification: {
    type: "bottle" | "box";
    confidence: number;
    scores: { bottle: number; box: number };
    features: { aspectRatio: number; topWidthRatio: number; shoulderWidthRatio: number; middleWidthRatio: number; bottomWidthRatio: number; neckTaper: number; rectangularProfile: number };
  };
};

export type PackageDetectionRun = {
  schemaVersion: 1;
  runId: string;
  helper: { id: "package-smart-lasso"; version: "package-smart-lasso-v1" };
  scope: { type: "package"; id: string };
  sourceImage: { width: number; height: number; imageUrl: string };
  config: BottleDetectionConfig;
  candidates: PackageDetectionCandidate[];
  selectedCandidateId: string | null;
  debug: Record<string, unknown>;
  status: "draft";
};

export type BottleAnnotation = {
  status: "verified" | "skipped";
  shape?: Array<[number, number]>;
  rawContour?: Array<[number, number]>;
  simplifiedContour?: Array<[number, number]>;
  curve?: BottleBezierCurve;
  bbox?: RecognitionRoi;
  source?: "auto-confirmed" | "auto-edited" | "manual";
  candidateId?: string;
  detectionRunId?: string;
  verification?: { candidateIoU: number; bboxIoU: number; contourDistance: number };
  verifiedAt: string;
};

export type SiglipLabelMode = "off" | "score-only" | "rerank";
export type DinoLabelMode = "off" | "observe" | "refine";
export type VisionEvidenceRunOptions = { labelMode: SiglipLabelMode; dinoMode: DinoLabelMode };

export type LabelSourceAnalysisRun = {
  schemaVersion: 1; runId: string; algorithm: string; version: number;
  savedAt?: string;
  stageSample?: StageSampleV1;
  stageExecution?: WizardStageExecution;
  labelStageExecution?: WizardStageExecution;
  sourceImage: { width: number; height: number; imageUrl: string };
  packageScope?: RecognitionRoi | null;
  packageContext?: {
    bbox: RecognitionRoi; contour: Array<[number, number]>;
    packageType?: "bottle" | "box" | "tube" | "other" | "unknown";
    confidence?: number | null; source: "accepted-package-helper" | "reviewed-package-geometry" | "runtime-package-helper";
  } | null;
  packageConditioningContext?: {
    bbox: RecognitionRoi; contour: Array<[number, number]>;
    packageType?: "bottle" | "box" | "tube" | "other" | "unknown";
    confidence?: number | null; source: "accepted-package-helper" | "reviewed-package-geometry" | "runtime-package-helper";
  } | null;
  visionEvidenceConfig?: { labelMode: SiglipLabelMode; dinoMode?: DinoLabelMode; source: "run-override" | "server-default" };
  semanticEvidence?: {
    schemaVersion: 1; provider: "siglip2"; status: "disabled" | "available" | "unavailable";
    mode: "off" | "score-only" | "rerank" | "proposals";
    model: { id: string; revision: string };
    preprocessing: { resize: 256; mode: "candidate-crop"; version: "candidate-crop-v1" };
    conceptSet: { id: "wine-label-v1"; version: 1 };
    fusion: { version: "label-fusion-v2"; cvWeight: number; semanticWeight: number; contourGeometryWeight: number };
    results: Array<{ id: string; positiveScore: number; negativeScore: number; semanticScore: number; scores: Record<string, number> }>;
    cache: { hits: number; misses: number };
    error?: { code: string; message: string };
  };
  structuralEvidence?: {
    schemaVersion: 1; provider: "dinov3"; status: "disabled" | "available" | "unavailable";
    mode: DinoLabelMode; rankingApplied: false;
    model: { id: string; revision: string };
    preprocessing: { version: string; inputLongSide: number; patchSize: number };
    artifact: null | { id: string; cacheHit: boolean; storage: "safetensors-fp16" | "numpy-fp16" | "numpy-fp32"; gridWidth: number; gridHeight: number; featureDimensions: number };
    results: Array<{ id: string; status: "available" | "insufficient"; regionCoherence: number | null; foregroundSeparation: number | null; insidePatchCount: number; ringPatchCount: number }>;
    error?: { code: string; message: string };
  };
  candidates: LabelSourceCandidate[];
  labelDetection?: {
    config: AutoLabelConfigV1;
    ocrScout?: {
      status: "completed" | "unavailable"; algorithm: "tesseract-layout-scout-v1"; profileVersion?: string;
      passCount?: number; lineCount?: number; clusterCount?: number; error?: string;
    };
    debug: {
      preview: { width: number; height: number; maxSide: number } | null;
      searchWindow: RecognitionRoi | null;
      neutralBands: Array<{ bbox: RecognitionRoi; coverage: number }>;
      cannyEvidence: Array<{ bbox: RecognitionRoi; score: number; passIds: string[] }>;
      envelope: RecognitionRoi | null;
      packageAware?: { mode: "package-aware" | "standalone"; source?: string; packageType?: string; contourPointCount?: number; bbox?: RecognitionRoi };
      multiScaleRecovery?: {
        trigger: "zero-candidates"; initialPreviewMaxSide: number;
        attempts: Array<{ previewMaxSide: number; candidateCount: number; bestScore: number }>;
        selectedPreviewMaxSide: number | null;
      };
      initialPreview?: { width: number; height: number; maxSide: number } | null;
    };
  };
  passes: Array<{ id: string; config: Record<string, unknown>; candidateIds: string[]; stats: { contourCount: number; acceptedCount: number } }>;
  outerObject: null | {
    bbox: RecognitionRoi; contour: Array<[number, number]>;
    palette: Array<{ rgb: number[]; lab: number[]; ratio: number }>;
    confidence: number; method: string; config: { colorDistanceThreshold?: number; closeKernel?: number; [key: string]: unknown }; warnings: string[];
  };
  bottleDetection: null | {
    algorithm: "bottle-context-v1" | "bottle-context-v2" | "bottle-outline-v1" | "bottle-silhouette-v1" | "bottle-contour-proposals-v1" | "bottle-border-flood-v1" | "bottle-border-flood-v2";
    config: BottleDetectionConfig;
    candidates: BottleContourCandidate[];
    selectedCandidateId: string | null;
    annotation: BottleAnnotation | null;
    palette: Array<{ rgb: number[]; lab: number[]; ratio: number }>;
    debug: {
      foregroundRatio?: number; contourCount: number; acceptedCount: number;
      rejectedContours?: Array<Array<[number, number]>>;
      raster?: { width: number; height: number; labelExclusion?: string; background?: string; foreground?: string; foregroundSeed?: string; foregroundClosed?: string; edges: string; morphology: string; silhouette?: string; edgeSilhouette?: string; backgroundSilhouette?: string; combinedSilhouette?: string };
      background?: { rgb: number[]; lab: number[] };
      padding?: { percent: number; x: number; y: number; fill: number[] };
      processing?: { mode: "preview" | "final"; rasterWidth: number; rasterHeight: number; sourceWidth: number; sourceHeight: number; effectiveSimplifyTolerance?: number; elapsedMs: number };
    };
  };
  winningDetection: null | { candidateId: string; passId: string; config: Record<string, unknown>; verifiedIoU: number };
  createdAt: string;
};

export type OcrSemanticType = "vintage" | "barcode" | "alcohol" | "volume" | "classification" | "color" | "region" | "producer" | "product-name" | "free-text" | "unknown";
export type OcrTextDirection = "right" | "left" | "down" | "up" | "mixed";
export type OcrGlyphOrientation = "upright" | "clockwise" | "counterclockwise" | "upside-down" | "mixed";

export type OcrCascadeEvidence = {
  schemaVersion: 1;
  profileVersion: string;
  completedStage: "cheap" | "deep" | "rescue";
  stopReason: "strong-cheap-evidence" | "strong-deep-evidence" | "strong-rescue-evidence" | "rescue-exhausted";
  passes: Array<{
    id: string; stage: "cheap" | "deep" | "rescue"; region: "full" | "top" | "center" | "bottom";
    preprocess: "normalized" | "contrast" | "threshold" | "invert" | "clahe" | "adaptive-threshold" | "glare-suppressed" | "deskew" | "perspective" | "rotate-cw" | "rotate-ccw"; psm: string;
    minWidth: number; weight: number; rawText: string; normalizedText: string;
    confidence: number; runtimeMs: number; observationCount: number; validObservationCount: number; deskewAngleDegrees?: number | null; rotationDegrees?: number | null;
  }>;
  observations: Array<{
    id: string; passId: string; profileWeight: number; parentObservationId: string | null; level: "line" | "word";
    bbox: RecognitionRoi; rawText: string; normalizedText: string; confidence: number | null;
    validityScore: number; valid: boolean; rejectionReasons: string[];
    textDirection?: OcrTextDirection; glyphOrientation?: OcrGlyphOrientation;
  }>;
  consensusRegions: Array<{
    key: string; parentKey: string | null; level: "line" | "word"; bbox: RecognitionRoi;
    rawText: string; normalizedText: string; confidence: number | null; support: number;
    passIds: string[]; observationIds: string[]; validityScore: number;
    textConsensus: number; spatialConsensus: number; consensus: number;
    semantic?: { type: OcrSemanticType; confidence: number; reasons: string[] };
    textDirection?: OcrTextDirection; glyphOrientation?: OcrGlyphOrientation;
  }>;
  geometry?: {
    evaluated: boolean; angleDegrees: number | null; confidence: number; applied: boolean;
    method: "component-baseline-v1";
    perspective?: {
      evaluated: boolean; applied: boolean; confidence: number; distortion: number;
      corners: null | { topLeft: { x: number; y: number }; topRight: { x: number; y: number }; bottomRight: { x: number; y: number }; bottomLeft: { x: number; y: number } };
      method: "directional-edge-quad-v1";
    };
  };
  quality: {
    observationCount: number; validObservationCount: number; rejectedObservationCount: number;
    consensusRegionCount: number; supportedConsensusRegionCount: number;
    averageOcrConfidence: number; averageValidityScore: number; averageConsensus: number;
    semanticRegionCount?: number; highConfidenceSemanticRegionCount?: number;
  };
};

export type LabelCatalogCandidate = {
  source: "svoe_vino" | "roskachestvo";
  sourceItemId: string;
  title: string;
  manufacturer: string | null;
  score: number;
  matchedRegionCount: number;
  isCurrentItem: boolean;
  matches: Array<{
    ocrRegionId: string; regionText: string; semanticType: OcrSemanticType;
    sourceField: string; sourceValue: string; lexicalScore: number;
    semanticCompatibility: number; score: number;
    matchKind: "exact" | "contains" | "token-overlap" | "fuzzy";
  }>;
};

export type CatalogIdentityReview = {
  id: string;
  source: "svoe_vino" | "roskachestvo";
  sourceItemId: string;
  analysisJobId: string;
  ocrRegionAnnotationSetId: string | null;
  revision: number;
  status: "confirmed" | "corrected" | "no-match" | "ambiguous";
  selectedSource: "svoe_vino" | "roskachestvo" | null;
  selectedSourceItemId: string | null;
  candidateSnapshot: Record<string, unknown>;
  score: number | null;
  notes: string;
  reviewedBy: string | null;
  createdAt: string;
  stageExecution?: WizardStageExecution;
};

export type PutCatalogIdentityReview = {
  baseRevision: number;
  analysisJobId: string;
  ocrRegionAnnotationSetId?: string | null;
  status: CatalogIdentityReview["status"];
  selectedSource?: CatalogIdentityReview["selectedSource"];
  selectedSourceItemId?: string | null;
  candidateSnapshot?: Record<string, unknown>;
  score?: number | null;
  notes?: string;
  reviewedBy?: string;
};

export type LabelAnalysisResult = {
  schemaVersion: 2;
  jobId: string;
  annotationId: string;
  annotationRevision: number;
  crop: {
    id: string; assetPath: string; sourceImage: string; sourceRect: RecognitionRoi; sourceGeometry?: QuadGeometry;
    width: number; height: number; transformMode?: "source-bbox" | "perspective" | "guided-cylindrical";
  };
  ocr: {
    runId: string; engine: string; engineVersion: string | null; rawText: string;
    normalizedText: string; confidence: number | null; runtimeMs: number | null;
    evidence: OcrCascadeEvidence | null;
  };
  textRegions: Array<{
    id: string; parentId: string | null; level: "line" | "word"; bbox: RecognitionRoi; geometry?: QuadGeometry;
    rawText: string; normalizedText: string; confidence: number | null;
    textDirection: OcrTextDirection; glyphOrientation: OcrGlyphOrientation;
    semantic?: { type: OcrSemanticType; confidence: number; reasons: string[] } | null;
  }>;
  sourceMatches: Array<{
    ocrRegionId: string; regionText: string; sourceField: string; sourceValue: string;
    score: number; matchKind: "exact" | "contains" | "token-overlap";
    lexicalScore?: number; semanticType?: OcrSemanticType; semanticConfidence?: number; semanticCompatibility?: number;
  }>;
  catalogCandidates?: LabelCatalogCandidate[];
  visualFeatures: {
    palette: Array<{ rgb: [number, number, number]; ratio: number }>;
    quality: { entropy: number | null; sharpness: number | null };
    components?: Array<{
      id: number; area: number; bbox: RecognitionRoi; centroid: { x: number; y: number }; accepted: boolean; proposalAccepted: boolean;
      areaRatio: number; width: number; height: number; aspectRatio: number; fillRatio: number;
      borderTouch: { top: boolean; right: boolean; bottom: boolean; left: boolean };
      reviewStatus: ComponentReviewStatus;
    }>;
    elements?: LabelElement[];
    elementProposals?: LabelElement[];
    contours: Array<{ kind: "binary-boundary"; componentId?: number; elementId?: string; ringIndex?: number; ringKind?: "outer" | "hole"; rawPoints?: Array<[number, number]>; points: Array<[number, number]>; vectorization?: "polygon" | "bezier"; bezier?: { kind: "closed-cubic-bezier"; start: [number, number]; segments: Array<{ control1: [number, number]; control2: [number, number]; end: [number, number] }> } | null; shapeDeviation?: number }>;
    stage?: LabelCvStage;
    stageMetrics?: Record<string, number>;
    cvDebug: Record<string, unknown>;
  };
  configSnapshot: LabelAnalysisCvConfig;
  warnings: string[];
  runtimeMs: number;
  provenance: { pipelineVersion: string; analysisProfileVersion: string; engine: string; configHash: string };
};

export type ComponentReviewStatus = "accepted" | "rejected" | "unreviewed";
export type LabelElementType = "text" | "graphic" | "separator" | "shape" | "unknown";
export type LabelElementRole = "brand" | "product_name" | "variety" | "producer" | "year" | "description" | "logo" | "signature" | "ornament" | "separator" | "unknown" | "other";
export type LabelElementProvenance = {
  source?: "manual" | "ocr" | "geometry" | "model" | "imported";
  /** @deprecated Read compatibility for the early schema-v4 shape. */
  method?: "manual" | "ocr" | "geometry" | "model";
  sourceRef?: { kind: "ocr-region"; id: string };
  /** @deprecated Read compatibility; this score now belongs to grouping.confidence. */
  confidence?: number;
  grouping?: { method: "manual" | "ocr-overlap" | "proximity" | "containment" | "alignment" | "model"; confidence?: number };
};
export type LabelElement = {
  id: string; bbox: RecognitionRoi; sourceComponentIds: number[]; type: LabelElementType;
  role?: LabelElementRole;
  status: ComponentReviewStatus; source: "auto" | "modified";
  /** @deprecated Read compatibility; use provenance.sourceRef. */
  textRegionId?: string;
  text?: string;
  /** @deprecated Read compatibility; OCR confidence remains on the referenced OCR region. */
  confidence?: number | null;
  provenance?: LabelElementProvenance;
  /** @deprecated Read compatibility for schema-v3 reviews. New saves emit provenance. */
  groupingMeta?: { method: "ocr" | "proximity" | "geometry" | "manual" | "model"; score?: number };
};
export type LabelCvReviewState = {
  componentDecisions: Record<string, Exclude<ComponentReviewStatus, "unreviewed">>;
  elements: Array<Pick<LabelElement, "id" | "sourceComponentIds" | "type" | "role" | "status" | "textRegionId" | "text" | "confidence" | "provenance" | "groupingMeta">>;
  elementsReviewed?: boolean;
};

export type LabelAnalysisCvConfig = {
  schemaVersion: 3;
  threshold: number;
  invert: boolean;
  maskSize: number;
  maskMode: "auto" | "candidate" | "manual";
  morphologyEnabled: boolean;
  morphologyOperation: "open" | "close" | "dilate" | "erode";
  morphologyKernelWidth: number;
  morphologyKernelHeight: number;
  morphologyIterations: number;
  morphologyMode: "auto" | "manual";
  morphologyPipeline?: Array<{
    operation: "open" | "close" | "dilate" | "erode";
    kernel: [number, number];
    iterations: number;
  }>;
  componentFilterPreset: "none" | "light" | "normal" | "strong" | "custom";
  componentMode: "auto" | "candidate" | "manual";
  componentConnectivity: 4 | 8;
  minComponentAreaRatio: number;
  maxComponentAreaRatio: number;
  maxContourPoints: number;
  contourDetail: "precise" | "balanced" | "simplified" | "custom";
  contourSimplifyRatio: number;
  contourVectorization: "polygon" | "bezier";
  paletteColors: number;
  paletteMinRatio: number;
};

export type LabelCvStage = "mask" | "morphology" | "components" | "elements" | "contours" | "palette";

export type LabelCvCheckpoint = {
  status: "valid" | "stale";
  completedAt: string;
  inputSignature: string;
  invalidatedAt?: string;
  invalidatedBy?: LabelCvStage;
  execution?: {
    initialParams: StageCapturedValue;
    finalParams: StageCapturedValue;
    autoOutput: StageCapturedValue;
    reviewedOutput: StageCapturedValue;
    humanCorrection?: StageSampleV1["humanCorrection"];
  };
};

export type LabelCvWorkflow = {
  schemaVersion: 1;
  lastCompletedStage: LabelCvStage;
  checkpoints: Partial<Record<LabelCvStage, LabelCvCheckpoint>>;
  updatedAt: string;
};

export type LabelPaletteColor = {
  rgb: [number, number, number];
  ratio?: number | null;
  source?: "detected" | "eyedropper";
};

export type LabelCvJob = {
  schemaVersion: 3 | 4;
  annotationId: string;
  annotationRevision: number;
  analysisJobId: string;
  config: LabelAnalysisCvConfig;
  previewStage?: LabelCvStage;
  preview?: LabelAnalysisResult["visualFeatures"];
  review?: LabelCvReviewState;
  palette?: LabelPaletteColor[];
  workflow?: LabelCvWorkflow;
  debugArtifact?: { schemaVersion: 1; kind: "label-cv-debug"; assetPath: string };
  updatedAt: string;
  reviewedAt?: string;
  stageSample?: StageSampleV1;
  stageExecution?: WizardStageExecution;
  summaryStageExecution?: WizardStageExecution;
};

export type LabelWorkflowSummary = {
  schemaVersion: 1;
  computedAt: string;
  ocrText: string;
  reviewedRegionCount: number;
  sourceMatches: Array<{
    ocrRegionAnnotationId: string; regionText: string; field: string; value: string;
    score: number; matchKind: "exact" | "contains" | "token-overlap";
  }>;
  fixedAssociations: Array<{
    id: string; regionTextSnapshot: string; sourceField: string; sourceValue: string;
    score: number | null; status: string;
  }>;
  catalogCandidates: LabelCatalogCandidate[];
  palette: LabelPaletteColor[];
  componentCount: number;
  reviewedComponentCount: number;
  elementCount: number;
  reviewedElementCount: number;
  contourCount: number;
  contourPointCount: number;
  ocrEvidence: null | {
    completedStage: "cheap" | "deep" | "rescue";
    stopReason: string;
    passCount: number;
    validObservationCount: number;
    rejectedObservationCount: number;
    consensusRegionCount: number;
    supportedConsensusRegionCount: number;
    averageConsensus: number;
    semanticRegionCount: number;
    highConfidenceSemanticRegionCount: number;
    deskewEvaluated: boolean;
    deskewApplied: boolean;
    deskewAngleDegrees: number | null;
    deskewConfidence: number;
    perspectiveEvaluated: boolean;
    perspectiveApplied: boolean;
    perspectiveConfidence: number;
    perspectiveDistortion: number;
  };
};

export type LabelAnalysisWorkspace = {
  annotation: LabelAnnotationState;
  sourceAnalysis: LabelSourceAnalysisRun | null;
  analysis: LabelAnalysisResult | null;
  review: LabelAnalysisReview | null;
  stale: boolean;
  latestJob: RecognitionItemJob | null;
  cvJob: LabelCvJob | null;
  summary: LabelWorkflowSummary;
  ocrRegionReview: LabelAnnotationOcrRegionReview | null;
  ocrRegionAnnotationSetId: string | null;
  catalogIdentityReview: CatalogIdentityReview | null;
  stageSamples: StageSampleV1[];
  stageExecutions: WizardStageExecution[];
};

export type DetectionProposalItem = {
  id: string;
  prediction: NonNullable<LabelAnnotationState["prediction"]>;
  status: string;
  createdAt: string;
};

export type LabelAnnotationOcrSnapshot = {
  crop: {
    id: string;
    bbox: Record<string, unknown>;
    geometry: QuadGeometry;
    width: number | null;
    height: number | null;
    assetPath: string | null;
    createdAt: string;
  };
  ocr: {
    id: string;
    executionMode: string;
    engine: string;
    engineVersion: string | null;
    configHash: string | null;
    rawText: string;
    normalizedText: string;
    confidence: number | null;
    status: string;
    runtimeMs: number | null;
    error: string | null;
    evidence: OcrCascadeEvidence | null;
    createdAt: string;
  };
  regions: LabelAnnotationOcrRegion[];
  stageExecution?: WizardStageExecution;
};

export type LabelAnnotationOcrRegion = {
  id: string;
  parentId: string | null;
  level: string;
  bbox: Record<string, unknown>;
  geometry?: QuadGeometry;
  rawText: string;
  normalizedText: string;
  confidence: number | null;
  reviewStatus: string;
  textDirection: OcrTextDirection;
  glyphOrientation: OcrGlyphOrientation;
  createdAt: string;
};

export type LabelAnnotationOcrReview = {
  id: string;
  source: string;
  sourceItemId: string;
  ocrRunId: string | null;
  text: string;
  normalizedText: string;
  status: string;
  sourceKind: string;
  revision: number;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LabelAnnotationOcrRegionReview = {
  id: string;
  source: string;
  sourceItemId: string;
  ocrRunId: string | null;
  revision: number;
  status: "draft" | "reviewed" | "rejected";
  reviewedBy: string | null;
  createdAt: string;
  stageExecution?: WizardStageExecution;
  compositions: Array<{
    id: string;
    kind: "string";
    memberIds: string[];
    text: string | null;
    transcriptionStatus: OcrTranscriptionStatus;
    sortOrder: number;
  }>;
  reviewOperations: Array<{
    id: string;
    type: "approve_region" | "approve_text" | "reject" | "edit_region" | "edit_text" | "merge_region" | "split_region" | "create_region" | "compose_string" | "decompose_string";
    inputIds: string[];
    outputIds: string[];
    actor: "human";
  }>;
  regions: Array<{
    id: string;
    sourceRegionIds: string[];
    level: "word" | "line" | "string";
    bbox: RecognitionRoi;
    geometry?: QuadGeometry;
    text: string | null;
    normalizedText: string | null;
    transcriptionStatus: OcrTranscriptionStatus;
    prediction: { bbox: RecognitionRoi; geometry?: QuadGeometry; text: string | null; confidence: number | null; layout: OcrLayout; rectification: OcrRectification | null } | null;
    annotation: { bbox: RecognitionRoi; geometry?: QuadGeometry; text: string | null; transcriptionStatus: OcrTranscriptionStatus };
    bboxEdited: boolean;
    textEdited: boolean;
    detectionGt: true;
    recognitionGt: boolean;
    source: "manual" | "auto" | "partially-corrected" | "fully-corrected";
    status: "reviewed" | "rejected";
    sourceKind: "accepted-generated" | "corrected-generated" | "manual" | "merged" | "split";
    textDirection: OcrTextDirection;
    glyphOrientation: OcrGlyphOrientation;
    layout: OcrLayout;
    rectification: OcrRectification | null;
    sortOrder: number;
  }>;
};

export type PutLabelAnnotationOcrRegionReview = {
  baseRevision: number;
  ocrRunId?: string | null;
  status?: "draft" | "reviewed" | "rejected";
  reviewedBy?: string;
  regions: Array<{
    clientId?: string;
    sourceRegionIds: string[];
    level: "word" | "line" | "string";
    prediction: { bbox: RecognitionRoi; geometry?: QuadGeometry; text: string | null; confidence?: number | null; layout?: OcrLayout; rectification?: OcrRectification | null } | null;
    annotation: { bbox: RecognitionRoi; geometry?: QuadGeometry; text: string | null; transcriptionStatus: OcrTranscriptionStatus };
    textDirection: OcrTextDirection;
    glyphOrientation: OcrGlyphOrientation;
    layout?: OcrLayout;
    rectification?: OcrRectification | null;
    sortOrder?: number;
  }>;
  compositions?: Array<{
    clientId: string;
    kind: "string";
    memberClientIds: string[];
    text: string | null;
    transcriptionStatus: OcrTranscriptionStatus;
    sortOrder?: number;
  }>;
};

export type OcrSourceField = "title" | "manufacturer" | "category" | "region" | "year" | "barcode" | "color" | "description" | "alias" | "normalized-token";

export type OcrSourceAssociationReview = {
  id: string;
  source: string;
  sourceItemId: string;
  ocrRegionAnnotationSetId: string | null;
  revision: number;
  status: "draft" | "reviewed" | "rejected";
  reviewedBy: string | null;
  createdAt: string;
  associations: Array<{
    id: string;
    ocrRegionAnnotationId: string | null;
    regionTextSnapshot: string;
    sourceField: OcrSourceField;
    sourceValue: string;
    status: "reviewed" | "rejected";
    sourceKind: "accepted-suggested" | "corrected-suggested" | "manual";
    matchKind: "exact" | "contains" | "token-overlap" | "manual";
    score: number | null;
    sortOrder: number;
  }>;
};

export type OcrSourceAssociationWorkspace = {
  ocrRegionReview: LabelAnnotationOcrRegionReview | null;
  sourceValues: Array<{ field: OcrSourceField; value: string; valueKind: "full" | "token" }>;
  candidates: Array<{
    ocrRegionAnnotationId: string;
    regionText: string;
    field: OcrSourceField;
    value: string;
    valueKind: "full" | "token";
    score: number;
    matchKind: "exact" | "contains" | "token-overlap";
  }>;
  review: OcrSourceAssociationReview | null;
};

export type PutOcrSourceAssociationReview = {
  baseRevision: number;
  ocrRegionAnnotationSetId?: string | null;
  status?: "draft" | "reviewed" | "rejected";
  reviewedBy?: string;
  associations: Array<{
    ocrRegionAnnotationId?: string | null;
    regionTextSnapshot: string;
    sourceField: OcrSourceField;
    sourceValue: string;
    status: "reviewed" | "rejected";
    sourceKind: "accepted-suggested" | "corrected-suggested" | "manual";
    matchKind: "exact" | "contains" | "token-overlap" | "manual";
    score?: number | null;
    sortOrder?: number;
  }>;
};

export type AliasReview = {
  id: string;
  source: string;
  sourceItemId: string;
  sourceAssociationSetId: string | null;
  revision: number;
  status: "draft" | "reviewed" | "rejected";
  reviewedBy: string | null;
  createdAt: string;
  aliases: Array<{
    id: string;
    value: string;
    normalizedValue: string;
    aliasType: "source-title" | "source-field" | "ocr-associated" | "composite" | "manual";
    status: "reviewed" | "rejected";
    sourceKind: "accepted-generated" | "corrected-generated" | "manual";
    score: number | null;
    sourceAssociationIds: string[];
    components: Record<string, unknown>;
    sortOrder: number;
  }>;
};

export type AliasReviewWorkspace = {
  sourceAssociationReview: OcrSourceAssociationReview | null;
  candidates: Array<{
    candidateKey: string;
    value: string;
    normalizedValue: string;
    aliasType: "source-title" | "source-field" | "ocr-associated" | "composite";
    score: number;
    sourceAssociationIds: string[];
    components: Record<string, unknown>;
  }>;
  review: AliasReview | null;
};

export type PutAliasReview = {
  baseRevision: number;
  sourceAssociationSetId?: string | null;
  status?: "draft" | "reviewed" | "rejected";
  reviewedBy?: string;
  aliases: Array<{
    value: string;
    aliasType: "source-title" | "source-field" | "ocr-associated" | "composite" | "manual";
    status: "reviewed" | "rejected";
    sourceKind: "accepted-generated" | "corrected-generated" | "manual";
    score?: number | null;
    sourceAssociationIds: string[];
    components?: Record<string, unknown>;
    sortOrder?: number;
  }>;
};

export type DatasetVersion = {
  id: string;
  cohortId?: string;
  name: string;
  version: number;
  schemaVersion: number;
  status: "frozen" | "archived";
  itemCount: number;
  manifest: { schemaVersion?: number; frozenAt?: string; itemCount?: number; layers?: Record<string, number> };
  createdAt: string;
  artifacts?: DatasetArtifact[];
};

export type DatasetArtifact = {
  id: string;
  datasetVersionId: string;
  artifactType: string;
  outputPath: string;
  annotationsSha256: string;
  manifest: Record<string, unknown>;
  createdAt: string;
};

export type TrainingTask = "label-roi" | "physical-label-roi" | "ocr-region" | "source-matching" | "alias-ranking" | "bottle-outline" | "label-elements" | "label-palette";
export type TrainingStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type ModelStatus = "candidate" | "validated" | "promoted" | "deprecated";

export type DatasetArtifactReadiness = {
  artifactId: string;
  schemaVersion: number;
  checksumValid: boolean;
  ready: boolean;
  task: TrainingTask;
  totalItems: number;
  eligibleItems: number;
  eligibleSamples: number;
  skippedItems: number;
  splits: Record<"train" | "validation" | "test", { total: number; eligible: number }>;
  layers: Record<string, number>;
  taskArtifact: { file: string; count: number; sha256: string; adapterVersion: number } | null;
  warnings: string[];
};

export type OcrTranscriptionStatus = "verified" | "partial" | "unreadable";

export type EvaluationResult = {
  id: string;
  trainingRunId: string;
  modelVersionId: string | null;
  split: "train" | "validation" | "test";
  metrics: Record<string, number>;
  sampleCount: number;
  createdAt: string;
};

export type ModelVersion = {
  id: string;
  trainingRunId: string;
  task: TrainingTask;
  name: string;
  version: number;
  status: ModelStatus;
  artifactPath: string;
  artifactSha256: string;
  runtime: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  promotedAt: string | null;
};

export type TrainingRun = {
  id: string;
  datasetArtifactId: string;
  datasetVersionId: string;
  datasetArtifactPath: string;
  datasetArtifactSha256: string;
  task: TrainingTask;
  name: string;
  status: TrainingStatus;
  framework: string;
  runtime: string | null;
  configSnapshot: Record<string, unknown>;
  codeVersion: string | null;
  createdBy: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  evaluations: EvaluationResult[];
  models: ModelVersion[];
};

export type AnnotationCohort = {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "frozen" | "archived";
  itemCount: number;
  createdBy?: string | null;
  createdAt: string;
  frozenAt?: string | null;
  versions: DatasetVersion[];
};

export type RecognitionMetadataResponse = {
  items: RecognitionMetaItem[];
  total: number;
  limit: number;
  offset: number;
};

export type RecognitionInventoryItem = {
  source: string;
  sourceItemId: string;
  title: string | null;
  manufacturer: string | null;
  category: string | null;
  region: string | null;
  year: number | null;
  barcode: string | null;
  color: string | null;
  description: string | null;
  imageUrls: string[];
  recognitionTags?: string[];
  annotationTracks: Array<{ id: string; ordinal: number; name: string; status: string; previewBbox: Record<string, unknown> | null; progress: {
    completedStages: number; totalStages: 11; nextStage: WizardStage | null; status: "not-started" | "in-progress" | "complete";
    executionActor: { type: "human" | "ml-agent" | "hybrid" | null; sources: string[] };
    automation: { mode: "manual" | "auto" | "mixed" | null; autoStages: number; manualStages: number; mixedStages: number; classifiedStages: number; automationRate: number | null; stages: Partial<Record<WizardStage, "manual" | "auto" | "mixed">> };
  } }>;
  annotationWorkflow: {
    status: "not-started" | "in-progress" | "complete";
    executionActor: { type: "human" | "ml-agent" | "hybrid" | null; sources: string[] };
    automation: { mode: "manual" | "auto" | "mixed" | null; autoStages: number; manualStages: number; mixedStages: number; classifiedStages: number; automationRate: number | null; stages: Partial<Record<WizardStage, "manual" | "auto" | "mixed">> };
  };
  metadata: {
    id: string;
    status: string;
    aliasesCount: number;
    normalizedTokensCount: number;
    hasCvMeta: boolean;
    generationVersion: string | null;
    sourceHash: string | null;
    updatedAt: string | null;
    annotationStatus: string | null;
    hasGeneratedLabelRoi: boolean;
    hasReviewedLabelRoi: boolean;
    hasBackendOcr: boolean;
    hasReviewedOcrText: boolean;
    catalogIdentityStatus: "confirmed" | "corrected" | "no-match" | "ambiguous" | null;
    catalogIdentityRevision: number | null;
  } | null;
  latestJob: {
    id: string;
    type: string | null;
    status: string;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
  } | null;
};

export type RecognitionInventoryResponse = {
  items: RecognitionInventoryItem[];
  total: number;
  limit: number;
  offset: number;
};

export type AnnotationSummary = {
  source: "all" | "svoe_vino" | "roskachestvo";
  totalItems: number;
  withProposal: number;
  missingProposal: number;
  needsReview: number;
  reviewed: number;
  reviewedBbox: number;
  noLabel: number;
  invalidImage: number;
  noAnnotation: number;
  readyForExport: number;
  withBackendOcr: number;
  withReviewedOcrText: number;
  needsOcr: number;
  needsOcrReview: number;
  textReadyForExport: number;
  withLabelAnalysis: number;
  needsLabelAnalysisReview: number;
  labelAnalysisAccepted: number;
  labelAnalysisNeedsTuning: number;
  labelAnalysisRejected: number;
  withCatalogIdentity: number;
  needsCatalogIdentity: number;
  catalogIdentityConfirmed: number;
  catalogIdentityCorrected: number;
  catalogIdentityNoMatch: number;
  catalogIdentityAmbiguous: number;
  reviewedPercent: number;
  exportReadyPercent: number;
  ocrReadyPercent: number;
  proposalCoveragePercent: number;
  catalogIdentityReadyPercent: number;
};

export type RecognitionMetadataParams = {
  source?: "all" | "svoe_vino" | "roskachestvo";
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

export type RecognitionInventoryParams = {
  source?: "all" | "svoe_vino" | "roskachestvo";
  search?: string;
  metaStatus?: string;
  cvMeta?: "all" | "present" | "missing";
  annotationStatus?: "missing" | "needs-review" | "reviewed" | "no-label" | "invalid-image" | "needs-ocr" | "needs-ocr-review" | "ready-for-export" | "not-started" | "in-progress" | "complete";
  executionActor?: "human" | "ml-agent" | "hybrid";
  automationMode?: "manual" | "auto" | "mixed";
  recognitionTag?: string;
  analysisStatus?: "missing" | "needs-review" | "accepted" | "needs-tuning" | "rejected";
  catalogIdentityStatus?: "missing" | "confirmed" | "corrected" | "no-match" | "ambiguous";
  firstPerInitial?: boolean;
  perInitialLimit?: number;
  limit?: number;
  offset?: number;
};

export type RecognitionDetailResponse = {
  sourceItem: {
    source: string;
    sourceItemId: string;
    title: string | null;
    producer: string | null;
    category: string | null;
    region: string | null;
    year: number | null;
    barcode: string | null;
    description: string | null;
    imageUrls: string[];
    sourceUpdatedAt: string | null;
  };
  metadata: RecognitionMetaItem | null;
  jobs: RecognitionItemJob[];
};

export type RecognitionItemJob = {
  jobId: string;
  parentJobId: string | null;
  scope: "batch-parent" | "batch-child" | "single-item";
  type: string;
  status: string;
  cancelRequested?: boolean;
  annotationVersionId?: string | null;
  pipelineVersion: string | null;
  sourceHash: string | null;
  options: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string | null;
  reused?: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type AnnotationVersion = {
  id: string;
  revision: number;
  status: "draft" | "processing" | "review_required" | "approved" | "failed" | "cancelled" | "superseded";
  annotationTrackId: string | null;
  parentVersionId: string | null;
  sourceJobId: string | null;
  origin: string;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  isActive: boolean;
  isDefault: boolean;
  snapshot?: AnnotationGraph;
};

export type MetadataVersion = {
  id: string;
  revision: number;
  origin: string;
  sourceJobId: string | null;
  createdAt: string;
  isActive: boolean;
  isDefault: boolean;
  snapshot: {
    aliases?: string[];
    normalizedTokens?: string[];
    visualFeatures?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    status?: string;
    generationVersion?: string | null;
    sourceHash?: string | null;
    generatedAt?: string | null;
    manuallyEditedAt?: string | null;
    updatedAt?: string | null;
  };
};

export type RecognitionJob = {
  jobId: string;
  parentJobId: string | null;
  scope: "batch-parent" | "batch-child" | "single-item";
  type: string;
  status: string;
  cancelRequested?: boolean;
  workerId?: string | null;
  heartbeatAt?: string | null;
  leaseExpiresAt?: string | null;
  recoveryCount?: number;
  annotationVersionId: string | null;
  target: Record<string, unknown>;
  options: Record<string, unknown>;
  progress: {
    total: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled?: number;
    humanRequired?: number;
  };
  result: Record<string, unknown>;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RecognitionJobType =
  | "ANNOTATION_HELPER_PIPELINE"
  | "ANNOTATION_LLM_PIPELINE"
  | "ANALYZE_LABEL"
  | "GENERATE_ALIASES"
  | "GENERATE_DETECTION_PROPOSAL"
  | "GENERATE_CV_META"
  | "GENERATE_ALL_META"
  | "REGENERATE_ALL_META";

export type RecognitionJobsResponse = {
  items: RecognitionJob[];
  total: number;
  limit: number;
  offset: number;
};

export type RecognitionJobEstimate = {
  source: string;
  pipelineVersion: string;
  missingCvMeta: boolean;
  force: boolean;
  eligible: number;
  batchSize: number;
  planned: number;
  activeOrCompletedJobs: number;
  note: string;
  presetId?: string | null;
  presetRevision?: number | null;
};

export type RecognitionBatchTarget =
  | { filter: { source: "all" | "svoe_vino" | "roskachestvo"; missingCvMeta?: boolean } }
  | { items: Array<{ source: "svoe_vino" | "roskachestvo"; sourceItemId: string }> };

export type CvPlaygroundRunResponse = {
  runId: string;
  mode: "preview" | "full";
  source: string;
  sourceItemId: string;
  imageUrl: string;
  metrics: {
    runtimeMs: number;
    candidateCount: number;
    selectedScore: number | null;
    selectedConfidence: number | null;
    labelFound: boolean;
    bottleFound: boolean;
    qualityScore: number;
  };
  cvMeta: unknown;
};

export type CvPlaygroundSweepResponse = {
  runId: string;
  mode: "preview" | "full";
  source: string;
  sourceItemId: string;
  totalVariants: number;
  runtimeMs: number;
  groups: Array<{
    parameterPath: string;
    values: number[];
    variants: Array<{
      parameterPath: string;
      value: number;
      config: Record<string, unknown>;
      configHash: string;
      metrics: CvPlaygroundRunResponse["metrics"];
      cvMeta: unknown;
    }>;
  }>;
};

export type PipelinePresetRecord<TConfig = Record<string, unknown>> = {
  revisionId: string;
  id: string;
  revision: number;
  layer: "label-roi" | "ocr-region" | "ocr-recognition" | "source-matching" | "alias-generation" | "pipeline";
  name: string;
  description: string | null;
  status: "draft" | "validated" | "deprecated";
  engineKind: string;
  engineVersion: string | null;
  config: TConfig;
  createdFrom: { source: string; sourceItemId: string } | null;
  createdBy: string | null;
  basedOnRevision: number | null;
  validationDatasetVersion: string | null;
  validationMetrics: Record<string, unknown> | null;
  createdAt: string;
};

export async function loginAdmin(username: string, password: string) {
  const formData = new URLSearchParams();
  formData.set("username", username);
  formData.set("password", password);

  return requestJson<TokenResponse>("/api/v1/auth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData,
  });
}

export async function listWines(params: WineListParams, token: string | null) {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "" && value !== "all") {
      searchParams.set(key, String(value));
    }
  }

  return requestJson<WineListResponse>(
    `/api/v1/wines?${searchParams.toString()}`,
    {},
    token
  );
}

export async function listCatalog(params: CatalogListParams, token: string | null) {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      searchParams.set(key, String(value));
    }
  }

  return requestJson<CatalogResponse>(
    `/api/v1/catalog?${searchParams.toString()}`,
    {},
    token
  );
}

export async function getWine(id: number, token: string | null) {
  return requestJson<WineDetail>(`/api/v1/wines/${id}`, {}, token);
}

export async function listRecognitionMetadata(
  params: RecognitionMetadataParams,
  token: string | null
) {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      searchParams.set(key, String(value));
    }
  }

  return requestLocalJson<RecognitionMetadataResponse>(
    `/api/admin/recognition/metadata?${searchParams.toString()}`,
    {},
    token
  );
}

export async function listRecognitionInventory(
  params: RecognitionInventoryParams,
  token: string | null
) {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      searchParams.set(key, String(value));
    }
  }

  return requestLocalJson<RecognitionInventoryResponse>(
    `/api/admin/recognition/inventory?${searchParams.toString()}`,
    {},
    token
  );
}

export async function getAnnotationSummary(
  source: "all" | "svoe_vino" | "roskachestvo",
  token: string | null
) {
  const searchParams = new URLSearchParams({ source });
  return requestLocalJson<AnnotationSummary>(
    `/api/admin/recognition/annotations/summary?${searchParams.toString()}`,
    {},
    token
  );
}

export async function getRecognitionMetadata(
  source: string,
  sourceItemId: string,
  token: string | null
) {
  return requestLocalJson<RecognitionDetailResponse>(
    `/api/admin/recognition/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}`,
    {},
    token
  );
}

export async function patchRecognitionMetadata(
  source: string,
  sourceItemId: string,
  payload: {
    aliases?: string[];
    normalizedTokens?: string[];
    visualFeatures?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
    status?: string;
  },
  token: string | null
) {
  return requestLocalJson<RecognitionMetaItem>(
    `/api/admin/recognition/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    token
  );
}

export async function getManualCvAnnotations(source: string, sourceItemId: string, token: string | null) {
  return requestLocalJson<ManualCvAnnotationPayload | Record<string, never>>(
    `/api/admin/recognition/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/annotations`,
    {},
    token
  );
}

export async function putManualCvAnnotations(
  source: string,
  sourceItemId: string,
  payload: ManualCvAnnotationPayload,
  token: string | null
) {
  return requestLocalJson<ManualCvAnnotationPayload>(
    `/api/admin/recognition/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/annotations`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
}

export async function listAnnotationTracks(source: string, sourceItemId: string, token: string | null) {
  return requestLocalJson<{ items: AnnotationTrack[] }>(
    `/api/admin/recognition/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/annotation-tracks`, {}, token,
  );
}

export async function createAnnotationTrack(source: string, sourceItemId: string, token: string | null, input: { name?: string } = {}) {
  return requestLocalJson<AnnotationTrack>(
    `/api/admin/recognition/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/annotation-tracks`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }, token,
  );
}

export async function getAnnotationGraph(source: string, sourceItemId: string, token: string | null) {
  return requestLocalJson<AnnotationGraph>(
    `/api/admin/recognition/items/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/annotations`, {}, token,
  );
}

export async function listAnnotationVersions(source: string, sourceItemId: string, token: string | null) {
  return requestLocalJson<{ activeVersionId: string | null; defaultVersionId: string | null; items: AnnotationVersion[] }>(
    annotationGraphEntityPath(source, sourceItemId, "annotation-versions"), {}, token,
  );
}

export async function getAnnotationVersion(source: string, sourceItemId: string, versionId: string, token: string | null) {
  return requestLocalJson<AnnotationVersion>(
    annotationGraphEntityPath(source, sourceItemId, `annotation-versions/${encodeURIComponent(versionId)}`), {}, token,
  );
}

export async function createAnnotationVersion(source: string, sourceItemId: string, token: string | null) {
  return requestLocalJson<{ versionId: string; revision: number; annotationTrackId: string | null; status: string }>(
    annotationGraphEntityPath(source, sourceItemId, "annotation-versions"), { method: "POST" }, token,
  );
}

export async function bootstrapAnnotationVersion(source: string, sourceItemId: string, token: string | null) {
  return requestLocalJson<{ created: boolean; versionId: string; revision: number; annotationTrackId: string | null; status: string }>(
    annotationGraphEntityPath(source, sourceItemId, "annotation-versions/bootstrap"), { method: "POST" }, token,
  );
}

export async function editAnnotationVersion(source: string, sourceItemId: string, versionId: string, token: string | null) {
  return requestLocalJson<{ versionId: string; revision: number; annotationTrackId: string; status: string; parentVersionId: string }>(
    annotationGraphEntityPath(source, sourceItemId, `annotation-versions/${encodeURIComponent(versionId)}/edit`), { method: "POST" }, token,
  );
}

export async function deleteAnnotationVersion(source: string, sourceItemId: string, versionId: string, token: string | null) {
  return requestLocalJson<{ deleted: true; versionId: string; activeVersionId: string; defaultVersionId: string | null }>(
    annotationGraphEntityPath(source, sourceItemId, `annotation-versions/${encodeURIComponent(versionId)}`), { method: "DELETE" }, token,
  );
}

export async function makeAnnotationVersionDefault(source: string, sourceItemId: string, versionId: string, token: string | null) {
  return requestLocalJson<AnnotationVersion>(
    annotationGraphEntityPath(source, sourceItemId, `annotation-versions/${encodeURIComponent(versionId)}/default`), { method: "POST" }, token,
  );
}

export async function listMetadataVersions(source: string, sourceItemId: string, token: string | null) {
  return requestLocalJson<{ activeVersionId: string | null; defaultVersionId: string | null; items: MetadataVersion[] }>(
    annotationGraphEntityPath(source, sourceItemId, "metadata-versions"), {}, token,
  );
}

export async function makeMetadataVersionDefault(source: string, sourceItemId: string, versionId: string, token: string | null) {
  return requestLocalJson<{ versionId: string; default: true }>(
    annotationGraphEntityPath(source, sourceItemId, `metadata-versions/${encodeURIComponent(versionId)}/default`), { method: "POST" }, token,
  );
}

export async function deleteMetadataVersion(source: string, sourceItemId: string, versionId: string, token: string | null) {
  return requestLocalJson<{ deleted: true; versionId: string; activeVersionId: string; defaultVersionId: string }>(
    annotationGraphEntityPath(source, sourceItemId, `metadata-versions/${encodeURIComponent(versionId)}`), { method: "DELETE" }, token,
  );
}

function annotationGraphEntityPath(source: string, sourceItemId: string, suffix: string) {
  return `/api/admin/recognition/items/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/${suffix}`;
}

function annotationControllerPath(source: string, sourceItemId: string, annotationId: string, suffix: string) {
  return annotationGraphEntityPath(source, sourceItemId, `annotations/${encodeURIComponent(annotationId)}/${suffix}`);
}

export async function runLlmWizardPlan(
  source: string,
  sourceItemId: string,
  annotationId: string,
  input: { selectedLabelId?: string; currentStage?: WizardStage; llmSessionId?: string } = {},
  token: string | null,
) {
  return requestLocalJson<LlmControllerPlanResponse>(
    annotationControllerPath(source, sourceItemId, annotationId, "controllers/llm/plan"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        render: {
          viewport: { type: "package" },
          maxSide: 768,
          overlays: [],
          includeRejected: false,
        },
        input: {
          ...(input.currentStage ? { currentStage: input.currentStage } : {}),
          ...(input.selectedLabelId ? { selectedLabelId: input.selectedLabelId } : {}),
          ...(input.llmSessionId ? { llmSessionId: input.llmSessionId } : {}),
        },
      }),
    },
    token,
  );
}

export async function startLlmWizardSession(source: string, sourceItemId: string, annotationId: string, token: string | null) {
  return requestLocalJson<{ session: LlmSession; reused: boolean }>(
    annotationControllerPath(source, sourceItemId, annotationId, "controllers/llm/sessions"),
    { method: "POST" }, token,
  );
}

export async function getCurrentLlmWizardSession(source: string, sourceItemId: string, annotationId: string, token: string | null) {
  return requestLocalJson<LlmSession | null>(
    annotationControllerPath(source, sourceItemId, annotationId, "controllers/llm/sessions/current"), {}, token,
  );
}

export async function getLlmWizardSession(source: string, sourceItemId: string, annotationId: string, sessionId: string, token: string | null) {
  return requestLocalJson<LlmSession>(
    annotationControllerPath(source, sourceItemId, annotationId, `controllers/llm/sessions/${encodeURIComponent(sessionId)}`), {}, token,
  );
}

export async function closeLlmWizardSession(source: string, sourceItemId: string, annotationId: string, sessionId: string, status: "completed" | "cancelled", token: string | null) {
  return requestLocalJson<LlmSession>(
    annotationControllerPath(source, sourceItemId, annotationId, `controllers/llm/sessions/${encodeURIComponent(sessionId)}/close`),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }, token,
  );
}

export async function getWizardCorrectionPlan(source: string, sourceItemId: string, annotationId: string, planId: string, token: string | null) {
  return requestLocalJson<WizardCorrectionPlan>(annotationControllerPath(source, sourceItemId, annotationId, `correction-plans/${encodeURIComponent(planId)}`), {}, token);
}

export async function applyWizardCorrectionPlan(source: string, sourceItemId: string, annotationId: string, planId: string, token: string | null) {
  return requestLocalJson<WizardCorrectionPlan>(
    annotationControllerPath(source, sourceItemId, annotationId, `correction-plans/${encodeURIComponent(planId)}/apply`),
    { method: "POST" }, token,
  );
}

export async function reviewLlmWizardPlan(
  source: string,
  sourceItemId: string,
  annotationId: string,
  planId: string,
  input: { stage: WizardStage; finalEditor: LlmFinalEditor; verdict: LlmReviewVerdict },
  token: string | null,
) {
  return requestLocalJson<{ schemaVersion: 1; planId: string; stage: WizardStage; llmDecision: NonNullable<WizardCorrectionPlan["llmDecision"]>; review: LlmProposalReview }>(
    annotationControllerPath(source, sourceItemId, annotationId, `correction-plans/${encodeURIComponent(planId)}/review`),
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }, token,
  );
}

export async function createAnnotationGraphLabel(source: string, sourceItemId: string, packageId: string, geometry: AnnotationRegionGeometry, token: string | null) {
  return requestLocalJson<{ id: string; packageId: string; legacyManaged: boolean; geometry: AnnotationRegionGeometry; status: string; parentRefinementSuggestions: Array<{ ocrId: string; transcription: string | null; status: string; overlap: number }> }>(
    annotationGraphEntityPath(source, sourceItemId, `packages/${encodeURIComponent(packageId)}/labels`),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ geometry, operation: manualGraphOperation() }) }, token,
  );
}

export async function reviewAnnotationGraphLabelCandidates(source: string, sourceItemId: string, packageId: string, input: {
  operation: {
    helperId: string;
    helperVersion?: string;
    initialConfig?: Record<string, unknown>;
    finalConfig?: Record<string, unknown>;
    candidates: Array<{ id: string; payload: Record<string, unknown>; score?: number | null }>;
    reviewMode: "accepted" | "edited";
  };
  reviews: Array<{
    candidateId: string;
      state: "accepted" | "edited" | "rejected" | "merged";
      geometry?: AnnotationRegionGeometry;
      resultEntityId?: string | null;
      mergeGroupId?: string;
    }>;
  mergeReviews?: Array<{ candidateIds: string[]; geometry: AnnotationRegionGeometry }>;
}, token: string | null) {
  return requestLocalJson<{
    operationId: string;
    status: "reviewed";
    resultEntityIds: string[];
    labelMergeGroups: Array<{ resultEntityId: string | null; candidateIds: string[]; mode: "automatic" | "manual" | "mixed"; mergeGeometry: AnnotationRegionGeometry; geometry: AnnotationRegionGeometry }>;
    roiReviewGraph: AnnotationGraphOperation["roiReviewGraph"];
  }>(
    annotationGraphEntityPath(source, sourceItemId, `packages/${encodeURIComponent(packageId)}/labels/review`),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }, token,
  );
}

export async function createAnnotationGraphOcr(source: string, sourceItemId: string, parent: { type: "label"; id: string }, input: {
  geometry: QuadGeometry;
  coordinateSpace: AnnotationGraphOcr["coordinateSpace"];
  regionStatus: AnnotationGraphOcr["regionStatus"];
  transcription: AnnotationGraphOcr["transcription"];
  layout: AnnotationGraphOcr["layout"];
  rectification: AnnotationGraphOcr["rectification"];
}, token: string | null) {
  const suffix = `labels/${encodeURIComponent(parent.id)}/ocr`;
  return requestLocalJson<AnnotationGraphOcr>(
    annotationGraphEntityPath(source, sourceItemId, suffix),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, operation: manualGraphOperation() }) }, token,
  );
}

export type AutoOcrCandidate = {
  id: string;
  score: number | null;
  payload: {
    geometry: QuadGeometry;
    sourceGeometry: QuadGeometry;
    coordinateSpace: AnnotationGraphOcr["coordinateSpace"];
    transcription: string | null;
    transcriptionStatus: AnnotationGraphOcr["transcription"]["status"];
    regionStatus: AnnotationGraphOcr["regionStatus"];
    layout: AnnotationGraphOcr["layout"];
    rectification: AnnotationGraphOcr["rectification"];
    detectionConfidence: number | null;
    recognitionConfidence: number | null;
    suggestedParent: { type: "label"; packageId: string; labelId: string };
    duplicateOfOcrId: string | null;
    duplicateAnalysis: {
      matches: Array<{
        existingOcrId: string;
        geometryScore: number;
        textScore: number | null;
        totalScore: number;
        classification: "probable_duplicate" | "possible_duplicate" | "overlapping" | "unlikely";
        existing: { transcription: string | null; regionStatus: AnnotationGraphOcr["regionStatus"]; transcriptionStatus: AnnotationGraphOcr["transcription"]["status"]; labelId: string; geometry: QuadGeometry };
      }>;
      config: Record<string, unknown>;
    };
    level: "line" | "word";
  };
};

export type AutoOcrRun = {
  operationId: string;
  helper: { id: "auto-ocr"; version: string };
  scope: { type: "label"; id: string };
  config: Record<string, unknown>;
  candidates: AutoOcrCandidate[];
  viewer: { assetPath: string; width: number; height: number; coordinateSpace: "source-image" | "label-rectified"; labelRevision?: number | null };
  status: "draft" | "failed";
};

export type LabelRectificationCandidate = {
  id: string;
  score: number;
  payload: {
    mode: "none" | "perspective" | "guided-cylindrical";
    geometry: QuadGeometry;
    rectification: LabelRectification | null;
    diagnostics: {
      method: "original-reviewed-label" | "directional-edge-quad-v1" | "horizontal-curve-consensus-v1";
      confidence: number;
      distortion: number;
      retainedArea: number;
      cornerDisplacement: number;
      recommended: boolean;
      warnings: string[];
      evidenceRows?: number;
      signedCurvature?: number;
    };
  };
};

export type LabelRectificationRun = {
  operationId: string;
  helper: { id: "label-rectification"; version: "cv-label-rectification-v1" };
  scope: { type: "label"; id: string };
  labelRevision: number;
  config: Record<string, unknown>;
  candidates: LabelRectificationCandidate[];
  status: "draft";
};

export async function runAnnotationGraphLabelRectification(source: string, sourceItemId: string, scope: { type: "label"; id: string }, token: string | null) {
  return requestLocalJson<LabelRectificationRun>(annotationGraphEntityPath(source, sourceItemId, "annotation/helpers/label-rectification/run"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, config: {} }),
  }, token);
}

export async function runAnnotationGraphPackageDetection(source: string, sourceItemId: string, scope: { type: "package"; id: string }, token: string | null, config: Partial<BottleDetectionConfig> = {}) {
  return requestLocalJson<PackageDetectionRun>(annotationGraphEntityPath(source, sourceItemId, "annotation/helpers/package/run"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, config }),
  }, token);
}

export async function runAnnotationGraphAutoOcr(source: string, sourceItemId: string, scope: { type: "label"; id: string }, token: string | null) {
  return requestLocalJson<AutoOcrRun>(annotationGraphEntityPath(source, sourceItemId, "annotation/helpers/ocr/run"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, config: {} }),
  }, token);
}

export async function reviewAnnotationGraphAutoOcr(source: string, sourceItemId: string, operationId: string, reviews: Array<{
  candidateId: string;
  state: "accepted" | "edited" | "rejected" | "merged";
  sourceOperationId?: string;
  mergeGroupId?: string;
  resultEntityId?: string | null;
  finalParent?: { type: "label"; packageId: string; labelId: string } | null;
  geometry?: QuadGeometry;
  regionStatus?: AnnotationGraphOcr["regionStatus"];
  transcription?: AnnotationGraphOcr["transcription"];
  layout?: AnnotationGraphOcr["layout"];
  rectification?: AnnotationGraphOcr["rectification"];
  splitOutputs?: Array<{
    geometry: QuadGeometry;
    regionStatus: "reviewed";
    transcription: AnnotationGraphOcr["transcription"];
    layout: AnnotationGraphOcr["layout"];
    rectification: AnnotationGraphOcr["rectification"];
    confidence: number | null;
    sourceOperationId: string;
  }>;
}>, token: string | null, options: {
  compositions?: Array<{
    sourceOperationId: string;
    memberSourceOperationIds: string[];
    text: string | null;
    transcriptionStatus: AnnotationGraphOcr["transcription"]["status"];
    sortOrder: number;
  }>;
  decomposeCompositionIds?: string[];
} = {}) {
  return requestLocalJson<{ operationId: string; status: "reviewed"; resultEntityIds: string[] }>(annotationGraphEntityPath(source, sourceItemId, "annotation/helpers/ocr/review"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId, reviews, ...options }),
  }, token);
}

export type HumanOcrEditOperation = {
  operationId: string;
  type: "approve_region" | "approve_text" | "reject" | "edit_region" | "edit_text" | "merge_region" | "split_region" | "compose_string" | "decompose_string";
  inputIds: string[];
  adjustment: { direction: "expand" | "contract"; edge: "all" | "top" | "right" | "bottom" | "left"; strength: "small" | "medium" } | null;
  geometry: QuadGeometry | null;
  layout: AnnotationGraphOcr["layout"] | null;
  rectification: AnnotationGraphOcr["rectification"];
  text: string | null;
  transcriptionStatus: AnnotationGraphOcr["transcription"]["status"] | null;
  split: { axis: "horizontal" | "vertical"; fractions: number[] } | null;
  composition: { text: string | null; transcriptionStatus: AnnotationGraphOcr["transcription"]["status"]; sortOrder: number } | null;
};

export async function reviewAnnotationGraphAutoOcrActions(source: string, sourceItemId: string, operationId: string, editOperations: HumanOcrEditOperation[], reuseExisting: Array<{ candidateId: string; resultEntityId: string }>, token: string | null) {
  return requestLocalJson<{ operationId: string; status: "reviewed"; resultEntityIds: string[] }>(annotationGraphEntityPath(source, sourceItemId, "annotation/helpers/ocr/review-actions"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId, editOperations, reuseExisting }),
  }, token);
}

export type OcrDuplicateMatch = AutoOcrCandidate["payload"]["duplicateAnalysis"]["matches"][number];

export async function preflightManualAnnotationGraphOcr(source: string, sourceItemId: string, parent: { type: "label"; id: string }, input: {
  geometry: QuadGeometry;
  coordinateSpace: AnnotationGraphOcr["coordinateSpace"];
  regionStatus: AnnotationGraphOcr["regionStatus"];
  transcription: AnnotationGraphOcr["transcription"];
  layout: AnnotationGraphOcr["layout"];
  rectification: AnnotationGraphOcr["rectification"];
}, token: string | null) {
  return requestLocalJson<{ operationId: string; candidateId: string; parent: { type: "label"; packageId: string; labelId: string }; matches: OcrDuplicateMatch[]; status: "draft" }>(
    annotationGraphEntityPath(source, sourceItemId, "annotation/ocr/dedupe-preflight"),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent, ...input }) }, token,
  );
}

export async function reparentAnnotationGraphOcr(source: string, sourceItemId: string, ocrId: string, target: { type: "label"; id: string }, token: string | null) {
  return requestLocalJson<AnnotationGraphOcr>(annotationGraphEntityPath(source, sourceItemId, `annotation/ocr/${encodeURIComponent(ocrId)}/reparent`), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, operation: manualGraphOperation("edited") }),
  }, token);
}

export async function createAnnotationGraphMeta(source: string, sourceItemId: string, input: {
  targetType: "item" | "package" | "label" | "ocr";
  targetId?: string | null;
  note: string;
  tags?: string[];
  source?: "human" | "auto";
}, token: string | null) {
  return requestLocalJson<AnnotationGraphMeta>(
    annotationGraphEntityPath(source, sourceItemId, "annotation-meta"),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, operation: manualGraphOperation() }) }, token,
  );
}

export async function updateAnnotationGraphEntity(source: string, sourceItemId: string, entityType: "package" | "label" | "ocr" | "meta", entityId: string, patch: Record<string, unknown>, token: string | null, operation?: AnnotationGraphHelperOperation) {
  return requestLocalJson<Record<string, unknown>>(
    annotationGraphEntityPath(source, sourceItemId, `annotation-entities/${entityType}/${encodeURIComponent(entityId)}`),
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...patch, operation: operation ?? manualGraphOperation("edited") }) }, token,
  );
}

export async function deleteAnnotationGraphEntity(source: string, sourceItemId: string, entityType: "package" | "label" | "ocr" | "meta", entityId: string, token: string | null) {
  return requestLocalJson<{ deleted: true; entityType: string; id: string; deletedAt: string }>(
    annotationGraphEntityPath(source, sourceItemId, `annotation-entities/${entityType}/${encodeURIComponent(entityId)}`),
    { method: "DELETE" }, token,
  );
}

function manualGraphOperation(reviewMode: "manual" | "edited" = "manual"): AnnotationGraphHelperOperation {
  return { helperId: "manual-graph-editor", helperVersion: "v1", initialConfig: {}, finalConfig: {}, reviewMode };
}

function annotationTrackPath(source: string, sourceItemId: string, annotationTrackId: string, suffix = "") {
  return `/api/admin/recognition/metadata/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}/label-annotation${suffix}?track=${encodeURIComponent(annotationTrackId)}`;
}

export async function getLabelAnnotation(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  token: string | null
) {
  return requestLocalJson<LabelAnnotationState>(
    annotationTrackPath(source, sourceItemId, annotationTrackId),
    {},
    token
  );
}

export async function putLabelAnnotation(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  payload: LabelAnnotationState,
  token: string | null
) {
  return requestLocalJson<LabelAnnotationState>(
    annotationTrackPath(source, sourceItemId, annotationTrackId),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
}

export async function putDetectionProposal(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  payload: NonNullable<LabelAnnotationState["prediction"]>,
  token: string | null
) {
  return requestLocalJson<LabelAnnotationState>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/proposal"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
}

export async function listDetectionProposals(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  token: string | null
) {
  return requestLocalJson<{ items: DetectionProposalItem[] }>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/proposals"),
    {},
    token
  );
}

export async function getLabelAnnotationOcr(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  token: string | null
) {
  return requestLocalJson<LabelAnnotationOcrSnapshot | null>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/ocr"),
    {},
    token
  );
}

export async function getLabelAnalysisReview(source: string, sourceItemId: string, annotationTrackId: string, token: string | null) {
  return requestLocalJson<LabelAnalysisReview | null>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/analysis/review"), {}, token,
  );
}

export async function getLabelAnalysisWorkspace(source: string, sourceItemId: string, annotationTrackId: string, token: string | null) {
  return requestLocalJson<LabelAnalysisWorkspace>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/analysis"), {}, token,
  );
}

export async function runLabelAnalysis(source: string, sourceItemId: string, annotationTrackId: string, token: string | null, force = false, config?: LabelAnalysisCvConfig) {
  return requestLocalJson<{ jobId: string; status: string; reused?: boolean }>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/analysis"),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force, config }) }, token,
  );
}

export async function runLabelSourceAnalysis(source: string, sourceItemId: string, annotationTrackId: string, token: string | null, verifiedLabel?: RecognitionRoi, outerConfig?: Partial<BottleDetectionConfig> & { colorDistanceThreshold?: number; closeKernel?: number }, labelConfig?: Partial<AutoLabelConfigV1>, packageScope?: RecognitionRoi, visionEvidence?: VisionEvidenceRunOptions) {
  return requestLocalJson<LabelSourceAnalysisRun>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/source-analysis/run"),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ verifiedLabel, outerConfig, labelConfig, packageScope, visionEvidence }) },
    token,
  );
}

export async function putLabelSourceAnalysis(source: string, sourceItemId: string, annotationTrackId: string, payload: LabelSourceAnalysisRun, token: string | null) {
  return requestLocalJson<LabelSourceAnalysisRun>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/source-analysis"),
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, token,
  );
}

export async function deleteRecognitionMetadata(
  items: Array<{ source: "svoe_vino" | "roskachestvo"; sourceItemId: string }>,
  token: string | null,
) {
  return requestLocalJson<{ requested: number; deleted: Record<string, number> }>(
    "/api/admin/recognition/metadata",
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    },
    token,
  );
}

function labelCvPath(source: string, sourceItemId: string, annotationTrackId: string, suffix: string, labelId?: string | null) {
  const path = annotationTrackPath(source, sourceItemId, annotationTrackId, suffix);
  return labelId ? `${path}&label=${encodeURIComponent(labelId)}` : path;
}

export async function getCanonicalLabelCvWorkspace(source: string, sourceItemId: string, annotationTrackId: string, labelId: string, token: string | null) {
  return requestLocalJson<LabelAnalysisWorkspace>(labelCvPath(source, sourceItemId, annotationTrackId, "/analysis/cv-job", labelId), {}, token);
}

export async function previewLabelCvJob(source: string, sourceItemId: string, annotationTrackId: string, stage: LabelCvStage, config: LabelAnalysisCvConfig, token: string | null, review?: LabelCvReviewState, labelId?: string | null) {
  return requestLocalJson<LabelCvJob>(
    labelCvPath(source, sourceItemId, annotationTrackId, "/analysis/cv-preview", labelId),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage, config, review }) }, token,
  );
}

export async function putLabelCvCheckpoint(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  stage: LabelCvStage,
  config: LabelAnalysisCvConfig,
  token: string | null,
  review?: LabelCvReviewState,
  palette?: LabelPaletteColor[],
  labelId?: string | null,
) {
  return requestLocalJson<LabelCvJob>(
    labelCvPath(source, sourceItemId, annotationTrackId, "/analysis/cv-checkpoint", labelId),
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage, config, review, palette }) }, token,
  );
}

export async function putLabelCvJob(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  config: LabelAnalysisCvConfig,
  palette: LabelPaletteColor[],
  token: string | null,
  review?: LabelCvReviewState,
  labelId?: string | null,
) {
  return requestLocalJson<LabelCvJob>(
    labelCvPath(source, sourceItemId, annotationTrackId, "/analysis/cv-job", labelId),
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config, palette, review }) }, token,
  );
}

export async function putLabelAnalysisReview(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  payload: {
    baseRevision: number; annotationId: string; annotationRevision: number; jobId: string;
    configHash: string; status: LabelAnalysisReview["status"]; notes?: string; reviewedBy?: string;
  },
  token: string | null,
) {
  return requestLocalJson<LabelAnalysisReview>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/analysis/review"),
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, token,
  );
}

export async function getCatalogIdentityReview(source: string, sourceItemId: string, annotationTrackId: string, token: string | null) {
  return requestLocalJson<CatalogIdentityReview | null>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/catalog-identity"), {}, token,
  );
}

export async function putCatalogIdentityReview(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  payload: PutCatalogIdentityReview,
  token: string | null,
) {
  return requestLocalJson<CatalogIdentityReview>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/catalog-identity"),
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }, token,
  );
}

export async function runLabelAnnotationOcr(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  token: string | null
) {
  return requestLocalJson<LabelAnnotationOcrSnapshot>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/ocr/run"),
    {
      method: "POST",
    },
    token
  );
}

export async function getLabelAnnotationOcrReview(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  token: string | null
) {
  return requestLocalJson<LabelAnnotationOcrReview | null>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/ocr/review"),
    {},
    token
  );
}

export async function putLabelAnnotationOcrReview(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  payload: {
    text: string;
    ocrRunId?: string | null;
    sourceKind?: "manual" | "corrected-generated" | "accepted-generated";
    status?: "reviewed" | "empty" | "rejected";
    reviewedBy?: string;
  },
  token: string | null
) {
  return requestLocalJson<LabelAnnotationOcrReview>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/ocr/review"),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
}

export async function getLabelAnnotationOcrRegionReview(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  token: string | null
) {
  return requestLocalJson<LabelAnnotationOcrRegionReview | null>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/ocr/regions/review"),
    {},
    token
  );
}

export async function putLabelAnnotationOcrRegionReview(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  payload: PutLabelAnnotationOcrRegionReview,
  token: string | null
) {
  return requestLocalJson<LabelAnnotationOcrRegionReview>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/ocr/regions/review"),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
}

export async function getOcrSourceAssociationWorkspace(source: string, sourceItemId: string, annotationTrackId: string, token: string | null) {
  return requestLocalJson<OcrSourceAssociationWorkspace>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/ocr/source-associations"),
    {},
    token
  );
}

export async function putOcrSourceAssociationReview(
  source: string,
  sourceItemId: string,
  annotationTrackId: string,
  payload: PutOcrSourceAssociationReview,
  token: string | null
) {
  return requestLocalJson<OcrSourceAssociationReview>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/ocr/source-associations"),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
}

export async function getAliasReviewWorkspace(source: string, sourceItemId: string, annotationTrackId: string, token: string | null) {
  return requestLocalJson<AliasReviewWorkspace>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/aliases"),
    {},
    token
  );
}

export async function putAliasReview(source: string, sourceItemId: string, annotationTrackId: string, payload: PutAliasReview, token: string | null) {
  return requestLocalJson<AliasReview>(
    annotationTrackPath(source, sourceItemId, annotationTrackId, "/aliases"),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
}

export async function listAnnotationCohorts(token: string | null) {
  return requestLocalJson<{ items: AnnotationCohort[] }>("/api/admin/recognition/datasets/cohorts", {}, token);
}

export async function createAnnotationCohort(
  payload: { name: string; description?: string; items: Array<{ source: "svoe_vino" | "roskachestvo"; sourceItemId: string }> },
  token: string | null
) {
  return requestLocalJson<AnnotationCohort>(
    "/api/admin/recognition/datasets/cohorts",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    token
  );
}

export async function createDatasetVersion(cohortId: string, payload: { name: string }, token: string | null) {
  return requestLocalJson<DatasetVersion>(
    `/api/admin/recognition/datasets/cohorts/${encodeURIComponent(cohortId)}/versions`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    token
  );
}

export async function exportDatasetVersionArtifact(datasetVersionId: string, token: string | null) {
  return requestLocalJson<DatasetArtifact & {
    outputRoot: string;
    itemCount: number;
    files: {
      annotations: string;
      splits: string;
      tasks: Record<TrainingTask, { file: string; count: number; sha256: string; adapterVersion: number }>;
    };
  }>(
    `/api/admin/recognition/datasets/versions/${encodeURIComponent(datasetVersionId)}/export`,
    { method: "POST" },
    token
  );
}

export async function listTrainingRuns(token: string | null) {
  return requestLocalJson<{ items: TrainingRun[] }>("/api/admin/recognition/training/runs", {}, token);
}

export async function getDatasetArtifactReadiness(artifactId: string, task: TrainingTask, token: string | null) {
  return requestLocalJson<DatasetArtifactReadiness>(
    `/api/admin/recognition/training/artifacts/${encodeURIComponent(artifactId)}/readiness?task=${encodeURIComponent(task)}`,
    {},
    token,
  );
}

export async function createTrainingRun(payload: {
  datasetArtifactId: string;
  task: TrainingTask;
  name: string;
  framework: string;
  runtime?: string;
  configSnapshot: Record<string, unknown>;
  codeVersion?: string;
}, token: string | null) {
  return requestLocalJson<TrainingRun>("/api/admin/recognition/training/runs", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }, token);
}

export async function updateTrainingRunStatus(runId: string, payload: { status: Exclude<TrainingStatus, "queued">; errorMessage?: string }, token: string | null) {
  return requestLocalJson<TrainingRun>(`/api/admin/recognition/training/runs/${encodeURIComponent(runId)}/status`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }, token);
}

export async function addTrainingEvaluation(runId: string, payload: { modelVersionId?: string; split: "train" | "validation" | "test"; metrics: Record<string, number>; sampleCount: number }, token: string | null) {
  return requestLocalJson<EvaluationResult>(`/api/admin/recognition/training/runs/${encodeURIComponent(runId)}/evaluations`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }, token);
}

export async function createModelVersion(runId: string, payload: { name: string; artifactPath: string; artifactSha256: string; runtime?: string; metadata: Record<string, unknown> }, token: string | null) {
  return requestLocalJson<ModelVersion>(`/api/admin/recognition/training/runs/${encodeURIComponent(runId)}/models`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }, token);
}

export async function updateModelStatus(modelId: string, status: Exclude<ModelStatus, "candidate">, token: string | null) {
  return requestLocalJson<ModelVersion>(`/api/admin/recognition/training/models/${encodeURIComponent(modelId)}/status`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
  }, token);
}

export async function generateRecognitionMetadata(
  source: string,
  sourceItemId: string,
  token: string | null
) {
  return requestLocalJson<{ item: RecognitionMetaItem; generated: boolean }>(
    "/api/admin/recognition/generate",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ source, sourceItemId }),
    },
    token
  );
}

export async function createRecognitionJob(
  source: string,
  sourceItemId: string,
  token: string | null,
  force = true,
  type: RecognitionJobType = force ? "REGENERATE_ALL_META" : "GENERATE_ALL_META",
  extraOptions: Record<string, unknown> = {}
) {
  return requestLocalJson<{ jobId: string; status: string; reused?: boolean; annotationVersionId?: string | null; annotationTrackId?: string | null }>(
    "/api/admin/recognition/jobs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type,
        target: { source, sourceItemId },
        options: { force, pipelineVersion: RECOGNITION_PIPELINE_VERSION, ...extraOptions },
      }),
    },
    token
  );
}

export async function createRecognitionBatchJob(
  source: "svoe_vino" | "roskachestvo",
  token: string | null,
  batchSize = 25,
  force = false,
  type: RecognitionJobType = force ? "REGENERATE_ALL_META" : "GENERATE_ALL_META"
) {
  return requestLocalJson<{ jobId: string; status: string }>(
    "/api/admin/recognition/jobs",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type,
        target: {
          filter: {
            source,
            missingCvMeta: true,
          },
        },
        options: { force, pipelineVersion: RECOGNITION_PIPELINE_VERSION, batchSize },
      }),
    },
    token
  );
}

export async function createRecognitionBatchTargetJob(
  target: RecognitionBatchTarget,
  token: string | null,
  options: {
    batchSize: number;
    force: boolean;
    type: RecognitionJobType;
    presetId?: string;
    presetRevision?: number;
  }
) {
  return requestLocalJson<{ jobId: string; status: string }>(
    "/api/admin/recognition/jobs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: options.type,
        target,
        options: {
          force: options.force,
          pipelineVersion: RECOGNITION_PIPELINE_VERSION,
          batchSize: options.batchSize,
          presetId: options.presetId,
          presetRevision: options.presetRevision,
        },
      }),
    },
    token
  );
}

export async function createLlmWizardBatchJob(
  cards: Array<{ source: "svoe_vino" | "roskachestvo"; sourceItemId: string; annotationTrackId?: string }>,
  llmExecutionMode: "session-chain" | "one-shot-chain",
  visionEvidence: VisionEvidenceRunOptions,
  token: string | null,
  stopAfterStage?: WizardStage | null,
) {
  return requestLocalJson<{ jobId: string; status: string; queuedChildren: number }>(
    "/api/admin/recognition/jobs",
    {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "ANNOTATION_LLM_PIPELINE",
        target: { items: cards },
        options: {
          force: false,
          pipelineVersion: "wizard-llm-stage-v1",
          batchSize: cards.length,
          llmExecutionMode,
          visionEvidence,
          ...(stopAfterStage ? { stopAfterStage } : {}),
        },
      }),
    }, token,
  );
}

export async function listRecognitionJobs(
  token: string | null,
  params: {
    status?: string;
    type?: RecognitionJobType;
    scope?: RecognitionJob["scope"];
    source?: "svoe_vino" | "roskachestvo";
    limit?: number;
    offset?: number;
  } = {}
) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return requestLocalJson<RecognitionJobsResponse>(
    `/api/admin/recognition/jobs?${searchParams}`,
    {},
    token
  );
}

export async function estimateRecognitionBatchJob(
  source: "all" | "svoe_vino" | "roskachestvo",
  token: string | null,
  batchSize = 25,
  force = false,
  type: RecognitionJobType = force ? "REGENERATE_ALL_META" : "GENERATE_ALL_META",
  options: { missingCvMeta?: boolean; presetId?: string; presetRevision?: number } = {}
) {
  const searchParams = new URLSearchParams({
    source,
    missingCvMeta: String(options.missingCvMeta ?? true),
    force: String(force),
    pipelineVersion: RECOGNITION_PIPELINE_VERSION,
    batchSize: String(batchSize),
    type,
  });
  if (options.presetId) searchParams.set("presetId", options.presetId);
  if (options.presetRevision !== undefined) searchParams.set("presetRevision", String(options.presetRevision));
  return requestLocalJson<RecognitionJobEstimate>(
    `/api/admin/recognition/jobs/estimate?${searchParams}`,
    {},
    token
  );
}

export async function getRecognitionJob(jobId: string, token: string | null) {
  return requestLocalJson<RecognitionJob>(`/api/admin/recognition/jobs/${encodeURIComponent(jobId)}`, {}, token);
}

export async function listRecognitionJobItems(
  jobId: string,
  token: string | null,
  params: { status?: string; limit?: number; offset?: number } = {}
) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") searchParams.set(key, String(value));
  }
  return requestLocalJson<{
    items: Array<{
      jobId: string;
      source: string;
      sourceItemId: string;
      status: string;
      attempt: number;
      error: string | null;
      result: Record<string, unknown>;
    }>;
    total: number;
    limit: number;
    offset: number;
  }>(`/api/admin/recognition/jobs/${encodeURIComponent(jobId)}/items?${searchParams}`, {}, token);
}

export async function retryRecognitionJob(jobId: string, mode: "current-version" | "new-version", token: string | null) {
  return requestLocalJson<{
    jobId: string;
    previousJobId: string;
    retried: number;
    status: string;
    mode: "current-version" | "new-version";
    annotationVersionId?: string | null;
    annotationTrackId?: string | null;
  }>(
    `/api/admin/recognition/jobs/${encodeURIComponent(jobId)}/retry`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) },
    token
  );
}

export async function cancelRecognitionJob(jobId: string, token: string | null) {
  return requestLocalJson<unknown>(
    `/api/admin/recognition/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
    token
  );
}

export async function deleteRecognitionJob(jobId: string, token: string | null) {
  return requestLocalJson<{ jobId: string; parentJobId: string | null; status: string; deleted: number }>(
    `/api/admin/recognition/jobs/${encodeURIComponent(jobId)}`,
    { method: "DELETE" },
    token
  );
}

export async function runCvPlayground(
  input: {
    source: string;
    sourceItemId: string;
    annotationTrackId?: string;
    config: Record<string, unknown>;
    mode?: "preview" | "full";
  },
  token: string | null
) {
  return requestLocalJson<CvPlaygroundRunResponse>(
    "/api/admin/cv/playground/run",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
    token
  );
}

export async function runCvPlaygroundSweep(
  input: {
    source: string;
    sourceItemId: string;
    annotationTrackId?: string;
    baseConfig: Record<string, unknown>;
    sweeps: Array<{
      parameterPath: string;
      values: number[];
    }>;
    mode?: "preview" | "full";
  },
  token: string | null
) {
  return requestLocalJson<CvPlaygroundSweepResponse>(
    "/api/admin/cv/playground/sweep",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    },
    token
  );
}

export async function listPipelinePresets<TConfig = Record<string, unknown>>(
  token: string | null,
  layer: PipelinePresetRecord["layer"] = "label-roi"
) {
  const searchParams = new URLSearchParams({ layer });
  return requestLocalJson<{ items: PipelinePresetRecord<TConfig>[] }>(
    `/api/admin/recognition/presets?${searchParams.toString()}`,
    {},
    token
  );
}

export async function createPipelinePreset<TConfig = Record<string, unknown>>(
  payload: {
    layer: PipelinePresetRecord["layer"];
    name: string;
    description?: string;
    status?: PipelinePresetRecord["status"];
    engineKind: string;
    engineVersion?: string;
    config: TConfig;
    createdFrom?: { source: string; sourceItemId: string };
    createdBy?: string;
  },
  token: string | null
) {
  return requestLocalJson<PipelinePresetRecord<TConfig>>(
    "/api/admin/recognition/presets",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
}

export async function createPipelinePresetRevision<TConfig = Record<string, unknown>>(
  presetId: string,
  payload: {
    baseRevision: number;
    config: TConfig;
    name?: string;
    description?: string;
    status?: PipelinePresetRecord["status"];
    engineKind?: string;
    engineVersion?: string;
    createdFrom?: { source: string; sourceItemId: string };
    createdBy?: string;
  },
  token: string | null
) {
  return requestLocalJson<PipelinePresetRecord<TConfig>>(
    `/api/admin/recognition/presets/${encodeURIComponent(presetId)}/revisions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token
  );
}

export function getCatalogImageUrl(item: CatalogItem) {
  if (item.image.local_path) {
    return `/api/admin/assets/${item.image.local_path.replace(/\\/g, "/")}`;
  }

  return item.image.url;
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  token?: string | null
): Promise<T> {
  const headers = new Headers(init.headers);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(formatRequestError(response, text));
  }

  return (await response.json()) as T;
}

async function requestLocalJson<T>(
  path: string,
  init: RequestInit = {},
  token?: string | null
): Promise<T> {
  const headers = new Headers(init.headers);

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(path, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(formatRequestError(response, text));
  }

  return (await response.json()) as T;
}

function formatRequestError(response: Response, body: string) {
  const fallback = `Request failed with ${response.status} ${response.statusText}`.trim();
  if (!body.trim()) return fallback;

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(body) as unknown;
      if (json && typeof json === "object") {
        const value = json as Record<string, unknown>;
        const error = typeof value.error === "string" ? value.error : null;
        const detail = typeof value.detail === "string" ? value.detail : null;
        const issues = Array.isArray(value.issues)
          ? value.issues.map((issue) => formatValidationIssue(issue)).filter(Boolean).join("; ")
          : null;
        const message = [error, detail, issues].filter(Boolean).join(": ") || JSON.stringify(json);
        const status = [response.status, response.statusText].filter(Boolean).join(" ");
        return `${status}: ${message}`;
      }
    } catch {
      return sanitizeErrorBody(body) || fallback;
    }
  }

  return sanitizeErrorBody(body) || fallback;
}

function formatValidationIssue(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const issue = value as Record<string, unknown>;
  const rawPath = Array.isArray(issue.path) ? issue.path : typeof issue.instancePath === "string" ? issue.instancePath.split("/").filter(Boolean) : [];
  const path = rawPath.map(String).join(".");
  const message = typeof issue.message === "string" ? issue.message : "Invalid value";
  return path ? `${path}: ${message}` : message;
}

function sanitizeErrorBody(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export type OfficialReference = {
  catalogItemId:string;officialSlug:string;source:"svoe_vino";sourceItemId:string;wineId:string;
  referenceAssetId:string;referencePath:string;referenceSha256:string;width:number;height:number;method:string;
};
export function listOfficialReferences(sourceItemId:string,token:string|null) {
  const query = new URLSearchParams({sourceItemId});
  return requestLocalJson<{items:OfficialReference[]}>(`/api/admin/recognition/contest-official/references?${query}`,{},token);
}

export type GpuMinerEvidenceContext = {
  schemaVersion: 1;
  authority: "external-gpu-miner-evidence";
  usagePolicy: "advisory_only";
  families: Partial<Record<"dinov3" | "siglip2", {
    id: string;
    status: "completed" | "failed";
    runId: string;
    imageHash: string | null;
    model: { id: string | null; revision: string | null };
    pipelineVersion: string | null;
    preprocessingVersion: string | null;
    features: Record<string, unknown>;
    metrics: Record<string, unknown>;
    artifactsAvailable: boolean;
    error: Record<string, unknown> | null;
    evidenceCreatedAt: string | null;
    importedAt: string;
  }>>;
};

export async function getGpuMinerEvidence(source: string, sourceItemId: string, token: string | null) {
  return requestLocalJson<GpuMinerEvidenceContext>(
    annotationGraphEntityPath(source, sourceItemId, "gpu-miner-evidence"), {}, token,
  );
}

export type DinoDenseOverlay = {
  schema: "DinoDenseOverlayV1";
  kind: "feature-boundary";
  evidenceId: string;
  runId: string;
  imageHash: string | null;
  gridWidth: number;
  gridHeight: number;
  inputWidth: number | null;
  inputHeight: number | null;
  sourceToInputTransform: Record<string, unknown> | null;
  normalization: { low: number; high: number };
  values: number[];
};

export async function getDinoDenseOverlay(source: string, sourceItemId: string, token: string | null) {
  return requestLocalJson<DinoDenseOverlay>(
    annotationGraphEntityPath(source, sourceItemId, "gpu-miner-evidence/dinov3/overlay"), {}, token,
  );
}

export async function getWizardVisionContext(source: string, sourceItemId: string, annotationId: string, token: string | null) {
  return requestLocalJson<{ minerEvidence: GpuMinerEvidenceContext }>(
    annotationControllerPath(source, sourceItemId, annotationId, "vision-context"), {}, token,
  );
}
export function createOfficialDraft(reference:OfficialReference,token:string|null) {
  return requestLocalJson<OfficialReference & {annotationTrackId:string;packageId:string;annotationVersionId:string}>("/api/admin/recognition/contest-official/drafts",
    {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({catalogItemId:reference.catalogItemId,referenceAssetId:reference.referenceAssetId,referencePath:reference.referencePath,referenceSha256:reference.referenceSha256})},token);
}
