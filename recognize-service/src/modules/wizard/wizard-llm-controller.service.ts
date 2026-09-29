import { env } from "../../config/env.js";
import { ConflictError, UpstreamServiceError } from "../../shared/errors.js";
import type { SourceName } from "../../shared/types.js";
import type { WizardStageId } from "../../shared/helperConfigContract.js";
import { validateAndCreateCorrectionPlan } from "./wizard-correction-plan.service.js";
import { requestExternalController, type ExternalControllerHttpOptions } from "./wizard-external-controller.service.js";
import { buildVisionContext } from "./wizard-vision-context.service.js";
import { renderWizardVisualContext } from "./wizard-visual.service.js";
import { applyLlmSemanticAdjustment, prepareLlmStageReview } from "./wizard-llm-stage-runtime.service.js";
import { stageLlmDecisionResponseSchema, type ExternalControllerPlanRequest, type OcrEditOperation, type WizardCorrectionPlanRequest } from "./wizard.schemas.js";
import { WIZARD_STAGE_ORDER } from "../../shared/wizardWorkflowContract.js";
import { transitionStageRuntime, wizardRuntimeAction, wizardRuntimeDefinition } from "../../shared/wizardRuntimeContract.js";
import { z } from "zod";
import type { SiglipLabelMode } from "../../vision/semanticEvidence.js";

const providerConversationResponseSchema = z.object({
  schemaVersion: z.literal(1), status: z.enum(["attached", "unavailable"]),
  provider: z.string().min(1).max(80), conversationId: z.string().min(1).max(300).nullable(),
  model: z.string().min(1).max(160), reason: z.string().max(500).optional(),
}).strict();

