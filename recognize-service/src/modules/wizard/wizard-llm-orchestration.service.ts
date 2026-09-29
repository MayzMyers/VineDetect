import type { SourceName } from "../../shared/types.js";
import type { WizardStageId } from "../../shared/helperConfigContract.js";
import { WIZARD_STAGE_ORDER } from "../../shared/wizardWorkflowContract.js";
import { attachLlmProviderConversation, createLlmStageRun, createOrGetActiveLlmSession, finishLlmStageRun, getLlmSession, closeLlmSession } from "../../db/llm-session.repository.js";
import { buildVisionContext } from "./wizard-vision-context.service.js";
import { createLlmControllerPlan, initializeLlmProviderConversation } from "./wizard-llm-controller.service.js";
import { applyCorrectionPlan } from "./wizard-correction-plan.service.js";
import { env } from "../../config/env.js";
import { UpstreamServiceError } from "../../shared/errors.js";
import { ExternalControllerRequestCancelledError } from "./wizard-external-controller.service.js";
import type { SiglipLabelMode } from "../../vision/semanticEvidence.js";

const LABEL_STAGES: WizardStageId[] = ["ocr", "mask", "morphology", "components", "elements", "contours", "palette"];
export type LlmWizardExecutionMode = "session-chain" | "one-shot-chain";
type LlmWizardRunOptions = { shouldCancel?: () => Promise<boolean>; visionEvidence?: { labelMode: SiglipLabelMode } };
export type LlmWizardStageFailure = {
  stage: WizardStageId;
  labelId: string | null;
  sessionId: string | null;
  message: string;
  failedAt: string;
  transport?: Record<string, unknown> | null;
};

export class LlmWizardStageError extends Error {
  readonly failure: LlmWizardStageFailure;
  completedStages: Array<Record<string, unknown>> = [];

  constructor(failure: LlmWizardStageFailure, cause: unknown) {
    super(`LLM Wizard stage ${failure.stage}${failure.labelId ? ` (${failure.labelId})` : ""} failed: ${failure.message}`, { cause });
    this.name = "LlmWizardStageError";
    this.failure = failure;
  }
}

