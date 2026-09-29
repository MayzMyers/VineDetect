import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import type { SourceName } from "../shared/types.js";
import { normalizeText } from "../modules/recognize-core/text.js";

export type AliasAnnotation = {
  id: string;
  value: string;
  normalizedValue: string;
  aliasType: string;
  status: string;
  sourceKind: string;
  score: number | null;
  sourceAssociationIds: string[];
  components: Record<string, unknown>;
  sortOrder: number;
};

export type AliasReview = {
  id: string;
  source: string;
  sourceItemId: string;
  sourceAssociationSetId: string | null;
  revision: number;
  status: string;
  reviewedBy: string | null;
  createdAt: string;
  aliases: AliasAnnotation[];
};

export type PutAliasReview = {
  baseRevision: number;
  sourceAssociationSetId?: string | null;
  status: string;
  reviewedBy?: string;
  aliases: Array<{
    value: string;
    aliasType: string;
    status: string;
    sourceKind: string;
    score?: number | null;
    sourceAssociationIds: string[];
    components?: Record<string, unknown>;
    sortOrder?: number;
  }>;
};

export async function getLatestAliasReview(source: SourceName, sourceItemId: string, annotationTrackId: string): Promise<AliasReview | null> {
  const result = await pool.query(
    `SELECT * FROM meta.alias_annotation_sets WHERE source = $1 AND source_item_id = $2 AND annotation_track_id = $3 ORDER BY revision DESC LIMIT 1`,
    [source, sourceItemId, annotationTrackId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const aliases = await pool.query(
    `SELECT * FROM meta.alias_annotations WHERE annotation_set_id = $1 ORDER BY sort_order, id`,
    [row.id],
  );
  return rowToReview(row, aliases.rows.map((item) => rowToAlias(item as Record<string, unknown>)));
}

export async function putAliasReview(source: SourceName, sourceItemId: string, annotationTrackId: string, input: PutAliasReview): Promise<AliasReview> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${annotationTrackId}:aliases`]);
    const current = await client.query(
      `SELECT revision FROM meta.alias_annotation_sets WHERE annotation_track_id = $1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
      [annotationTrackId],
    );
    const currentRevision = Number(current.rows[0]?.revision ?? 0);
    if (input.baseRevision !== currentRevision) {
      throw new ConflictError(`Alias revision conflict: expected ${input.baseRevision}, current ${currentRevision}`);
    }

    if (input.sourceAssociationSetId) {
      const associationSet = await client.query(
        `SELECT id FROM meta.ocr_source_association_sets WHERE id = $1 AND source = $2 AND source_item_id = $3 AND annotation_track_id = $4 AND status = 'reviewed'`,
        [input.sourceAssociationSetId, source, sourceItemId, annotationTrackId],
      );
      if (!associationSet.rowCount) throw new NotFoundError("Reviewed source association set not found for source item");
    }
    const associationIds = [...new Set(input.aliases.flatMap((alias) => alias.sourceAssociationIds))];
    if (associationIds.length) {
      if (!input.sourceAssociationSetId) throw new ConflictError("Source association ids require a source association set");
      const associations = await client.query(
        `SELECT id FROM meta.ocr_source_associations WHERE association_set_id = $1 AND id = ANY($2::uuid[])`,
        [input.sourceAssociationSetId, associationIds],
      );
      if (associations.rowCount !== associationIds.length) throw new ConflictError("One or more source associations do not belong to the selected review set");
    }

    const setId = randomUUID();
    const revision = currentRevision + 1;
    const setResult = await client.query(
      `INSERT INTO meta.alias_annotation_sets (id, source, source_item_id, annotation_track_id, source_association_set_id, revision, status, reviewed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [setId, source, sourceItemId, annotationTrackId, input.sourceAssociationSetId ?? null, revision, input.status, input.reviewedBy ?? null],
    );
    const inserted: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const [index, alias] of input.aliases.entries()) {
      const normalizedValue = normalizeText(alias.value);
      if (!normalizedValue) throw new ConflictError("Alias must contain letters or numbers");
      const duplicateKey = `${normalizedValue}\u0000${alias.aliasType}`;
      if (seen.has(duplicateKey)) throw new ConflictError(`Duplicate alias: ${alias.value}`);
      seen.add(duplicateKey);
      const result = await client.query(
        `INSERT INTO meta.alias_annotations (
           id, annotation_set_id, value, normalized_value, alias_type, status, source_kind,
           score, source_association_ids, components, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10, $11) RETURNING *`,
        [
          randomUUID(), setId, alias.value.trim(), normalizedValue, alias.aliasType, alias.status,
          alias.sourceKind, alias.score ?? null, alias.sourceAssociationIds,
          JSON.stringify(alias.components ?? {}), alias.sortOrder ?? index,
        ],
      );
      inserted.push(result.rows[0] as Record<string, unknown>);
    }
    await client.query("COMMIT");
    return rowToReview(setResult.rows[0] as Record<string, unknown>, inserted.map(rowToAlias));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function rowToReview(row: Record<string, unknown>, aliases: AliasAnnotation[]): AliasReview {
  return {
    id: String(row.id), source: String(row.source), sourceItemId: String(row.source_item_id),
    sourceAssociationSetId: nullableString(row.source_association_set_id), revision: Number(row.revision),
    status: String(row.status), reviewedBy: nullableString(row.reviewed_by), createdAt: dateString(row.created_at), aliases,
  };
}

function rowToAlias(row: Record<string, unknown>): AliasAnnotation {
  return {
    id: String(row.id), value: String(row.value), normalizedValue: String(row.normalized_value),
    aliasType: String(row.alias_type), status: String(row.status), sourceKind: String(row.source_kind),
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    sourceAssociationIds: Array.isArray(row.source_association_ids) ? row.source_association_ids.map(String) : [],
    components: objectValue(row.components), sortOrder: Number(row.sort_order ?? 0),
  };
}

function nullableString(value: unknown) { return value === null || value === undefined ? null : String(value); }
function dateString(value: unknown) { return value instanceof Date ? value.toISOString() : String(value ?? ""); }
function objectValue(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
