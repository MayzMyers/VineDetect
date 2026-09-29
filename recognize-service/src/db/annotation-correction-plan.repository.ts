import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import type { SourceName } from "../shared/types.js";

export type CorrectionPlanExecutor = "human" | "llm" | "local_ml" | "system";
export type CorrectionPlanInteractionMode = "auto" | "manual" | "mixed";
export type LlmDecisionMode = "accepted_helper" | "modified_helper" | "manual_created";
export type LlmReviewVerdict = "llm_correct" | "llm_false_accept" | "llm_false_correction" | "llm_partially_correct";
export type StageProposalReview = {
  reviewedBy: "human" | "llm" | "local_ml";
  reviewerSubject?: string;
  finalEditor: "helper" | "llm" | "human" | "local_ml";
  verdict: LlmReviewVerdict;
  reviewedAt: string;
};
export type CorrectionPlanStatus = "validated" | "applying" | "applied" | "partially_applied" | "failed";

export type AnnotationCorrectionPlan = {
  id: string;
  source: SourceName;
  sourceItemId: string;
  annotationTrackId: string;
  executor: CorrectionPlanExecutor;
  interactionMode: CorrectionPlanInteractionMode;
  llmDecision: { mode: LlmDecisionMode; executor: "llm" } | null;
  controller: Record<string, unknown>;
  proposedOutput: Record<string, unknown>;
  operations: unknown[];
  continueOnError: boolean;
  validation: Record<string, unknown>;
  status: CorrectionPlanStatus;
  result: Record<string, unknown> | null;
  createdAt: string;
  appliedAt: string | null;
};

export async function createAnnotationCorrectionPlan(input: Omit<AnnotationCorrectionPlan, "id" | "status" | "result" | "createdAt" | "appliedAt" | "llmDecision">) {
  const result = await pool.query(
    `INSERT INTO meta.annotation_correction_plans (
       id, source, source_item_id, annotation_track_id, executor, interaction_mode, controller, proposed_output, operations, continue_on_error, validation, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11::jsonb,'validated') RETURNING *`,
    [randomUUID(), input.source, input.sourceItemId, input.annotationTrackId, input.executor, input.interactionMode, JSON.stringify(input.controller),
     JSON.stringify(input.proposedOutput), JSON.stringify(input.operations), input.continueOnError, JSON.stringify(input.validation)],
  );
  return mapPlan(result.rows[0] as Record<string, unknown>);
}

export async function getAnnotationCorrectionPlan(id: string) {
  const result = await pool.query(`SELECT * FROM meta.annotation_correction_plans WHERE id = $1`, [id]);
  return result.rows[0] ? mapPlan(result.rows[0] as Record<string, unknown>) : null;
}

export async function setAnnotationCorrectionPlanResult(id: string, status: CorrectionPlanStatus, resultValue: Record<string, unknown> | null) {
  const result = await pool.query(
    `UPDATE meta.annotation_correction_plans SET status = $2, result = $3::jsonb,
       applied_at = CASE WHEN $2 IN ('applied','partially_applied','failed') THEN now() ELSE applied_at END
     WHERE id = $1 RETURNING *`,
    [id, status, resultValue ? JSON.stringify(resultValue) : null],
  );
  return result.rows[0] ? mapPlan(result.rows[0] as Record<string, unknown>) : null;
}

export async function claimAnnotationCorrectionPlan(id: string) {
  const result = await pool.query(
    `UPDATE meta.annotation_correction_plans SET status = 'applying'
     WHERE id = $1 AND status = 'validated' RETURNING *`,
    [id],
  );
  return result.rows[0] ? mapPlan(result.rows[0] as Record<string, unknown>) : null;
}

export async function attachStageProposedOutput(annotationTrackId: string, stage: string, planId: string, executor: CorrectionPlanExecutor, interactionMode: CorrectionPlanInteractionMode, proposedOutput: Record<string, unknown>) {
  await pool.query(
    `UPDATE meta.wizard_stage_executions SET proposed_output = $4::jsonb, proposal_executor = $5, proposal_plan_id = $3, proposal_interaction_mode = $6, updated_at = now()
     WHERE id = (
       SELECT id FROM meta.wizard_stage_executions
       WHERE annotation_track_id = $1 AND stage = $2 AND status <> 'superseded'
       ORDER BY revision DESC LIMIT 1
     )`,
    [annotationTrackId, stage, planId, JSON.stringify(proposedOutput), executor, interactionMode],
  );
}

export async function attachStageProposalReview(input: {
  annotationTrackId: string;
  stage: string;
  planId: string;
  interactionMode: CorrectionPlanInteractionMode;
  proposedOutput: Record<string, unknown>;
  review: StageProposalReview;
}) {
  const result = await pool.query(
    `UPDATE meta.wizard_stage_executions SET
       proposed_output = $4::jsonb,
       proposal_executor = 'llm',
       proposal_plan_id = $3,
       proposal_interaction_mode = $5,
       proposal_review = $6::jsonb,
       updated_at = now()
     WHERE id = (
       SELECT id FROM meta.wizard_stage_executions
       WHERE annotation_track_id = $1 AND stage = $2 AND status = 'reviewed'
       ORDER BY revision DESC LIMIT 1
     )
     RETURNING id`,
    [input.annotationTrackId, input.stage, input.planId, JSON.stringify(input.proposedOutput), input.interactionMode, JSON.stringify(input.review)],
  );
  return Boolean(result.rowCount);
}

function mapPlan(row: Record<string, unknown>): AnnotationCorrectionPlan {
  return {
    id: String(row.id), source: String(row.source) as SourceName, sourceItemId: String(row.source_item_id), annotationTrackId: String(row.annotation_track_id),
    executor: String(row.executor) as CorrectionPlanExecutor, interactionMode: interactionMode(row.interaction_mode),
    llmDecision: String(row.executor) === "llm" ? { mode: llmDecisionMode(interactionMode(row.interaction_mode)), executor: "llm" } : null,
    controller: object(row.controller), proposedOutput: object(row.proposed_output),
    operations: Array.isArray(row.operations) ? row.operations : [], continueOnError: row.continue_on_error === true,
    validation: object(row.validation), status: String(row.status) as CorrectionPlanStatus,
    result: row.result ? object(row.result) : null, createdAt: date(row.created_at), appliedAt: row.applied_at ? date(row.applied_at) : null,
  };
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function interactionMode(value: unknown): CorrectionPlanInteractionMode { return value === "manual" || value === "mixed" ? value : "auto"; }
export function llmDecisionMode(value: CorrectionPlanInteractionMode): LlmDecisionMode {
  return value === "manual" ? "manual_created" : value === "mixed" ? "modified_helper" : "accepted_helper";
}
function date(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