export async function runLlmWizardJob(
  source: SourceName,
  sourceItemId: string,
  annotationId: string,
  executionMode: LlmWizardExecutionMode = "session-chain",
  options: LlmWizardRunOptions = {},
) {
  let sessionId: string | null = null;
  const results: Array<Record<string, unknown>> = [];
  try {
    const initial = await buildVisionContext(source, sourceItemId, annotationId);
    if (await options.shouldCancel?.()) throw new LlmWizardCancellationError();
    if ((initial.package as Record<string, any>).multiplicity?.value === "multiple") {
      return { schemaVersion: 1, executionMode, sessionId: null, status: "blocked_multipackage", stopReason: "multipackage", stages: [] };
    }
    const created = await createOrGetActiveLlmSession({
      source, sourceItemId, annotationTrackId: annotationId, provider: env.LLM_WIZARD_PROVIDER, model: env.LLM_WIZARD_MODEL,
      adapterVersion: "vision-stage-adapter-v7", promptVersion: "stage-output-review-v13", wizardDefinitionVersion: `wizard-${WIZARD_STAGE_ORDER.length}-stages-v1`,
      globalContext: { executionMode, visionEvidence: options.visionEvidence ?? null, visionContextId: initial.visionContextId, card: initial.card, catalogEvidence: initial.catalogEvidence, assets: initial.assets, stageContexts: {} },
    });
    let session = created.session;
    sessionId = session.id;
    if (executionMode === "session-chain") {
      if (session.provider === "qwen" && !session.providerConversationId) {
        const cancellation = watchCancellation(options.shouldCancel);
        try {
          const initialized = await initializeLlmProviderConversation({ llmSessionId: session.id, annotationId }, cancellation.signal);
          if (initialized.status === "attached" && initialized.conversationId) {
            session = (await attachLlmProviderConversation({ sessionId: session.id, provider: initialized.provider, conversationId: initialized.conversationId, model: initialized.model })) ?? session;
          }
        } catch (error) {
          if (error instanceof ExternalControllerRequestCancelledError) throw new LlmWizardCancellationError();
          if (error instanceof UpstreamServiceError) {
            throw new LlmWizardStageError({
              stage: "package", labelId: null, sessionId, message: error.message,
              failedAt: new Date().toISOString(), transport: error.transport,
            }, error);
          }
          throw error;
        } finally {
          cancellation.stop();
        }
      }
    }
    let blockedByReview = false;
    const auditSessionId = sessionId;
    if (!auditSessionId) throw new Error("LLM audit session was not created");
    const runNextStage = async (stage: WizardStageId, selectedLabelId: string | null) => {
      if (await options.shouldCancel?.()) throw new LlmWizardCancellationError();
      return runStage(source, sourceItemId, annotationId, auditSessionId, executionMode, stage, selectedLabelId, options.shouldCancel, options.visionEvidence);
    };

    const packageResult = await runNextStage("package", null);
    results.push(packageResult);
    if (packageResult.status === "human_required") {
      return {
        schemaVersion: 1, executionMode, sessionId,
        status: packageResult.packageMultiplicity === "multiple" ? "blocked_multipackage" : "blocked_by_review",
        stopReason: packageResult.packageMultiplicity === "multiple" ? "multipackage" : "package_review_required",
        stages: results,
      };
    }

    const labelResult = await runNextStage("label", null);
    const labelCollectionBlocked = labelResult.status === "human_required";
    results.push(labelResult); blockedByReview ||= labelCollectionBlocked;
    if (!labelCollectionBlocked) {
      const objectResult = await runNextStage("bottle", null);
      results.push(objectResult); blockedByReview ||= objectResult.status === "human_required";
    }

    const afterPackage = await buildVisionContext(source, sourceItemId, annotationId);
    for (const label of labelCollectionBlocked ? [] : afterPackage.labels) {
      let branchBlocked = false;
      for (const stage of LABEL_STAGES) {
        if (branchBlocked) break;
        let result = await runNextStage(stage, label.id);
        results.push(result);
        if (stage === "ocr" && result.status === "completed" && result.helperId === "label-rectification") {
          result = await runNextStage(stage, label.id);
          results.push(result);
        }
        branchBlocked = result.status === "human_required";
        blockedByReview ||= branchBlocked;
      }
    }
    if (!blockedByReview && afterPackage.labels.length) results.push(await runNextStage("summary", null));
    if (!blockedByReview && sessionId) await closeLlmSession(sessionId, "completed");
    return { schemaVersion: 1, executionMode, sessionId, status: blockedByReview ? "blocked_by_review" : "completed", stages: results };
  } catch (error) {
    if (error instanceof LlmWizardCancellationError || error instanceof ExternalControllerRequestCancelledError) {
      if (sessionId) await closeLlmSession(sessionId, "cancelled");
      return { schemaVersion: 1, executionMode, sessionId, status: "cancelled", stopReason: "cancel_requested", stages: results };
    }
    if (error instanceof LlmWizardStageError) {
      error.completedStages = [...results];
      if (sessionId) await closeLlmSession(sessionId, "failed");
    }
    throw error;
  }
}

class LlmWizardCancellationError extends Error {
  constructor() {
    super("LLM Wizard job cancellation requested");
    this.name = "LlmWizardCancellationError";
  }
}