export async function createLlmControllerPlan(
  source: SourceName,
  sourceItemId: string,
  annotationId: string,
  request: ExternalControllerPlanRequest,
  sessionContext?: Record<string, unknown>,
  execution: { transportFailureMode?: "human-required" | "throw"; signal?: AbortSignal; visionEvidence?: { labelMode: SiglipLabelMode } } = {},
) {
  if (!env.LLM_WIZARD_CONTROLLER_URL) throw new ConflictError("LLM_WIZARD_CONTROLLER_URL is not configured");
  const requestedStage = typeof request.input.currentStage === "string" ? request.input.currentStage : "summary";
  if (!WIZARD_STAGE_ORDER.includes(requestedStage as WizardStageId)) throw new ConflictError(`Unknown wizard stage: ${requestedStage}`);
  const currentStage = requestedStage as WizardStageId;
  const selectedLabelId = typeof request.input.selectedLabelId === "string" ? request.input.selectedLabelId : undefined;
  const labelViewport = selectedLabelId && ["ocr", "mask", "morphology", "components", "elements", "contours", "palette"].includes(currentStage);
  const [visionContext, visualContext] = await Promise.all([
    buildVisionContext(source, sourceItemId, annotationId),
    renderWizardVisualContext(source, sourceItemId, annotationId, {
      ...request.render, viewport: labelViewport ? { type: "label", id: selectedLabelId } : { type: "package" }, selectedLabelId,
      overlays: [], includeRejected: false,
    }),
  ]);
  if (currentStage !== "package" && (visionContext.package as Record<string, any>).multiplicity?.value === "multiple") {
    return noAction("Automatic LLM orchestration is stopped because this item is marked multipackage.", visionContext.visionContextId, visualContext);
  }
  let runtime: Awaited<ReturnType<typeof prepareLlmStageReview>>;
  try { runtime = await prepareLlmStageReview(source, sourceItemId, annotationId, currentStage, selectedLabelId, visualContext, { visionEvidence: execution.visionEvidence }); }
  catch (error) {
    if (error instanceof ConflictError) return noAction(error.message, visionContext.visionContextId, visualContext);
    throw error;
  }
  let observation = runtime.observation;
  observation = { ...observation, context: { ...object(observation.context), catalogEvidence: visionContext.catalogEvidence } };
  if (sessionContext) observation = withSessionContext(observation, sessionContext);
  let response: Awaited<ReturnType<typeof requestLlmStageController>>;
  const iterationTrace: Array<Record<string, unknown>> = [];
  let pendingOcrOperations: Array<Record<string, any>> = [];
  for (let iteration = 0; ; iteration += 1) {
    try {
      response = await requestLlmStageController({ schemaVersion: 1, task: "stage-evaluation", stageObservation: observation }, {
        url: env.LLM_WIZARD_CONTROLLER_URL!, token: env.LLM_WIZARD_CONTROLLER_TOKEN,
        timeoutMs: env.LLM_WIZARD_CONTROLLER_TIMEOUT_MS,
        maxResponseBytes: env.LLM_WIZARD_CONTROLLER_MAX_RESPONSE_BYTES,
        signal: execution.signal,
      });
    } catch (error) {
      if (error instanceof UpstreamServiceError) {
        if (execution.transportFailureMode === "throw") throw error;
        return {
          ...noAction(`LLM review is unavailable; deterministic output remains available for human review. ${error.message}`, visionContext.visionContextId, visualContext),
          transportError: error.transport,
          proposedOutput: { iterationTrace, transportError: error.transport },
        };
      }
      throw error;
    }
    if (response.observationId !== observation.observationId) throw new UpstreamServiceError("LLM stage decision references a different observation");
    if (response.decision.stage !== observation.stage) throw new UpstreamServiceError("LLM stage decision references a different stage");
    const runtimeDefinition = wizardRuntimeDefinition(currentStage);
    if (!runtimeDefinition.actions.includes(response.decision.action)) throw new UpstreamServiceError("LLM stage decision uses an action not registered for this stage");
    if (!array(object(observation.policy).allowedActions).includes(response.decision.action)) throw new UpstreamServiceError("LLM stage decision uses an action unavailable in the current runtime state");
    if (sessionContext && response.providerEvidence.providerConversationId) {
      sessionContext = { ...sessionContext, providerConversationId: response.providerEvidence.providerConversationId };
    }
    const runtimeBefore = object(observation.runtimeState);
    const runtimeAfter = transitionStageRuntime(currentStage, runtimeBefore.state === "helper_running" ? "helper_running" : "helper_output_ready", response.decision.action);
    iterationTrace.push({
      iteration, observationId: observation.observationId, helperRunId: observation.helper?.runId ?? null,
      config: observation.helper?.config ?? {}, runtimeBefore, event: response.decision.action, runtimeAfter, decision: response.decision,
    });
    if (currentStage === "ocr" && response.decision.action === "review" && response.decision.editOperations.length && "refineReview" in runtime && typeof runtime.refineReview === "function") {
      validateGranularDecision(observation, response.decision.reviews, response.decision.topologyEdits, response.decision.editOperations);
      const changesGeometry = response.decision.editOperations.some((operation) => ["edit_region", "merge_region", "split_region", "create_region"].includes(operation.type));
      if (changesGeometry) {
        if (iteration >= runtimeDefinition.maxLlmIterations) return {
          ...noAction("OCR geometry still changes after the bounded correction loop; human review is required.", visionContext.visionContextId, visualContext),
          controller: response.controller, proposedOutput: decisionEvidence(response, observation, undefined, undefined, iterationTrace),
        };
        const refined = await runtime.refineReview(response.decision.editOperations, pendingOcrOperations, iteration + 1);
        if (refined) {
          pendingOcrOperations = refined.operations;
          const refinedObservation = { ...refined.observation, context: { ...object(refined.observation.context), catalogEvidence: visionContext.catalogEvidence } };
          observation = sessionContext ? withSessionContext(refinedObservation, sessionContext) : refinedObservation;
          iterationTrace.push({ iteration: iteration + 1, event: "rerun_ocr", systemOperations: refined.operations.filter((operation) => operation.type === "rerun_ocr"), observationId: observation.observationId });
          continue;
        }
      }
    }
    const actionDefinition = wizardRuntimeAction(response.decision.action);
    if (actionDefinition.flow !== "rerun_helper") break;
    if (Number(object(observation.policy).remainingLLMIterations) < 1 || !response.decision.paramsPatch) throw new UpstreamServiceError("LLM exceeded the bounded rerun policy");
    const nextConfig = applyLlmSemanticAdjustment(currentStage, observation.helper?.config, response.decision.paramsPatch);
    runtime = await prepareLlmStageReview(source, sourceItemId, annotationId, currentStage, selectedLabelId, visualContext, { configOverride: nextConfig, iteration: iteration + 1, visionEvidence: execution.visionEvidence });
    observation = runtime.observation;
    observation = { ...observation, context: { ...object(observation.context), catalogEvidence: visionContext.catalogEvidence } };
    if (sessionContext) observation = withSessionContext(observation, sessionContext);
  }
  const finalAction = wizardRuntimeAction(response.decision.action);
  if (finalAction.flow === "stop") return {
    ...noAction(`LLM requested human review for the current ${currentStage} result.`, visionContext.visionContextId, visualContext),
    controller: response.controller, proposedOutput: decisionEvidence(response, observation, undefined, undefined, iterationTrace),
  };
  if (finalAction.flow !== "create_plan") throw new UpstreamServiceError("LLM action did not reach a terminal runtime state");
  const selectedId = response.decision.candidateId!;
  const selected = observation.candidates.find((candidate: any) => candidate.id === selectedId);
  if (!selected) throw new UpstreamServiceError("LLM selected a candidate outside the current observation");
  let operations: WizardCorrectionPlanRequest["operations"];
  const finishesPendingOcrCorrection = currentStage === "ocr" && pendingOcrOperations.length > 0 && response.decision.action === "accept";
  if (response.decision.action === "review" || finishesPendingOcrCorrection) {
    let terminalEditOperations = response.decision.editOperations;
    if (currentStage === "ocr" && pendingOcrOperations.length && !terminalEditOperations.length) {
      terminalEditOperations = terminalOcrApprovalOperations(observation.reviewTargets, response.decision.reviews);
    }
    validateGranularDecision(observation, response.decision.reviews, response.decision.topologyEdits, terminalEditOperations);
    if (!("reviewOperation" in runtime) || typeof runtime.reviewOperation !== "function") throw new UpstreamServiceError(`${currentStage} does not support granular LLM review`);
    const planned = (runtime.reviewOperation as (...args: any[]) => WizardCorrectionPlanRequest["operations"][number] | WizardCorrectionPlanRequest["operations"])(selectedId, response.decision.reviews, response.decision.topologyEdits, terminalEditOperations, pendingOcrOperations);
    operations = Array.isArray(planned) ? planned : [planned];
  } else if (observation.stage === "label" && "operation" in observation) {
    operations = [{
      operationId: `llm-accept-label-${selectedId}`, stage: "label" as const, command: "select_candidate" as const,
      payload: {
        operation: { ...observation.operation, reviewMode: "accepted" as const },
        reviews: observation.operation.candidates.map((candidate: any) => ({
          candidateId: candidate.id, state: candidate.id === selectedId ? "accepted" as const : "rejected" as const,
          ...(candidate.id === selectedId ? { geometry: candidate.payload.geometry } : {}),
        })),
      }, proposedOutput: { decision: response.decision, selectedCandidate: selected },
    }];
  } else if (typeof runtime.acceptOperation === "function") operations = [runtime.acceptOperation(selectedId)];
  else return {
    ...noAction(`${currentStage} LLM review is advisory; final commit remains a human boundary.`, visionContext.visionContextId, visualContext),
    controller: response.controller, proposedOutput: decisionEvidence(response, observation, undefined, undefined, iterationTrace),
  };
  const evidence = decisionEvidence(response, observation, visionContext.visionContextId, visualContext.renderId, iterationTrace);
  operations = operations.map((operation) => ({ ...operation, proposedOutput: { ...(operation.proposedOutput ?? {}), llmReview: evidence } }));
  const interactionMode = iterationTrace.some((item) => ["rerun", "review"].includes(String(object(item.decision).action))) ? "mixed" as const : "auto" as const;
  const plan = await validateAndCreateCorrectionPlan(source, sourceItemId, annotationId, "llm", {
    executor: "llm", interactionMode, controller: response.controller,
    proposedOutput: evidence,
    operations, continueOnError: false,
  });
  return {
    schemaVersion: 1, adapter: "wizard-stage-llm-http-v1", endpointConfigured: true, status: "planned" as const,
    visionContextId: visionContext.visionContextId, visualContext, controller: response.controller,
    interactionMode, proposedOutput: evidence, plan,
  };
}

