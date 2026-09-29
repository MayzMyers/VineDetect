import {
  attachStageProposedOutput,
  attachStageProposalReview,
  claimAnnotationCorrectionPlan,
  createAnnotationCorrectionPlan,
  getAnnotationCorrectionPlan,
  setAnnotationCorrectionPlanResult,
  type CorrectionPlanExecutor,
  llmDecisionMode,
} from "../../db/annotation-correction-plan.repository.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import type { SourceName } from "../../shared/types.js";
import { executeWizardCommand, validateWizardCommand } from "./wizard-command.service.js";
import type { LlmHumanReviewRequest, WizardCommandRequest, WizardCorrectionPlanRequest } from "./wizard.schemas.js";
import { recordAppliedLlmPlanContext } from "../../db/llm-session.repository.js";
import type { EditOperationActor } from "../../shared/editStageContract.js";

export function resolveCorrectionPlanExecutor(headers: Record<string, unknown>, requested?: CorrectionPlanExecutor): CorrectionPlanExecutor {
  const role = header(headers["x-auth-role"]);
  const subject = header(headers["x-auth-subject"]);
  if (!subject || !role) throw new ConflictError("Trusted x-auth-role and x-auth-subject headers are required for correction plans");
  if (role === "admin" || role === "annotator") {
    if (requested && requested !== "human") throw new ConflictError("Human accounts cannot claim an automated proposal executor");
    return "human";
  }
  if (role === "ml-service") {
    if (requested === "human") throw new ConflictError("ML service accounts cannot claim a human proposal executor");
    return requested ?? "system";
  }
  throw new ConflictError("Account role cannot create correction plans");
}

export async function validateAndCreateCorrectionPlan(
  source: SourceName,
  sourceItemId: string,
  annotationId: string,
  executor: CorrectionPlanExecutor,
  request: WizardCorrectionPlanRequest,
) {
  const validations = [];
  for (const [index, operation] of request.operations.entries()) {
    await validateWizardCommand(source, sourceItemId, annotationId, operation.stage, operation.labelId, commandOf(operation));
    validations.push({ index, operationId: operation.operationId ?? `operation-${index + 1}`, valid: true });
  }
  return createAnnotationCorrectionPlan({
    source, sourceItemId, annotationTrackId: annotationId, executor, controller: request.controller,
    interactionMode: request.interactionMode,
    proposedOutput: request.proposedOutput, operations: request.operations, continueOnError: request.continueOnError,
    validation: { valid: true, validatedAt: new Date().toISOString(), operations: validations },
  });
}

export async function getOwnedCorrectionPlan(source: SourceName, sourceItemId: string, annotationId: string, planId: string) {
  const plan = await getAnnotationCorrectionPlan(planId);
  if (!plan || plan.source !== source || plan.sourceItemId !== sourceItemId || plan.annotationTrackId !== annotationId) {
    throw new NotFoundError("Correction plan not found");
  }
  return plan;
}

export async function applyCorrectionPlan(
  source: SourceName,
  sourceItemId: string,
  annotationId: string,
  planId: string,
  approvalActor?: EditOperationActor,
) {
  const existing = await getOwnedCorrectionPlan(source, sourceItemId, annotationId, planId);
  // POST may be retried by the browser/proxy after the first request committed.
  // Replaying commands would be unsafe, but returning the persisted terminal
  // result is fully idempotent and lets a stale UI converge without a 409.
  if (isTerminalCorrectionPlanStatus(existing.status)) return existing;
  const plan = await claimAnnotationCorrectionPlan(planId);
  if (!plan) {
    const current = await getOwnedCorrectionPlan(source, sourceItemId, annotationId, planId);
    if (isTerminalCorrectionPlanStatus(current.status)) return current;
    throw new ConflictError("Correction plan is currently applying or was interrupted while applying; wait for completion or request a new plan");
  }
  const results: Array<Record<string, unknown>> = [];
  let failures = 0;
  for (const [index, raw] of plan.operations.entries()) {
    const operation = raw as WizardCorrectionPlanRequest["operations"][number];
    const operationId = operation.operationId ?? `operation-${index + 1}`;
    try {
      const operationActor = editActor(plan.executor);
      const result = await executeWizardCommand(
        source, sourceItemId, annotationId, operation.stage, operation.labelId, commandOf(operation),
        { actor: operationActor, approvalActor: approvalActor ?? operationActor },
      );
      await attachStageProposedOutput(annotationId, operation.stage, plan.id, plan.executor, plan.interactionMode, {
        operationId, command: operation.command, output: operation.proposedOutput ?? object(operation.payload),
      });
      results.push({ operationId, stage: operation.stage, command: operation.command, status: "applied", commandResult: result });
    } catch (error) {
      failures += 1;
      results.push({ operationId, stage: operation.stage, command: operation.command, status: "failed", error: error instanceof Error ? error.message : String(error) });
      if (!plan.continueOnError) break;
    }
  }
  const applied = results.filter((item) => item.status === "applied").length;
  const status = failures === 0 ? "applied" : applied ? "partially_applied" : "failed";
  const result = { schemaVersion: 1, planId, executor: plan.executor, applied, failures, operations: results };
  await setAnnotationCorrectionPlanResult(planId, status, result);
  if (applied > 0 && plan.executor === "llm") {
    const keepSessionBlocked = plan.operations.some((raw) => {
      const operation = raw as WizardCorrectionPlanRequest["operations"][number];
      return operation.stage === "package" && object(operation.proposedOutput).multiplicity === "multiple";
    });
    await recordAppliedLlmPlanContext(planId, result, { keepSessionBlocked });
  }
  return { ...(await getOwnedCorrectionPlan(source, sourceItemId, annotationId, planId)), result };
}

