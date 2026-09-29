import type { QuadGeometry } from "./quadGeometry.js";
import type { LabelRectificationValue } from "./labelRectificationContract.js";
import type { EditOperationActor } from "./editStageContract.js";

export type AnnotationEntityType = "package" | "label" | "ocr" | "meta";
export type AnnotationReviewMode = "accepted" | "edited" | "manual";
export type AnnotationOperationType =
  | "add_package" | "add_label" | "add_ocr" | "add_meta"
  | "edit_package" | "edit_label" | "edit_ocr" | "edit_meta"
  | "delete_package" | "delete_label" | "delete_ocr" | "delete_meta"
  | "run_ocr" | "reparent_ocr" | "run_label_rectification";

export type PolygonGeometry = {
  type: "polygon";
  points: Array<{ x: number; y: number }>;
  bbox: { x: number; y: number; width: number; height: number };
};

export type RegionGeometry = QuadGeometry | PolygonGeometry;
export type RoiReviewNode = {
  id: string;
  origin: "autodetect" | "derived" | "manual" | "canonical";
  geometry: RegionGeometry;
  candidateId?: string;
  entity?: { type: "label"; id: string };
};
export type RoiReviewPrimitive =
  | { type: "edit"; actor: EditOperationActor; input: string; output: string }
  | { type: "merge"; actor: EditOperationActor; inputs: string[]; output: string; mode: "automatic" | "manual" | "mixed" }
  | { type: "reject"; actor: EditOperationActor; input: string }
  | { type: "approve"; actor: EditOperationActor; input: string; outputEntity: { type: "label"; id: string } };
export type RoiReviewGraph = {
  schemaVersion: 1;
  nodes: RoiReviewNode[];
  operations: RoiReviewPrimitive[];
  reviewedOutputIds: string[];
};
export type PackageType = "bottle" | "tube" | "box" | "other" | "unknown";
export type VisualRegionKind = "physical-label" | "direct-print" | "text-only" | "graphic-only" | "mixed" | "other" | "unknown";

export type AnnotationCandidate = {
  id: string;
  payload: Record<string, unknown>;
  score: number | null;
  sortOrder: number;
  detectionConfidence?: number | null;
  recognitionConfidence?: number | null;
  suggestedParent?: { type: "package"; packageId: string } | { type: "label"; packageId: string; labelId: string } | null;
  duplicateOfOcrId?: string | null;
};

