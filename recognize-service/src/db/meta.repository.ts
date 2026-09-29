import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import type { MetadataPayload, RecognizeJobType, SourceName } from "../shared/types.js";
import { ConflictError } from "../shared/errors.js";
import { recordMetadataRevision } from "./card-version.repository.js";

export type MetaItemRow = {
  id: string;
  source: SourceName;
  source_item_id: string;
  aliases: string[];
  normalized_tokens: string[];
  visual_features: Record<string, unknown>;
  annotations: Record<string, unknown>;
  status: string;
  generation_version: string | null;
  source_hash: string | null;
  updated_at: Date;
};

export async function listMetadata(params: {
  source?: SourceName;
  status?: string;
  search?: string;
  page: number;
  limit: number;
}) {
  const offset = (params.page - 1) * params.limit;
  const values: unknown[] = [];
  const where: string[] = [];

  if (params.source) {
    values.push(params.source);
    where.push(`m.source = $${values.length}`);
  }
  if (params.status) {
    values.push(params.status);
    where.push(`m.status = $${values.length}`);
  }
  if (params.search) {
    values.push(`%${params.search}%`);
    where.push(`
      (
        m.source_item_id ILIKE $${values.length}
        OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(m.aliases) AS alias(value)
          WHERE alias.value ILIKE $${values.length}
        )
      )
    `);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const count = await pool.query(`SELECT COUNT(*)::int AS total FROM meta.items AS m ${whereSql}`, values);
  values.push(params.limit, offset);
  const rows = await pool.query(
    `
    SELECT *
    FROM meta.items AS m
    ${whereSql}
    ORDER BY m.updated_at DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values,
  );

  return { rows: rows.rows.map(rowToMetaItem), total: Number(count.rows[0]?.total ?? 0) };
}

export async function getMetadata(source: SourceName, sourceItemId: string): Promise<MetaItemRow | null> {
  const result = await pool.query(
    `SELECT * FROM meta.items WHERE source = $1 AND source_item_id = $2`,
    [source, sourceItemId],
  );
  return result.rows[0] ? rowToMetaItem(result.rows[0]) : null;
}

export async function upsertGeneratedMetadata(input: {
  source: SourceName;
  sourceItemId: string;
  metadata: MetadataPayload;
  overwrite: boolean;
  sourceHash: string;
}) {
  const existing = await getMetadata(input.source, input.sourceItemId);
  if (existing && existing.status === "reviewed" && !input.overwrite) return existing;
  if (existing && !input.overwrite) return existing;

  const result = await pool.query(
    `
    INSERT INTO meta.items (
      id, source, source_item_id, aliases, normalized_tokens,
      visual_features, annotations, status, generation_version,
      source_hash, generated_at
    )
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, 'recognize-v1', $9, now())
    ON CONFLICT (source, source_item_id)
    DO UPDATE SET
      aliases = EXCLUDED.aliases,
      normalized_tokens = EXCLUDED.normalized_tokens,
      visual_features = EXCLUDED.visual_features,
      annotations = CASE
        WHEN meta.items.status = 'reviewed' AND $10 = false THEN meta.items.annotations
        ELSE EXCLUDED.annotations
      END,
      status = CASE
        WHEN meta.items.status = 'reviewed' AND $10 = false THEN meta.items.status
        ELSE EXCLUDED.status
      END,
      generation_version = EXCLUDED.generation_version,
      source_hash = EXCLUDED.source_hash,
      generated_at = now(),
      updated_at = now()
    RETURNING *
    `,
    [
      randomUUID(),
      input.source,
      input.sourceItemId,
      JSON.stringify(input.metadata.aliases),
      JSON.stringify(input.metadata.normalizedTokens),
      JSON.stringify(input.metadata.visualFeatures),
      JSON.stringify(input.metadata.annotations),
      input.metadata.status,
      input.sourceHash,
      input.overwrite,
    ],
  );
  await recordMetadataRevision(result.rows[0], input.overwrite ? "auto-force" : "auto");
  return rowToMetaItem(result.rows[0]);
}

export async function upsertGeneratedMetadataPatch(input: {
  source: SourceName;
  sourceItemId: string;
  metadata: Partial<MetadataPayload>;
  overwrite: boolean;
  sourceHash: string;
}) {
  const current = await getMetadata(input.source, input.sourceItemId);
  if (current && current.status === "reviewed" && !input.overwrite) return current;

  const result = await pool.query(
    `
    INSERT INTO meta.items (
      id, source, source_item_id, aliases, normalized_tokens,
      visual_features, annotations, status, generation_version,
      source_hash, generated_at
    )
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, 'recognize-v1', $9, now())
    ON CONFLICT (source, source_item_id)
    DO UPDATE SET
      aliases = EXCLUDED.aliases,
      normalized_tokens = EXCLUDED.normalized_tokens,
      visual_features = EXCLUDED.visual_features,
      annotations = meta.items.annotations || EXCLUDED.annotations,
      status = EXCLUDED.status,
      generation_version = EXCLUDED.generation_version,
      source_hash = EXCLUDED.source_hash,
      generated_at = now(),
      updated_at = now()
    RETURNING *
    `,
    [
      current?.id ?? randomUUID(),
      input.source,
      input.sourceItemId,
      JSON.stringify(input.metadata.aliases ?? current?.aliases ?? []),
      JSON.stringify(input.metadata.normalizedTokens ?? current?.normalized_tokens ?? []),
      JSON.stringify(input.metadata.visualFeatures ?? current?.visual_features ?? {}),
      JSON.stringify(input.metadata.annotations ?? {}),
      input.metadata.status ?? current?.status ?? "generated",
      input.sourceHash,
    ],
  );
  await recordMetadataRevision(result.rows[0], input.overwrite ? "auto-force" : "auto-patch");
  return rowToMetaItem(result.rows[0]);
}

export async function patchMetadata(source: SourceName, sourceItemId: string, patch: Partial<MetadataPayload>) {
  const current = await getMetadata(source, sourceItemId);
  const result = await pool.query(
    `
    INSERT INTO meta.items (
      id, source, source_item_id, aliases, normalized_tokens,
      visual_features, annotations, status, manually_edited_at
    )
    VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, now())
    ON CONFLICT (source, source_item_id)
    DO UPDATE SET
      aliases = EXCLUDED.aliases,
      normalized_tokens = EXCLUDED.normalized_tokens,
      visual_features = EXCLUDED.visual_features,
      annotations = EXCLUDED.annotations,
      status = EXCLUDED.status,
      manually_edited_at = now(),
      updated_at = now()
    RETURNING *
    `,
    [
      current?.id ?? randomUUID(),
      source,
      sourceItemId,
      JSON.stringify(patch.aliases ?? current?.aliases ?? []),
      JSON.stringify(patch.normalizedTokens ?? current?.normalized_tokens ?? []),
      JSON.stringify(patch.visualFeatures ?? current?.visual_features ?? {}),
      JSON.stringify(patch.annotations ?? current?.annotations ?? {}),
      patch.status ?? current?.status ?? "reviewed",
    ],
  );
  await recordMetadataRevision(result.rows[0], "human-edit");
  return rowToMetaItem(result.rows[0]);
}

export async function getManualAnnotations(source: SourceName, sourceItemId: string) {
  const current = await getMetadata(source, sourceItemId);
  return normalizeObject(current?.visual_features.manualAnnotations);
}

export async function putManualAnnotations(source: SourceName, sourceItemId: string, annotations: Record<string, unknown>) {
  const current = await getMetadata(source, sourceItemId);
  const visualFeatures = {
    ...(current?.visual_features ?? {}),
    manualAnnotations: {
      ...annotations,
      updatedAt: new Date().toISOString(),
    },
  };
  const metadata = await patchMetadata(source, sourceItemId, {
    aliases: current?.aliases ?? [],
    normalizedTokens: current?.normalized_tokens ?? [],
    annotations: current?.annotations ?? {},
    visualFeatures,
    status: current?.status ?? "reviewed",
  });
  return normalizeObject(metadata.visual_features.manualAnnotations);
}

export async function deleteManualAnnotations(source: SourceName, sourceItemId: string) {
  const current = await getMetadata(source, sourceItemId);
  if (!current) return {};
  const { manualAnnotations: _manualAnnotations, ...visualFeatures } = current.visual_features;
  await patchMetadata(source, sourceItemId, {
    aliases: current.aliases,
    normalizedTokens: current.normalized_tokens,
    annotations: current.annotations,
    visualFeatures,
    status: current.status,
  });
  return {};
}

export async function createGenerationJob(input: { source?: SourceName; mode: string; totalItems?: number }) {
  const id = randomUUID();
  await pool.query(
    `
    INSERT INTO meta.generation_jobs (id, source, mode, status, total_items)
    VALUES ($1, $2, $3, 'queued', $4)
    `,
    [id, input.source ?? null, input.mode, input.totalItems ?? 0],
  );
  return { id, status: "queued" };
}

export async function createRecognizeJob(input: {
  type: RecognizeJobType;
  source: SourceName;
  sourceItemId: string;
  annotationTrackId?: string;
  annotationVersionId?: string;
  options: Record<string, unknown>;
  target?: Record<string, unknown>;
  pipelineVersion: string;
  parentJobId?: string;
  status?: string;
  idempotencyKey?: string;
  sourceHash?: string;
}) {
  const id = randomUUID();
  const result = await pool.query(
    `
    INSERT INTO meta.generation_jobs (
      id, source, source_item_id, annotation_track_id, annotation_version_id, parent_job_id, mode, job_type, status,
      target, options, pipeline_version, total_items, idempotency_key, source_hash
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $7, $8,
      $9::jsonb, $10::jsonb, $11, 1, $12, $13
    )
    ON CONFLICT (idempotency_key)
    WHERE idempotency_key IS NOT NULL
      AND deleted_at IS NULL
      AND status IN ('queued', 'running', 'completed')
    DO UPDATE SET id = meta.generation_jobs.id
    RETURNING id, status
    `,
    [
      id,
      input.source,
      input.sourceItemId,
      input.annotationTrackId ?? null,
      input.annotationVersionId ?? null,
      input.parentJobId ?? null,
      input.type,
      input.status ?? "queued",
      JSON.stringify(input.target ?? { source: input.source, sourceItemId: input.sourceItemId }),
      JSON.stringify(input.options),
      input.pipelineVersion,
      input.idempotencyKey ?? null,
      input.sourceHash ?? null,
    ],
  );
  return {
    id: String(result.rows[0].id),
    status: String(result.rows[0].status),
    reused: String(result.rows[0].id) !== id,
  };
}

export async function listGenerationJobsForSourceItem(input: {
  source: SourceName;
  sourceItemId: string;
  limit: number;
  annotationTrackId?: string;
  jobType?: RecognizeJobType;
  offset?: number;
}) {
  const rows = await pool.query(
    `
    SELECT *
    FROM meta.generation_jobs
    WHERE source = $1
      AND source_item_id = $2
      AND deleted_at IS NULL
      AND ($4::uuid IS NULL OR annotation_track_id = $4)
      AND ($5::text IS NULL OR job_type = $5)
      AND job_type IS NOT NULL
    ORDER BY created_at DESC
    LIMIT $3 OFFSET $6
    `,
    [input.source, input.sourceItemId, input.limit, input.annotationTrackId ?? null, input.jobType ?? null, input.offset ?? 0],
  );
  return rows.rows;
}

export async function createBatchRecognizeJob(input: {
  type: RecognizeJobType;
  source?: SourceName;
  target: Record<string, unknown>;
  options: Record<string, unknown>;
  pipelineVersion: string;
  totalItems: number;
}) {
  const id = randomUUID();
  await pool.query(
    `
    INSERT INTO meta.generation_jobs (
      id, source, mode, job_type, status, target, options,
      pipeline_version, total_items
    )
    VALUES ($1, $2, $3, $3, 'queued', $4::jsonb, $5::jsonb, $6, $7)
    `,
    [
      id,
      input.source ?? null,
      input.type,
      JSON.stringify(input.target),
      JSON.stringify(input.options),
      input.pipelineVersion,
      input.totalItems,
    ],
  );
  return { id, status: "queued" };
}

export async function countActiveJobsForSource(input: {
  source: SourceName;
  type: RecognizeJobType;
  pipelineVersion: string;
}) {
  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM meta.generation_jobs
    WHERE source = $1
      AND deleted_at IS NULL
      AND job_type = $2
      AND pipeline_version = $3
      AND source_item_id IS NOT NULL
      AND status IN ('queued', 'running', 'completed')
    `,
    [input.source, input.type, input.pipelineVersion],
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function listChildJobs(parentJobId: string, params: { status?: string; limit: number; offset: number }) {
  const values: unknown[] = [parentJobId];
  const where = ["parent_job_id = $1", "deleted_at IS NULL"];
  if (params.status) {
    values.push(params.status);
    where.push(`status = $${values.length}`);
  }
  const count = await pool.query(
    `SELECT COUNT(*)::int AS total FROM meta.generation_jobs WHERE ${where.join(" AND ")}`,
    values,
  );
  values.push(params.limit, params.offset);
  const rows = await pool.query(
    `
    SELECT *
    FROM meta.generation_jobs
    WHERE ${where.join(" AND ")}
    ORDER BY created_at ASC
    LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values,
  );
  return { rows: rows.rows, total: Number(count.rows[0]?.total ?? 0) };
}

export async function summarizeChildJobs(parentJobId: string) {
  const result = await pool.query(
    `
    SELECT status, COUNT(*)::int AS count
    FROM meta.generation_jobs
    WHERE parent_job_id = $1 AND deleted_at IS NULL
    GROUP BY status
    UNION ALL
    SELECT 'blocked_by_review' AS status, COUNT(*)::int AS count
    FROM meta.generation_jobs
    WHERE parent_job_id = $1 AND deleted_at IS NULL AND result->>'status' = 'blocked_by_review'
    `,
    [parentJobId],
  );
  return Object.fromEntries(result.rows.map((row) => [String(row.status), Number(row.count)]));
}

export async function summarizeChildJobsForParents(parentJobIds: string[]) {
  if (parentJobIds.length === 0) return new Map<string, Record<string, number>>();
  const result = await pool.query(
    `
    SELECT parent_job_id, status, COUNT(*)::int AS count
    FROM meta.generation_jobs
    WHERE parent_job_id = ANY($1::uuid[]) AND deleted_at IS NULL
    GROUP BY parent_job_id, status
    UNION ALL
    SELECT parent_job_id, 'blocked_by_review' AS status, COUNT(*)::int AS count
    FROM meta.generation_jobs
    WHERE parent_job_id = ANY($1::uuid[]) AND deleted_at IS NULL AND result->>'status' = 'blocked_by_review'
    GROUP BY parent_job_id
    `,
    [parentJobIds],
  );
  const summaries = new Map<string, Record<string, number>>();
  for (const row of result.rows) {
    const parentJobId = String(row.parent_job_id);
    const summary = summaries.get(parentJobId) ?? {};
    summary[String(row.status)] = Number(row.count);
    summaries.set(parentJobId, summary);
  }
  return summaries;
}

export async function markJobCancelRequested(jobId: string) {
  await pool.query(
    `UPDATE meta.generation_jobs SET cancel_requested = TRUE, status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
       worker_id=CASE WHEN status='queued' THEN NULL ELSE worker_id END,
       lease_token=CASE WHEN status='queued' THEN NULL ELSE lease_token END,
       heartbeat_at=CASE WHEN status='queued' THEN NULL ELSE heartbeat_at END,
       lease_expires_at=CASE WHEN status='queued' THEN NULL ELSE lease_expires_at END
     WHERE id = $1`,
    [jobId],
  );
  await pool.query(
    `UPDATE meta.generation_jobs SET cancel_requested = TRUE, status = 'cancelled',
       worker_id=NULL,lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL,completed_at=now()
     WHERE parent_job_id = $1 AND status = 'queued'`,
    [jobId],
  );
}

export async function resetFailedChildren(parentJobId: string) {
  const result = await pool.query(
    `
    UPDATE meta.generation_jobs
    SET status = 'queued',
        error = NULL,
        result = '{}'::jsonb,
        attempt = attempt + 1,
        started_at = NULL,
        completed_at = NULL,
        worker_id = NULL,
        lease_token = NULL,
        heartbeat_at = NULL,
        lease_expires_at = NULL,
        recovery_count = 0
    WHERE parent_job_id = $1
      AND status = 'failed'
    RETURNING id
    `,
    [parentJobId],
  );
  return result.rows.map((row) => String(row.id));
}

export async function isGenerationJobCancellationRequested(jobId: string) {
  const result = await pool.query(
    `
    SELECT COALESCE(job.cancel_requested, FALSE)
        OR COALESCE(parent.cancel_requested, FALSE) AS requested
    FROM meta.generation_jobs job
    LEFT JOIN meta.generation_jobs parent ON parent.id = job.parent_job_id
    WHERE job.id = $1 AND job.deleted_at IS NULL
    `,
    [jobId],
  );
  return result.rows[0]?.requested === true;
}

export async function softDeleteGenerationJob(jobId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `
      SELECT id, parent_job_id, status
      FROM meta.generation_jobs
      WHERE deleted_at IS NULL AND (id = $1 OR parent_job_id = $1)
      FOR UPDATE
      `,
      [jobId],
    );
    const job = selected.rows.find((row) => String(row.id) === jobId) ?? null;
    if (!job) {
      await client.query("ROLLBACK");
      return null;
    }
    const active = selected.rows.find((row) => !["completed", "failed", "completed_with_errors", "cancelled"].includes(String(row.status)));
    if (active) throw new ConflictError("Active recognize job cannot be deleted; cancel it first");
    const deleted = await client.query(
      `
      UPDATE meta.generation_jobs
      SET deleted_at = now()
      WHERE deleted_at IS NULL AND (id = $1 OR parent_job_id = $1)
      RETURNING id
      `,
      [jobId],
    );
    await client.query("COMMIT");
    return {
      jobId: String(job.id),
      parentJobId: job.parent_job_id ? String(job.parent_job_id) : null,
      status: String(job.status),
      deleted: deleted.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const OPERATIONAL_METADATA_DELETE_TABLES = [
  // Canonical annotation graph must be removed before its legacy track binding.
  // Packages cascade to Labels/OCR; operations cascade to candidates/reviews/results;
  // tracks cascade to track state, helper runs and track-scoped legacy revisions.
  "annotation_meta",
  "annotation_operations",
  "annotation_packages",
  "annotation_tracks",
  "wizard_stage_executions",
  "alias_annotation_sets",
  "catalog_identity_reviews",
  "ocr_source_association_sets",
  "ocr_region_annotation_sets",
  "ocr_text_annotations",
  "label_analysis_reviews",
  "ocr_runs",
  "label_crops",
  "image_annotations",
  "detection_proposals",
  "generation_jobs",
  "items",
] as const;

export async function deleteOperationalMetadataItems(items: Array<{ source: SourceName; sourceItemId: string }>) {
  const uniqueItems = [...new Map(items.map((item) => [`${item.source}:${item.sourceItemId}`, item])).values()];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const item of uniqueItems) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${item.source}:${item.sourceItemId}:metadata-delete`]);
    }
    const sources = uniqueItems.map((item) => item.source);
    const sourceItemIds = uniqueItems.map((item) => item.sourceItemId);
    const activeJobs = await client.query(
      `SELECT id, source, source_item_id, status
       FROM meta.generation_jobs
       WHERE (source, source_item_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))
         AND status IN ('queued', 'running')
       FOR UPDATE`,
      [sources, sourceItemIds],
    );
    if (activeJobs.rowCount) {
      const sample = activeJobs.rows.slice(0, 3).map((row) => `${row.source}:${row.source_item_id} (${row.status})`).join(", ");
      throw new ConflictError(`Cannot delete metadata while recognition jobs are active: ${sample}`);
    }

    const deleted: Record<string, number> = {};
    for (const table of OPERATIONAL_METADATA_DELETE_TABLES) {
      const result = await client.query(
        `DELETE FROM meta.${table}
         WHERE (source, source_item_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
        [sources, sourceItemIds],
      );
      deleted[table] = result.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return { requested: uniqueItems.length, deleted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function resetFailedSingleJob(jobId: string) {
  const result = await pool.query(
    `
    UPDATE meta.generation_jobs
    SET status = 'queued',
        error = NULL,
        result = '{}'::jsonb,
        attempt = attempt + 1,
        cancel_requested = FALSE,
        started_at = NULL,
        completed_at = NULL,
        worker_id = NULL,
        lease_token = NULL,
        heartbeat_at = NULL,
        lease_expires_at = NULL,
        recovery_count = 0
    WHERE id = $1
      AND parent_job_id IS NULL
      AND source_item_id IS NOT NULL
      AND status = 'failed'
    RETURNING id
    `,
    [jobId],
  );
  return result.rowCount === 1;
}

export async function requeueRecognizeJob(jobId: string, input: {
  annotationTrackId?: string | null;
  annotationVersionId?: string | null;
  options?: Record<string, unknown>;
}) {
  const result = await pool.query(
    `UPDATE meta.generation_jobs
     SET status='queued', error=NULL, result='{}'::jsonb, attempt=attempt+1,
       cancel_requested=FALSE, processed_items=0, failed_items=0,
       started_at=NULL, completed_at=NULL,
       annotation_track_id=COALESCE($2,annotation_track_id),
       annotation_version_id=COALESCE($3,annotation_version_id),
       options=COALESCE($4::jsonb,options),
       worker_id=NULL,lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL,recovery_count=0
     WHERE id=$1 AND deleted_at IS NULL
       AND status IN ('completed','failed','completed_with_errors','cancelled')
     RETURNING id,status,attempt`,
    [jobId, input.annotationTrackId ?? null, input.annotationVersionId ?? null,
      input.options ? JSON.stringify(input.options) : null],
  );
  return result.rows[0] ?? null;
}

export async function bindRecognizeJobAnnotationVersion(jobId: string, annotationVersionId: string, annotationTrackId: string) {
  await pool.query(
    `UPDATE meta.generation_jobs
     SET annotation_version_id=$2,
         annotation_track_id=$3,
         options=jsonb_set(jsonb_set(options, '{annotationVersionId}', to_jsonb($2::text), true), '{annotationTrackId}', to_jsonb($3::text), true)
     WHERE id=$1 AND deleted_at IS NULL`,
    [jobId, annotationVersionId, annotationTrackId],
  );
}

export async function reopenParentJobForRetry(parentJobId: string) {
  await pool.query(
    `UPDATE meta.generation_jobs SET status='running',error=NULL,cancel_requested=FALSE,completed_at=NULL
     WHERE id=$1 AND deleted_at IS NULL`,
    [parentJobId],
  );
}

export async function updateGenerationJob(
  id: string,
  patch: Partial<{
    status: string;
    totalItems: number;
    processedItems: number;
    failedItems: number;
    error: string | null;
    result: Record<string, unknown>;
  }>,
) {
  await pool.query(
    `
    UPDATE meta.generation_jobs
    SET
      status = COALESCE($2, status),
      total_items = COALESCE($3, total_items),
      processed_items = COALESCE($4, processed_items),
      failed_items = COALESCE($5, failed_items),
      error = CASE WHEN $8 THEN $6 ELSE error END,
      result = COALESCE($7::jsonb, result),
      worker_id = CASE WHEN $2 IN ('completed', 'failed', 'completed_with_errors', 'cancelled') THEN NULL ELSE worker_id END,
      lease_token = CASE WHEN $2 IN ('completed', 'failed', 'completed_with_errors', 'cancelled') THEN NULL ELSE lease_token END,
      heartbeat_at = CASE WHEN $2 IN ('completed', 'failed', 'completed_with_errors', 'cancelled') THEN NULL ELSE heartbeat_at END,
      lease_expires_at = CASE WHEN $2 IN ('completed', 'failed', 'completed_with_errors', 'cancelled') THEN NULL ELSE lease_expires_at END,
      started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
      completed_at = CASE WHEN $2 IN ('completed', 'failed', 'completed_with_errors', 'cancelled') THEN now() WHEN $2 IN ('queued', 'running') THEN NULL ELSE completed_at END
    WHERE id = $1
    `,
    [
      id,
      patch.status,
      patch.totalItems,
      patch.processedItems,
      patch.failedItems,
      patch.error,
      patch.result ? JSON.stringify(patch.result) : null,
      patch.error !== undefined,
    ],
  );
}

export async function getGenerationJob(id: string) {
  const result = await pool.query(`SELECT * FROM meta.generation_jobs WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return result.rows[0] ?? null;
}

export async function listGenerationJobs(params: {
  status?: string;
  type?: RecognizeJobType;
  scope?: "batch-parent" | "batch-child" | "single-item";
  source?: SourceName;
  limit: number;
  offset: number;
}) {
  const values: unknown[] = [];
  const where = ["job_type IS NOT NULL", "deleted_at IS NULL"];
  if (params.status) {
    values.push(params.status);
    where.push(`status = $${values.length}`);
  }
  if (params.type) {
    values.push(params.type);
    where.push(`job_type = $${values.length}`);
  }
  if (params.source) {
    values.push(params.source);
    where.push(`source = $${values.length}`);
  }
  if (params.scope === "batch-parent") where.push("parent_job_id IS NULL AND source_item_id IS NULL");
  if (params.scope === "batch-child") where.push("parent_job_id IS NOT NULL");
  if (params.scope === "single-item") where.push("parent_job_id IS NULL AND source_item_id IS NOT NULL");
  const count = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM meta.generation_jobs
    WHERE ${where.join(" AND ")}
    `,
    values,
  );
  values.push(params.limit, params.offset);
  const rows = await pool.query(
    `
    SELECT *
    FROM meta.generation_jobs
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values,
  );
  return { rows: rows.rows, total: Number(count.rows[0]?.total ?? 0) };
}

