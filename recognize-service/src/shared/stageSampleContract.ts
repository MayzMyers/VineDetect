import {
  bindAllHelpersToCard,
  type HelperConfigContract,
  type WizardHelperBinding,
  type WizardStageId,
} from "./helperConfigContract.js";
import { normalizeHelperIntermediateStates, type HelperIntermediateState } from "./wizardRuntimeContract.js";

export type HelperParams = Record<string, unknown>;
export type StageInput = Record<string, unknown>;
export type StageOutput = Record<string, unknown>;

export type UnavailableStageValue = {
  availability: "unavailable";
  reason: "not-captured" | "not-persisted" | "not-reviewed" | "not-applicable";
};

export type CapturedStageValue<T> = T | UnavailableStageValue;

export type StageHelperRunV1 = {
  id: string;
  runIndex: number;
  config: HelperParams;
  candidates: unknown[];
  output: StageOutput;
  artifact?: Record<string, unknown> | null;
  intermediateStates: HelperIntermediateState[];
  createdAt?: string;
};

export type StageProposalReviewV1 = {
  reviewedBy: "human" | "llm" | "local_ml";
  reviewerSubject?: string;
  finalEditor: "helper" | "llm" | "human" | "local_ml";
  verdict: "llm_correct" | "llm_false_accept" | "llm_false_correction" | "llm_partially_correct";
  reviewedAt: string;
};

export type StageProposalV1 = {
  executor: "human" | "llm" | "local_ml" | "system";
  interactionMode?: "auto" | "manual" | "mixed";
  planId?: string;
  llmDecision?: { mode: "accepted_helper" | "modified_helper" | "manual_created"; executor: "llm" };
  review?: StageProposalReviewV1;
};

export type StageSampleV1 = {
  schemaVersion: 1;
  cardId: string;
  card: { source: string; sourceItemId: string };
  stage: WizardStageId;
  stageInput: CapturedStageValue<StageInput>;
  helper: {
    id: string;
    algorithm?: string;
    version?: string;
  };
  execution: {
    runs: StageHelperRunV1[];
    selection: { runId: string; candidateId: string } | null;
    reviewMode: "accepted" | "corrected" | "manual" | null;
    defaultParams?: HelperParams;
    initialParams: CapturedStageValue<HelperParams>;
    finalParams: CapturedStageValue<HelperParams>;
    autoOutput?: CapturedStageValue<StageOutput>;
    proposal?: StageProposalV1;
    reviewedOutput: CapturedStageValue<StageOutput>;
  };
  humanCorrection: {
    reviewed: boolean;
    paramsEdited: boolean | null;
    outputEdited: boolean | null;
    changedFields: string[];
    reviewedAt?: string;
  };
  provenance: {
    adapter: string;
    persisted: boolean;
    migrationGap: boolean;
  };
};

export type StageSampleContext = {
  source: string;
  sourceItemId: string;
  helperContract: HelperConfigContract;
  labelRoi?: unknown;
  sourceAnalysis?: unknown;
  analysis?: unknown;
  ocrRegions?: unknown;
  sourceAssociations?: unknown;
  cvJob?: unknown;
  summary?: unknown;
  finalReview?: unknown;
  stageExecutions?: unknown;
};

const STAGES: WizardStageId[] = ["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"];

export function buildStageSamplesV1(context: StageSampleContext): StageSampleV1[] {
  const bindings = bindAllHelpersToCard(context.helperContract, context.source, context.sourceItemId);
  return STAGES.map((stage) => buildStageSampleV1(context, bindings.find((binding) => binding.wizardStage === stage)!));
}