async function runStage(
  source: SourceName,
  sourceItemId: string,
  annotationId: string,
  sessionId: string,
  executionMode: LlmWizardExecutionMode,
  stage: WizardStageId,
  selectedLabelId: string | null,
  shouldCancel?: () => Promise<boolean>,
  visionEvidence?: { labelMode: SiglipLabelMode },
) {
  let run: Awaited<ReturnType<typeof createLlmStageRun>> | null = null;
  let trace: unknown[] = [];
  let response: Record<string, any> | null = null;
  let appliedPlanId: string | null = null;
  try {
    const session = await getLlmSession(sessionId);
    if (!session || !["active", "blocked"].includes(session.status)) throw new Error("LLM session is unavailable during Wizard orchestration");
    const sessionContext = executionMode === "session-chain" ? {
      llmSessionId: session.id, provider: session.provider, providerConversationId: session.providerConversationId,
      currentStage: session.currentStage, context: session.globalContext, contextEvents: session.contextEvents,
    } : undefined;
    run = await createLlmStageRun(session.id, stage, selectedLabelId, [], {
      schemaVersion: 1, executionMode, stage, labelId: selectedLabelId, session: sessionContext ?? null,
    });
    const cancellation = watchCancellation(shouldCancel);
    try {
      response = await createLlmControllerPlan(source, sourceItemId, annotationId, {
        render: { viewport: { type: "source" }, maxSide: 768, overlays: [], includeRejected: false },
        input: { currentStage: stage, ...(selectedLabelId ? { selectedLabelId } : {}) },
      }, sessionContext, { transportFailureMode: "throw", signal: cancellation.signal, visionEvidence });
    } finally {
      cancellation.stop();
    }
    if (await shouldCancel?.()) throw new LlmWizardCancellationError();
    trace = iterationTrace(response);
    if (response.plan) {
      appliedPlanId = response.plan.id;
      const appliedPlan = await applyCorrectionPlan(source, sourceItemId, annotationId, response.plan.id);
      const failures = Number(appliedPlan.result?.failures ?? 0);
      if (failures > 0) {
        const failedOperation = Array.isArray(appliedPlan.result?.operations)
          ? appliedPlan.result.operations.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).status === "failed") as Record<string, unknown> | undefined
          : undefined;
        throw new Error(`Correction plan ${response.plan.id} failed in ${failures} operation(s)${failedOperation?.error ? `: ${String(failedOperation.error)}` : ""}`);
      }
      if (await shouldCancel?.()) throw new LlmWizardCancellationError();
    }
    const packageMultiplicity = responsePackageMultiplicity(response);
    const humanRequired = (response.status === "no-action" && stage !== "summary") || (stage === "package" && packageMultiplicity === "multiple");
    const helperId = responseHelperId(response);
    if (run) await finishLlmStageRun({
      id: run.id, status: humanRequired ? "human_required" : "completed", decisions: trace,
      correctionPlanId: appliedPlanId, controllerModel: String((response.controller as Record<string, unknown>).model ?? response.controller.id),
      inputArtifactIds: inputArtifacts(response),
      ...providerRunEvidence(response),
      stageContext: { [selectedLabelId ? `${stage}:${selectedLabelId}` : stage]: { stage, status: humanRequired ? "human_required" : response.status, labelId: selectedLabelId, planId: appliedPlanId, decisions: trace, updatedAt: new Date().toISOString() } },
      ...(humanRequired ? {} : { contextEvent: { type: "stage_completed", stage, labelId: selectedLabelId, resultId: appliedPlanId ?? `${stage}:${run?.id ?? "one-shot"}`, at: new Date().toISOString() } }),
    });
    return {
      stage, labelId: selectedLabelId, helperId, packageMultiplicity,
      executionMode: executionMode === "session-chain" ? "session" : "one-shot",
      status: humanRequired ? "human_required" : "completed",
      planId: appliedPlanId, iterations: trace.length,
      decisions: trace,
      reason: typeof response.reason === "string" ? response.reason : null,
      providerEvidence: providerRunEvidence(response),
    };
  } catch (error) {
    if (error instanceof LlmWizardCancellationError || error instanceof ExternalControllerRequestCancelledError) {
      if (run) await finishLlmStageRun({
        id: run.id, status: "cancelled", decisions: trace, error: "Cancellation requested", correctionPlanId: appliedPlanId,
        stageContext: { [selectedLabelId ? `${stage}:${selectedLabelId}` : stage]: { stage, status: "cancelled", labelId: selectedLabelId, updatedAt: new Date().toISOString() } },
        contextEvent: { type: "stage_cancelled", stage, labelId: selectedLabelId, at: new Date().toISOString() },
      });
      throw new LlmWizardCancellationError();
    }
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = new Date().toISOString();
    if (run) await finishLlmStageRun({
      id: run.id, status: "failed", decisions: trace, error: message, correctionPlanId: appliedPlanId,
      transportError: error instanceof UpstreamServiceError ? error.transport : null,
      ...(response ? {
        controllerModel: String((response.controller as Record<string, unknown>).model ?? response.controller.id),
        inputArtifactIds: inputArtifacts(response),
        ...providerRunEvidence(response),
      } : {}),
      stageContext: { [selectedLabelId ? `${stage}:${selectedLabelId}` : stage]: { stage, status: "failed", labelId: selectedLabelId, error: message, updatedAt: failedAt } },
      contextEvent: { type: "stage_failed", stage, labelId: selectedLabelId, error: message, at: failedAt },
    });
    throw new LlmWizardStageError({
      stage, labelId: selectedLabelId, sessionId, message, failedAt,
      transport: error instanceof UpstreamServiceError ? error.transport : null,
    }, error);
  }
}

