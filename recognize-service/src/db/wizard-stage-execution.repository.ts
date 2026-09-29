import { createHash, randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import type { PoolClient } from "pg";
import type { SourceName } from "../shared/types.js";
import type { WizardStageId } from "../shared/helperConfigContract.js";
import { normalizeHelperIntermediateStates, type HelperIntermediateState } from "../shared/wizardRuntimeContract.js";

export type WizardStageExecution = {
  id: string;
  source: SourceName;
  sourceItemId: string;
  annotationTrackId: string;
  stage: WizardStageId;
  revision: number;
  helperId: string;
  algorithm: string;
  algorithmVersion: string | null;
  status: "started" | "reviewed" | "superseded";
  stageInput: Record<string, unknown> | null;
  defaultParams: Record<string, unknown> | null;
  initialParams: Record<string, unknown> | null;
  autoOutput: Record<string, unknown> | null;
  proposedOutput: Record<string, unknown> | null;
  proposalExecutor: "human" | "llm" | "local_ml" | "system" | null;
  proposalInteractionMode: "auto" | "manual" | "mixed" | null;
  proposalPlanId: string | null;
  proposalReview: Record<string, unknown> | null;
  finalParams: Record<string, unknown> | null;
  reviewedOutput: Record<string, unknown> | null;
  humanCorrection: Record<string, unknown>;
  helperRuns: WizardHelperRun[];
  selection: { runId: string; candidateId: string } | null;
  reviewMode: "accepted" | "corrected" | "manual" | null;
  startedAt: string;
  reviewedAt: string | null;
  updatedAt: string;
};

export type WizardHelperRun = {
  id: string;
  stageExecutionId: string;
  runIndex: number;
  config: Record<string, unknown>;
  candidates: unknown[];
  output: Record<string, unknown>;
  artifact: Record<string, unknown> | null;
  intermediateStates: HelperIntermediateState[];
  createdAt: string;
};

type StartInput = {
  source: SourceName;
  sourceItemId: string;
  annotationTrackId: string;
  stage: WizardStageId;
  helperId: string;
  algorithm: string;
  algorithmVersion?: string | null;
  stageInput?: Record<string, unknown> | null;
  defaultParams?: Record<string, unknown> | null;
  initialParams: Record<string, unknown>;
  autoOutput: Record<string, unknown>;
  candidates?: unknown[];
  artifact?: Record<string, unknown> | null;
  intermediateStates?: unknown;
};

type ReviewInput = Omit<StartInput, "initialParams" | "autoOutput"> & {
  finalParams: Record<string, unknown>;
  reviewedOutput: Record<string, unknown>;
  selection?: { runId?: string | null; candidateId?: string | null } | null;
  reviewMode?: "accepted" | "corrected" | "manual";
};

export async function getLatestWizardStageExecutions(source: SourceName, sourceItemId: string, annotationTrackId: string): Promise<WizardStageExecution[]> {
  const result = await pool.query(
    `SELECT DISTINCT ON (stage) *
     FROM meta.wizard_stage_executions
     WHERE source = $1 AND source_item_id = $2 AND annotation_track_id = $3 AND status <> 'superseded'
     ORDER BY stage, revision DESC`,
    [source, sourceItemId, annotationTrackId],
  );
  return hydrateRows(result.rows as Record<string, unknown>[]);
}

export async function startWizardStageExecution(input: StartInput): Promise<WizardStageExecution> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${input.annotationTrackId}:${input.stage}:execution`]);
    const active = await client.query(
      `SELECT * FROM meta.wizard_stage_executions
       WHERE annotation_track_id = $1 AND stage = $2 AND status = 'started'
       ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
      [input.annotationTrackId, input.stage],
    );
    if (active.rows[0] && sameExecutionIdentity(active.rows[0] as Record<string, unknown>, input)) {
      await ensureHelperRun(client, String(active.rows[0].id), input);
      await client.query("COMMIT");
      return hydrateRow(active.rows[0] as Record<string, unknown>);
    }
    if (active.rows[0]) await client.query(
      `UPDATE meta.wizard_stage_executions SET status = 'superseded', updated_at = now() WHERE id = $1`,
      [active.rows[0].id],
    );
    const latestReviewed = await client.query(
      `SELECT * FROM meta.wizard_stage_executions
       WHERE annotation_track_id = $1 AND stage = $2 AND status = 'reviewed'
       ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
      [input.annotationTrackId, input.stage],
    );
    if (latestReviewed.rows[0]) {
      const previous = mapRow(latestReviewed.rows[0] as Record<string, unknown>);
      const deterministicReplay = previous.helperId === input.helperId && previous.algorithm === input.algorithm
        && previous.algorithmVersion === (input.algorithmVersion ?? null)
        && stableJson(previous.stageInput) === stableJson(input.stageInput ?? null)
        && stableJson(previous.finalParams) === stableJson(input.initialParams)
        && (input.stage === "bottle" || stableJson(previous.reviewedOutput) === stableJson(input.autoOutput));
      if (deterministicReplay) {
        await client.query("COMMIT");
        return hydrateRow(latestReviewed.rows[0] as Record<string, unknown>);
      }
    }
    const revisionResult = await client.query(
      `SELECT COALESCE(MAX(revision), 0)::int + 1 AS revision
       FROM meta.wizard_stage_executions WHERE annotation_track_id = $1 AND stage = $2`,
      [input.annotationTrackId, input.stage],
    );
    const revision = Number(revisionResult.rows[0]?.revision ?? 1);
    const result = await client.query(
      `INSERT INTO meta.wizard_stage_executions (
         id, source, source_item_id, annotation_track_id, stage, revision, helper_id, algorithm, algorithm_version,
         status, stage_input, default_params, initial_params, auto_output
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'started',$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb)
       RETURNING *`,
      [randomUUID(), input.source, input.sourceItemId, input.annotationTrackId, input.stage, revision, input.helperId, input.algorithm,
       input.algorithmVersion ?? null, json(input.stageInput), json(input.defaultParams), JSON.stringify(input.initialParams), JSON.stringify(input.autoOutput)],
    );
    await ensureHelperRun(client, String(result.rows[0].id), input);
    await client.query("COMMIT");
    return hydrateRow(result.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reviewWizardStageExecution(input: ReviewInput): Promise<WizardStageExecution> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${input.annotationTrackId}:${input.stage}:execution`]);
    const requestedRunId = input.selection?.runId ?? null;
    const active = requestedRunId
      ? await client.query(
        `SELECT execution.* FROM meta.wizard_stage_executions execution
         JOIN meta.wizard_helper_runs run ON run.stage_execution_id = execution.id
         WHERE run.id = $1 AND execution.annotation_track_id = $2
           AND execution.stage = $3 AND execution.status = 'started'
         LIMIT 1 FOR UPDATE OF execution`,
        [requestedRunId, input.annotationTrackId, input.stage],
      )
      : await client.query(
        `SELECT * FROM meta.wizard_stage_executions
         WHERE annotation_track_id = $1 AND stage = $2 AND status = 'started'
         ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        [input.annotationTrackId, input.stage],
      );
    if (requestedRunId && !active.rows[0]) throw new Error(`Selected helper run ${requestedRunId} is not an active ${input.stage} execution`);
    const now = new Date().toISOString();
    if (active.rows[0] && (requestedRunId || sameExecutionIdentity(active.rows[0] as Record<string, unknown>, input))) {
      const current = await hydrateRow(active.rows[0] as Record<string, unknown>);
      const humanCorrection = correction(current.initialParams, input.finalParams, current.autoOutput, input.reviewedOutput, now);
      const selection = resolveSelection(current.helperRuns, input.finalParams, input.selection);
      if (input.selection?.candidateId && !selection) throw new Error(`Candidate ${input.selection.candidateId} does not belong to helper run ${requestedRunId ?? "<auto>"}`);
      const reviewMode = input.reviewMode ?? inferReviewMode(current.autoOutput, input.reviewedOutput, selection);
      const result = await client.query(
        `UPDATE meta.wizard_stage_executions SET
           status = 'reviewed', final_params = $2::jsonb, reviewed_output = $3::jsonb,
           human_correction = $4::jsonb, reviewed_at = $5, updated_at = $5,
           selected_run_id = $6, selected_candidate_id = $7, review_mode = $8
         WHERE id = $1 RETURNING *`,
        [current.id, JSON.stringify(input.finalParams), JSON.stringify(input.reviewedOutput), JSON.stringify(humanCorrection), now,
         selection?.runId ?? null, selection?.candidateId ?? null, reviewMode],
      );
      await client.query("COMMIT");
      return hydrateRow(result.rows[0] as Record<string, unknown>);
    }
    if (active.rows[0]) await client.query(
      `UPDATE meta.wizard_stage_executions SET status = 'superseded', updated_at = now() WHERE id = $1`,
      [active.rows[0].id],
    );
    const latestReviewed = await client.query(
      `SELECT * FROM meta.wizard_stage_executions
       WHERE annotation_track_id = $1 AND stage = $2 AND status = 'reviewed'
       ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
      [input.annotationTrackId, input.stage],
    );
    if (latestReviewed.rows[0]) {
      const previous = mapRow(latestReviewed.rows[0] as Record<string, unknown>);
      if (stableJson(previous.stageInput) === stableJson(input.stageInput ?? null)
        && stableJson(previous.finalParams) === stableJson(input.finalParams)
        && stableJson(previous.reviewedOutput) === stableJson(input.reviewedOutput)
        && stableJson(previous.selection) === stableJson(normalizeRequestedSelection(input.selection, previous.selection))
        && previous.reviewMode === (input.reviewMode ?? previous.reviewMode)) {
        await client.query("COMMIT");
        return hydrateRow(latestReviewed.rows[0] as Record<string, unknown>);
      }
    }
    const revisionResult = await client.query(
      `SELECT COALESCE(MAX(revision), 0)::int + 1 AS revision
       FROM meta.wizard_stage_executions WHERE annotation_track_id = $1 AND stage = $2`,
      [input.annotationTrackId, input.stage],
    );
    const result = await client.query(
      `INSERT INTO meta.wizard_stage_executions (
         id, source, source_item_id, annotation_track_id, stage, revision, helper_id, algorithm, algorithm_version, status,
         stage_input, default_params, final_params, reviewed_output, human_correction, reviewed_at, review_mode
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reviewed',$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16)
       RETURNING *`,
      [randomUUID(), input.source, input.sourceItemId, input.annotationTrackId, input.stage, Number(revisionResult.rows[0]?.revision ?? 1),
       input.helperId, input.algorithm, input.algorithmVersion ?? null, json(input.stageInput), json(input.defaultParams),
       JSON.stringify(input.finalParams), JSON.stringify(input.reviewedOutput),
       JSON.stringify(correction(null, input.finalParams, null, input.reviewedOutput, now)), now, input.reviewMode ?? "manual"],
    );
    await client.query("COMMIT");
    return hydrateRow(result.rows[0] as Record<string, unknown>);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function correction(initialParams: unknown, finalParams: unknown, autoOutput: unknown, reviewedOutput: unknown, reviewedAt: string) {
  const paramChanges = initialParams ? changedFields(initialParams, finalParams).map((field) => `execution.params.${field}`) : [];
  const outputChanges = autoOutput ? changedFields(autoOutput, reviewedOutput).map((field) => `execution.output.${field}`) : [];
  return {
    reviewed: true,
    paramsEdited: initialParams ? paramChanges.length > 0 : null,
    outputEdited: autoOutput ? outputChanges.length > 0 : null,
    changedFields: [...paramChanges, ...outputChanges],
    reviewedAt,
  };
}