export async function claimQueuedRecognizeJobs(limit: number, workerId: string, leaseToken: string, leaseMs: number) {
  const result = await pool.query(
    `
    WITH claimed AS (
      SELECT id
      FROM meta.generation_jobs
      WHERE status = 'queued'
        AND deleted_at IS NULL
        AND job_type IS NOT NULL
        AND source_item_id IS NOT NULL
        AND cancel_requested = FALSE
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    UPDATE meta.generation_jobs AS j
    SET status = 'running',
        started_at = COALESCE(j.started_at, now()),
        worker_id = $2,
        lease_token = $3::uuid,
        heartbeat_at = now(),
        lease_expires_at = now() + ($4::bigint * interval '1 millisecond')
    FROM claimed
    WHERE j.id = claimed.id
    RETURNING j.*
    `,
    [limit, workerId, leaseToken, leaseMs],
  );
  return result.rows;
}

export async function heartbeatRecognizeJob(jobId: string, workerId: string, leaseToken: string, leaseMs: number) {
  const result = await pool.query(
    `UPDATE meta.generation_jobs
     SET heartbeat_at=now(),lease_expires_at=now()+($4::bigint * interval '1 millisecond')
     WHERE id=$1 AND worker_id=$2 AND lease_token=$3::uuid AND status='running' AND deleted_at IS NULL
     RETURNING id`,
    [jobId, workerId, leaseToken, leaseMs],
  );
  return result.rowCount === 1;
}