export function buildRouteStageSampleV1(binding: WizardHelperBinding, responseValue: unknown, ephemeral = false): StageSampleV1 {
  const response = objectValue(responseValue);
  const bindingRecord = {
    helperId: binding.helperId, algorithm: binding.algorithm, configSchemaVersion: binding.configSchemaVersion,
    config: binding.config, role: binding.role, provenance: binding.provenance, review: binding.review,
  };
  const helperContract: HelperConfigContract = { schemaVersion: 1, records: binding.persisted || ephemeral ? [bindingRecord] : [] };
  const context: StageSampleContext = {
    source: binding.card.source, sourceItemId: binding.card.sourceItemId, helperContract,
    stageExecutions: response.stageExecution ? [response.stageExecution] : [],
    ...(binding.wizardStage === "label" ? { labelRoi: response } : {}),
    ...(binding.wizardStage === "bottle" ? { sourceAnalysis: response } : {}),
    ...(binding.wizardStage === "ocr" ? { analysis: response, ocrRegions: response } : {}),
    ...(["mask", "morphology", "components", "elements", "contours", "palette"].includes(binding.wizardStage) ? { cvJob: response } : {}),
    ...(binding.wizardStage === "summary" ? { summary: response, finalReview: response } : {}),
  };
  const sample = buildStageSamplesV1(context).find((item) => item.stage === binding.wizardStage)!;
  sample.provenance.persisted = sample.humanCorrection.reviewed || binding.persisted;
  if (ephemeral && !response.stageExecution) {
    sample.provenance.persisted = false;
    sample.execution.initialParams = finalParamsForBinding({ ...binding, persisted: true });
    sample.execution.finalParams = unavailable("not-reviewed");
    sample.execution.autoOutput = availableObject(response) ?? unavailable("not-captured");
    sample.execution.reviewedOutput = unavailable("not-reviewed");
    sample.humanCorrection = { reviewed: false, paramsEdited: null, outputEdited: null, changedFields: [] };
  }
  return sample;
}