function changedFields(left: unknown, right: unknown, prefix = ""): string[] {
  if (stableJson(left) === stableJson(right)) return [];
  if (!isObject(left) || !isObject(right)) return [prefix || "$value"];
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys.flatMap((key) => changedFields(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function mapRow(row: Record<string, unknown>): WizardStageExecution {
  const selectedRunId = nullableString(row.selected_run_id);
  const selectedCandidateId = nullableString(row.selected_candidate_id);
  return {
    id: String(row.id), source: String(row.source) as SourceName, sourceItemId: String(row.source_item_id), annotationTrackId: String(row.annotation_track_id),
    stage: String(row.stage) as WizardStageId, revision: Number(row.revision), helperId: String(row.helper_id),
    algorithm: String(row.algorithm), algorithmVersion: nullableString(row.algorithm_version), status: String(row.status) as WizardStageExecution["status"],
    stageInput: nullableObject(row.stage_input), defaultParams: nullableObject(row.default_params), initialParams: nullableObject(row.initial_params),
    autoOutput: nullableObject(row.auto_output), proposedOutput: nullableObject(row.proposed_output),
    proposalExecutor: proposalExecutor(row.proposal_executor), proposalInteractionMode: proposalInteractionMode(row.proposal_interaction_mode), proposalPlanId: nullableString(row.proposal_plan_id),
    proposalReview: nullableObject(row.proposal_review),
    finalParams: nullableObject(row.final_params), reviewedOutput: nullableObject(row.reviewed_output),
    humanCorrection: nullableObject(row.human_correction) ?? {},
    helperRuns: Array.isArray(row.helper_runs) ? row.helper_runs.map((value) => mapRun(value as Record<string, unknown>)) : [],
    selection: selectedRunId && selectedCandidateId ? { runId: selectedRunId, candidateId: selectedCandidateId } : null,
    reviewMode: reviewMode(row.review_mode),
    startedAt: dateString(row.started_at), reviewedAt: nullableDate(row.reviewed_at), updatedAt: dateString(row.updated_at),
  };
}

async function hydrateRows(rows: Record<string, unknown>[]) {
  return Promise.all(rows.map(hydrateRow));
}

async function hydrateRow(row: Record<string, unknown>): Promise<WizardStageExecution> {
  const result = await pool.query(
    `SELECT * FROM meta.wizard_helper_runs WHERE stage_execution_id = $1 ORDER BY run_index`,
    [row.id],
  );
  return mapRow({ ...row, helper_runs: result.rows });
}

async function ensureHelperRun(client: PoolClient, executionId: string, input: StartInput): Promise<void> {
  const configHash = hash(input.initialParams);
  const outputHash = hash(input.autoOutput);
  const intermediateStates = normalizeHelperIntermediateStates(input.intermediateStates ?? input.autoOutput.intermediateStates);
  const traceHash = hash(intermediateStates);
  const existing = await client.query(
    `SELECT id FROM meta.wizard_helper_runs
     WHERE stage_execution_id = $1 AND config_hash = $2 AND output_hash = $3 AND trace_hash = $4 LIMIT 1`,
    [executionId, configHash, outputHash, traceHash],
  );
  if (existing.rowCount) return;
  const next = await client.query(
    `SELECT COALESCE(MAX(run_index), 0)::int + 1 AS run_index
     FROM meta.wizard_helper_runs WHERE stage_execution_id = $1`,
    [executionId],
  );
  await client.query(
    `INSERT INTO meta.wizard_helper_runs (
       id, stage_execution_id, run_index, config, candidates, output, artifact, intermediate_states, config_hash, output_hash, trace_hash
     ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)`,
    [randomUUID(), executionId, Number(next.rows[0]?.run_index ?? 1), JSON.stringify(input.initialParams),
     JSON.stringify(input.candidates ?? extractCandidates(input.autoOutput)), JSON.stringify(input.autoOutput),
     json(input.artifact), JSON.stringify(intermediateStates), configHash, outputHash, traceHash],
  );
}

function resolveSelection(
  runs: WizardHelperRun[],
  finalParams: Record<string, unknown>,
  requested?: ReviewInput["selection"],
): WizardStageExecution["selection"] {
  if (requested === null) return null;
  const candidateId = requested?.candidateId ?? null;
  if (!candidateId) return null;
  const run = requested?.runId
    ? runs.find((item) => item.id === requested.runId && runContainsCandidate(item, candidateId))
    : [...runs].reverse().find((item) => runContainsCandidate(item, candidateId))
      ?? [...runs].reverse().find((item) => stableJson(item.config) === stableJson(finalParams));
  return run ? { runId: run.id, candidateId } : null;
}

function runContainsCandidate(run: WizardHelperRun, candidateId: string) {
  return run.candidates.some((candidate) => {
    const value = nullableObject(candidate);
    return nullableString(value?.candidateId) === candidateId || nullableString(value?.id) === candidateId;
  });
}

function normalizeRequestedSelection(requested: ReviewInput["selection"], fallback: WizardStageExecution["selection"]) {
  if (requested === undefined) return fallback;
  if (requested === null || !requested.candidateId) return null;
  if (!requested.runId) return fallback?.candidateId === requested.candidateId ? fallback : null;
  return { runId: requested.runId, candidateId: requested.candidateId };
}

function inferReviewMode(
  autoOutput: Record<string, unknown> | null,
  reviewedOutput: Record<string, unknown>,
  selection: WizardStageExecution["selection"],
): WizardStageExecution["reviewMode"] {
  if (!autoOutput) return "manual";
  if (selection || stableJson(autoOutput) === stableJson(reviewedOutput)) return stableJson(autoOutput) === stableJson(reviewedOutput) ? "accepted" : "corrected";
  return "corrected";
}

function sameExecutionIdentity(row: Record<string, unknown>, input: Pick<StartInput, "helperId" | "algorithm" | "algorithmVersion" | "stageInput">) {
  return String(row.helper_id) === input.helperId
    && String(row.algorithm) === input.algorithm
    && nullableString(row.algorithm_version) === (input.algorithmVersion ?? null)
    && stableJson(nullableObject(row.stage_input)) === stableJson(input.stageInput ?? null);
}

function extractCandidates(output: Record<string, unknown>): unknown[] {
  for (const key of ["candidates", "regions", "components", "elements", "contours", "palette", "catalogCandidates"]) {
    if (Array.isArray(output[key])) return output[key] as unknown[];
  }
  const prediction = nullableObject(output.prediction);
  return prediction ? [prediction] : [];
}

function mapRun(row: Record<string, unknown>): WizardHelperRun {
  return {
    id: String(row.id), stageExecutionId: String(row.stage_execution_id), runIndex: Number(row.run_index),
    config: nullableObject(row.config) ?? {}, candidates: Array.isArray(row.candidates) ? row.candidates : [],
    output: nullableObject(row.output) ?? {}, artifact: nullableObject(row.artifact),
    intermediateStates: normalizeHelperIntermediateStates(row.intermediate_states), createdAt: dateString(row.created_at),
  };
}

function hash(value: unknown) { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function reviewMode(value: unknown): WizardStageExecution["reviewMode"] {
  return value === "accepted" || value === "corrected" || value === "manual" ? value : null;
}
function proposalExecutor(value: unknown): WizardStageExecution["proposalExecutor"] {
  return value === "human" || value === "llm" || value === "local_ml" || value === "system" ? value : null;
}
function proposalInteractionMode(value: unknown): WizardStageExecution["proposalInteractionMode"] {
  return value === "auto" || value === "manual" || value === "mixed" ? value : null;
}

function json(value: unknown) { return value == null ? null : JSON.stringify(value); }
function nullableObject(value: unknown) { return isObject(value) ? value : null; }
function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function nullableString(value: unknown) { return typeof value === "string" ? value : null; }
function dateString(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function nullableDate(value: unknown) { return value == null ? null : dateString(value); }
