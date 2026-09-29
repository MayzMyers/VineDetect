import type { WizardStageId } from "./helperConfigContract.js";

export const EDIT_ENGINE_VERSION = "edit-engine-v1";

export type EditOperationActor = "autodetect" | "llm" | "human" | "local_ml" | "system" | "unknown";
export type EditPrimitiveId =
  | "accept" | "reject" | "edit" | "merge" | "split" | "create" | "delete" | "reparent" | "set_semantic" | "approve"
  | "approve_region" | "approve_text" | "edit_region" | "edit_text" | "merge_region" | "split_region"
  | "create_region" | "delete_region" | "rerun_ocr" | "compose_string" | "decompose_string" | "set_status" | "set_role" | "set_order";

export type EditPrimitiveDefinition = {
  id: EditPrimitiveId;
  createsDerivedNode: boolean;
  mutatesInput: false;
  requiresInputs: boolean;
  inputCardinality: { min: number; max: number };
};

export type StageEditDefinition = {
  version: typeof EDIT_ENGINE_VERSION;
  stage: WizardStageId;
  primitives: EditPrimitiveId[];
  humanApprovalRequired: true;
  maxLlmIterations: number;
};

const PRIMITIVES: Record<EditPrimitiveId, EditPrimitiveDefinition> = {
  accept: primitive("accept", false, 1, 1),
  reject: primitive("reject", false, 1, 1),
  edit: primitive("edit", true, 1, 1),
  merge: primitive("merge", true, 2, 20),
  split: primitive("split", true, 1, 1),
  create: primitive("create", true, 0, 0),
  delete: primitive("delete", false, 1, 1),
  reparent: primitive("reparent", true, 1, 1),
  set_semantic: primitive("set_semantic", true, 1, 1),
  approve: primitive("approve", false, 1, 1),
  approve_region: primitive("approve_region", false, 1, 1),
  approve_text: primitive("approve_text", false, 1, 1),
  edit_region: primitive("edit_region", true, 1, 1),
  edit_text: primitive("edit_text", true, 1, 1),
  merge_region: primitive("merge_region", true, 2, 20),
  split_region: primitive("split_region", true, 1, 1),
  create_region: primitive("create_region", true, 0, 0),
  delete_region: primitive("delete_region", false, 1, 1),
  rerun_ocr: primitive("rerun_ocr", true, 1, 1),
  compose_string: primitive("compose_string", true, 2, 100),
  decompose_string: primitive("decompose_string", false, 1, 1),
  set_status: primitive("set_status", true, 1, 1),
  set_role: primitive("set_role", true, 1, 1),
  set_order: primitive("set_order", true, 1, 100),
};

const STAGE_PRIMITIVES: Record<WizardStageId, EditPrimitiveId[]> = {
  package: ["create", "edit", "delete", "set_semantic", "approve"],
  label: ["accept", "reject", "edit", "merge", "create", "delete", "set_semantic", "approve"],
  bottle: ["accept", "reject", "edit", "set_semantic", "approve"],
  ocr: ["approve_region", "approve_text", "reject", "edit_region", "edit_text", "merge_region", "split_region", "create_region", "delete_region", "rerun_ocr", "compose_string", "decompose_string", "reparent", "set_status", "set_role", "set_order", "approve"],
  mask: ["accept", "edit", "approve"],
  morphology: ["accept", "edit", "approve"],
  components: ["accept", "reject", "edit", "delete", "approve"],
  elements: ["accept", "reject", "edit", "merge", "split", "create", "delete", "set_semantic", "approve"],
  contours: ["accept", "reject", "edit", "approve"],
  palette: ["accept", "reject", "edit", "create", "delete", "approve"],
  summary: ["approve"],
};

export function editPrimitive(id: EditPrimitiveId) { return PRIMITIVES[id]; }
export function editPrimitives() { return Object.values(PRIMITIVES); }
export function stageEditDefinition(stage: WizardStageId, maxLlmIterations = 0): StageEditDefinition {
  return { version: EDIT_ENGINE_VERSION, stage, primitives: STAGE_PRIMITIVES[stage], humanApprovalRequired: true, maxLlmIterations };
}
export function stageEditDefinitions(maxIterations: Partial<Record<WizardStageId, number>> = {}) {
  return (Object.keys(STAGE_PRIMITIVES) as WizardStageId[]).map((stage) => stageEditDefinition(stage, maxIterations[stage] ?? 0));
}

function primitive(id: EditPrimitiveId, createsDerivedNode: boolean, minInputs: number, maxInputs: number): EditPrimitiveDefinition {
  return { id, createsDerivedNode, mutatesInput: false, requiresInputs: minInputs > 0, inputCardinality: { min: minInputs, max: maxInputs } };
}