export function terminalOcrApprovalOperations(reviewTargets: unknown, reviews: Array<Record<string, any>>): OcrEditOperation[] {
  const granularById = new Map(reviews.map((item) => [item.id, item]));
  return array(reviewTargets).map((raw, index) => {
    const id = String(object(raw).id);
    const review = granularById.get(id);
    return {
      operationId: `op-${index + 1}`,
      type: review?.state === "rejected" ? "reject" : "approve_region",
      inputIds: [id], adjustment: null, geometry: null, text: null, transcriptionStatus: null,
    };
  });
}

export type LlmControllerHttpOptions = Omit<ExternalControllerHttpOptions, "displayName">;

export function requestLlmController(
  payload: Record<string, unknown>,
  options: LlmControllerHttpOptions = {
    url: env.LLM_WIZARD_CONTROLLER_URL!, token: env.LLM_WIZARD_CONTROLLER_TOKEN,
    timeoutMs: env.LLM_WIZARD_CONTROLLER_TIMEOUT_MS,
    maxResponseBytes: env.LLM_WIZARD_CONTROLLER_MAX_RESPONSE_BYTES,
  },
) {
  return requestExternalController(payload, { ...options, displayName: "LLM Wizard controller" });
}

export function requestLlmStageController(
  payload: Record<string, unknown>,
  options: LlmControllerHttpOptions = {
    url: env.LLM_WIZARD_CONTROLLER_URL!, token: env.LLM_WIZARD_CONTROLLER_TOKEN,
    timeoutMs: env.LLM_WIZARD_CONTROLLER_TIMEOUT_MS,
    maxResponseBytes: env.LLM_WIZARD_CONTROLLER_MAX_RESPONSE_BYTES,
  },
) {
  return requestExternalController(payload, { ...options, displayName: "LLM Wizard controller" }, stageLlmDecisionResponseSchema);
}