function buildStageSampleV1(context: StageSampleContext, binding: WizardHelperBinding): StageSampleV1 {
  const nativeExecution = arrayValue(context.stageExecutions)
    .map(objectValue)
    .find((execution) => execution.stage === binding.wizardStage);
  if (nativeExecution) return buildNativeStageSample(binding, nativeExecution);
  const labelRoi = objectValue(context.labelRoi);
  const prediction = objectValue(labelRoi.prediction);
  const annotation = objectValue(labelRoi.annotation);
  const sourceAnalysis = objectValue(context.sourceAnalysis);
  const bottle = objectValue(sourceAnalysis.bottleDetection);
  const analysis = objectValue(context.analysis);
  const ocrRegions = objectValue(context.ocrRegions);
  const cvJob = objectValue(context.cvJob);
  const preview = objectValue(cvJob.preview);
  const workflow = objectValue(cvJob.workflow);
  const checkpoint = objectValue(objectValue(workflow.checkpoints)[binding.wizardStage]);
  const storedExecution = objectValue(checkpoint.execution);
  const finalParams = finalParamsForBinding(binding);
  const storedInitialParams = capturedObject(storedExecution.initialParams);
  const storedAutoOutput = capturedObject(storedExecution.autoOutput);
  const storedReviewedOutput = capturedObject(storedExecution.reviewedOutput);

  let stageInput: CapturedStageValue<StageInput> = unavailable("not-captured");
  let initialParams: CapturedStageValue<HelperParams> = storedInitialParams ?? unavailable("not-captured");
  let autoOutput: CapturedStageValue<StageOutput> | undefined = storedAutoOutput ?? unavailable("not-captured");
  let reviewedOutput: CapturedStageValue<StageOutput> = storedReviewedOutput ?? unavailable("not-reviewed");
  let reviewed = binding.persisted && String(objectValue(binding.review).status ?? "unreviewed") !== "unreviewed";
  let reviewedAt = stringValue(checkpoint.completedAt) ?? stringValue(objectValue(binding.provenance).savedAt);

  if (binding.wizardStage === "package") {
    const packageScope = objectValue(sourceAnalysis.packageScope);
    stageInput = { source: context.source, sourceItemId: context.sourceItemId, coordinateSpace: "source-image" };
    initialParams = finalParams;
    autoOutput = unavailable("not-captured");
    reviewedOutput = Object.keys(packageScope).length ? { scope: packageScope } : { scope: null, source: "default-full-image" };
    reviewed = true;
    reviewedAt = stringValue(sourceAnalysis.savedAt) ?? reviewedAt;
  } else if (binding.wizardStage === "label") {
    stageInput = { source: context.source, sourceItemId: context.sourceItemId, imageRef: stringValue(prediction.imageUrl) };
    const algorithm = objectValue(prediction.algorithm);
    const predictionParams = objectValue(algorithm.params);
    if (Object.keys(predictionParams).length) initialParams = predictionParams;
    autoOutput = prediction && Object.keys(prediction).length ? prediction : unavailable("not-captured");
    reviewedOutput = annotation && Object.keys(annotation).length ? annotation : unavailable("not-reviewed");
    reviewed = Boolean(labelRoi.reviewed && annotation && Object.keys(annotation).length);
    reviewedAt = stringValue(annotation.reviewedAt) ?? reviewedAt;
  } else if (binding.wizardStage === "bottle") {
    stageInput = labelInput(labelRoi);
    const candidates = arrayValue(bottle.candidates);
    const selectedId = stringValue(bottle.selectedCandidateId);
    const candidate = candidates.map(objectValue).find((item) => stringValue(item.id) === selectedId);
    autoOutput = candidate ?? (candidates.length ? { candidates, selectedCandidateId: selectedId } : unavailable("not-captured"));
    const bottleAnnotation = objectValue(bottle.annotation);
    reviewedOutput = Object.keys(bottleAnnotation).length
      ? { annotation: bottleAnnotation, palette: arrayValue(bottle.palette) }
      : unavailable("not-reviewed");
    reviewed = String(bottleAnnotation.status ?? "") === "reviewed" || String(bottleAnnotation.status ?? "") === "accepted";
    reviewedAt = stringValue(sourceAnalysis.savedAt) ?? reviewedAt;
  } else if (binding.wizardStage === "ocr") {
    stageInput = cropInput(labelRoi, analysis);
    if (binding.persisted && !storedInitialParams) initialParams = finalParams;
    const generatedOcr = objectValue(analysis.ocr);
    autoOutput = Object.keys(generatedOcr).length || arrayValue(analysis.textRegions).length
      ? { ocr: generatedOcr, textRegions: arrayValue(analysis.textRegions) }
      : unavailable("not-captured");
    reviewedOutput = Object.keys(ocrRegions).length ? ocrRegions : unavailable("not-reviewed");
    reviewed = String(ocrRegions.status ?? "") === "reviewed";
    reviewedAt = stringValue(ocrRegions.createdAt) ?? stringValue(ocrRegions.created_at) ?? reviewedAt;
  } else if (["mask", "morphology", "components", "elements", "contours", "palette"].includes(binding.wizardStage)) {
    stageInput = cvStageInput(binding.wizardStage, labelRoi, analysis, workflow);
    if (!storedReviewedOutput) reviewedOutput = cvReviewedOutput(binding.wizardStage, preview, cvJob);
    const bindingReviewStatus = String(objectValue(binding.review).status ?? "");
    reviewed = String(checkpoint.status ?? "") === "valid" || ["valid", "saved", "reviewed", "accepted"].includes(bindingReviewStatus);
    if (!reviewed) reviewedOutput = unavailable("not-reviewed");
  } else {
    stageInput = {
      fromStages: STAGES.filter((stage) => stage !== "summary"),
      sourceAssociationReviewId: stringValue(objectValue(context.sourceAssociations).id),
    };
    if (binding.persisted && !storedInitialParams) initialParams = finalParams;
    autoOutput = Object.keys(objectValue(context.summary)).length ? objectValue(context.summary) : unavailable("not-captured");
    const finalReview = objectValue(context.finalReview);
    reviewedOutput = Object.keys(finalReview).length
      ? { summary: objectValue(context.summary), review: finalReview }
      : unavailable("not-reviewed");
    reviewed = Object.keys(finalReview).length > 0;
    reviewedAt = stringValue(finalReview.createdAt) ?? stringValue(finalReview.created_at) ?? reviewedAt;
  }

  const runs = arrayValue(storedExecution.helperRuns ?? storedExecution.helper_runs).map(helperRunValue).filter((run): run is StageHelperRunV1 => run !== null);
  return finalizeSample({ binding, stageInput, initialParams, finalParams, autoOutput, reviewedOutput, reviewed, reviewedAt, runs, adapter: `${binding.wizardStage}-adapter-v1` });
}

