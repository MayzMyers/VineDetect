import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import type { SourceName } from "../shared/types.js";
import type { WizardStageId } from "../shared/helperConfigContract.js";

export type LlmSessionStatus = "created" | "active" | "blocked" | "completed" | "failed" | "cancelled";
export type LlmStageRunStatus = "queued" | "running" | "completed" | "human_required" | "failed" | "cancelled";

export type LlmSession = {
  id: string; source: SourceName; sourceItemId: string; annotationTrackId: string;
  provider: string; providerConversationId: string | null;
  model: string; modelSnapshot: string | null; adapterVersion: string; promptVersion: string; wizardDefinitionVersion: string;
  status: LlmSessionStatus; globalContext: Record<string, unknown>;
  currentStage: WizardStageId | null; contextEvents: unknown[];
  startedAt: string; completedAt: string | null; updatedAt: string;
  stageRuns: LlmStageRun[];
};

export type LlmStageRun = {
  id: string; sessionId: string; stage: WizardStageId; labelId: string | null;
  status: LlmStageRunStatus; iterationCount: number; inputArtifactIds: string[];
  inputContextSnapshot: Record<string, unknown>;
  decisions: unknown[]; correctionPlanId: string | null; error: string | null;
  providerResponseId: string | null; providerRequestId: string | null;
  transportError: Record<string, unknown>;
  usage: Record<string, unknown>; latencyMs: number | null;
  startedAt: string; finishedAt: string | null;
};

export async function createOrGetActiveLlmSession(input: {
  source: SourceName; sourceItemId: string; annotationTrackId: string;
  model: string; promptVersion: string; wizardDefinitionVersion: string;
  provider?: string; modelSnapshot?: string; adapterVersion?: string;
  globalContext: Record<string, unknown>;
}) {
  const existing = await getActiveLlmSession(input.annotationTrackId);
  if (existing) return { session: existing, reused: true };
  const result = await pool.query(
    `INSERT INTO meta.llm_sessions (
       id, source, source_item_id, annotation_track_id, provider, model, model_snapshot, adapter_version,
       prompt_version, wizard_definition_version, global_context, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'active')
     ON CONFLICT (annotation_track_id) WHERE status IN ('created','active','blocked') DO NOTHING
     RETURNING *`,
    [randomUUID(), input.source, input.sourceItemId, input.annotationTrackId, input.provider ?? "qwen", input.model,
      input.modelSnapshot ?? null, input.adapterVersion ?? "vision-stage-adapter-v7", input.promptVersion,
      input.wizardDefinitionVersion, JSON.stringify(input.globalContext)],
  );
  if (!result.rows[0]) return { session: (await getActiveLlmSession(input.annotationTrackId))!, reused: true };
  return { session: { ...mapSession(result.rows[0] as Record<string, unknown>), stageRuns: [] }, reused: false };
}

export async function getActiveLlmSession(annotationTrackId: string) {
  const result = await pool.query(
    `SELECT * FROM meta.llm_sessions WHERE annotation_track_id = $1 AND status IN ('created','active','blocked') ORDER BY started_at DESC LIMIT 1`,
    [annotationTrackId],
  );
  if (!result.rows[0]) return null;
  return hydrateSession(result.rows[0] as Record<string, unknown>);
}

export async function getLlmSession(id: string) {
  const result = await pool.query(`SELECT * FROM meta.llm_sessions WHERE id = $1`, [id]);
  if (!result.rows[0]) return null;
  return hydrateSession(result.rows[0] as Record<string, unknown>);
}

export async function attachLlmProviderConversation(input: {
  sessionId: string; provider: string; conversationId: string; model?: string;
}) {
  const result = await pool.query(
    `UPDATE meta.llm_sessions SET provider=$2, provider_conversation_id=COALESCE(provider_conversation_id,$3),
       model=COALESCE($4,model), status=CASE WHEN status='created' THEN 'active' ELSE status END, updated_at=now()
     WHERE id=$1 AND status IN ('created','active','blocked')
       AND (provider_conversation_id IS NULL OR provider_conversation_id=$3)
     RETURNING *`,
    [input.sessionId, input.provider, input.conversationId, input.model ?? null],
  );
  return result.rows[0] ? hydrateSession(result.rows[0] as Record<string, unknown>) : null;
}