export type AnnotationOperation = {
  id: string;
  operationType: AnnotationOperationType;
  parent: { type: "item" | AnnotationEntityType; id: string | null } | null;
  result: { type: AnnotationEntityType; id: string } | null;
  results: Array<{ type: AnnotationEntityType; id: string; deletedAt?: string | null }>;
  scope: { type: "package" | "label"; id: string } | null;
  helper: { id: string; version: string | null };
  initialConfig: Record<string, unknown>;
  finalConfig: Record<string, unknown>;
  candidates: AnnotationCandidate[];
  selectedCandidateId: string | null;
  candidateReviews: Array<{
    candidateId: string;
    state: "accepted" | "edited" | "rejected" | "merged";
    resultEntityId: string | null;
    resultEntityIds: string[];
    finalPackageId: string | null;
    finalLabelId: string | null;
    reviewedGeometry: QuadGeometry | null;
    reviewedTranscription: string | null;
    reviewedRegionStatus: GraphOcrAnnotation["regionStatus"] | null;
    reviewedTranscriptionStatus: GraphOcrAnnotation["transcription"]["status"] | null;
    reviewedLayout: GraphOcrAnnotation["layout"] | null;
    reviewedRectification: GraphOcrAnnotation["rectification"];
  }>;
  reviewOperations: Array<{
    type: "merge";
    inputCandidateIds: string[];
    outputEntity: { type: "label"; id: string };
    outputGeometry: RegionGeometry;
    mode: "automatic" | "manual" | "mixed";
  }>;
  /** Immutable ROI lineage. Candidates are source nodes; review actions create new derived nodes. */
  roiReviewGraph: RoiReviewGraph | null;
  status: "draft" | "reviewed" | "failed";
  helperOutput: Record<string, unknown> | null;
  reviewMode: AnnotationReviewMode;
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
    scope: { geometry: RegionGeometry | null; source: "default-full-image" | "auto" | "human" | "legacy-unclassified"; trainingRole: "helper-input" };
    packageType: { value: PackageType; status: "unreviewed" | "reviewed"; source: "human" | "auto" | null; reviewedAt: string | null };
    objectContext: { geometry: RegionGeometry | null; status: "missing" | "suggested" | "reviewed" | "rejected"; source: "human" | "auto" | null; reviewedAt: string | null; trainingRole: "segmentation-gt" };
    /** @deprecated Compatibility alias for scope.geometry. */
    geometry: RegionGeometry | null;
    status: "draft" | "reviewed";
    labels: Array<{
      id: string;
      legacyManaged: boolean;
      origin: "human" | "helper" | "legacy" | "migrated_from_direct_ocr";
      geometryReviewStatus: "suggested" | "reviewed" | "rejected";
      visualRegionKind: { value: VisualRegionKind; status: "unreviewed" | "reviewed" };
      geometry: RegionGeometry;
      rectification: LabelRectificationValue | null;
      revision: number;
      status: "draft" | "reviewed";
      cv: { crop: Record<string, unknown> | null; job: Record<string, unknown> | null };
      ocr: Array<GraphOcrAnnotation>;
      ocrCompositions?: Array<GraphOcrComposition>;
      meta: Array<GraphMetaAnnotation>;
    }>;
    /** @deprecated Always empty in schema v7. OCR belongs to a Label/VisualRegion. */
    ocr: Array<GraphOcrAnnotation>;
    meta: Array<GraphMetaAnnotation>;
  }>;
  meta: Array<GraphMetaAnnotation>;
  operations: AnnotationOperation[];
  validation: {
    unresolvedIdentityConflicts: number;
    suggestedParentRelations: number;
    readyForCanonicalExport: boolean;
  };
};

export type GraphOcrComposition = {
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

export type GraphOcrAnnotation = {
  id: string;
  packageId: string;
  labelId: string;
  legacyManaged: boolean;
  geometry: QuadGeometry;
  coordinateSpace: OcrCoordinateSpace;
  regionStatus: "reviewed" | "rejected";
  transcription: { text: string | null; status: "verified" | "partial" | "unreadable" };
  layout: OcrLayout;
  rectification: OcrRectification | null;
  confidence: number | null;
  parentRelation: {
    packageId: string;
    labelId: string;
    source: "auto" | "human";
    status: "suggested" | "reviewed";
    suggestedLabelId: string | null;
  };
  meta: GraphMetaAnnotation[];
};

export type OcrLayout = {
  type: "word" | "string";
  flow: "linear" | "curved";
  baselineAngleDeg: number;
  baseline: Array<{ x: number; y: number }> | null;
  characterOrientation: "aligned" | "tangent-aligned" | "upright" | "mixed";
};

export type OcrRectification =
  | { type: "rotation"; angleDeg: number }
  | { type: "affine"; matrix: number[] }
  | { type: "perspective"; homography: number[] }
  | { type: "curved"; path: Array<{ x: number; y: number }>; params?: Record<string, number> };

export type OcrCoordinateSpace =
  | { type: "label-rectified"; units: "normalized"; labelId: string; cropRevision: number | null; width: number | null; height: number | null }
  | { type: "unavailable"; reason: string };

export type GraphMetaAnnotation = {
  id: string;
  targetType: "item" | AnnotationEntityType;
  targetId: string | null;
  note: string;
  tags: string[];
  source: "human" | "auto";
};

export type AutoHelperRunInput = {
  helperId: string;
  helperVersion?: string;
  initialConfig?: Record<string, unknown>;
  finalConfig?: Record<string, unknown>;
  candidates?: Array<{ id: string; payload: Record<string, unknown>; score?: number | null }>;
  selectedCandidateId?: string | null;
  reviewMode: AnnotationReviewMode;
};
