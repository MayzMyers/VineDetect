import type { WizardStageId } from "./helperConfigContract.js";
import { WIZARD_RUNTIME_DEFINITION_VERSION, wizardRuntimeActions, wizardRuntimeDefinitions } from "./wizardRuntimeContract.js";
import { EDIT_ENGINE_VERSION, editPrimitives, stageEditDefinitions } from "./editStageContract.js";

export type WizardScope = "package" | "label" | "item";
export type WizardCommandName =
  | "run_helper"
  | "select_candidate"
  | "update_params"
  | "create_region"
  | "edit_region"
  | "delete_region"
  | "merge"
  | "reparent"
  | "set_semantic"
  | "commit";

export type WizardStageGuide = {
  stage: WizardStageId;
  displayName: string;
  goal: string;
  scope: WizardScope;
  prerequisites: WizardStageId[];
  requirements: string[];
  availableActions: WizardCommandName[];
  constraints: string[];
  helperId: string;
  existingApi: string[];
};

const LABEL_BRANCH_REQUIREMENT = "A label-scoped stage requires an explicit canonical labelId when the Package owns more than one Label.";

export const WIZARD_STAGE_ORDER: WizardStageId[] = [
  "package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary",
];

const GUIDES: Record<WizardStageId, WizardStageGuide> = {
  package: guide("package", "Package", "Define the technical source-image working scope and coarse package type.", "package", [], "package-scope",
    ["Full image is a valid default scope.", "Package scope is helper input, not object segmentation ground truth."],
    ["Do not create Label or OCR entities.", "Do not treat the crop rectangle as Object Context ground truth."],
    ["run_helper", "select_candidate", "create_region", "edit_region", "delete_region", "set_semantic", "commit"],
    ["POST /management/items/{source}/{sourceItemId}/annotation/helpers/package/run", "POST /management/items/{source}/{sourceItemId}/packages", "PATCH|DELETE /management/items/{source}/{sourceItemId}/annotation-entities/package/{packageId}"]),
  label: guide("label", "Label", "Locate and review one or more Label/VisualRegion regions inside the selected Package.", "package", ["package"], "label-roi-detection",
    ["Every Label belongs to exactly one Package.", "Multiple Labels are allowed.", "Auto-detect may produce zero or more candidates."],
    ["Do not create OCR entities.", "Do not change Package scope."],
    ["run_helper", "select_candidate", "update_params", "create_region", "edit_region", "delete_region", "merge", "set_semantic", "commit"],
    ["POST /management/metadata/{source}/{sourceItemId}/label-annotation/source-analysis/run", "POST /management/items/{source}/{sourceItemId}/packages/{packageId}/labels/review", "POST /management/items/{source}/{sourceItemId}/packages/{packageId}/labels", "PATCH|DELETE /management/items/{source}/{sourceItemId}/annotation-entities/label/{labelId}"]),
  bottle: guide("bottle", "Object Context", "Extract and review the physical package contour inside Package scope.", "package", ["package"], "bottle-outline",
    ["The contour is physical-object segmentation ground truth.", "The compatibility API key remains bottle while the UI name is Object Context."],
    ["Do not overwrite Package scope.", "Do not bind Object Context to a Label branch."],
    ["run_helper", "select_candidate", "update_params", "edit_region", "set_semantic", "commit"],
    ["POST /management/metadata/{source}/{sourceItemId}/label-annotation/source-analysis/run", "PUT /management/metadata/{source}/{sourceItemId}/label-annotation/source-analysis"]),
  ocr: guide("ocr", "OCR", "Detect, recognize, deduplicate and review text regions inside one Label/VisualRegion.", "label", ["label"], "label-ocr-cascade",
    [LABEL_BRANCH_REQUIREMENT, "Every canonical OCR belongs to exactly one Label.", "Text geometry and transcription confidence are independent review signals."],
    ["Do not create package-owned OCR.", "Merge normalizes identity; reparent reviews structural semantics separately."],
    ["run_helper", "select_candidate", "update_params", "create_region", "edit_region", "delete_region", "merge", "reparent", "set_semantic", "commit"],
    ["POST /management/items/{source}/{sourceItemId}/annotation/helpers/ocr/run", "POST /management/items/{source}/{sourceItemId}/annotation/helpers/ocr/review", "POST /management/items/{source}/{sourceItemId}/annotation/ocr/dedupe-preflight", "POST /management/items/{source}/{sourceItemId}/annotation/ocr/{ocrId}/reparent", "PATCH|DELETE /management/items/{source}/{sourceItemId}/annotation-entities/ocr/{ocrId}"]),
  mask: cvGuide("mask", "Mask", "Build and review the binary foreground mask inside the selected Label crop.", ["ocr"], "label-mask"),
  morphology: cvGuide("morphology", "Morphology", "Review morphology applied to the saved Mask result.", ["mask"], "label-morphology"),
  components: cvGuide("components", "Components", "Review connected component candidates derived from Morphology.", ["morphology"], "label-components"),
  elements: cvGuide("elements", "Elements", "Group accepted Components into semantic Elements.", ["components"], "label-elements"),
  contours: cvGuide("contours", "Contours", "Extract reviewed contours for accepted semantic Elements.", ["elements"], "label-contours"),
  palette: cvGuide("palette", "Palette", "Review detected and manually sampled Label colours.", ["contours"], "label-palette"),
  summary: guide("summary", "Summary", "Validate and review the complete Package and Label branches for export.", "item", ["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette"], "label-summary",
    ["Summary aggregates all Packages and Label branches.", "Unresolved identity conflicts block canonical export."],
    ["Do not mutate upstream geometry implicitly.", "A reviewed Summary must refer to persisted upstream state."],
    ["commit"], ["GET /management/items/{source}/{sourceItemId}/annotations", "PUT /management/metadata/{source}/{sourceItemId}/label-annotation/analysis/review"]),
};