export function initializeLlmProviderConversation(input: { llmSessionId: string; annotationId: string }, signal?: AbortSignal) {
  return requestExternalController({
    schemaVersion: 1, task: "conversation-initialize", session: input,
  }, {
    url: env.LLM_WIZARD_CONTROLLER_URL!, token: env.LLM_WIZARD_CONTROLLER_TOKEN,
    timeoutMs: env.LLM_WIZARD_CONTROLLER_TIMEOUT_MS,
    maxResponseBytes: env.LLM_WIZARD_CONTROLLER_MAX_RESPONSE_BYTES,
    displayName: "LLM provider conversation initializer",
    signal,
  }, providerConversationResponseSchema);
}

export function decisionEvidence(
  response: Awaited<ReturnType<typeof requestLlmStageController>>,
  observation: Record<string, any>,
  visionContextId?: string,
  visualRenderId?: string,
  iterationTrace: Array<Record<string, unknown>> = [],
) {
  return {
    stageDecision: response.decision,
    observation: {
      id: observation.observationId, stage: observation.stage, helper: observation.helper,
      candidateIds: observation.candidates.map((candidate: Record<string, unknown>) => candidate.id), policy: observation.policy, runtimeState: observation.runtimeState,
    },
    renderer: observation.visuals.renderer,
    iterationTrace,
    adapter: response.adapter, providerEvidence: response.providerEvidence,
    ...(visionContextId ? { visionContextId } : {}), ...(visualRenderId ? { visualRenderId } : {}),
  };
}