function buildNativeStageSample(binding: WizardHelperBinding, execution: Record<string, unknown>): StageSampleV1 {
  const value = (camel: string, snake: string) => execution[camel] ?? execution[snake];
  const captured = (camel: string, snake: string, reason: UnavailableStageValue["reason"]): CapturedStageValue<Record<string, unknown>> => {
    const object = objectValue(value(camel, snake));
    return Object.keys(object).length ? object : unavailable(reason);
  };
  const reviewed = execution.status === "reviewed";
  const nativeBinding: WizardHelperBinding = {
    ...binding,
    helperId: stringValue(value("helperId", "helper_id")) ?? binding.helperId,
    algorithm: stringValue(execution.algorithm) ?? binding.algorithm,
    config: {
      ...(objectValue(value("defaultParams", "default_params")) ? { defaultParams: objectValue(value("defaultParams", "default_params")) } : {}),
      algorithmVersion: stringValue(value("algorithmVersion", "algorithm_version")),
    },
    persisted: true,
  };
  const sample = finalizeSample({
    binding: nativeBinding,
    stageInput: captured("stageInput", "stage_input", "not-captured"),
    initialParams: captured("initialParams", "initial_params", "not-captured"),
    finalParams: captured("finalParams", "final_params", reviewed ? "not-persisted" : "not-reviewed"),
    autoOutput: captured("autoOutput", "auto_output", "not-captured"),
    proposal: stageProposal(execution),
    reviewedOutput: captured("reviewedOutput", "reviewed_output", "not-reviewed"),
    reviewed,
    reviewedAt: stringValue(value("reviewedAt", "reviewed_at")),
    runs: arrayValue(value("helperRuns", "helper_runs")).map(helperRunValue).filter((run): run is StageHelperRunV1 => run !== null),
    selection: stageSelection(execution),
    reviewMode: stageReviewMode(value("reviewMode", "review_mode")),
    adapter: `${binding.wizardStage}-native-execution-v1`,
  });
  sample.provenance.migrationGap = isUnavailable(sample.execution.initialParams)
    || (reviewed && isUnavailable(sample.execution.reviewedOutput));
  return sample;
}

function finalizeSample(input: {
  binding: WizardHelperBinding;
  stageInput: CapturedStageValue<StageInput>;
  initialParams: CapturedStageValue<HelperParams>;
  finalParams: CapturedStageValue<HelperParams>;
  autoOutput?: CapturedStageValue<StageOutput>;
  proposal?: StageProposalV1;
  reviewedOutput: CapturedStageValue<StageOutput>;
  reviewed: boolean;
  reviewedAt?: string | null;
  runs?: StageHelperRunV1[];
  selection?: { runId: string; candidateId: string } | null;
  reviewMode?: "accepted" | "corrected" | "manual" | null;
  adapter: string;
}): StageSampleV1 {
  const initial = availableValue(input.initialParams);
  const final = availableValue(input.finalParams);
  const auto = availableValue(input.autoOutput);
  const reviewedOutput = availableValue(input.reviewedOutput);
  const paramChanges = initial && final ? changedFields(initial, final).map((field) => `execution.params.${field}`) : [];
  const outputChanges = auto && reviewedOutput ? changedFields(auto, reviewedOutput).map((field) => `execution.output.${field}`) : [];
  const bindingConfig = objectValue(input.binding.config);
  const defaultParams = objectValue(bindingConfig.defaultParams);
  return {
    schemaVersion: 1,
    cardId: `${input.binding.card.source}:${input.binding.card.sourceItemId}`,
    card: input.binding.card,
    stage: input.binding.wizardStage,
    stageInput: input.stageInput,
    helper: {
      id: input.binding.helperId,
      algorithm: input.binding.algorithm,
      version: stringValue(bindingConfig.algorithmVersion) ?? undefined,
    },
    execution: {
      runs: input.runs ?? [],
      selection: input.selection ?? null,
      reviewMode: input.reviewMode ?? legacyReviewMode(input.reviewed, auto, reviewedOutput),
      ...(Object.keys(defaultParams).length ? { defaultParams } : {}),
      initialParams: input.initialParams,
      finalParams: input.finalParams,
      ...(input.autoOutput ? { autoOutput: input.autoOutput } : {}),
      ...(input.proposal ? { proposal: input.proposal } : {}),
      reviewedOutput: input.reviewedOutput,
    },
    humanCorrection: {
      reviewed: input.reviewed,
      paramsEdited: initial && final ? paramChanges.length > 0 : null,
      outputEdited: auto && reviewedOutput ? outputChanges.length > 0 : null,
      changedFields: [...paramChanges, ...outputChanges],
      ...(input.reviewedAt ? { reviewedAt: input.reviewedAt } : {}),
    },
    provenance: {
      adapter: input.adapter,
      persisted: input.binding.persisted,
      migrationGap: isUnavailable(input.initialParams) || isUnavailable(input.reviewedOutput),
    },
  };
}