export async function recoverExpiredRecognizeJobs(maxRecoveries = 3) {
  const result = await pool.query(
    `UPDATE meta.generation_jobs AS job
     SET status=CASE
           WHEN job.cancel_requested OR COALESCE((SELECT parent.cancel_requested FROM meta.generation_jobs parent WHERE parent.id=job.parent_job_id),FALSE)
             THEN 'cancelled'
           WHEN job.recovery_count+1 >= $1 THEN 'failed'
           ELSE 'queued'
         END,
         cancel_requested=CASE
           WHEN job.cancel_requested OR COALESCE((SELECT parent.cancel_requested FROM meta.generation_jobs parent WHERE parent.id=job.parent_job_id),FALSE)
             THEN TRUE
           ELSE FALSE
         END,
         attempt=COALESCE(job.attempt,0)+1,
         recovery_count=job.recovery_count+1,
         error=CASE WHEN job.recovery_count+1 >= $1 THEN 'Worker lease expired repeatedly' ELSE NULL END,
         result=CASE
           WHEN job.cancel_requested OR COALESCE((SELECT parent.cancel_requested FROM meta.generation_jobs parent WHERE parent.id=job.parent_job_id),FALSE)
             THEN jsonb_build_object('status','cancelled','stopReason','lease_expired_after_cancel')
           WHEN job.recovery_count+1 >= $1
             THEN jsonb_build_object('status','failed','failure',jsonb_build_object('kind','worker_lease','message','Worker lease expired repeatedly'))
           ELSE '{}'::jsonb
         END,
         worker_id=NULL,lease_token=NULL,heartbeat_at=NULL,lease_expires_at=NULL,
         started_at=NULL,
         completed_at=CASE
           WHEN job.cancel_requested
             OR COALESCE((SELECT parent.cancel_requested FROM meta.generation_jobs parent WHERE parent.id=job.parent_job_id),FALSE)
             OR job.recovery_count+1 >= $1
             THEN now()
           ELSE NULL
         END
     WHERE job.status='running'
       AND job.source_item_id IS NOT NULL
       AND job.deleted_at IS NULL
       AND job.lease_expires_at IS NOT NULL
       AND job.lease_expires_at < now()
     RETURNING job.id,job.status,job.annotation_version_id,job.parent_job_id,job.recovery_count`,
    [maxRecoveries],
  );
  return result.rows.map((row) => ({
    jobId: String(row.id),
    status: String(row.status) as "queued" | "cancelled" | "failed",
    annotationVersionId: nullableString(row.annotation_version_id),
    parentJobId: nullableString(row.parent_job_id),
    recoveryCount: Number(row.recovery_count),
  }));
}