export function wizardWorkflowContract() {
  return {
    schemaVersion: 1,
    stages: WIZARD_STAGE_ORDER.map((stage) => GUIDES[stage]),
    commandVocabulary: ["run_helper", "select_candidate", "update_params", "create_region", "edit_region", "delete_region", "merge", "reparent", "set_semantic", "commit"] as WizardCommandName[],
    executorTypes: ["human", "llm", "local_ml", "system"] as const,
    interactionModes: ["auto", "manual", "mixed"] as const,
    runtimeDefinitionVersion: WIZARD_RUNTIME_DEFINITION_VERSION,
    runtimeDefinitions: wizardRuntimeDefinitions(),
    runtimeActions: wizardRuntimeActions(),
    editEngineVersion: EDIT_ENGINE_VERSION,
    editPrimitives: editPrimitives(),
    stageEditDefinitions: stageEditDefinitions(Object.fromEntries(wizardRuntimeDefinitions().map((item) => [item.stage, item.maxLlmIterations]))),
  };
}

export function wizardStageGuide(stage: WizardStageId) { return GUIDES[stage]; }

function cvGuide(stage: WizardStageId, displayName: string, goal: string, prerequisites: WizardStageId[], helperId: string) {
  return guide(stage, displayName, goal, "label", prerequisites, helperId,
    [LABEL_BRANCH_REQUIREMENT, "Preview is ephemeral; checkpoint/commit is the reviewed persistence boundary."],
    ["Do not run outside the selected reviewed Label crop.", "Do not silently rewrite an upstream checkpoint."],
    ["run_helper", "update_params", "select_candidate", "edit_region", "delete_region", "set_semantic", "commit"],
    ["POST /management/metadata/{source}/{sourceItemId}/label-annotation/analysis/cv-preview", "PUT /management/metadata/{source}/{sourceItemId}/label-annotation/analysis/cv-checkpoint"]);
}

function guide(stage: WizardStageId, displayName: string, goal: string, scope: WizardScope, prerequisites: WizardStageId[], helperId: string,
  requirements: string[], constraints: string[], availableActions: WizardCommandName[], existingApi: string[]): WizardStageGuide {
  return { stage, displayName, goal, scope, prerequisites, requirements, availableActions, constraints, helperId, existingApi };
}