function stageProposal(execution: Record<string, unknown>): StageProposalV1 | undefined {
  const executor = execution.proposalExecutor ?? execution.proposal_executor;
  if (executor !== "human" && executor !== "llm" && executor !== "local_ml" && executor !== "system") return undefined;
  const planId = stringValue(execution.proposalPlanId ?? execution.proposal_plan_id);
  const rawMode = execution.proposalInteractionMode ?? execution.proposal_interaction_mode;
  const interactionMode = rawMode === "auto" || rawMode === "manual" || rawMode === "mixed" ? rawMode : null;
  const review = stageProposalReview(execution.proposalReview ?? execution.proposal_review);
  const llmDecision = executor === "llm" && interactionMode
    ? { mode: interactionMode === "manual" ? "manual_created" as const : interactionMode === "mixed" ? "modified_helper" as const : "accepted_helper" as const, executor: "llm" as const }
    : undefined;
  return {
    executor,
    ...(interactionMode ? { interactionMode } : {}),
    ...(planId ? { planId } : {}),
    ...(llmDecision ? { llmDecision } : {}),
    ...(review ? { review } : {}),
  };
}

function stageProposalReview(value: unknown): StageProposalReviewV1 | undefined {
  const review = objectValue(value);
  const reviewedBy = review.reviewedBy ?? review.reviewed_by;
  const finalEditor = review.finalEditor ?? review.final_editor;
  const verdict = review.verdict;
  const reviewedAt = stringValue(review.reviewedAt ?? review.reviewed_at);
  if (reviewedBy !== "human" && reviewedBy !== "llm" && reviewedBy !== "local_ml") return undefined;
  if (finalEditor !== "helper" && finalEditor !== "llm" && finalEditor !== "human" && finalEditor !== "local_ml") return undefined;
  if (verdict !== "llm_correct" && verdict !== "llm_false_accept" && verdict !== "llm_false_correction" && verdict !== "llm_partially_correct") return undefined;
  if (!reviewedAt) return undefined;
  const reviewerSubject = stringValue(review.reviewerSubject ?? review.reviewer_subject);
  return { reviewedBy, ...(reviewerSubject ? { reviewerSubject } : {}), finalEditor, verdict, reviewedAt };
}

function helperRunValue(value: unknown): StageHelperRunV1 | null {
  const run = objectValue(value);
  const id = stringValue(run.id);
  if (!id) return null;
  return {
    id,
    runIndex: Number(run.runIndex ?? run.run_index ?? 0),
    config: objectValue(run.config),
    candidates: arrayValue(run.candidates),
    output: objectValue(run.output),
    intermediateStates: normalizeHelperIntermediateStates(run.intermediateStates ?? run.intermediate_states),
    ...(run.artifact === null || run.artifact === undefined ? {} : { artifact: objectValue(run.artifact) }),
    ...(stringValue(run.createdAt ?? run.created_at) ? { createdAt: stringValue(run.createdAt ?? run.created_at)! } : {}),
  };
}

function stageSelection(execution: Record<string, unknown>) {
  const selection = objectValue(execution.selection);
  const runId = stringValue(selection.runId ?? execution.selectedRunId ?? execution.selected_run_id);
  const candidateId = stringValue(selection.candidateId ?? execution.selectedCandidateId ?? execution.selected_candidate_id);
  return runId && candidateId ? { runId, candidateId } : null;
}

function stageReviewMode(value: unknown): "accepted" | "corrected" | "manual" | null {
  return value === "accepted" || value === "corrected" || value === "manual" ? value : null;
}

function legacyReviewMode(reviewed: boolean, auto: Record<string, unknown> | null, output: Record<string, unknown> | null) {
  if (!reviewed) return null;
  if (!auto) return "manual" as const;
  return stableJson(auto) === stableJson(output) ? "accepted" as const : "corrected" as const;
}

function finalParamsForBinding(binding: WizardHelperBinding): CapturedStageValue<HelperParams> {
  if (!binding.persisted) return unavailable("not-persisted");
  const config = objectValue(binding.config);
  const nestedParams = objectValue(config.params);
  return Object.keys(nestedParams).length ? nestedParams : config;
}