export async function recoverInterruptedRecognizeJobs() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recovered = await client.query(
      `UPDATE meta.generation_jobs AS job
       SET status=CASE
             WHEN job.cancel_requested OR COALESCE((SELECT parent.cancel_requested FROM meta.generation_jobs parent WHERE parent.id=job.parent_job_id),FALSE)
               THEN 'cancelled'
             ELSE 'queued'
           END,
           cancel_requested=CASE
             WHEN job.cancel_requested OR COALESCE((SELECT parent.cancel_requested FROM meta.generation_jobs parent WHERE parent.id=job.parent_job_id),FALSE)
               THEN TRUE
             ELSE FALSE
           END,
           attempt=CASE
             WHEN job.cancel_requested OR COALESCE((SELECT parent.cancel_requested FROM meta.generation_jobs parent WHERE parent.id=job.parent_job_id),FALSE)
               THEN job.attempt
             ELSE COALESCE(job.attempt,0)+1
           END,
           error=NULL,
           result=CASE
             WHEN job.cancel_requested OR COALESCE((SELECT parent.cancel_requested FROM meta.generation_jobs parent WHERE parent.id=job.parent_job_id),FALSE)
               THEN jsonb_build_object('status','cancelled','stopReason','worker_restarted_after_cancel')
             ELSE '{}'::jsonb
           END,
           started_at=NULL,
           worker_id=NULL,
           lease_token=NULL,
           heartbeat_at=NULL,
           lease_expires_at=NULL,
           completed_at=CASE
             WHEN job.cancel_requested OR COALESCE((SELECT parent.cancel_requested FROM meta.generation_jobs parent WHERE parent.id=job.parent_job_id),FALSE)
               THEN now()
             ELSE NULL
           END
       WHERE job.status='running'
         AND job.source_item_id IS NOT NULL
         AND job.deleted_at IS NULL
         AND job.lease_expires_at IS NULL
       RETURNING job.id,job.status,job.annotation_version_id,job.parent_job_id`,
    );
    const parents = await client.query(
      `SELECT id FROM meta.generation_jobs
       WHERE status='running' AND source_item_id IS NULL AND deleted_at IS NULL`,
    );
    await client.query("COMMIT");
    return {
      jobs: recovered.rows.map((row) => ({
        jobId: String(row.id),
        status: String(row.status) as "queued" | "cancelled",
        annotationVersionId: nullableString(row.annotation_version_id),
        parentJobId: nullableString(row.parent_job_id),
      })),
      parentJobIds: parents.rows.map((row) => String(row.id)),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function findRecognitionCandidates(tokens: string[], limit: number) {
  const result = await pool.query(
    `
    SELECT source, source_item_id, aliases, normalized_tokens
    FROM meta.items
    WHERE status IN ('generated', 'reviewed')
    ORDER BY updated_at DESC
    LIMIT 5000
    `,
  );
  const querySet = new Set(tokens.map(normalizeToken).filter(Boolean));
  return result.rows
    .map((row) => {
      const candidateTokens = [...normalizeArray(row.aliases), ...normalizeArray(row.normalized_tokens)].map(normalizeToken);
      const candidateSet = new Set(candidateTokens.filter(Boolean));
      const overlap = [...querySet].filter((token) => candidateSet.has(token)).length;
      const score = querySet.size ? overlap / querySet.size : 0;
      return { source: row.source, sourceItemId: row.source_item_id, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function rowToMetaItem(row: Record<string, unknown>): MetaItemRow {
  return {
    id: String(row.id),
    source: row.source as SourceName,
    source_item_id: String(row.source_item_id),
    aliases: normalizeArray(row.aliases),
    normalized_tokens: normalizeArray(row.normalized_tokens),
    visual_features: normalizeObject(row.visual_features),
    annotations: normalizeObject(row.annotations),
    status: String(row.status),
    generation_version: nullableString(row.generation_version),
    source_hash: nullableString(row.source_hash),
    updated_at: row.updated_at as Date,
  };
}

function normalizeArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeToken(value: string) {
  return value.trim().toLocaleLowerCase("ru");
}
