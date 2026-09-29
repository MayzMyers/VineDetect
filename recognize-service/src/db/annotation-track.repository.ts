import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import type { SourceName } from "../shared/types.js";
import { NotFoundError } from "../shared/errors.js";

export type AnnotationTrack = {
  id: string;
  source: SourceName;
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

export async function listAnnotationTracks(source: SourceName, sourceItemId: string): Promise<AnnotationTrack[]> {
  const result = await pool.query(
    `SELECT track.*,
            annotation.image_url AS preview_image_url,
            annotation.bbox AS preview_bbox,
            COALESCE(execution.completed_stages, 0)::int AS completed_stages
     FROM meta.annotation_tracks track
     LEFT JOIN LATERAL (
       SELECT image_url, bbox
       FROM meta.image_annotations
       WHERE annotation_track_id = track.id AND annotation_type = 'label-bbox'
       ORDER BY revision DESC, updated_at DESC LIMIT 1
     ) annotation ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(DISTINCT stage) FILTER (WHERE status = 'reviewed') AS completed_stages
       FROM meta.wizard_stage_executions WHERE annotation_track_id = track.id
     ) execution ON TRUE
     WHERE track.source = $1 AND track.source_item_id = $2 AND track.status <> 'archived'
     ORDER BY track.ordinal, track.created_at`,
    [source, sourceItemId],
  );
  return result.rows.map(toDto);
}

export async function createAnnotationTrack(source: SourceName, sourceItemId: string, input: {
  name?: string;
  sourceAssetRef?: string;
  targetRegion?: Record<string, unknown>;
}): Promise<AnnotationTrack> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [source, sourceItemId]);
    const ordinalResult = await client.query(
      "SELECT COALESCE(max(ordinal), 0) + 1 AS ordinal FROM meta.annotation_tracks WHERE source = $1 AND source_item_id = $2",
      [source, sourceItemId],
    );
    const ordinal = Number(ordinalResult.rows[0]?.ordinal ?? 1);
    const id = randomUUID();
    const inserted = await client.query(
      `INSERT INTO meta.annotation_tracks
         (id, source, source_item_id, ordinal, name, source_asset_ref, target_region)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [id, source, sourceItemId, ordinal, input.name?.trim() || `Annotation ${ordinal}`,
        input.sourceAssetRef?.trim() || null, input.targetRegion ? JSON.stringify(input.targetRegion) : null],
    );
    await client.query("INSERT INTO meta.annotation_track_states (annotation_track_id) VALUES ($1)", [id]);
    await client.query(
      `INSERT INTO meta.annotation_packages
         (id, source, source_item_id, legacy_annotation_track_id, source_asset_ref, geometry, scope_geometry, scope_source, status)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $6::jsonb, $7, $8)
       ON CONFLICT (legacy_annotation_track_id) DO NOTHING`,
      [randomUUID(), source, sourceItemId, id, input.sourceAssetRef?.trim() || null,
        input.targetRegion ? JSON.stringify(input.targetRegion) : null, input.targetRegion ? "human" : "default-full-image", input.targetRegion ? "reviewed" : "draft"],
    );
    await client.query("COMMIT");
    return toDto({ ...inserted.rows[0], preview_image_url: null, preview_bbox: null, completed_stages: 0 });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function ensurePrimaryAnnotationTrack(source: SourceName, sourceItemId: string) {
  const id = await pool.query(
    `INSERT INTO meta.annotation_tracks (id, source, source_item_id, ordinal, name)
     VALUES ((
       substr(md5($1 || E'\\x1f' || $2), 1, 8) || '-' ||
       substr(md5($1 || E'\\x1f' || $2), 9, 4) || '-5' ||
       substr(md5($1 || E'\\x1f' || $2), 14, 3) || '-8' ||
       substr(md5($1 || E'\\x1f' || $2), 18, 3) || '-' ||
       substr(md5($1 || E'\\x1f' || $2), 21, 12)
     )::uuid, $1, $2, 1, 'Annotation 1')
     ON CONFLICT (source, source_item_id, ordinal) DO UPDATE SET updated_at = meta.annotation_tracks.updated_at
     RETURNING id`,
    [source, sourceItemId],
  );
  const trackId = String(id.rows[0].id);
  await pool.query("INSERT INTO meta.annotation_track_states (annotation_track_id) VALUES ($1) ON CONFLICT DO NOTHING", [trackId]);
  await pool.query(
    `INSERT INTO meta.annotation_packages
       (id, source, source_item_id, legacy_annotation_track_id, source_asset_ref, geometry, scope_geometry, scope_source, status)
     SELECT meta.deterministic_uuid('package:' || track.id::text), track.source, track.source_item_id,
            track.id, track.source_asset_ref, track.target_region, track.target_region,
            CASE WHEN track.target_region IS NULL THEN 'default-full-image' ELSE 'legacy-unclassified' END,
            CASE WHEN track.target_region IS NULL THEN 'draft' ELSE 'reviewed' END
     FROM meta.annotation_tracks track WHERE track.id = $1
     ON CONFLICT (legacy_annotation_track_id) DO NOTHING`,
    [trackId],
  );
  return trackId;
}

export async function requireAnnotationTrack(source: SourceName, sourceItemId: string, trackId: string) {
  const result = await pool.query(
    "SELECT * FROM meta.annotation_tracks WHERE id = $1 AND source = $2 AND source_item_id = $3 AND status <> 'archived'",
    [trackId, source, sourceItemId],
  );
  if (!result.rows[0]) throw new NotFoundError("Annotation track not found for this item");
  return result.rows[0];
}

export async function getAnnotationTrackState(source: SourceName, sourceItemId: string, trackId: string) {
  await requireAnnotationTrack(source, sourceItemId, trackId);
  const result = await pool.query(
    `SELECT state.visual_features, state.annotations, state.status, state.updated_at
     FROM meta.annotation_track_states state WHERE state.annotation_track_id = $1`,
    [trackId],
  );
  return result.rows[0] ?? { visual_features: {}, annotations: {}, status: "draft", updated_at: new Date() };
}

export async function patchAnnotationTrackState(source: SourceName, sourceItemId: string, trackId: string, patch: {
  visualFeatures?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  status?: string;
}) {
  await requireAnnotationTrack(source, sourceItemId, trackId);
  const result = await pool.query(
    `INSERT INTO meta.annotation_track_states (annotation_track_id, visual_features, annotations, status)
     VALUES ($1, COALESCE($2::jsonb, '{}'::jsonb), COALESCE($3::jsonb, '{}'::jsonb), COALESCE($4, 'draft'))
     ON CONFLICT (annotation_track_id) DO UPDATE SET
       visual_features = COALESCE($2::jsonb, meta.annotation_track_states.visual_features),
       annotations = COALESCE($3::jsonb, meta.annotation_track_states.annotations),
       status = COALESCE($4, meta.annotation_track_states.status), updated_at = now()
     RETURNING *`,
    [trackId, patch.visualFeatures ? JSON.stringify(patch.visualFeatures) : null,
      patch.annotations ? JSON.stringify(patch.annotations) : null, patch.status ?? null],
  );
  await pool.query(
    `UPDATE meta.annotation_tracks SET status = CASE
       WHEN $4 = 'reviewed' THEN 'reviewed'
       WHEN status = 'draft' THEN 'in-progress' ELSE status END, updated_at = now()
     WHERE id = $1 AND source = $2 AND source_item_id = $3`,
    [trackId, source, sourceItemId, patch.status ?? null],
  );
  return result.rows[0];
}

function toDto(row: Record<string, unknown>): AnnotationTrack {
  const ordinal = Number(row.ordinal);
  return {
    id: String(row.id), source: row.source as SourceName, sourceItemId: String(row.source_item_id), ordinal,
    name: String(row.name || `Annotation ${ordinal}`), sourceAssetRef: nullableString(row.source_asset_ref),
    targetRegion: objectValue(row.target_region), status: row.status as AnnotationTrack["status"],
    preview: { imageUrl: nullableString(row.preview_image_url), bbox: objectValue(row.preview_bbox) },
    completedStages: Number(row.completed_stages ?? 0), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at),
    executionActor: {
      type: nullableString(row.execution_actor_type) as AnnotationTrack["executionActor"]["type"],
      sources: Array.isArray(row.execution_actor_sources) ? row.execution_actor_sources.filter((value): value is string => typeof value === "string") : [],
    },
  };
}

function nullableString(value: unknown) { return typeof value === "string" && value ? value : null; }
function objectValue(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function dateValue(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
