import type { AnnotationGraphOcr, AnnotationGraphOperation } from "@/lib/admin/api";

export type OcrStatus = {
  origin: "auto-helper" | "manual" | "unknown";
  reviewer: "llm" | "human" | "unknown";
  change: "unchanged" | "edited" | "not-applicable" | "unknown";
};

const UNKNOWN: OcrStatus = { origin: "unknown", reviewer: "unknown", change: "unknown" };

function reviewForEntity(operation: AnnotationGraphOperation, entityId: string) {
  return operation.candidateReviews.find((review) => review.state !== "merged"
    && (review.resultEntityId === entityId || review.resultEntityIds?.includes(entityId)));
}

function actorFromOperation(operation: AnnotationGraphOperation): OcrStatus["reviewer"] {
  const review = operation.helperOutput?.ocrReview;
  const actor = review && typeof review === "object" && "reviewActor" in review ? review.reviewActor : null;
  if (actor === "llm") return "llm";
  if (actor === "human") return "human";
  if (operation.helper.id === "ocr-dedupe-preflight" || operation.helper.id === "manual-graph-editor") return "human";
  return "unknown";
}

function changedByEdit(operation: AnnotationGraphOperation) {
  const before = operation.previousEntitySnapshot;
  const after = operation.resultingEntitySnapshot;
  if (!before || !after) return operation.reviewMode === "edited";
  const fields = ["geometry", "coordinate_space", "transcription", "status", "region_status", "transcription_status", "layout_type", "text_direction", "glyph_orientation", "layout_flow", "baseline_angle_deg", "layout_baseline", "character_orientation", "rectification", "confidence"];
  return fields.some((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}

export function ocrStatusForEntity(entity: Pick<AnnotationGraphOcr, "id" | "legacyManaged">, operations: AnnotationGraphOperation[]): OcrStatus {
  if (entity.legacyManaged) return UNKNOWN;
  const related = operations.filter((operation) => operation.status === "reviewed"
    && (operation.results.some((result) => result.type === "ocr" && result.id === entity.id && !result.deletedAt)
      || operation.result?.type === "ocr" && operation.result.id === entity.id));
  const creation = related.find((operation) => operation.operationType === "run_ocr" && reviewForEntity(operation, entity.id))
    ?? related.find((operation) => operation.operationType === "add_ocr");
  if (!creation) return UNKNOWN;

  const manual = creation.helper.id === "ocr-dedupe-preflight"
    || creation.helperOutput?.entryPoint === "manual-create"
    || creation.operationType === "add_ocr" && creation.helper.id === "manual-graph-editor";
  const auto = creation.operationType === "run_ocr" && creation.helper.id === "auto-ocr";
  const origin: OcrStatus["origin"] = manual ? "manual" : auto ? "auto-helper" : "unknown";
  const review = reviewForEntity(creation, entity.id);
  const editedAfterCreation = related.some((operation) => operation.operationType === "edit_ocr" && operation.createdAt >= creation.createdAt && changedByEdit(operation));
  const latestEdit = [...related].reverse().find((operation) => operation.operationType === "edit_ocr" && operation.createdAt >= creation.createdAt);
  return {
    origin,
    reviewer: latestEdit ? actorFromOperation(latestEdit) : actorFromOperation(creation),
    change: manual ? "not-applicable" : auto
      ? review?.state === "edited" || editedAfterCreation ? "edited" : review?.state === "accepted" ? "unchanged" : "unknown"
      : "unknown",
  };
}