export async function closeLlmSession(id: string, status: "completed" | "failed" | "cancelled") {
  const result = await pool.query(
    `UPDATE meta.llm_sessions SET status=$2, completed_at=now(), updated_at=now()
     WHERE id=$1 AND status IN ('created','active','blocked') RETURNING *`, [id, status],
  );
  return result.rows[0] ? { ...mapSession(result.rows[0] as Record<string, unknown>), stageRuns: (await hydrateSession(result.rows[0] as Record<string, unknown>)).stageRuns } : null;
}

export async function createLlmStageRun(
  sessionId: string, stage: WizardStageId, labelId: string | null,
  inputArtifactIds: string[] = [], inputContextSnapshot: Record<string, unknown> = {},
) {
  const result = await pool.query(
    `INSERT INTO meta.llm_stage_runs (id, session_id, stage, label_id, input_artifact_ids, input_context_snapshot)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING *`,
    [randomUUID(), sessionId, stage, labelId, JSON.stringify(inputArtifactIds), JSON.stringify(inputContextSnapshot)],
  );
  return mapStageRun(result.rows[0] as Record<string, unknown>);
}

export async function finishLlmStageRun(input: {
  id: string; status: Exclude<LlmStageRunStatus, "queued" | "running">;
  decisions: unknown[]; correctionPlanId?: string | null; error?: string | null;
  stageContext?: Record<string, unknown>;
  inputArtifactIds?: string[];
  controllerModel?: string;
  providerConversationId?: string | null;
  providerResponseId?: string | null;
  providerRequestId?: string | null;
  usage?: Record<string, unknown>;
  latencyMs?: number | null;
  transportError?: Record<string, unknown> | null;
  contextEvent?: Record<string, unknown>;
}) {
  const result = await pool.query(
    `UPDATE meta.llm_stage_runs SET status=$2, iteration_count=$3, decisions=$4::jsonb,
       correction_plan_id=$5, error=$6, input_artifact_ids=COALESCE($7::jsonb,input_artifact_ids),
       provider_response_id=$8, provider_request_id=$9, usage=$10::jsonb, latency_ms=$11,
       transport_error=$12::jsonb, finished_at=now()
     WHERE id=$1 RETURNING *`,
    [input.id, input.status, input.decisions.length, JSON.stringify(input.decisions), input.correctionPlanId ?? null, input.error ?? null,
      input.inputArtifactIds ? JSON.stringify(input.inputArtifactIds) : null, input.providerResponseId ?? null,
      input.providerRequestId ?? null, JSON.stringify(input.usage ?? {}), input.latencyMs ?? null,
      JSON.stringify(input.transportError ?? {})],
  );
  if (input.stageContext || input.controllerModel || input.providerConversationId || input.contextEvent || input.status === "human_required" || input.status === "failed") await pool.query(
    `UPDATE meta.llm_sessions SET global_context = CASE WHEN $2::jsonb IS NULL THEN global_context ELSE jsonb_set(global_context, '{stageContexts}',
       COALESCE(global_context->'stageContexts','{}'::jsonb) || $2::jsonb, true) END,
       model=COALESCE($3,model), provider_conversation_id=COALESCE($4,provider_conversation_id),
       context_events=CASE WHEN $5::jsonb IS NULL THEN context_events ELSE context_events || jsonb_build_array($5::jsonb) END,
       current_stage=(SELECT stage FROM meta.llm_stage_runs WHERE id=$1),
       status=CASE WHEN $6='failed' THEN 'failed' WHEN $6='human_required' THEN 'blocked' WHEN status='blocked' AND $6='completed' THEN 'active' ELSE status END,
       completed_at=CASE WHEN $6='failed' THEN now() ELSE completed_at END,
       updated_at=now()
     WHERE id=(SELECT session_id FROM meta.llm_stage_runs WHERE id=$1)`,
    [input.id, input.stageContext ? JSON.stringify(input.stageContext) : null, input.controllerModel ?? null,
      input.providerConversationId ?? null, input.contextEvent ? JSON.stringify(input.contextEvent) : null, input.status],
  );
  return result.rows[0] ? mapStageRun(result.rows[0] as Record<string, unknown>) : null;
}