export function isTerminalCorrectionPlanStatus(status: string) {
  return status === "applied" || status === "partially_applied" || status === "failed";
}

function editActor(executor: CorrectionPlanExecutor) {
  return executor === "local_ml" ? "local_ml" as const : executor;
}

export async function reviewLlmCorrectionPlan(
  source: SourceName,
  sourceItemId: string,
  annotationId: string,
  planId: string,
  headers: Record<string, unknown>,
  request: LlmHumanReviewRequest,
) {
  const reviewerSubject = humanReviewerSubject(headers);
  const plan = await getOwnedCorrectionPlan(source, sourceItemId, annotationId, planId);
  if (plan.executor !== "llm") throw new ConflictError("Only an LLM correction plan accepts LLM quality review metadata");
  if (plan.status !== "applied" && plan.status !== "partially_applied") throw new ConflictError("LLM correction plan must be applied before review");
  const appliedOperation = appliedStageOperation(plan, request.stage);
  if (!appliedOperation) throw new ConflictError(`Correction plan has no applied ${request.stage} operation`);
  const decisionMode = llmDecisionMode(plan.interactionMode);
  validateLlmReview(decisionMode, request);
  const reviewedAt = new Date().toISOString();
  const review = {
    reviewedBy: "human" as const,
    reviewerSubject,
    finalEditor: request.finalEditor,
    verdict: request.verdict,
    reviewedAt,
  };
  const attached = await attachStageProposalReview({
    annotationTrackId: annotationId,
    stage: request.stage,
    planId,
    interactionMode: plan.interactionMode,
    proposedOutput: {
      operationId: appliedOperation["operationId"],
      command: appliedOperation["command"],
      output: operationProposedOutput(plan, appliedOperation),
    },
    review,
  });
  if (!attached) throw new ConflictError(`${request.stage} must have a final reviewed execution before LLM review can be recorded`);
  return { schemaVersion: 1, planId, stage: request.stage, llmDecision: { mode: decisionMode, executor: "llm" as const }, review };
}

function commandOf(operation: WizardCorrectionPlanRequest["operations"][number]): WizardCommandRequest {
  return { command: operation.command, ...(operation.target ? { target: operation.target } : {}), payload: operation.payload };
}
function header(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : Array.isArray(value) && typeof value[0] === "string" ? value[0].trim() : null; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function humanReviewerSubject(headers: Record<string, unknown>) {
  const role = header(headers["x-auth-role"]);
  const subject = header(headers["x-auth-subject"]);
  if ((role !== "admin" && role !== "annotator") || !subject) throw new ConflictError("LLM review requires a trusted human reviewer account");
  return subject.slice(0, 80);
}

function appliedStageOperation(plan: Awaited<ReturnType<typeof getOwnedCorrectionPlan>>, stage: string): Record<string, unknown> | null {
  const resultOperations = Array.isArray(plan.result?.operations) ? plan.result.operations : [];
  for (const [operationIndex, raw] of resultOperations.entries()) {
    const operation = object(raw);
    if (operation.stage === stage && operation.status === "applied") return { ...operation, operationIndex };
  }
  return null;
}

function operationProposedOutput(plan: Awaited<ReturnType<typeof getOwnedCorrectionPlan>>, appliedOperation: Record<string, unknown>) {
  const operationId = appliedOperation.operationId;
  const byId = operationId ? plan.operations.map(object).find((item) => item.operationId === operationId) : null;
  const operation = byId ?? object(plan.operations[Number(appliedOperation.operationIndex)]);
  return operation ? object(operation.proposedOutput ?? operation.payload) : {};
}

export function validateLlmReview(decisionMode: ReturnType<typeof llmDecisionMode>, review: LlmHumanReviewRequest) {
  if (review.verdict === "llm_false_accept" && decisionMode !== "accepted_helper") {
    throw new ConflictError("llm_false_accept requires an accepted_helper LLM decision");
  }
  if (review.verdict === "llm_false_correction" && decisionMode !== "modified_helper") {
    throw new ConflictError("llm_false_correction requires a modified_helper LLM decision");
  }
  if (review.verdict === "llm_partially_correct" && decisionMode !== "modified_helper" && decisionMode !== "manual_created") {
    throw new ConflictError("llm_partially_correct requires a modified_helper or manual_created LLM decision");
  }
  if (review.verdict !== "llm_correct" && review.finalEditor !== "human") {
    throw new ConflictError(`${review.verdict} requires finalEditor=human`);
  }
  if (review.verdict === "llm_correct") {
    const expected = decisionMode === "accepted_helper" ? "helper" : "llm";
    if (review.finalEditor !== expected) throw new ConflictError(`llm_correct with ${decisionMode} requires finalEditor=${expected}`);
  }
}
