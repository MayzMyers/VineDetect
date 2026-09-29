import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./pool.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";

export const TRAINING_TASKS = ["label-roi", "physical-label-roi", "ocr-region", "source-matching", "alias-ranking", "bottle-outline", "label-elements", "label-palette"] as const;
export type TrainingTask = (typeof TRAINING_TASKS)[number];
export type TrainingStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export async function registerDatasetArtifact(input: {
  datasetVersionId: string;
  outputPath: string;
  annotationsSha256: string;
  manifest: Record<string, unknown>;
}) {
  const id = randomUUID();
  const result = await pool.query(
    `INSERT INTO meta.dataset_artifacts
       (id, dataset_version_id, output_path, annotations_sha256, manifest)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [id, input.datasetVersionId, input.outputPath, input.annotationsSha256, JSON.stringify(input.manifest)],
  );
  return mapArtifact(result.rows[0]);
}

export async function getDatasetArtifact(artifactId: string) {
  const result = await pool.query(`SELECT * FROM meta.dataset_artifacts WHERE id = $1`, [artifactId]);
  if (!result.rowCount) throw new NotFoundError("Dataset artifact not found");
  return mapArtifact(result.rows[0]);
}

export async function listTrainingRuns() {
  const result = await pool.query(`
    SELECT r.*, a.dataset_version_id, a.output_path AS dataset_artifact_path,
      a.annotations_sha256 AS dataset_artifact_sha256,
      COALESCE((SELECT json_agg(to_jsonb(e) ORDER BY e.created_at DESC) FROM meta.evaluation_results e WHERE e.training_run_id = r.id), '[]'::json) AS evaluations,
      COALESCE((SELECT json_agg(to_jsonb(m) ORDER BY m.created_at DESC) FROM meta.model_versions m WHERE m.training_run_id = r.id), '[]'::json) AS models
    FROM meta.training_runs r
    JOIN meta.dataset_artifacts a ON a.id = r.dataset_artifact_id
    ORDER BY r.created_at DESC
  `);
  return result.rows.map(mapRun);
}

export async function createTrainingRun(input: {
  datasetArtifactId: string;
  task: TrainingTask;
  name: string;
  framework: string;
  runtime?: string;
  configSnapshot: Record<string, unknown>;
  codeVersion?: string;
  createdBy?: string;
}) {
  const artifact = await pool.query(`SELECT id FROM meta.dataset_artifacts WHERE id = $1`, [input.datasetArtifactId]);
  if (!artifact.rowCount) throw new NotFoundError("Dataset artifact not found");
  const result = await pool.query(
    `INSERT INTO meta.training_runs
       (id, dataset_artifact_id, task, name, framework, runtime, config_snapshot, code_version, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [randomUUID(), input.datasetArtifactId, input.task, input.name, input.framework, input.runtime ?? null,
      JSON.stringify(input.configSnapshot), input.codeVersion ?? null, input.createdBy ?? null],
  );
  return getTrainingRun(String(result.rows[0].id));
}

export async function updateTrainingRunStatus(runId: string, input: { status: TrainingStatus; errorMessage?: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(`SELECT * FROM meta.training_runs WHERE id = $1 FOR UPDATE`, [runId]);
    if (!current.rowCount) throw new NotFoundError("Training run not found");
    const previous = String(current.rows[0].status) as TrainingStatus;
    if (!allowedRunTransition(previous, input.status)) throw new ConflictError(`Training run cannot transition from ${previous} to ${input.status}`);
    if (input.status === "failed" && !input.errorMessage) throw new ConflictError("Failed training run requires an error message");
    await client.query(
      `UPDATE meta.training_runs SET status = $2, error_message = $3, updated_at = now(),
         started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, now()) ELSE started_at END,
         completed_at = CASE WHEN $2 IN ('completed', 'failed', 'cancelled') THEN now() ELSE completed_at END
       WHERE id = $1`,
      [runId, input.status, input.status === "failed" ? input.errorMessage : null],
    );
    await client.query("COMMIT");
    return getTrainingRun(runId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function addEvaluation(runId: string, input: { modelVersionId?: string; split: "train" | "validation" | "test"; metrics: Record<string, number>; sampleCount: number }) {
  const run = await pool.query(`SELECT status FROM meta.training_runs WHERE id = $1`, [runId]);
  if (!run.rowCount) throw new NotFoundError("Training run not found");
  if (run.rows[0].status !== "completed") throw new ConflictError("Evaluations can only be registered for completed training runs");
  if (input.modelVersionId) {
    const model = await pool.query(`SELECT id FROM meta.model_versions WHERE id = $1 AND training_run_id = $2`, [input.modelVersionId, runId]);
    if (!model.rowCount) throw new ConflictError("Model version does not belong to the training run");
  }
  const result = await pool.query(
    `INSERT INTO meta.evaluation_results (id, training_run_id, model_version_id, split, metrics, sample_count)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [randomUUID(), runId, input.modelVersionId ?? null, input.split, JSON.stringify(input.metrics), input.sampleCount],
  );
  return mapEvaluation(result.rows[0]);
}

export async function createModelVersion(runId: string, input: { name: string; artifactPath: string; artifactSha256: string; runtime?: string; metadata: Record<string, unknown> }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await client.query(`SELECT * FROM meta.training_runs WHERE id = $1 FOR UPDATE`, [runId]);
    if (!run.rowCount) throw new NotFoundError("Training run not found");
    if (run.rows[0].status !== "completed") throw new ConflictError("Model versions can only be registered for completed training runs");
    const next = await client.query(`SELECT COALESCE(MAX(version), 0)::int + 1 AS version FROM meta.model_versions WHERE task = $1 AND name = $2`, [run.rows[0].task, input.name]);
    const result = await client.query(
      `INSERT INTO meta.model_versions (id, training_run_id, task, name, version, artifact_path, artifact_sha256, runtime, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [randomUUID(), runId, run.rows[0].task, input.name, Number(next.rows[0].version), input.artifactPath, input.artifactSha256, input.runtime ?? null, JSON.stringify(input.metadata)],
    );
    await client.query("COMMIT");
    return mapModel(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateModelStatus(modelId: string, status: "validated" | "promoted" | "deprecated") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`SELECT * FROM meta.model_versions WHERE id = $1 FOR UPDATE`, [modelId]);
    if (!result.rowCount) throw new NotFoundError("Model version not found");
    const current = String(result.rows[0].status);
    const allowed = current === "candidate" ? ["validated", "deprecated"] : current === "validated" ? ["promoted", "deprecated"] : current === "promoted" ? ["deprecated"] : [];
    if (!allowed.includes(status)) throw new ConflictError(`Model version cannot transition from ${current} to ${status}`);
    if (status === "validated" || status === "promoted") await requireValidationEvaluation(client, modelId);
    if (status === "promoted") {
      await client.query(`UPDATE meta.model_versions SET status = 'deprecated' WHERE task = $1 AND status = 'promoted' AND id <> $2`, [result.rows[0].task, modelId]);
    }
    const updated = await client.query(
      `UPDATE meta.model_versions SET status = $2, promoted_at = CASE WHEN $2 = 'promoted' THEN now() ELSE promoted_at END WHERE id = $1 RETURNING *`,
      [modelId, status],
    );
    await client.query("COMMIT");
    return mapModel(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getTrainingRun(runId: string) {
  const runs = await pool.query(`
    SELECT r.*, a.dataset_version_id, a.output_path AS dataset_artifact_path, a.annotations_sha256 AS dataset_artifact_sha256,
      '[]'::json AS evaluations, '[]'::json AS models
    FROM meta.training_runs r JOIN meta.dataset_artifacts a ON a.id = r.dataset_artifact_id WHERE r.id = $1`, [runId]);
  if (!runs.rowCount) throw new NotFoundError("Training run not found");
  return mapRun(runs.rows[0]);
}

async function requireValidationEvaluation(client: PoolClient, modelId: string) {
  const evaluation = await client.query(`SELECT id FROM meta.evaluation_results WHERE model_version_id = $1 AND split = 'validation' LIMIT 1`, [modelId]);
  if (!evaluation.rowCount) throw new ConflictError("A validation evaluation is required before validating or promoting a model");
}

function allowedRunTransition(from: TrainingStatus, to: TrainingStatus) {
  if (from === to) return false;
  if (from === "queued") return to === "running" || to === "cancelled";
  if (from === "running") return to === "completed" || to === "failed" || to === "cancelled";
  return false;
}

function mapArtifact(row: Record<string, unknown>) {
  return { id: String(row.id), datasetVersionId: String(row.dataset_version_id), artifactType: String(row.artifact_type), outputPath: String(row.output_path), annotationsSha256: String(row.annotations_sha256), manifest: objectValue(row.manifest), createdAt: dateString(row.created_at) };
}
function mapRun(row: Record<string, unknown>) {
  return { id: String(row.id), datasetArtifactId: String(row.dataset_artifact_id), datasetVersionId: String(row.dataset_version_id), datasetArtifactPath: String(row.dataset_artifact_path), datasetArtifactSha256: String(row.dataset_artifact_sha256), task: String(row.task), name: String(row.name), status: String(row.status), framework: String(row.framework), runtime: nullableString(row.runtime), configSnapshot: objectValue(row.config_snapshot), codeVersion: nullableString(row.code_version), createdBy: nullableString(row.created_by), errorMessage: nullableString(row.error_message), createdAt: dateString(row.created_at), updatedAt: dateString(row.updated_at), startedAt: nullableDate(row.started_at), completedAt: nullableDate(row.completed_at), evaluations: arrayValue(row.evaluations).map(mapEvaluation), models: arrayValue(row.models).map(mapModel) };
}
function mapEvaluation(row: Record<string, unknown>) {
  return { id: String(row.id), trainingRunId: String(row.training_run_id), modelVersionId: nullableString(row.model_version_id), split: String(row.split), metrics: objectValue(row.metrics), sampleCount: Number(row.sample_count), createdAt: dateString(row.created_at) };
}
function mapModel(row: Record<string, unknown>) {
  return { id: String(row.id), trainingRunId: String(row.training_run_id), task: String(row.task), name: String(row.name), version: Number(row.version), status: String(row.status), artifactPath: String(row.artifact_path), artifactSha256: String(row.artifact_sha256), runtime: nullableString(row.runtime), metadata: objectValue(row.metadata), createdAt: dateString(row.created_at), promotedAt: nullableDate(row.promoted_at) };
}
function arrayValue(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value as Record<string, unknown>[] : []; }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function nullableString(value: unknown) { return value === null || value === undefined ? null : String(value); }
function dateString(value: unknown) { return value instanceof Date ? value.toISOString() : String(value ?? ""); }
function nullableDate(value: unknown) { return value === null || value === undefined ? null : dateString(value); }
