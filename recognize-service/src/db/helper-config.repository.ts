import { pool } from "./pool.js";
import type { SourceName } from "../shared/types.js";
import { buildHelperConfigContract } from "../shared/helperConfigContract.js";

export async function getHelperConfigContractForItem(source: SourceName, sourceItemId: string, annotationTrackId: string) {
  const result = await pool.query(`
    SELECT state.visual_features,
      reviewed_run.id::text AS ocr_run_id,
      reviewed_run.evidence AS ocr_evidence,
      latest_proposal.id::text AS label_prediction_id,
      latest_proposal.detector_type AS label_prediction_algorithm_id,
      latest_proposal.detector_version AS label_prediction_algorithm_version,
      latest_proposal.config_snapshot AS label_prediction_config,
      latest_proposal.created_at AS label_prediction_created_at,
      latest_annotation.status AS label_review_status
    FROM meta.annotation_tracks track
    JOIN meta.annotation_track_states state ON state.annotation_track_id = track.id
    LEFT JOIN LATERAL (
      SELECT run.id, run.evidence
      FROM meta.ocr_region_annotation_sets annotation_set
      JOIN meta.ocr_runs run ON run.id = annotation_set.ocr_run_id
      WHERE annotation_set.annotation_track_id = track.id
        AND annotation_set.status = 'reviewed'
      ORDER BY annotation_set.revision DESC
      LIMIT 1
    ) reviewed_run ON TRUE
    LEFT JOIN LATERAL (
      SELECT proposal.*
      FROM meta.detection_proposals proposal
      WHERE proposal.annotation_track_id = track.id
      ORDER BY proposal.created_at DESC
      LIMIT 1
    ) latest_proposal ON TRUE
    LEFT JOIN LATERAL (
      SELECT annotation.status
      FROM meta.image_annotations annotation
      WHERE annotation.annotation_track_id = track.id
        AND annotation.annotation_type = 'label-bbox'
      ORDER BY annotation.updated_at DESC
      LIMIT 1
    ) latest_annotation ON TRUE
    WHERE track.source = $1 AND track.source_item_id = $2 AND track.id = $3
  `, [source, sourceItemId, annotationTrackId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const snapshot = objectValue(row?.label_prediction_config);
  return buildHelperConfigContract(row?.visual_features, row?.ocr_evidence, row?.ocr_run_id, row?.label_prediction_id ? {
    id: row.label_prediction_id,
    algorithm: {
      id: row.label_prediction_algorithm_id,
      version: row.label_prediction_algorithm_version,
      params: objectValue(snapshot?.params) ?? snapshot ?? {},
      defaultParams: objectValue(snapshot?.defaultParams),
    },
    createdAt: row.label_prediction_created_at instanceof Date ? row.label_prediction_created_at.toISOString() : row.label_prediction_created_at,
    reviewStatus: row.label_review_status,
  } : null);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
