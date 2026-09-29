import type { WizardStageId } from "./helperConfigContract.js";

export const WIZARD_RUNTIME_DEFINITION_VERSION = "wizard-runtime-v1";

export type LlmStageActionId = "accept" | "review" | "rerun" | "human_required";
export type StageRuntimeStateId = "helper_output_ready" | "helper_running" | "plan_ready" | "blocked";
export type LlmActionFlow = "create_plan" | "rerun_helper" | "stop";

export type WizardRuntimeActionDefinition = {
  id: LlmStageActionId;
  flow: LlmActionFlow;
  requiresCandidate: boolean;
};

export type HelperIntermediateState = {
  id: string;
  parentId: string | null;
  sequence: number;
  status: "pending" | "completed" | "failed";
  algorithm: string | null;
  summary: Record<string, unknown>;
};

export type WizardRuntimeDefinition = {
  version: typeof WIZARD_RUNTIME_DEFINITION_VERSION;
  stage: WizardStageId;
  algorithms: string[];
  actions: LlmStageActionId[];
  maxLlmIterations: number;
  transitions: Array<{ from: StageRuntimeStateId; event: string; to: StageRuntimeStateId }>;
};

const BASE_TRANSITIONS: WizardRuntimeDefinition["transitions"] = [
  { from: "helper_output_ready", event: "accept", to: "plan_ready" },
  { from: "helper_output_ready", event: "review", to: "plan_ready" },
  { from: "helper_output_ready", event: "rerun", to: "helper_running" },
  { from: "helper_running", event: "helper_completed", to: "helper_output_ready" },
  { from: "helper_output_ready", event: "human_required", to: "blocked" },
];

const actionDefinitions: Record<LlmStageActionId, WizardRuntimeActionDefinition> = {
  accept: { id: "accept", flow: "create_plan", requiresCandidate: true },
  review: { id: "review", flow: "create_plan", requiresCandidate: true },
  rerun: { id: "rerun", flow: "rerun_helper", requiresCandidate: false },
  human_required: { id: "human_required", flow: "stop", requiresCandidate: false },
};

const definitions: Record<WizardStageId, WizardRuntimeDefinition> = {
  package: definition("package", ["package-smart-lasso-v1"], ["accept", "human_required"], 0),
  label: definition("label", ["label-multi-family-consensus-v7", "label-multi-family-consensus-v6", "label-multi-family-consensus-v4"], ["accept", "review", "rerun", "human_required"], 2),
  bottle: definition("bottle", ["bottle-border-flood-v2"], ["accept", "rerun", "human_required"], 2),
  ocr: definition("ocr", ["tesseract-cascade-v6"], ["accept", "review", "human_required"], 2),
  mask: definition("mask", ["binary-mask-variant-search-v1"], ["accept", "human_required"], 1),
  morphology: definition("morphology", ["label-morphology-v1"], ["accept", "rerun", "human_required"], 2),
  components: definition("components", ["connected-components-v2", "connected-components-v1"], ["accept", "review", "rerun", "human_required"], 2),
  elements: definition("elements", ["element-grouping-v1"], ["accept", "review", "human_required"], 0),
  contours: definition("contours", ["component-contours-v2", "component-contours-v1"], ["accept", "rerun", "human_required"], 2),
  palette: definition("palette", ["label-palette-v1"], ["accept", "rerun", "human_required"], 2),
  summary: definition("summary", ["canonical-summary-validation"], ["accept", "human_required"], 0),
};

export function wizardRuntimeDefinition(stage: WizardStageId) { return definitions[stage]; }
export function wizardRuntimeDefinitions() { return Object.values(definitions); }
export function wizardRuntimeAction(action: LlmStageActionId) { return actionDefinitions[action]; }
export function wizardRuntimeActions() { return Object.values(actionDefinitions); }

export function buildStageRuntimeSnapshot(input: {
  stage: WizardStageId;
  algorithm: string;
  iteration?: number;
  intermediateStates?: unknown;
}) {
  const definition = wizardRuntimeDefinition(input.stage);
  return {
    definitionVersion: definition.version,
    stage: input.stage,
    state: "helper_output_ready" as const,
    iteration: input.iteration ?? 0,
    algorithms: definition.algorithms,
    availableActions: definition.actions,
    helper: {
      algorithm: input.algorithm,
      intermediateStates: normalizeHelperIntermediateStates(input.intermediateStates),
    },
  };
}

export function transitionStageRuntime(stage: WizardStageId, state: StageRuntimeStateId, event: string) {
  const transition = wizardRuntimeDefinition(stage).transitions.find((item) => item.from === state && item.event === event);
  return transition?.to ?? null;
}

export function normalizeHelperIntermediateStates(value: unknown): HelperIntermediateState[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.slice(0, 32).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" && /^[a-z0-9][a-z0-9_.:-]{0,79}$/i.test(item.id) ? item.id : null;
    const status: HelperIntermediateState["status"] | null = item.status === "pending" || item.status === "completed" || item.status === "failed" ? item.status : null;
    if (!id || !status) return [];
    const parentId = typeof item.parentId === "string" && /^[a-z0-9][a-z0-9_.:-]{0,79}$/i.test(item.parentId) ? item.parentId : null;
    const algorithm = typeof item.algorithm === "string" && /^[a-z0-9][a-z0-9_.:@/-]{0,159}$/i.test(item.algorithm) ? item.algorithm : null;
    const summary = item.summary && typeof item.summary === "object" && !Array.isArray(item.summary)
      ? boundedObject(item.summary as Record<string, unknown>) : {};
    return [{ id, parentId, sequence: Number.isInteger(item.sequence) ? Number(item.sequence) : index, status, algorithm, summary } satisfies HelperIntermediateState];
  });
  const ids = new Set(normalized.map((item) => item.id));
  return normalized.map((item) => ({ ...item, parentId: item.parentId && ids.has(item.parentId) && item.parentId !== item.id ? item.parentId : null }));
}

function definition(stage: WizardStageId, algorithms: string[], actions: LlmStageActionId[], maxLlmIterations: number): WizardRuntimeDefinition {
  return { version: WIZARD_RUNTIME_DEFINITION_VERSION, stage, algorithms, actions, maxLlmIterations, transitions: BASE_TRANSITIONS };
}

function boundedObject(value: Record<string, unknown>) {
  const entries = Object.entries(value).slice(0, 32).map(([key, item]) => [key.slice(0, 80), boundedValue(item)]);
  return Object.fromEntries(entries);
}
function boundedValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(boundedValue);
  if (value && typeof value === "object") return boundedObject(value as Record<string, unknown>);
  return null;
}