export async function recordAppliedLlmPlanContext(planId: string, result: Record<string, unknown>, options: { keepSessionBlocked?: boolean } = {}) {
  const runResult = await pool.query(
    `SELECT run.id, run.stage, run.label_id, run.session_id
     FROM meta.llm_stage_runs run
     WHERE run.correction_plan_id=$1
     ORDER BY run.started_at DESC LIMIT 1`,
    [planId],
  );
  const run = runResult.rows[0] as Record<string, unknown> | undefined;
  if (!run) return false;
  const stage = String(run.stage);
  const labelId = run.label_id ? String(run.label_id) : null;
  const key = labelId ? `${stage}:${labelId}` : stage;
  const now = new Date().toISOString();
  const context = { stage, labelId, status: options.keepSessionBlocked ? "blocked_multipackage" : "applied", resultId: planId, summary: compactPlanResult(result), updatedAt: now };
  const event = { type: options.keepSessionBlocked ? "pipeline_blocked" : "stage_completed", stage, labelId, resultId: planId, ...(options.keepSessionBlocked ? { reason: "multipackage" } : {}), at: now };
  await pool.query(
    `UPDATE meta.llm_sessions SET
       global_context=jsonb_set(global_context, '{stageContexts}',
         COALESCE(global_context->'stageContexts','{}'::jsonb) || jsonb_build_object($2,$3::jsonb), true),
       context_events=context_events || jsonb_build_array($4::jsonb),
       current_stage=$5,
       status=CASE WHEN $6 THEN 'blocked' WHEN status='blocked' THEN 'active' ELSE status END,
       updated_at=now()
     WHERE id=$1`,
    [String(run.session_id), key, JSON.stringify(context), JSON.stringify(event), stage, options.keepSessionBlocked === true],
  );
  return true;
}

async function hydrateSession(row: Record<string, unknown>) {
  const runs = await pool.query(`SELECT * FROM meta.llm_stage_runs WHERE session_id=$1 ORDER BY started_at ASC`, [row.id]);
  return { ...mapSession(row), stageRuns: runs.rows.map((item) => mapStageRun(item as Record<string, unknown>)) };
}

function mapSession(row: Record<string, unknown>): Omit<LlmSession, "stageRuns"> {
  return {
    id: String(row.id), source: String(row.source) as SourceName, sourceItemId: String(row.source_item_id), annotationTrackId: String(row.annotation_track_id),
    provider: String(row.provider ?? "qwen"), providerConversationId: row.provider_conversation_id ? String(row.provider_conversation_id) : null,
    model: String(row.model), modelSnapshot: row.model_snapshot ? String(row.model_snapshot) : null,
    adapterVersion: String(row.adapter_version ?? "vision-stage-adapter-v7"), promptVersion: String(row.prompt_version), wizardDefinitionVersion: String(row.wizard_definition_version),
    status: String(row.status) as LlmSessionStatus, globalContext: object(row.global_context), startedAt: date(row.started_at),
    currentStage: row.current_stage ? String(row.current_stage) as WizardStageId : null,
    contextEvents: Array.isArray(row.context_events) ? row.context_events : [],
    completedAt: row.completed_at ? date(row.completed_at) : null, updatedAt: date(row.updated_at),
  };
}

function mapStageRun(row: Record<string, unknown>): LlmStageRun {
  return {
    id: String(row.id), sessionId: String(row.session_id), stage: String(row.stage) as WizardStageId,
    labelId: row.label_id ? String(row.label_id) : null, status: String(row.status) as LlmStageRunStatus,
    iterationCount: Number(row.iteration_count ?? 0), inputArtifactIds: strings(row.input_artifact_ids),
    inputContextSnapshot: object(row.input_context_snapshot),
    decisions: Array.isArray(row.decisions) ? row.decisions : [], correctionPlanId: row.correction_plan_id ? String(row.correction_plan_id) : null,
    providerResponseId: row.provider_response_id ? String(row.provider_response_id) : null,
    providerRequestId: row.provider_request_id ? String(row.provider_request_id) : null,
    transportError: object(row.transport_error),
    usage: object(row.usage), latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    error: row.error ? String(row.error) : null, startedAt: date(row.started_at), finishedAt: row.finished_at ? date(row.finished_at) : null,
  };
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function compactPlanResult(value: Record<string, unknown>) {
  return {
    applied: Number(value.applied ?? 0), failures: Number(value.failures ?? 0),
    operations: (Array.isArray(value.operations) ? value.operations : []).slice(0, 20).map((raw) => {
      const item = object(raw);
      return { operationId: item.operationId ?? null, stage: item.stage ?? null, command: item.command ?? null, status: item.status ?? null };
    }),
  };
}
function strings(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function date(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
