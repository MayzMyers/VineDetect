import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import { getAnnotationTrackState, patchAnnotationTrackState } from "./annotation-track.repository.js";
import type { SourceName } from "../shared/types.js";
import { normalizeQuadGeometry, sameQuad, type QuadGeometry } from "../shared/quadGeometry.js";
import { normalizeLabelRectification, type LabelRectificationValue } from "../shared/labelRectificationContract.js";

export type LabelRoiPrediction = {
  id?: string;
  helperRunId?: string;
  candidateId?: string;
  roi: Record<string, unknown>;
  geometry?: QuadGeometry;
  rectification?: LabelRectificationValue | null;
  confidence?: number | null;
  algorithm: {
    id: string;
    version?: string;
    params?: Record<string, unknown>;
    defaultParams?: Record<string, unknown>;
  };
  createdAt?: string;
};

export type LabelRoiAnnotation = {
  id?: string;
  revision?: number;
  roi: Record<string, unknown>;
  geometry?: QuadGeometry;
  rectification?: LabelRectificationValue | null;
  reviewedAt?: string;
  reviewedBy?: string;
};

export type LabelAnnotationState = {
  schemaVersion: 2;
  prediction: LabelRoiPrediction | null;
  annotation: LabelRoiAnnotation | null;
  status: "unprocessed" | "generated" | "needs-review" | "reviewed" | "no-label" | "invalid-image";
  reviewed?: boolean;
  roiEdited?: boolean;
  source?: "auto" | "corrected" | "manual" | null;
  iou?: number | null;
  labelRoiGt?: boolean;
  updatedAt?: string;
};

export type DetectionProposalDto = {
  id: string;
  prediction: LabelRoiPrediction;
  status: string;
  createdAt: string;
};

export async function getLabelAnnotationState(source: SourceName, sourceItemId: string, trackId: string, imageUrl: string | null) {
  const [proposal, annotation, metadata] = await Promise.all([
    getLatestDetectionProposal(source, sourceItemId, trackId),
    getLatestImageAnnotation(source, sourceItemId, trackId),
    getAnnotationTrackState(source, sourceItemId, trackId),
  ]);
  const legacy = normalizeLabelAnnotation(metadata?.annotations?.labelAnnotation);
  const prediction = annotation
    ? linkedPrediction(annotation)
    : proposal ? proposalToPrediction(proposal) : legacy?.prediction ?? generatedFromCvMeta(metadata?.visual_features, imageUrl);
  const reviewedAnnotation = annotation ? annotationToLabelRoi(annotation) : legacy?.annotation ?? null;
  const status = annotationStatus(annotation, legacy, prediction);
  return buildLabelAnnotationState({
    prediction,
    annotation: reviewedAnnotation,
    status,
    updatedAt: annotation?.updated_at instanceof Date ? annotation.updated_at.toISOString() : legacy?.updatedAt,
  });
}

export async function putLabelAnnotationState(source: SourceName, sourceItemId: string, trackId: string, state: LabelAnnotationState, imageUrl: string | null) {
  let proposalId: string | null = null;
  if (state.prediction?.roi) {
    const proposal = await upsertDetectionProposalFromState(source, sourceItemId, trackId, state.prediction, imageUrl);
    proposalId = String(proposal.id);
  }

  if (state.annotation || state.status === "no-label" || state.status === "invalid-image") {
    await insertImageAnnotationFromState(source, sourceItemId, trackId, state, proposalId, imageUrl);
  }

  await patchLegacyAnnotation(source, sourceItemId, trackId, state);
  return getLabelAnnotationState(source, sourceItemId, trackId, imageUrl);
}

export async function putDetectionProposalState(source: SourceName, sourceItemId: string, trackId: string, prediction: LabelRoiPrediction, imageUrl: string | null) {
  await upsertDetectionProposalFromState(source, sourceItemId, trackId, prediction, imageUrl);
  const current = await getLabelAnnotationState(source, sourceItemId, trackId, imageUrl);
  const nextState = buildLabelAnnotationState({
    prediction,
    annotation: current.annotation,
    status: current.annotation ? "reviewed" : "needs-review",
    updatedAt: new Date().toISOString(),
  });
  await patchLegacyAnnotation(source, sourceItemId, trackId, nextState);
  return getLabelAnnotationState(source, sourceItemId, trackId, imageUrl);
}