function noAction(reason: string, visionContextId: string, visualContext: Awaited<ReturnType<typeof renderWizardVisualContext>>) {
  return {
    schemaVersion: 1, adapter: "wizard-stage-llm-http-v1", endpointConfigured: true, status: "no-action" as const,
    visionContextId, visualContext,
    controller: { id: "vinedetect-stage-review-adapter", version: "4", promptVersion: "stage-output-review-v4" },
    interactionMode: "auto" as const, proposedOutput: {}, reason, plan: null,
  };
}
function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function array(value: unknown): any[] { return Array.isArray(value) ? value : []; }
function withSessionContext<T>(observation: T, sessionContext: Record<string, unknown>): T {
  const value = object(observation);
  return { ...value, context: { ...object(value.context), llmSession: sessionContext } } as T;
}
function validateGranularDecision(observation: Record<string, any>, reviews: Array<Record<string, any>>, topologyEdits: Array<Record<string, any>> = [], editOperations: Array<Record<string, any>> = []) {
  if (!["label", "ocr", "components", "elements"].includes(observation.stage) || !object(observation.policy).granularReviewAllowed) throw new UpstreamServiceError("Granular review is not allowed for this stage");
  const configuredLimit = Number(object(observation.policy).maxEditOperations);
  const maxEditOperations = Number.isInteger(configuredLimit) ? Math.max(1, Math.min(99, configuredLimit)) : 20;
  if (editOperations.length > maxEditOperations) throw new UpstreamServiceError(`Edit Engine plan exceeds the current limit of ${maxEditOperations} operations`);
  if (observation.stage === "label") {
    if (reviews.length || topologyEdits.length || !editOperations.length) throw new UpstreamServiceError("Label review requires Edit Engine operations only");
    const candidateIds = new Set(array(object(observation.operation).candidates).map((candidate) => String(object(candidate).id)));
    const derivedIds = new Set<string>();
    for (const operation of editOperations) {
      const id = String(operation.operationId); const inputs = array(operation.inputIds).map(String);
      if (derivedIds.has(id) || candidateIds.has(id)) throw new UpstreamServiceError("Label Edit Engine operation IDs must be unique");
      if (inputs.some((input) => !candidateIds.has(input) && !derivedIds.has(input))) throw new UpstreamServiceError("Label Edit Engine references an unknown or forward node");
      if (operation.type === "edit" || operation.type === "merge") derivedIds.add(id);
    }
    return;
  }
  if (observation.stage === "ocr" && editOperations.length) {
    if (reviews.length || topologyEdits.length) throw new UpstreamServiceError("OCR review uses either Edit Engine operations or legacy granular reviews, never both");
    validateOcrEditOperations(observation, editOperations);
    return;
  }
  if (editOperations.length) throw new UpstreamServiceError("Edit Engine operations are not allowed for this stage");
  const targetItems = (Array.isArray(observation.reviewTargets) ? observation.reviewTargets : []).map(object);
  const targets = new Set(targetItems.map((item) => String(item.id)));
  const ids = reviews.map((item) => item.id);
  if ((!ids.length && !topologyEdits.length) || new Set(ids).size !== ids.length || ids.some((id) => !targets.has(id))) throw new UpstreamServiceError("LLM granular review references an unknown or duplicate target");
  for (const item of reviews) {
    if (observation.stage === "ocr") {
      const target = targetItems.find((candidate) => String(candidate.id) === item.id);
      if (target?.duplicateOfOcrId && item.state !== "rejected") throw new UpstreamServiceError("Duplicate OCR observations may only be rejected by granular review");
      if (item.type !== null || item.role !== null) throw new UpstreamServiceError("OCR granular review cannot set Element semantics");
      if (item.transcriptionStatus === "unreadable" && item.text) throw new UpstreamServiceError("Unreadable OCR review cannot contain text");
      if (item.text && item.transcriptionStatus !== "verified" && item.transcriptionStatus !== "partial") throw new UpstreamServiceError("Corrected OCR text requires a transcription status");
      if (item.state === "rejected" && (item.text !== null || item.transcriptionStatus !== null)) throw new UpstreamServiceError("Rejected OCR review cannot contain a transcription correction");
    } else if (item.text !== null || item.transcriptionStatus !== null) throw new UpstreamServiceError("CV granular review cannot set OCR transcription");
    if (observation.stage === "components" && (item.type !== null || item.role !== null)) throw new UpstreamServiceError("Component granular review cannot set Element semantics");
  }
  if (topologyEdits.length) {
    if (observation.stage !== "elements") throw new UpstreamServiceError("Only Elements review may change grouping topology");
    const available = new Set((Array.isArray(observation.availableComponentIds) ? observation.availableComponentIds : []).map(Number));
    const seen = new Set<number>();
    for (const edit of topologyEdits) {
      const componentId = Number(edit.componentId);
      if (!Number.isInteger(componentId) || !available.has(componentId) || seen.has(componentId)) throw new UpstreamServiceError("Topology edits must reference unique available component IDs");
      if (Boolean(edit.destinationElementId) === Boolean(edit.newGroupKey)) throw new UpstreamServiceError("Topology edit requires exactly one destination");
      if (edit.destinationElementId && !targets.has(String(edit.destinationElementId))) throw new UpstreamServiceError("Topology destination is not an existing Element");
      if (edit.newGroupKey && !/^group-[1-9][0-9]?$/.test(String(edit.newGroupKey))) throw new UpstreamServiceError("Topology new-group key is invalid");
      seen.add(componentId);
    }
  }
}