function labelInput(labelRoi: Record<string, unknown>): CapturedStageValue<StageInput> {
  const annotation = objectValue(labelRoi.annotation);
  return Object.keys(annotation).length
    ? { labelAnnotationId: annotation.id ?? null, labelRevision: annotation.revision ?? null, roi: annotation.roi ?? null }
    : unavailable("not-reviewed");
}

function cropInput(labelRoi: Record<string, unknown>, analysis: Record<string, unknown>): CapturedStageValue<StageInput> {
  const label = labelInput(labelRoi);
  if (isUnavailable(label)) return label;
  const crop = objectValue(analysis.crop);
  return { ...label, cropAssetPath: crop.assetPath ?? analysis.cropAssetPath ?? null, analysisJobId: analysis.jobId ?? null };
}

function cvStageInput(stage: WizardStageId, labelRoi: Record<string, unknown>, analysis: Record<string, unknown>, workflow: Record<string, unknown>): CapturedStageValue<StageInput> {
  const crop = cropInput(labelRoi, analysis);
  if (isUnavailable(crop)) return crop;
  const previousStage: Partial<Record<WizardStageId, WizardStageId>> = {
    morphology: "mask", components: "morphology", elements: "components", contours: "elements", palette: "contours",
  };
  const upstream = previousStage[stage];
  return { ...crop, ...(upstream ? { upstreamStage: upstream, upstreamCheckpoint: objectValue(objectValue(workflow.checkpoints)[upstream]) } : {}) };
}

function cvReviewedOutput(stage: WizardStageId, preview: Record<string, unknown>, cvJob: Record<string, unknown>): CapturedStageValue<StageOutput> {
  const debug = objectValue(preview.cvDebug);
  if (stage === "mask") return Object.keys(debug).length || cvJob.debugArtifact ? { debugArtifact: cvJob.debugArtifact ?? null, mask: debug.mask ?? debug.binaryMask ?? null, source: debug.source ?? null } : unavailable("not-captured");
  if (stage === "morphology") return Object.keys(debug).length ? { autoConfig: debug.autoMorphologyConfig ?? null, effectiveConfig: debug.effectiveMorphologyConfig ?? null, score: debug.autoMorphologyScore ?? null } : unavailable("not-captured");
  if (stage === "components") return arrayValue(preview.components).length || Object.keys(objectValue(objectValue(cvJob.review).componentDecisions)).length ? { components: arrayValue(preview.components), decisions: objectValue(objectValue(cvJob.review).componentDecisions) } : unavailable("not-captured");
  if (stage === "elements") return arrayValue(preview.elements).length ? { elements: arrayValue(preview.elements) } : unavailable("not-captured");
  if (stage === "contours") return arrayValue(preview.contours).length ? { contours: arrayValue(preview.contours) } : unavailable("not-captured");
  return arrayValue(cvJob.palette).length || arrayValue(preview.palette).length ? { palette: arrayValue(cvJob.palette).length ? arrayValue(cvJob.palette) : arrayValue(preview.palette) } : unavailable("not-captured");
}

export function unavailable(reason: UnavailableStageValue["reason"]): UnavailableStageValue {
  return { availability: "unavailable", reason };
}

function isUnavailable(value: unknown): value is UnavailableStageValue {
  return objectValue(value).availability === "unavailable";
}

function availableValue(value: unknown): Record<string, unknown> | null {
  const object = objectValue(value);
  return Object.keys(object).length && !isUnavailable(object) ? object : null;
}

function availableObject(value: unknown): Record<string, unknown> | null {
  const object = objectValue(value);
  return Object.keys(object).length ? object : null;
}

function capturedObject(value: unknown): CapturedStageValue<Record<string, unknown>> | null {
  const object = objectValue(value);
  return Object.keys(object).length ? object : null;
}

function changedFields(left: unknown, right: unknown, prefix = ""): string[] {
  if (stableJson(left) === stableJson(right)) return [];
  const leftObject = objectValue(left);
  const rightObject = objectValue(right);
  if (!Object.keys(leftObject).length || !Object.keys(rightObject).length || Array.isArray(left) || Array.isArray(right)) return [prefix || "$value"];
  const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
  return keys.flatMap((key) => changedFields(leftObject[key], rightObject[key], prefix ? `${prefix}.${key}` : key));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