export async function listDetectionProposals(source: SourceName, sourceItemId: string, trackId: string, limit = 20): Promise<DetectionProposalDto[]> {
  const result = await pool.query(
    `
    SELECT *
    FROM meta.detection_proposals
    WHERE source = $1 AND source_item_id = $2 AND annotation_track_id = $3
    ORDER BY created_at DESC
    LIMIT $4
    `,
    [source, sourceItemId, trackId, limit],
  );
  return result.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    prediction: proposalToPrediction(row),
    status: stringValue(row.status) ?? "generated",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date().toISOString(),
  }));
}

async function getLatestDetectionProposal(source: SourceName, sourceItemId: string, trackId: string) {
  const result = await pool.query(
    `
    SELECT *
    FROM meta.detection_proposals
    WHERE source = $1 AND source_item_id = $2 AND annotation_track_id = $3
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [source, sourceItemId, trackId],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

async function getLatestImageAnnotation(source: SourceName, sourceItemId: string, trackId: string) {
  const result = await pool.query(
    `
    SELECT annotation.*,
      proposal.id AS prediction_id,
      proposal.bbox AS prediction_roi,
      proposal.geometry AS prediction_geometry,
      proposal.rectification AS prediction_rectification,
      proposal.confidence AS prediction_confidence,
      proposal.detector_type AS prediction_algorithm_id,
      proposal.detector_version AS prediction_algorithm_version,
      proposal.config_snapshot AS prediction_algorithm_params,
      proposal.created_at AS prediction_created_at,
      proposal.helper_run_id AS prediction_helper_run_id,
      proposal.helper_candidate_id AS prediction_candidate_id
    FROM meta.image_annotations annotation
    LEFT JOIN meta.detection_proposals proposal ON proposal.id = annotation.suggestion_id
    WHERE annotation.source = $1 AND annotation.source_item_id = $2 AND annotation.annotation_track_id = $3 AND annotation.annotation_type = 'label-bbox'
    ORDER BY annotation.updated_at DESC
    LIMIT 1
    `,
    [source, sourceItemId, trackId],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
}

async function upsertDetectionProposalFromState(source: SourceName, sourceItemId: string, trackId: string, prediction: LabelRoiPrediction, imageUrl: string | null) {
  if (prediction.id) {
    const existing = await pool.query(
      `SELECT * FROM meta.detection_proposals WHERE id = $1 AND source = $2 AND source_item_id = $3 AND annotation_track_id = $4 LIMIT 1`,
      [prediction.id, source, sourceItemId, trackId],
    );
    if (existing.rows[0]) return existing.rows[0] as Record<string, unknown>;
  }
  const id = randomUUID();
  const algorithm = prediction.algorithm;
  const geometry = normalizeQuadGeometry(prediction.geometry, prediction.roi);
  if (!geometry) throw new Error("A valid convex label quad is required");
  const result = await pool.query(
    `
    INSERT INTO meta.detection_proposals (
      id, source, source_item_id, annotation_track_id, image_url, detector_type, detector_version,
      bbox, geometry, rectification, confidence, candidate_score, preset_id, preset_revision, config_hash, config_snapshot, helper_run_id, helper_candidate_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, NULL, NULL, NULL, $12, $13, $14)
    RETURNING *
    `,
    [
      id,
      source,
      sourceItemId,
      trackId,
      imageUrl,
      algorithm.id,
      algorithm.version ?? "unknown",
      JSON.stringify(geometry.bbox),
      JSON.stringify(geometry),
      prediction.rectification ? JSON.stringify(normalizeLabelRectification(prediction.rectification)) : null,
      prediction.confidence ?? null,
      JSON.stringify({ params: algorithm.params ?? {}, defaultParams: algorithm.defaultParams ?? null }),
      prediction.helperRunId ?? null,
      prediction.candidateId ?? null,
    ],
  );
  return result.rows[0] as Record<string, unknown>;
}

async function insertImageAnnotationFromState(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
  state: LabelAnnotationState,
  proposalId: string | null,
  imageUrl: string | null,
) {
  const current = await getLatestImageAnnotation(source, sourceItemId, trackId);
  const revision = Number(current?.revision ?? 0) + 1;
  const annotation = state.annotation;
  const geometry = annotation ? normalizeQuadGeometry(annotation.geometry, annotation.roi) : null;
  if (annotation && !geometry) throw new Error("A valid convex reviewed label quad is required");
  const sourceKind = state.status === "no-label"
    ? "no-label"
    : state.status === "invalid-image"
      ? "invalid-image"
      : derivedDbSourceKind(state.prediction, annotation);
  const status = state.status === "no-label" ? "no-object" : state.status === "invalid-image" ? "rejected" : "reviewed";
  await pool.query(
    `
    INSERT INTO meta.image_annotations (
      id, source, source_item_id, annotation_track_id, image_url, annotation_type, bbox, geometry, rectification,
      status, source_kind, suggestion_id, revision, reviewed_by
    )
    VALUES ($1, $2, $3, $4, $5, 'label-bbox', $6, $7, $8, $9, $10, $11, $12, $13)
    `,
    [
      randomUUID(),
      source,
      sourceItemId,
      trackId,
      imageUrl,
      geometry ? JSON.stringify(geometry.bbox) : null,
      geometry ? JSON.stringify(geometry) : null,
      annotation?.rectification ? JSON.stringify(normalizeLabelRectification(annotation.rectification)) : null,
      status,
      sourceKind,
      proposalId,
      revision,
      annotation?.reviewedBy ?? null,
    ],
  );
}

async function patchLegacyAnnotation(source: SourceName, sourceItemId: string, trackId: string, state: LabelAnnotationState) {
  const current = await getAnnotationTrackState(source, sourceItemId, trackId);
  const canonicalState = buildLabelAnnotationState({
    prediction: state.prediction,
    annotation: state.annotation,
    status: state.status,
    updatedAt: new Date().toISOString(),
  });
  await patchAnnotationTrackState(source, sourceItemId, trackId, {
    visualFeatures: current?.visual_features ?? {},
    annotations: {
      ...(current?.annotations ?? {}),
      labelAnnotation: {
        ...canonicalState,
      },
    },
    status: state.status === "reviewed" || state.status === "no-label" ? "reviewed" : current?.status ?? "reviewed",
  });
}

function proposalToPrediction(row: Record<string, unknown>): LabelRoiPrediction {
  const snapshot = objectValue(row.config_snapshot);
  const geometry = normalizeQuadGeometry(row.geometry, row.bbox);
  if (!geometry) throw new Error(`Detection proposal ${String(row.id)} has no valid geometry`);
  return {
    id: String(row.id),
    helperRunId: stringValue(row.helper_run_id) ?? undefined,
    candidateId: stringValue(row.helper_candidate_id) ?? undefined,
    roi: geometry.bbox,
    geometry,
    rectification: normalizeLabelRectification(row.rectification),
    confidence: numberValue(row.confidence),
    algorithm: {
      id: stringValue(row.detector_type) ?? "unknown",
      version: stringValue(row.detector_version) ?? undefined,
      params: objectValue(snapshot?.params) ?? snapshot ?? {},
      defaultParams: objectValue(snapshot?.defaultParams) ?? undefined,
    },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date().toISOString(),
  };
}

function linkedPrediction(row: Record<string, unknown>): LabelRoiPrediction | null {
  const geometry = normalizeQuadGeometry(row.prediction_geometry, row.prediction_roi);
  if (!geometry) return null;
  const snapshot = objectValue(row.prediction_algorithm_params);
  return {
    id: stringValue(row.prediction_id) ?? undefined,
    helperRunId: stringValue(row.prediction_helper_run_id) ?? undefined,
    candidateId: stringValue(row.prediction_candidate_id) ?? undefined,
    roi: geometry.bbox,
    geometry,
    rectification: normalizeLabelRectification(row.prediction_rectification),
    confidence: numberValue(row.prediction_confidence),
    algorithm: {
      id: stringValue(row.prediction_algorithm_id) ?? "unknown",
      version: stringValue(row.prediction_algorithm_version) ?? undefined,
      params: objectValue(snapshot?.params) ?? snapshot ?? {},
      defaultParams: objectValue(snapshot?.defaultParams) ?? undefined,
    },
    createdAt: row.prediction_created_at instanceof Date ? row.prediction_created_at.toISOString() : undefined,
  };
}

function annotationToLabelRoi(row: Record<string, unknown>): LabelRoiAnnotation | null {
  const status = stringValue(row.status);
  if (status !== "reviewed") return null;
  const geometry = normalizeQuadGeometry(row.geometry, row.bbox);
  if (!geometry) return null;
  return {
    id: String(row.id),
    revision: Number(row.revision ?? 1),
    roi: geometry.bbox,
    geometry,
    rectification: normalizeLabelRectification(row.rectification),
    reviewedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date().toISOString(),
    reviewedBy: stringValue(row.reviewed_by) ?? undefined,
  };
}

export async function getReviewedLabelAnnotationRevision(source: SourceName, sourceItemId: string, trackId: string, annotationId: string, revision: number) {
  const result = await pool.query(
    `SELECT id, image_url, bbox, geometry, rectification, revision, source_kind, updated_at
     FROM meta.image_annotations
     WHERE id = $1 AND source = $2 AND source_item_id = $3 AND annotation_track_id = $4 AND revision = $5
       AND annotation_type = 'label-bbox' AND status = 'reviewed' AND bbox IS NOT NULL`,
    [annotationId, source, sourceItemId, trackId, revision],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const geometry = normalizeQuadGeometry(row.geometry, row.bbox);
  if (!geometry) return null;
  return {
    id: String(row.id),
    source,
    sourceItemId,
    imageUrl: stringValue(row.image_url),
    bbox: geometry.bbox,
    geometry,
    rectification: normalizeLabelRectification(row.rectification),
    revision: Number(row.revision),
    sourceKind: stringValue(row.source_kind) ?? "manual",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ""),
  };
}

export async function getLatestReviewedLabelAnnotationRevision(source: SourceName, sourceItemId: string, trackId: string) {
  const result = await pool.query(
    `SELECT id, image_url, bbox, geometry, rectification, revision, status, source_kind, reviewed_by, updated_at
     FROM meta.image_annotations WHERE source = $1 AND source_item_id = $2 AND annotation_track_id = $3
       AND annotation_type = 'label-bbox' AND status = 'reviewed' AND bbox IS NOT NULL
     ORDER BY revision DESC LIMIT 1`, [source, sourceItemId, trackId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const annotation = annotationToLabelRoi(row);
  if (!annotation) return null;
  return {
    id: annotation.id!,
    revision: annotation.revision!,
    bbox: annotation.roi,
    geometry: annotation.geometry,
    rectification: annotation.rectification,
    source: stringValue(row.source_kind) ?? "manual",
    reviewedAt: annotation.reviewedAt,
    reviewedBy: annotation.reviewedBy,
  };
}

function annotationStatus(annotation: Record<string, unknown> | undefined, legacy: LabelAnnotationState | null, prediction: LabelRoiPrediction | null) {
  const dbStatus = stringValue(annotation?.status);
  if (dbStatus === "reviewed") return "reviewed";
  if (dbStatus === "no-object") return "no-label";
  if (dbStatus === "rejected") return "invalid-image";
  if (legacy?.status) return legacy.status;
  return prediction ? "needs-review" : "unprocessed";
}

function generatedFromCvMeta(visualFeatures: Record<string, unknown> | undefined, imageUrl: string | null): LabelRoiPrediction | null {
  const cvMeta = objectValue(visualFeatures?.cvMeta) ?? visualFeatures;
  const label = objectValue(cvMeta?.label);
  const roi = objectValue(label?.roi);
  if (!roi) return null;
  const source = objectValue(cvMeta?.source);
  const width = numberValue(source?.width) ?? 1000;
  const height = numberValue(source?.height) ?? 1000;
  const detection = objectValue(label?.detection);
  const layout = objectValue(label?.layout);
  const diagnostics = objectValue(cvMeta?.diagnostics);
  const geometry = normalizeQuadGeometry(null, {
      x: Math.round((numberValue(roi.x) ?? 0) * width),
      y: Math.round((numberValue(roi.y) ?? 0) * height),
      width: Math.round((numberValue(roi.width) ?? 0) * width),
      height: Math.round((numberValue(roi.height) ?? 0) * height),
  });
  if (!geometry) return null;
  return {
    roi: geometry.bbox,
    geometry,
    algorithm: {
      id: "cv-meta-label-roi",
      version: stringValue(diagnostics?.pipelineVersion) ?? stringValue(cvMeta?.extractorVersion) ?? "cv-meta-v2",
      params: objectValue(diagnostics?.config) ?? {},
    },
    confidence: numberValue(detection?.confidence),
    createdAt: new Date().toISOString(),
  };
}

function normalizeLabelAnnotation(value: unknown): LabelAnnotationState | null {
  const record = objectValue(value);
  if (!record) return null;
  if (record.schemaVersion === 2) {
    return buildLabelAnnotationState({
      prediction: normalizePrediction(record.prediction),
      annotation: normalizeAnnotation(record.annotation),
      status: normalizeStatus(record.status),
      updatedAt: stringValue(record.updatedAt) ?? undefined,
    });
  }
  if (record.schemaVersion !== 1) return null;
  const generated = objectValue(record.generated);
  const reviewed = objectValue(record.reviewed);
  const prediction = generated ? legacyGeneratedToPrediction(generated) : null;
  const reviewedGeometry = normalizeQuadGeometry(reviewed?.geometry, reviewed?.bbox);
  const annotation = reviewedGeometry ? {
    id: stringValue(reviewed?.id) ?? undefined,
    revision: numberValue(reviewed?.revision) ?? undefined,
    roi: reviewedGeometry.bbox,
    geometry: reviewedGeometry,
    reviewedAt: stringValue(reviewed?.reviewedAt) ?? undefined,
    reviewedBy: stringValue(reviewed?.reviewedBy) ?? undefined,
  } : null;
  return buildLabelAnnotationState({ prediction, annotation, status: normalizeStatus(record.status), updatedAt: stringValue(record.updatedAt) ?? undefined });
}

function normalizePrediction(value: unknown): LabelRoiPrediction | null {
  const record = objectValue(value);
  const geometry = normalizeQuadGeometry(record?.geometry, record?.roi);
  const algorithm = objectValue(record?.algorithm);
  if (!record || !geometry || !algorithm) return null;
  return {
    id: stringValue(record.id) ?? undefined,
    roi: geometry.bbox,
    geometry,
    rectification: normalizeLabelRectification(record.rectification),
    confidence: numberValue(record.confidence),
    algorithm: {
      id: stringValue(algorithm.id) ?? "unknown",
      version: stringValue(algorithm.version) ?? undefined,
      params: objectValue(algorithm.params) ?? {},
      defaultParams: objectValue(algorithm.defaultParams) ?? undefined,
    },
    createdAt: stringValue(record.createdAt) ?? undefined,
  };
}

function normalizeAnnotation(value: unknown): LabelRoiAnnotation | null {
  const record = objectValue(value);
  const geometry = normalizeQuadGeometry(record?.geometry, record?.roi);
  if (!record || !geometry) return null;
  return {
    id: stringValue(record.id) ?? undefined,
    revision: numberValue(record.revision) ?? undefined,
    roi: geometry.bbox,
    geometry,
    rectification: normalizeLabelRectification(record.rectification),
    reviewedAt: stringValue(record.reviewedAt) ?? undefined,
    reviewedBy: stringValue(record.reviewedBy) ?? undefined,
  };
}

function legacyGeneratedToPrediction(generated: Record<string, unknown>): LabelRoiPrediction | null {
  const geometry = normalizeQuadGeometry(generated.geometry, generated.bbox);
  if (!geometry) return null;
  const detector = objectValue(generated.detector);
  return {
    roi: geometry.bbox,
    geometry,
    confidence: numberValue(generated.confidence),
    algorithm: {
      id: stringValue(detector?.type) ?? "legacy-label-detector",
      version: stringValue(detector?.version) ?? undefined,
      params: {
        candidateScore: numberValue(generated.candidateScore),
        presetId: stringValue(generated.presetId),
        presetRevision: numberValue(generated.presetRevision),
        configHash: stringValue(generated.configHash),
      },
    },
    createdAt: stringValue(generated.generatedAt) ?? undefined,
  };
}

function buildLabelAnnotationState(input: {
  prediction: LabelRoiPrediction | null;
  annotation: LabelRoiAnnotation | null;
  status: LabelAnnotationState["status"];
  updatedAt?: string;
}): LabelAnnotationState {
  const predictionGeometry = input.prediction ? normalizeQuadGeometry(input.prediction.geometry, input.prediction.roi) : null;
  const annotationGeometry = input.annotation ? normalizeQuadGeometry(input.annotation.geometry, input.annotation.roi) : null;
  const prediction = input.prediction && predictionGeometry ? { ...input.prediction, roi: predictionGeometry.bbox, geometry: predictionGeometry } : null;
  const annotation = input.annotation && annotationGeometry ? { ...input.annotation, roi: annotationGeometry.bbox, geometry: annotationGeometry } : null;
  const iou = prediction && annotation ? rectIoU(prediction.roi, annotation.roi) : null;
  const geometryEdited = predictionGeometry && annotationGeometry ? !sameQuad(predictionGeometry, annotationGeometry) : false;
  const rectificationEdited = prediction && annotation
    ? JSON.stringify(prediction.rectification ?? null) !== JSON.stringify(annotation.rectification ?? null)
    : Boolean(annotation?.rectification);
  return {
    schemaVersion: 2,
    prediction,
    annotation,
    status: input.status,
    reviewed: annotation !== null,
    roiEdited: geometryEdited || rectificationEdited,
    source: annotation ? prediction ? geometryEdited || rectificationEdited ? "corrected" : "auto" : "manual" : null,
    iou,
    labelRoiGt: annotation !== null,
    updatedAt: input.updatedAt,
  };
}

function derivedDbSourceKind(prediction: LabelRoiPrediction | null, annotation: LabelRoiAnnotation | null) {
  if (!annotation || !prediction) return "manual";
  const predictionGeometry = normalizeQuadGeometry(prediction.geometry, prediction.roi);
  const annotationGeometry = normalizeQuadGeometry(annotation.geometry, annotation.roi);
  return sameQuad(predictionGeometry, annotationGeometry) ? "accepted-generated" : "corrected-generated";
}

function rectIoU(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftX = numberValue(left.x) ?? 0; const leftY = numberValue(left.y) ?? 0;
  const rightX = numberValue(right.x) ?? 0; const rightY = numberValue(right.y) ?? 0;
  const leftWidth = Math.max(0, numberValue(left.width) ?? 0); const leftHeight = Math.max(0, numberValue(left.height) ?? 0);
  const rightWidth = Math.max(0, numberValue(right.width) ?? 0); const rightHeight = Math.max(0, numberValue(right.height) ?? 0);
  const intersectionWidth = Math.max(0, Math.min(leftX + leftWidth, rightX + rightWidth) - Math.max(leftX, rightX));
  const intersectionHeight = Math.max(0, Math.min(leftY + leftHeight, rightY + rightHeight) - Math.max(leftY, rightY));
  const intersection = intersectionWidth * intersectionHeight;
  const union = leftWidth * leftHeight + rightWidth * rightHeight - intersection;
  return union > 0 ? Math.round(intersection / union * 1_000_000) / 1_000_000 : 0;
}

function normalizeStatus(value: unknown): LabelAnnotationState["status"] {
  return value === "generated" || value === "needs-review" || value === "reviewed" || value === "no-label" || value === "invalid-image" ? value : "unprocessed";
}

function normalizeObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}