function validateOcrEditOperations(observation: Record<string, any>, operations: Array<Record<string, any>>) {
  const targets = new Map((Array.isArray(observation.reviewTargets) ? observation.reviewTargets : []).map(object).map((item) => [String(item.id), item]));
  const compositionTargets = new Map((Array.isArray(observation.compositionTargets) ? observation.compositionTargets : []).map(object).map((item) => [String(item.id), item]));
  const available = new Set([...targets.keys(), ...compositionTargets.keys()]);
  const nodeKinds = new Map<string, "region" | "composition">([...targets.keys()].map((id) => [id, "region"]));
  for (const id of compositionTargets.keys()) nodeKinds.set(id, "composition");
  const priorOperations = array(object(observation.context).priorEditOperations).map(object);
  const priorOperationIds = new Set(priorOperations.map((operation) => String(operation.operationId)).filter(Boolean));
  for (const operation of priorOperations) {
    const operationId = String(operation.operationId); const type = String(operation.type);
    if (type === "split_region") {
      const childCount = array(object(operation.split).fractions).length + 1;
      for (let index = 1; index <= childCount; index += 1) { available.add(`${operationId}:${index}`); nodeKinds.set(`${operationId}:${index}`, "region"); }
    } else if (["edit_region", "edit_text", "merge_region", "create_region", "set_status", "rerun_ocr"].includes(type)) {
      available.add(operationId); nodeKinds.set(operationId, "region");
    } else if (type === "compose_string") {
      available.add(operationId); nodeKinds.set(operationId, "composition");
    }
  }
  const operationIds = new Set<string>(); let approvals = 0;
  const derivedTypes = new Set(["edit_region", "edit_text", "merge_region", "split_region", "create_region", "compose_string", "set_status"]);
  const allowed = new Set(["approve_region", "approve_text", "reject", "decompose_string", ...derivedTypes]);
  for (const operation of operations) {
    const id = String(operation.operationId); const type = String(operation.type); const inputs = array(operation.inputIds).map(String);
    if (!/^op-[1-9][0-9]?$/.test(id) || operationIds.has(id) || priorOperationIds.has(id) || available.has(id)) throw new UpstreamServiceError("OCR Edit Engine operation IDs must be unique op-N values");
    if (!allowed.has(type)) throw new UpstreamServiceError("OCR Edit Engine primitive is unavailable");
    if (inputs.some((input) => !available.has(input))) throw new UpstreamServiceError("OCR Edit Engine references an unknown or forward node");
    if (((type === "merge_region" || type === "compose_string") && inputs.length < 2) || (type === "create_region" && inputs.length !== 0) || (!["merge_region", "compose_string", "create_region"].includes(type) && inputs.length !== 1)) throw new UpstreamServiceError("OCR Edit Engine input cardinality is invalid");
    if (type === "compose_string" && inputs.some((input) => nodeKinds.get(input) !== "region")) throw new UpstreamServiceError("OCR compose_string accepts physical region nodes only");
    if (type === "decompose_string" && nodeKinds.get(inputs[0]!) !== "composition") throw new UpstreamServiceError("OCR decompose_string requires an existing composition");
    if (!["compose_string", "decompose_string"].includes(type) && inputs.some((input) => nodeKinds.get(input) === "composition")) throw new UpstreamServiceError("Physical OCR operations cannot consume a composition");
    for (const input of inputs) if (targets.get(input)?.duplicateOfOcrId && type !== "reject") throw new UpstreamServiceError("Duplicate OCR observations may only be rejected");
    operationIds.add(id);
    if (type === "split_region") {
      const split = object(operation.split); const fractions = array(split.fractions).map(Number);
      if (!["horizontal", "vertical"].includes(String(split.axis)) || !fractions.length || fractions.length > 3 || fractions.some((fraction, index) => !Number.isFinite(fraction) || fraction < .1 || fraction > .9 || (index > 0 && fraction <= fractions[index - 1]!))) throw new UpstreamServiceError("OCR Edit Engine split parameters are invalid");
      for (let index = 0; index <= fractions.length; index += 1) available.add(`${id}:${index + 1}`);
    } else if (derivedTypes.has(type)) { available.add(id); nodeKinds.set(id, type === "compose_string" ? "composition" : "region"); }
    if (type === "approve_region") approvals += 1;
  }
  if (!approvals) throw new UpstreamServiceError("OCR Edit Engine plan must explicitly approve at least one final region");
  validateOcrDerivedTerminals(operations);
}

