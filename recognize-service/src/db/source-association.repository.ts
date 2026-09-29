import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import type { SourceName } from "../shared/types.js";

export type SourceAssociation = {
  id: string;
  ocrRegionAnnotationId: string | null;
  regionTextSnapshot: string;
  sourceField: string;
  sourceValue: string;
  status: string;
  sourceKind: string;
  matchKind: string;
  score: number | null;
  sortOrder: number;
};

export type SourceAssociationReview = {
  id: string;
  source: string;
  sourceItemId: string;
  ocrRegionAnnotationSetId: string | null;
  revision: number;
  status: string;
  reviewedBy: string | null;
  createdAt: string;
  associations: SourceAssociation[];
};

export type PutSourceAssociationReview = {
  baseRevision: number;
  ocrRegionAnnotationSetId?: string | null;
  status: string;
  reviewedBy?: string;
  associations: Array<{
    ocrRegionAnnotationId?: string | null;
    regionTextSnapshot: string;
    sourceField: string;
    sourceValue: string;
    status: string;
    sourceKind: string;
    matchKind: string;
    score?: number | null;
    sortOrder?: number;
  }>;
};

export async function getLatestSourceAssociationReview(
  source: SourceName,
  sourceItemId: string,
  annotationTrackId: string,
): Promise<SourceAssociationReview | null> {
  const result = await pool.query(
    `
    SELECT *
    FROM meta.ocr_source_association_sets
    WHERE source = $1 AND source_item_id = $2 AND annotation_track_id = $3
    ORDER BY revision DESC
    LIMIT 1
    `,
    [source, sourceItemId, annotationTrackId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToReview(row, await listAssociations(String(row.id)));
}

export async function putSourceAssociationReview(
  source: SourceName,
  sourceItemId: string,
  annotationTrackId: string,
  input: PutSourceAssociationReview,
  validSourceValues: Set<string>,
): Promise<SourceAssociationReview> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${annotationTrackId}:source-associations`]);
    const current = await client.query(
      `SELECT revision FROM meta.ocr_source_association_sets WHERE annotation_track_id = $1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
      [annotationTrackId],
    );
    const currentRevision = Number(current.rows[0]?.revision ?? 0);
    if (input.baseRevision !== currentRevision) {
      throw new ConflictError(`Source association revision conflict: expected ${input.baseRevision}, current ${currentRevision}`);
    }

    if (input.ocrRegionAnnotationSetId) {
      const regionSet = await client.query(
        `SELECT id FROM meta.ocr_region_annotation_sets WHERE id = $1 AND source = $2 AND source_item_id = $3 AND annotation_track_id = $4`,
        [input.ocrRegionAnnotationSetId, source, sourceItemId, annotationTrackId],
      );
      if (!regionSet.rowCount) throw new NotFoundError("OCR region annotation set not found for source item");
    }

    const regionIds = [...new Set(input.associations.flatMap((association) => association.ocrRegionAnnotationId ? [association.ocrRegionAnnotationId] : []))];
    if (regionIds.length) {
      if (!input.ocrRegionAnnotationSetId) throw new ConflictError("OCR region ids require an OCR region annotation set");
      const regions = await client.query(
        `SELECT id FROM meta.ocr_region_annotations WHERE annotation_set_id = $1 AND id = ANY($2::uuid[])`,
        [input.ocrRegionAnnotationSetId, regionIds],
      );
      if (regions.rowCount !== regionIds.length) throw new ConflictError("One or more OCR regions do not belong to the selected review set");
    }

    for (const association of input.associations) {
      if (!validSourceValues.has(sourceValueKey(association.sourceField, association.sourceValue))) {
        throw new ConflictError(`Source value is not present on the current item: ${association.sourceField}`);
      }
    }

    const setId = randomUUID();
    const revision = currentRevision + 1;
    const setResult = await client.query(
      `
      INSERT INTO meta.ocr_source_association_sets (
        id, source, source_item_id, annotation_track_id, ocr_region_annotation_set_id, revision, status, reviewed_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [setId, source, sourceItemId, annotationTrackId, input.ocrRegionAnnotationSetId ?? null, revision, input.status, input.reviewedBy ?? null],
    );

    const inserted: Record<string, unknown>[] = [];
    for (const [index, association] of input.associations.entries()) {
      const result = await client.query(
        `
        INSERT INTO meta.ocr_source_associations (
          id, association_set_id, ocr_region_annotation_id, region_text_snapshot,
          source_field, source_value, status, source_kind, match_kind, score, sort_order
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING *
        `,
        [
          randomUUID(), setId, association.ocrRegionAnnotationId ?? null, association.regionTextSnapshot,
          association.sourceField, association.sourceValue, association.status, association.sourceKind,
          association.matchKind, association.score ?? null, association.sortOrder ?? index,
        ],
      );
      inserted.push(result.rows[0] as Record<string, unknown>);
    }
    await client.query("COMMIT");
    return rowToReview(setResult.rows[0] as Record<string, unknown>, inserted.map(rowToAssociation));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function sourceValueKey(field: string, value: string) {
  return `${field}\u0000${value.trim()}`;
}

async function listAssociations(setId: string) {
  const result = await pool.query(
    `SELECT * FROM meta.ocr_source_associations WHERE association_set_id = $1 ORDER BY sort_order, id`,
    [setId],
  );
  return result.rows.map((row) => rowToAssociation(row as Record<string, unknown>));
}

function rowToReview(row: Record<string, unknown>, associations: SourceAssociation[]): SourceAssociationReview {
  return {
    id: String(row.id),
    source: String(row.source),
    sourceItemId: String(row.source_item_id),
    ocrRegionAnnotationSetId: nullableString(row.ocr_region_annotation_set_id),
    revision: Number(row.revision),
    status: String(row.status),
    reviewedBy: nullableString(row.reviewed_by),
    createdAt: dateString(row.created_at),
    associations,
  };
}

function rowToAssociation(row: Record<string, unknown>): SourceAssociation {
  return {
    id: String(row.id),
    ocrRegionAnnotationId: nullableString(row.ocr_region_annotation_id),
    regionTextSnapshot: String(row.region_text_snapshot ?? ""),
    sourceField: String(row.source_field),
    sourceValue: String(row.source_value),
    status: String(row.status),
    sourceKind: String(row.source_kind),
    matchKind: String(row.match_kind),
    score: typeof row.score === "number" ? row.score : row.score === null || row.score === undefined ? null : Number(row.score),
    sortOrder: Number(row.sort_order ?? 0),
  };
}

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function dateString(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}
