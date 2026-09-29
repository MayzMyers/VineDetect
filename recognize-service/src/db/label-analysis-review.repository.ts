import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import type { SourceName } from "../shared/types.js";

export type LabelAnalysisReview = {
  id: string; source: SourceName; sourceItemId: string; annotationId: string;
  annotationRevision: number; jobId: string; configHash: string; revision: number;
  status: "accepted" | "needs-tuning" | "rejected"; notes: string;
  reviewedBy: string | null; createdAt: string;
};

export type PutLabelAnalysisReview = {
  baseRevision: number; annotationId: string; annotationRevision: number; jobId: string;
  configHash: string; status: LabelAnalysisReview["status"]; notes?: string; reviewedBy?: string;
};

export async function getLatestLabelAnalysisReview(source: SourceName, sourceItemId: string, annotationTrackId: string): Promise<LabelAnalysisReview | null> {
  const result = await pool.query(
    `SELECT * FROM meta.label_analysis_reviews WHERE source = $1 AND source_item_id = $2 AND annotation_track_id = $3 ORDER BY revision DESC LIMIT 1`,
    [source, sourceItemId, annotationTrackId],
  );
  return result.rows[0] ? rowToReview(result.rows[0] as Record<string, unknown>) : null;
}

export async function putLabelAnalysisReview(source: SourceName, sourceItemId: string, annotationTrackId: string, input: PutLabelAnalysisReview): Promise<LabelAnalysisReview> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${annotationTrackId}:label-analysis-review`]);
    const current = await client.query(
      `SELECT revision FROM meta.label_analysis_reviews WHERE annotation_track_id = $1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
      [annotationTrackId],
    );
    const currentRevision = Number(current.rows[0]?.revision ?? 0);
    if (input.baseRevision !== currentRevision) throw new ConflictError(`Label analysis review conflict: expected ${input.baseRevision}, current ${currentRevision}`);

    const generated = await client.query(
      `SELECT 1
       FROM meta.annotation_track_states i
       JOIN meta.image_annotations a ON a.id = $3::uuid
       JOIN meta.generation_jobs j ON j.id = $5::uuid
       WHERE i.annotation_track_id = $7::uuid
         AND a.source = $1 AND a.source_item_id = $2 AND a.annotation_track_id = $7::uuid AND a.revision = $4
         AND a.annotation_type = 'label-bbox' AND a.status = 'reviewed'
         AND j.source = $1 AND j.source_item_id = $2 AND j.annotation_track_id = $7::uuid AND j.status = 'completed'
         AND i.visual_features->'labelAnalysis'->>'annotationId' = $3::text
         AND (i.visual_features->'labelAnalysis'->>'annotationRevision')::integer = $4
         AND i.visual_features->'labelAnalysis'->>'jobId' = $5::text
         AND i.visual_features->'labelAnalysis'->'provenance'->>'configHash' = $6`,
      [source, sourceItemId, input.annotationId, input.annotationRevision, input.jobId, input.configHash, annotationTrackId],
    );
    if (!generated.rowCount) throw new NotFoundError("Current completed label analysis result not found");

    const result = await client.query(
      `INSERT INTO meta.label_analysis_reviews (
         id, source, source_item_id, annotation_track_id, annotation_id, annotation_revision, job_id, config_hash,
         revision, status, notes, reviewed_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [randomUUID(), source, sourceItemId, annotationTrackId, input.annotationId, input.annotationRevision, input.jobId,
       input.configHash, currentRevision + 1, input.status, input.notes?.trim() ?? "", input.reviewedBy ?? null],
    );
    await client.query("COMMIT");
    return rowToReview(result.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

function rowToReview(row: Record<string, unknown>): LabelAnalysisReview {
  return {
    id: String(row.id), source: row.source as SourceName, sourceItemId: String(row.source_item_id),
    annotationId: String(row.annotation_id), annotationRevision: Number(row.annotation_revision),
    jobId: String(row.job_id), configHash: String(row.config_hash), revision: Number(row.revision),
    status: row.status as LabelAnalysisReview["status"], notes: String(row.notes ?? ""),
    reviewedBy: row.reviewed_by == null ? null : String(row.reviewed_by),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
  };
}
