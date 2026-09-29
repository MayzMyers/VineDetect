import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import type { SourceName } from "../shared/types.js";

export type CatalogIdentityStatus = "confirmed" | "corrected" | "no-match" | "ambiguous";

export type CatalogIdentityReview = {
  id: string;
  source: SourceName;
  sourceItemId: string;
  analysisJobId: string;
  ocrRegionAnnotationSetId: string | null;
  revision: number;
  status: CatalogIdentityStatus;
  selectedSource: SourceName | null;
  selectedSourceItemId: string | null;
  candidateSnapshot: Record<string, unknown>;
  score: number | null;
  notes: string;
  reviewedBy: string | null;
  createdAt: string;
};

export type PutCatalogIdentityReview = {
  baseRevision: number;
  analysisJobId: string;
  ocrRegionAnnotationSetId?: string | null;
  status: CatalogIdentityStatus;
  selectedSource?: SourceName | null;
  selectedSourceItemId?: string | null;
  candidateSnapshot?: Record<string, unknown>;
  score?: number | null;
  notes?: string;
  reviewedBy?: string;
};

export async function getLatestCatalogIdentityReview(source: SourceName, sourceItemId: string, annotationTrackId: string): Promise<CatalogIdentityReview | null> {
  const result = await pool.query(
    `SELECT * FROM meta.catalog_identity_reviews WHERE source = $1 AND source_item_id = $2 AND annotation_track_id = $3 ORDER BY revision DESC LIMIT 1`,
    [source, sourceItemId, annotationTrackId],
  );
  return result.rows[0] ? rowToReview(result.rows[0] as Record<string, unknown>) : null;
}

export async function putCatalogIdentityReview(
  source: SourceName,
  sourceItemId: string,
  annotationTrackId: string,
  input: PutCatalogIdentityReview,
): Promise<CatalogIdentityReview> {
  const selectedSource = input.selectedSource ?? null;
  const selectedSourceItemId = input.selectedSourceItemId ?? null;
  if (Boolean(selectedSource) !== Boolean(selectedSourceItemId)) {
    throw new ConflictError("Selected catalog source and item id must be provided together");
  }
  const hasSelection = Boolean(selectedSource && selectedSourceItemId);
  if ((input.status === "confirmed" || input.status === "corrected") !== hasSelection) {
    throw new ConflictError(`${input.status} catalog identity requires exactly one selected item`);
  }
  const selectedIsCurrent = selectedSource === source && selectedSourceItemId === sourceItemId;
  if (input.status === "confirmed" && !selectedIsCurrent) throw new ConflictError("Confirmed identity must select the current source item");
  if (input.status === "corrected" && selectedIsCurrent) throw new ConflictError("Corrected identity must select a different source item");
  const snapshotSource = input.candidateSnapshot?.source;
  const snapshotItemId = input.candidateSnapshot?.sourceItemId;
  if (hasSelection && (snapshotSource !== selectedSource || snapshotItemId !== selectedSourceItemId)) {
    throw new ConflictError("Candidate snapshot identity must match the selected catalog item");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${annotationTrackId}:catalog-identity`]);
    const current = await client.query(
      `SELECT revision FROM meta.catalog_identity_reviews WHERE annotation_track_id = $1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
      [annotationTrackId],
    );
    const currentRevision = Number(current.rows[0]?.revision ?? 0);
    if (input.baseRevision !== currentRevision) {
      throw new ConflictError(`Catalog identity revision conflict: expected ${input.baseRevision}, current ${currentRevision}`);
    }

    const analysisJob = await client.query(
      `SELECT j.id
       FROM meta.generation_jobs j
       JOIN meta.annotation_track_states i ON i.annotation_track_id = j.annotation_track_id
       WHERE j.id = $1 AND j.source = $2 AND j.source_item_id = $3
         AND j.annotation_track_id = $4 AND j.job_type = 'ANALYZE_LABEL' AND j.status = 'completed'
         AND i.visual_features->'labelAnalysis'->>'jobId' = j.id::text`,
      [input.analysisJobId, source, sourceItemId, annotationTrackId],
    );
    if (!analysisJob.rowCount) throw new NotFoundError("Completed label-analysis job not found for source item");

    if (input.ocrRegionAnnotationSetId) {
      const regionSet = await client.query(
        `SELECT id FROM meta.ocr_region_annotation_sets WHERE id = $1 AND source = $2 AND source_item_id = $3 AND annotation_track_id = $4`,
        [input.ocrRegionAnnotationSetId, source, sourceItemId, annotationTrackId],
      );
      if (!regionSet.rowCount) throw new NotFoundError("OCR region annotation set not found for source item");
    }

    if (hasSelection) {
      const selected = await client.query(
        `SELECT 1 FROM (${catalogIdentitySourceSql()}) AS catalog WHERE source = $1 AND source_item_id = $2`,
        [selectedSource, selectedSourceItemId],
      );
      if (!selected.rowCount) throw new NotFoundError("Selected catalog item not found");
    }

    const result = await client.query(
      `INSERT INTO meta.catalog_identity_reviews (
         id, source, source_item_id, annotation_track_id, analysis_job_id, ocr_region_annotation_set_id, revision, status,
         selected_source, selected_source_item_id, candidate_snapshot, score, notes, reviewed_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14) RETURNING *`,
      [randomUUID(), source, sourceItemId, annotationTrackId, input.analysisJobId, input.ocrRegionAnnotationSetId ?? null,
       currentRevision + 1, input.status, selectedSource, selectedSourceItemId,
       JSON.stringify(input.candidateSnapshot ?? {}), input.score ?? null, input.notes?.trim() ?? "", input.reviewedBy ?? null],
    );
    await client.query("COMMIT");
    return rowToReview(result.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function catalogIdentitySourceSql() {
  return `
    SELECT 'svoe_vino'::text AS source, COALESCE(w.external_id, w.slug, w.id::text) AS source_item_id FROM svoe_vino.wines w
    UNION ALL
    SELECT 'roskachestvo'::text AS source, p.rskrf_product_id AS source_item_id FROM roskachestvo.products p
  `;
}

function rowToReview(row: Record<string, unknown>): CatalogIdentityReview {
  return {
    id: String(row.id), source: row.source as SourceName, sourceItemId: String(row.source_item_id),
    analysisJobId: String(row.analysis_job_id), ocrRegionAnnotationSetId: nullableString(row.ocr_region_annotation_set_id),
    revision: Number(row.revision), status: row.status as CatalogIdentityStatus,
    selectedSource: row.selected_source == null ? null : row.selected_source as SourceName,
    selectedSourceItemId: nullableString(row.selected_source_item_id),
    candidateSnapshot: isObject(row.candidate_snapshot) ? row.candidate_snapshot : {},
    score: row.score == null ? null : Number(row.score), notes: String(row.notes ?? ""),
    reviewedBy: nullableString(row.reviewed_by),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
  };
}

function nullableString(value: unknown) { return value == null ? null : String(value); }
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