function watchCancellation(shouldCancel?: () => Promise<boolean>) {
  const controller = new AbortController();
  let stopped = false;
  let checking = false;
  const check = async () => {
    if (stopped || checking || controller.signal.aborted || !shouldCancel) return;
    checking = true;
    try {
      if (await shouldCancel()) controller.abort();
    } catch {
      // A transient DB error must not masquerade as a user cancellation.
    } finally {
      checking = false;
    }
  };
  const timer = shouldCancel ? setInterval(() => { void check(); }, 1_000) : null;
  return {
    signal: controller.signal,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
  };
}

function responseHelperId(response: Record<string, any>) {
  const proposed = response.plan?.proposedOutput ?? response.proposedOutput ?? {};
  const value = proposed.observation?.helper?.id;
  return typeof value === "string" ? value : null;
}

function responsePackageMultiplicity(response: Record<string, any>) {
  const operations = Array.isArray(response.plan?.operations) ? response.plan.operations : [];
  const value = operations.map((operation: Record<string, any>) => operation.proposedOutput?.multiplicity).find((item: unknown) => item === "single" || item === "multiple");
  return value === "single" || value === "multiple" ? value : null;
}

function iterationTrace(response: Record<string, any>) {
  const controllerEvidence = response.proposedOutput ?? {};
  const planEvidence = response.plan?.proposedOutput ?? {};
  return evidenceIterationTrace(controllerEvidence) ?? evidenceIterationTrace(planEvidence) ?? [];
}

function evidenceIterationTrace(evidence: Record<string, any>) {
  if (Array.isArray(evidence.iterationTrace)) return evidence.iterationTrace;
  return Array.isArray(evidence.observation?.iterationTrace) ? evidence.observation.iterationTrace : null;
}

function inputArtifacts(response: Record<string, any>) {
  return Object.values(response.visualContext?.assets ?? {}).flatMap((value) => {
    if (typeof value === "string") return [value];
    if (value && typeof value === "object" && typeof (value as Record<string, unknown>).assetPath === "string") return [String((value as Record<string, unknown>).assetPath)];
    return [];
  });
}

function providerRunEvidence(response: Record<string, any>) {
  const controllerEvidence = response.proposedOutput ?? {};
  const planEvidence = response.plan?.proposedOutput ?? {};
  const evidence = controllerEvidence.providerEvidence ?? planEvidence.providerEvidence ?? {};
  return {
    providerConversationId: typeof evidence.providerConversationId === "string" ? evidence.providerConversationId : null,
    providerResponseId: typeof evidence.responseId === "string" ? evidence.responseId : null,
    providerRequestId: typeof evidence.requestId === "string" ? evidence.requestId : null,
    usage: evidence.usage && typeof evidence.usage === "object" ? evidence.usage : {},
    latencyMs: Number.isInteger(evidence.latencyMs) ? evidence.latencyMs : null,
  };
}