function validateOcrDerivedTerminals(operations: Array<Record<string, any>>) {
  const derivedRegionIds = new Set<string>();
  const consumedByTransform = new Set<string>();
  const explicitlyResolved = new Set<string>();
  const regionTransforms = new Set(["edit_region", "edit_text", "merge_region", "split_region", "create_region", "set_status", "rerun_ocr"]);
  for (const operation of operations) {
    const operationId = String(operation.operationId); const type = String(operation.type); const inputs = array(operation.inputIds).map(String);
    if (regionTransforms.has(type) && type !== "create_region") for (const input of inputs) consumedByTransform.add(input);
    if (type === "split_region") {
      const childCount = array(object(operation.split).fractions).length + 1;
      for (let index = 1; index <= childCount; index += 1) derivedRegionIds.add(`${operationId}:${index}`);
    } else if (regionTransforms.has(type)) derivedRegionIds.add(operationId);
    if (["approve_region", "approve_text", "reject"].includes(type)) for (const input of inputs) explicitlyResolved.add(input);
  }
  const dangling = [...derivedRegionIds].filter((id) => !consumedByTransform.has(id) && !explicitlyResolved.has(id));
  if (dangling.length) throw new UpstreamServiceError(`OCR Edit Engine leaves derived region node(s) uncommitted: ${dangling.slice(0, 8).join(", ")}`);
}
