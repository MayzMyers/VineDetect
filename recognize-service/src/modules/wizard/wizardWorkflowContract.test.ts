import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { wizardStageGuide, wizardWorkflowContract } from "../../shared/wizardWorkflowContract.js";
import { externalControllerPlanRequestSchema, llmHumanReviewSchema, localMlControllerPlanRequestSchema, localMlControllerResponseSchema, packageMultiplicityCommandSchema, stageLlmDecisionResponseSchema, wizardAutomationRunSchema, wizardCommandSchema, wizardCorrectionPlanSchema, wizardManualOcrCreateSchema, wizardVisualRenderSchema } from "./wizard.schemas.js";
import { isTerminalCorrectionPlanStatus, resolveCorrectionPlanExecutor, validateLlmReview } from "./wizard-correction-plan.service.js";
import { planSystemControllerOperations } from "./wizard-system-controller.service.js";
import { projectLabelPoint, projectSourcePoint } from "./wizard-visual.service.js";
import { automationStagesThrough } from "./wizard-automation.service.js";
import { createRecognizeJobSchema, retryRecognizeJobSchema } from "../jobs/jobs.schemas.js";
import { requestLocalMlController } from "./wizard-local-ml-controller.service.js";
import { decisionEvidence, requestLlmController, requestLlmStageController, terminalOcrApprovalOperations } from "./wizard-llm-controller.service.js";
import { appendOcrOperations, applyElementTopology, applyLlmSemanticAdjustment, buildLabelEditPlanOperation, buildOcrEditPlanOperation, buildOcrEditPlanOperations, requiresOcrNormalization } from "./wizard-llm-stage-runtime.service.js";
import { UpstreamServiceError } from "../../shared/errors.js";
import { executeEditOperationPlan, registeredEditOperationPrimitives } from "./wizard-edit-operation-engine.service.js";
import { wizardRuntimeDefinition } from "../../shared/wizardRuntimeContract.js";
import { LlmWizardStageError } from "./wizard-llm-orchestration.service.js";
import { ExternalControllerRequestCancelledError } from "./wizard-external-controller.service.js";

test("LLM pipeline stage errors retain the interrupted stage and partial progress", () => {
  const error = new LlmWizardStageError({
    stage: "ocr",
    labelId: "8d48202e-bbc7-47df-b3ca-3a88b79ddb5a",
    sessionId: "de7aa4c4-b1e7-4bdc-a6e1-9d0888f73ef1",
    message: "provider timeout",
    failedAt: "2026-09-05T10:00:00.000Z",
  }, new Error("provider timeout"));
  error.completedStages = [{ stage: "package", status: "completed" }, { stage: "label", status: "completed" }];
  assert.equal(error.failure.stage, "ocr");
  assert.equal(error.failure.labelId, "8d48202e-bbc7-47df-b3ca-3a88b79ddb5a");
  assert.equal(error.completedStages.length, 2);
  assert.match(error.message, /LLM Wizard stage ocr.*failed: provider timeout/);
});

test("terminal correction plans are safe idempotent apply responses", () => {
  assert.equal(isTerminalCorrectionPlanStatus("applied"), true);
  assert.equal(isTerminalCorrectionPlanStatus("partially_applied"), true);
  assert.equal(isTerminalCorrectionPlanStatus("failed"), true);
  assert.equal(isTerminalCorrectionPlanStatus("validated"), false);
  assert.equal(isTerminalCorrectionPlanStatus("applying"), false);
});

test("accepted Original rectification advances OCR without inventing a transform", () => {
  const label = { id: "label-1", rectification: null };
  assert.equal(requiresOcrNormalization(label, []), true);
  assert.equal(requiresOcrNormalization(label, [{
    operationType: "edit_label", helper: { id: "label-rectification" }, result: { id: "label-1" },
    status: "reviewed", reviewMode: "accepted",
  }]), false);
  assert.equal(requiresOcrNormalization(label, [{
    operationType: "edit_label", helper: { id: "label-rectification" }, result: { id: "another-label" },
    status: "reviewed", reviewMode: "accepted",
  }]), true);
});

test("headless workflow exposes every UI wizard stage in canonical order", () => {
  const contract = wizardWorkflowContract();
  assert.deepEqual(contract.stages.map((item) => item.stage), ["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"]);
  assert.equal(new Set(contract.stages.map((item) => item.helperId)).size, 11);
  assert.equal(contract.runtimeDefinitionVersion, "wizard-runtime-v1");
  assert.equal(contract.runtimeDefinitions.length, 11);
  assert.deepEqual(contract.runtimeActions.map((item) => item.id), ["accept", "review", "rerun", "human_required"]);
  assert.equal(contract.editEngineVersion, "edit-engine-v1");
  assert.equal(contract.editPrimitives.every((item) => item.mutatesInput === false), true);
  assert.deepEqual(contract.editPrimitives.find((item) => item.id === "merge")?.inputCardinality, { min: 2, max: 20 });
  assert.deepEqual(contract.stageEditDefinitions.find((item) => item.stage === "label")?.primitives,
    ["accept", "reject", "edit", "merge", "create", "delete", "set_semantic", "approve"]);
  assert.equal(contract.stageEditDefinitions.every((item) => item.humanApprovalRequired), true);
});

test("Edit Engine registry dispatches only implemented stage primitives", () => {
  assert.deepEqual(registeredEditOperationPrimitives("label"), ["accept", "reject", "edit", "merge"]);
  assert.deepEqual(registeredEditOperationPrimitives("ocr"), ["approve_region", "approve_text", "reject", "edit_region", "edit_text", "merge_region", "split_region", "create_region", "rerun_ocr", "compose_string", "decompose_string", "set_status"]);
  assert.equal(wizardRuntimeDefinition("ocr").maxLlmIterations, 2);
  assert.deepEqual(registeredEditOperationPrimitives("bottle"), []);
  const geometry = { type: "quad", points: [], bbox: { x: 10, y: 10, width: 20, height: 20 } };
  assert.throws(() => executeEditOperationPlan({
    stage: "bottle",
    initialNodes: [{ id: "roi-1", payload: geometry, sources: new Map([["roi-1", geometry]]) }],
    operations: [{ operationId: "op-1", type: "accept", inputIds: ["roi-1"], adjustment: null }],
  }), /handler is not implemented/);
  assert.throws(() => executeEditOperationPlan({
    stage: "label",
    initialNodes: [{ id: "roi-1", payload: geometry, sources: new Map([["roi-1", geometry]]) }],
    operations: [{ operationId: "op-1", type: "merge", inputIds: ["roi-1"], adjustment: null }],
  }), /requires 2\.\.20 input/);
});

test("OCR Edit Engine keeps immutable candidates and emits one physical merge result", () => {
  const geometry = (x: number, y: number, width: number, height: number) => ({
    type: "quad", points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], bbox: { x, y, width, height },
  });
  const operation = buildOcrEditPlanOperation({
    operationId: "6f481c18-b439-4ac3-bff7-e6261471377a",
    candidates: [
      { id: "ocr-a", payload: { geometry: geometry(.1, .2, .2, .1), transcription: "CABER", transcriptionStatus: "partial", suggestedParent: { type: "label", id: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" } } },
      { id: "ocr-b", payload: { geometry: geometry(.3, .2, .25, .1), transcription: "NET", transcriptionStatus: "verified", suggestedParent: { type: "label", id: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" } } },
    ],
  }, "ocr-run:1", "d73ec9a2-1a70-465e-b8c1-a8371072b92c", [
    { operationId: "op-1", type: "edit_text", inputIds: ["ocr-a"], adjustment: null, geometry: null, text: "CABERNET", transcriptionStatus: "verified" },
    { operationId: "op-2", type: "merge_region", inputIds: ["op-1", "ocr-b"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
    { operationId: "op-3", type: "approve_region", inputIds: ["op-2"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
  ]);
  const payload = operation.payload as any;
  assert.equal(payload.reviews.length, 2);
  assert.equal(payload.reviews.every((item: any) => item.state === "edited"), true);
  assert.equal(payload.reviews[0].mergeGroupId, payload.reviews[1].mergeGroupId);
  assert.equal((operation.proposedOutput as any).derivedOutputs[0].sourceCandidateIds.length, 2);
});

test("OCR Edit Engine maps a created node to a canonical create_region command", () => {
  const geometry = { type: "quad" as const, points: [{ x: .1, y: .1 }, { x: .4, y: .1 }, { x: .4, y: .2 }, { x: .1, y: .2 }] as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }], bbox: { x: .1, y: .1, width: .3, height: .1 } };
  const operations = buildOcrEditPlanOperations({
    operationId: "6f481c18-b439-4ac3-bff7-e6261471377a", config: { languages: ["rus"] },
    candidates: [{ id: "noise", payload: { geometry, transcription: "", transcriptionStatus: "unreadable", suggestedParent: { type: "label", id: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" } } }],
  }, "ocr-run:1", "d73ec9a2-1a70-465e-b8c1-a8371072b92c", [
    { operationId: "op-1", type: "reject", inputIds: ["noise"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
    { operationId: "op-2", type: "create_region", inputIds: [], adjustment: null, geometry, text: "MASSANDRA", transcriptionStatus: "verified" },
    { operationId: "op-3", type: "approve_region", inputIds: ["op-2"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
  ]);
  assert.deepEqual(operations.map((operation) => operation.command), ["select_candidate", "create_region"]);
  assert.equal((operations[0]!.payload as any).reviews[0].state, "rejected");
  assert.equal((operations[1]!.payload as any).annotation.transcription.text, "MASSANDRA");
});

test("OCR Edit Engine can recover an empty helper run with a created region", () => {
  const geometry = { type: "quad" as const, points: [{ x: .12, y: .62 }, { x: .88, y: .62 }, { x: .88, y: .78 }, { x: .12, y: .78 }] as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }], bbox: { x: .12, y: .62, width: .76, height: .16 } };
  const operations = buildOcrEditPlanOperations({
    operationId: "6f481c18-b439-4ac3-bff7-e6261471377a", config: { languages: ["rus", "eng"] }, candidates: [],
  }, "ocr-run:empty", "d73ec9a2-1a70-465e-b8c1-a8371072b92c", [
    { operationId: "op-1", type: "create_region", inputIds: [], adjustment: null, geometry, text: "VINTAGE", transcriptionStatus: "verified" },
    { operationId: "op-2", type: "approve_region", inputIds: ["op-1"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
  ]);
  assert.deepEqual(operations.map((operation) => operation.command), ["select_candidate", "create_region"]);
  assert.deepEqual((operations[0]!.payload as any).reviews, []);
  assert.equal((operations[1]!.payload as any).annotation.transcription.text, "VINTAGE");
  assert.equal((operations[1]!.payload as any).annotation.coordinateSpace.type, "label-rectified");
});

test("OCR Edit Engine rejects a terminal derived region without an explicit decision", () => {
  const geometry = { type: "quad" as const, points: [{ x: .12, y: .62 }, { x: .88, y: .62 }, { x: .88, y: .78 }, { x: .12, y: .78 }] as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }], bbox: { x: .12, y: .62, width: .76, height: .16 } };
  assert.throws(() => buildOcrEditPlanOperations({
    operationId: "6f481c18-b439-4ac3-bff7-e6261471377a", config: { languages: ["rus", "eng"] },
    candidates: [{ id: "ocr-a", payload: { geometry, transcription: "BRUT", transcriptionStatus: "verified", suggestedParent: { type: "label", id: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" } } }],
  }, "ocr-run:dangling", "d73ec9a2-1a70-465e-b8c1-a8371072b92c", [
    { operationId: "op-1", type: "approve_region", inputIds: ["ocr-a"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
    { operationId: "op-2", type: "create_region", inputIds: [], adjustment: null, geometry, text: "AGORA WINERY", transcriptionStatus: "verified" },
  ]), /uncommitted: op-2/);
});

test("OCR Edit Engine preserves one candidate to many outputs for a physical split", () => {
  const geometry = { type: "quad", points: [{ x: .1, y: .2 }, { x: .7, y: .2 }, { x: .7, y: .4 }, { x: .1, y: .4 }], bbox: { x: .1, y: .2, width: .6, height: .2 } };
  const operations = buildOcrEditPlanOperations({
    operationId: "6f481c18-b439-4ac3-bff7-e6261471377a",
    candidates: [{ id: "ocr-a", payload: { geometry, transcription: "CABERNET SAUVIGNON", transcriptionStatus: "verified", layout: { type: "string", flow: "linear", baselineAngleDeg: 0, baseline: null, characterOrientation: "aligned" }, suggestedParent: { type: "label", packageId: "478c582a-6289-4d79-9f9a-85681b257184", labelId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" } } }],
  }, "ocr-run:split", "d73ec9a2-1a70-465e-b8c1-a8371072b92c", [
    { operationId: "op-1", type: "split_region", inputIds: ["ocr-a"], adjustment: null, geometry: null, text: null, transcriptionStatus: null, split: { axis: "vertical", fractions: [.5] } },
    { operationId: "op-2", type: "approve_region", inputIds: ["op-1:1"], adjustment: null, geometry: null, text: null, transcriptionStatus: null, split: null },
    { operationId: "op-3", type: "approve_region", inputIds: ["op-1:2"], adjustment: null, geometry: null, text: null, transcriptionStatus: null, split: null },
  ]);
  const review = (operations[0]!.payload as any).reviews[0];
  assert.equal(review.state, "edited");
  assert.equal(review.splitOutputs.length, 2);
  assert.deepEqual(review.splitOutputs.map((output: any) => output.sourceOperationId), ["op-1:1", "op-1:2"]);
  assert.ok(Math.abs(review.splitOutputs[0].geometry.bbox.width - .3) < 1e-9);
});

test("OCR Edit Engine persists semantic composition without replacing member regions", () => {
  const geometry = (x: number) => ({ type: "quad", points: [{ x, y: .2 }, { x: x + .2, y: .2 }, { x: x + .2, y: .3 }, { x, y: .3 }], bbox: { x, y: .2, width: .2, height: .1 } });
  const operations = buildOcrEditPlanOperations({
    operationId: "6f481c18-b439-4ac3-bff7-e6261471377a",
    candidates: [
      { id: "ocr-a", payload: { geometry: geometry(.1), transcription: "CABERNET", transcriptionStatus: "verified", suggestedParent: { type: "label", packageId: "478c582a-6289-4d79-9f9a-85681b257184", labelId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" } } },
      { id: "ocr-b", payload: { geometry: geometry(.4), transcription: "SAUVIGNON", transcriptionStatus: "verified", suggestedParent: { type: "label", packageId: "478c582a-6289-4d79-9f9a-85681b257184", labelId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" } } },
    ],
  }, "ocr-run:compose", "d73ec9a2-1a70-465e-b8c1-a8371072b92c", [
    { operationId: "op-1", type: "approve_region", inputIds: ["ocr-a"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
    { operationId: "op-2", type: "approve_region", inputIds: ["ocr-b"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
    { operationId: "op-3", type: "compose_string", inputIds: ["ocr-a", "ocr-b"], adjustment: null, geometry: null, text: null, transcriptionStatus: null,
      composition: { text: "CABERNET SAUVIGNON", transcriptionStatus: "verified", sortOrder: 0 } },
  ]);
  const payload = operations[0]!.payload as any;
  assert.equal(payload.reviews.length, 2);
  assert.deepEqual(payload.compositions, [{
    sourceOperationId: "op-3", memberSourceOperationIds: ["ocr-a", "ocr-b"], text: "CABERNET SAUVIGNON", transcriptionStatus: "verified", sortOrder: 0,
  }]);
  assert.equal((operations[0]!.proposedOutput as any).derivedOutputs.length, 2);
});

test("OCR Edit Engine decompose removes only an existing semantic relation", () => {
  const geometry = { type: "quad", points: [{ x: .1, y: .2 }, { x: .3, y: .2 }, { x: .3, y: .3 }, { x: .1, y: .3 }], bbox: { x: .1, y: .2, width: .2, height: .1 } };
  const compositionId = "7a42578d-e665-4a7e-a132-3ad4d48b0a6d";
  const operations = buildOcrEditPlanOperations({
    operationId: "6f481c18-b439-4ac3-bff7-e6261471377a",
    candidates: [{ id: "ocr-a", payload: { geometry, transcription: "CABERNET", transcriptionStatus: "verified", suggestedParent: { type: "label", packageId: "478c582a-6289-4d79-9f9a-85681b257184", labelId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" } } }],
    compositions: [{ id: compositionId, memberIds: ["old-a", "old-b"], text: "OLD STRING", transcriptionStatus: "verified", sortOrder: 0 }],
  }, "ocr-run:decompose", "d73ec9a2-1a70-465e-b8c1-a8371072b92c", [
    { operationId: "op-1", type: "approve_region", inputIds: ["ocr-a"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
    { operationId: "op-2", type: "decompose_string", inputIds: [compositionId], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
  ]);
  assert.deepEqual((operations[0]!.payload as any).decomposeCompositionIds, [compositionId]);
  assert.deepEqual((operations[0]!.payload as any).compositions, []);
});

test("OCR Edit Engine rejects duplicate approval outside distinct split branches", () => {
  const geometry = { type: "quad", points: [{ x: .1, y: .2 }, { x: .7, y: .2 }, { x: .7, y: .4 }, { x: .1, y: .4 }], bbox: { x: .1, y: .2, width: .6, height: .2 } };
  assert.throws(() => buildOcrEditPlanOperations({
    operationId: "6f481c18-b439-4ac3-bff7-e6261471377a",
    candidates: [{ id: "ocr-a", payload: { geometry, transcription: "TEXT", transcriptionStatus: "verified", suggestedParent: { type: "label", packageId: "478c582a-6289-4d79-9f9a-85681b257184", labelId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" } } }],
  }, "ocr-run:invalid", "d73ec9a2-1a70-465e-b8c1-a8371072b92c", [
    { operationId: "op-1", type: "edit_region", inputIds: ["ocr-a"], adjustment: { direction: "expand", edge: "right", strength: "small" }, geometry: null, text: null, transcriptionStatus: null },
    { operationId: "op-2", type: "approve_region", inputIds: ["ocr-a"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
    { operationId: "op-3", type: "approve_region", inputIds: ["op-1"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
  ]), /multiple approved outputs only through distinct branches/);
});

test("system OCR rerun updates only the derived node before final approval", () => {
  const geometry = { type: "quad" as const, points: [{ x: .1, y: .1 }, { x: .3, y: .1 }, { x: .3, y: .2 }, { x: .1, y: .2 }], bbox: { x: .1, y: .1, width: .2, height: .1 } };
  const operation = buildOcrEditPlanOperations({
    operationId: "6f481c18-b439-4ac3-bff7-e6261471377a",
    candidates: [{ id: "ocr-a", payload: { geometry, transcription: "MAS", transcriptionStatus: "partial", suggestedParent: { type: "label", packageId: "478c582a-6289-4d79-9f9a-85681b257184", labelId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" } } }],
  }, "ocr-run:1", "d73ec9a2-1a70-465e-b8c1-a8371072b92c", [
    { operationId: "op-1", type: "edit_region", inputIds: ["ocr-a"], adjustment: { direction: "expand", edge: "right", strength: "small" }, geometry: null, text: null, transcriptionStatus: null },
    { operationId: "system-rerun-1-1", type: "rerun_ocr", actor: "system", inputIds: ["op-1"], helper: { id: "tesseract-cascade", version: "v6", config: {} }, result: { transcription: "MASSANDRA", transcriptionStatus: "verified", recognitionConfidence: .91, evidence: { stopReason: "strong-deep-evidence" } } },
    { operationId: "op-2", type: "approve_region", inputIds: ["system-rerun-1-1"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
  ]);
  const review = (operation[0]!.payload as any).reviews[0];
  assert.equal(review.state, "edited");
  assert.equal(review.transcription.text, "MASSANDRA");
  assert.equal((operation[0]!.proposedOutput as any).operations[1].type, "rerun_ocr");
});

test("OCR correction iterations rebase provider-local operation IDs", () => {
  const previous = [
    { operationId: "op-1", type: "edit_region", inputIds: ["ocr-a"], adjustment: { direction: "expand", edge: "right", strength: "small" }, geometry: null, text: null, transcriptionStatus: null },
    { operationId: "system-rerun-1-1", type: "rerun_ocr", actor: "system", inputIds: ["op-1"], helper: { id: "tesseract-cascade", version: "v6", config: {} }, result: { transcription: "MAS", transcriptionStatus: "partial", recognitionConfidence: .6, evidence: {} } },
  ] as any;
  const combined = appendOcrOperations(previous, [
    { operationId: "op-1", type: "edit_region", inputIds: ["system-rerun-1-1"], adjustment: { direction: "expand", edge: "left", strength: "small" }, geometry: null, text: null, transcriptionStatus: null },
    { operationId: "op-2", type: "approve_region", inputIds: ["op-1"], adjustment: null, geometry: null, text: null, transcriptionStatus: null },
  ]);
  assert.deepEqual(combined.map((operation) => operation.operationId), ["op-1", "system-rerun-1-1", "op-2", "op-3"]);
  assert.deepEqual(combined[2]!.inputIds, ["system-rerun-1-1"]);
  assert.deepEqual(combined[3]!.inputIds, ["op-2"]);
});

test("OCR correction rebasing retains deterministic split child references", () => {
  const combined = appendOcrOperations([
    { operationId: "op-1", type: "edit_region", inputIds: ["ocr-a"], adjustment: { direction: "expand", edge: "right", strength: "small" }, geometry: null, text: null, transcriptionStatus: null },
  ] as any, [
    { operationId: "op-1", type: "split_region", inputIds: ["op-1"], adjustment: null, geometry: null, text: null, transcriptionStatus: null, split: { axis: "vertical", fractions: [.5] } },
    { operationId: "op-2", type: "approve_region", inputIds: ["op-1:2"], adjustment: null, geometry: null, text: null, transcriptionStatus: null, split: null },
  ]);
  assert.equal(combined[1]!.operationId, "op-2");
  assert.deepEqual(combined[2]!.inputIds, ["op-2:2"]);
});

test("a terminal OCR accept preserves rerun nodes as explicit approvals", () => {
  assert.deepEqual(terminalOcrApprovalOperations([
    { id: "system-rerun-1-1" }, { id: "ocr-b" },
  ], [{ id: "ocr-b", state: "rejected" }]).map((operation) => ({ type: operation.type, inputIds: operation.inputIds })), [
    { type: "approve_region", inputIds: ["system-rerun-1-1"] },
    { type: "reject", inputIds: ["ocr-b"] },
  ]);
});

test("manual OCR command makes merge intent explicit", () => {
  const base = {
    annotation: {
      parent: { type: "label", id: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" },
      geometry: { type: "quad", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], bbox: { x: 0, y: 0, width: 1, height: 1 } },
      coordinateSpace: { type: "label-rectified", units: "normalized", labelId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c", cropRevision: 1, width: 100, height: 100 },
      regionStatus: "reviewed", transcription: { text: "TEST", status: "verified" },
      layout: { type: "word", flow: "linear", baselineAngleDeg: 0, baseline: null, characterOrientation: "aligned" }, rectification: null,
    },
  };
  assert.equal(wizardManualOcrCreateSchema.safeParse({ ...base, duplicateDecision: "merge" }).success, false);
  assert.equal(wizardManualOcrCreateSchema.safeParse({ ...base, duplicateDecision: "merge", mergeTargetId: "e9ced963-39fe-48e8-af99-11b934b00602" }).success, true);
});

test("automatic pipeline defaults to complete helper-only traversal", () => {
  const input = wizardAutomationRunSchema.parse({});
  assert.equal(input.through, "summary");
  assert.equal(input.continueOnError, true);
  assert.deepEqual(automationStagesThrough("components"), ["package", "label", "bottle", "ocr", "mask", "morphology", "components"]);
  assert.equal(wizardAutomationRunSchema.safeParse({ through: "training" }).success, false);
  assert.equal(wizardAutomationRunSchema.safeParse({ configs: { database: {} } }).success, false);
});

test("persisted helper pipeline job requires one item and an annotation track", () => {
  const valid = createRecognizeJobSchema.safeParse({
    type: "ANNOTATION_HELPER_PIPELINE",
    target: { source: "svoe_vino", sourceItemId: "item-1" },
    options: { annotationTrackId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c", automation: { through: "ocr" } },
  });
  assert.equal(valid.success, true);
  assert.equal(createRecognizeJobSchema.safeParse({ type: "ANNOTATION_HELPER_PIPELINE", target: { source: "svoe_vino", sourceItemId: "item-1" } }).success, false);
  assert.equal(createRecognizeJobSchema.safeParse({
    type: "ANNOTATION_HELPER_PIPELINE", target: { items: [{ source: "svoe_vino", sourceItemId: "item-1" }] },
    options: { annotationTrackId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" },
  }).success, false);
});

test("LLM Wizard accepts version-owning batch cards and a selected card version", () => {
  const valid = createRecognizeJobSchema.safeParse({
    type: "ANNOTATION_LLM_PIPELINE",
    target: { items: [
      { source: "svoe_vino", sourceItemId: "item-1", annotationTrackId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" },
      { source: "roskachestvo", sourceItemId: "item-2", annotationTrackId: "478c582a-6289-4d79-9f9a-85681b257184" },
    ] },
  });
  assert.equal(valid.success, true);
  const oneShot = createRecognizeJobSchema.safeParse({
    type: "ANNOTATION_LLM_PIPELINE",
    target: { items: [{ source: "svoe_vino", sourceItemId: "item-1", annotationTrackId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" }] },
    options: { llmExecutionMode: "one-shot-chain" },
  });
  assert.equal(oneShot.success && oneShot.data.options.llmExecutionMode, "one-shot-chain");
  const semanticRerank = createRecognizeJobSchema.safeParse({
    type: "ANNOTATION_LLM_PIPELINE",
    target: { items: [{ source: "svoe_vino", sourceItemId: "item-1", annotationTrackId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" }] },
    options: { visionEvidence: { labelMode: "rerank" } },
  });
  assert.equal(semanticRerank.success && semanticRerank.data.options.visionEvidence?.labelMode, "rerank");
  assert.equal(createRecognizeJobSchema.safeParse({
    type: "ANNOTATION_LLM_PIPELINE",
    target: { items: [{ source: "svoe_vino", sourceItemId: "item-1" }] },
    options: { visionEvidence: { labelMode: "proposals" } },
  }).success, false);
  assert.equal(createRecognizeJobSchema.safeParse({
    type: "ANNOTATION_LLM_PIPELINE",
    target: { items: [{ source: "svoe_vino", sourceItemId: "item-1", annotationTrackId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" }] },
    options: { llmExecutionMode: "not-a-mode" },
  }).success, false);
  assert.equal(createRecognizeJobSchema.safeParse({
    type: "ANNOTATION_LLM_PIPELINE", target: { items: [{ source: "svoe_vino", sourceItemId: "item-1" }] },
  }).success, true);
  assert.equal(createRecognizeJobSchema.safeParse({
    type: "ANNOTATION_LLM_PIPELINE",
    target: { source: "svoe_vino", sourceItemId: "item-1" },
    options: {
      annotationVersionId: "7c6dd074-46b4-4241-9d77-2603dc84cc71",
      annotationVersionInitialization: "empty",
      annotationVersionPublishPolicy: "review",
    },
  }).success, true);
  assert.equal(createRecognizeJobSchema.safeParse({
    type: "ANNOTATION_LLM_PIPELINE",
    target: { source: "svoe_vino", sourceItemId: "item-1" },
    options: {
      annotationTrackId: "d73ec9a2-1a70-465e-b8c1-a8371072b92c",
      annotationVersionInitialization: "after-package",
      annotationVersionPublishPolicy: "review",
    },
  }).success, true);
  assert.equal(createRecognizeJobSchema.safeParse({
    type: "ANNOTATION_LLM_PIPELINE", target: { filter: { source: "svoe_vino" } },
  }).success, false);
});

test("recognition job retry requires an explicit version strategy", () => {
  assert.deepEqual(retryRecognizeJobSchema.parse({ mode: "current-version" }), { mode: "current-version" });
  assert.deepEqual(retryRecognizeJobSchema.parse({ mode: "new-version" }), { mode: "new-version" });
  assert.equal(retryRecognizeJobSchema.safeParse({}).success, false);
  assert.equal(retryRecognizeJobSchema.safeParse({ mode: "same-job" }).success, false);
});

test("label-scoped guides require explicit branch context", () => {
  for (const stage of ["ocr", "mask", "morphology", "components", "elements", "contours", "palette"] as const) {
    const guide = wizardStageGuide(stage);
    assert.equal(guide.scope, "label");
    assert.match(guide.requirements.join(" "), /labelId/);
  }
});

test("guide command vocabulary is a subset of the canonical command contract", () => {
  const contract = wizardWorkflowContract();
  const commands = new Set(contract.commandVocabulary);
  assert.equal(contract.stages.every((stage) => stage.availableActions.every((action) => commands.has(action))), true);
});

test("Label Edit Engine converts merge and bounded edit into one canonical review payload", () => {
  const geometry = (x: number, y: number, width: number, height: number) => ({
    type: "quad", points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], bbox: { x, y, width, height },
  });
  const operation = buildLabelEditPlanOperation({ operation: {
    helperId: "label-roi-detection", helperVersion: "4", initialConfig: {}, finalConfig: {},
    candidates: [
      { id: "roi-1", payload: { geometry: geometry(10, 10, 80, 40) }, score: .9 },
      { id: "roi-2", payload: { geometry: geometry(10, 48, 80, 42) }, score: .8 },
      { id: "noise", payload: { geometry: geometry(150, 20, 20, 20) }, score: .2 },
    ],
  } }, [
    { operationId: "op-1", type: "merge", inputIds: ["roi-1", "roi-2"], adjustment: null },
    { operationId: "op-2", type: "edit", inputIds: ["op-1"], adjustment: { direction: "contract", edge: "bottom", strength: "small" } },
    { operationId: "op-3", type: "accept", inputIds: ["op-2"], adjustment: null },
    { operationId: "op-4", type: "reject", inputIds: ["noise"], adjustment: null },
  ]);
  const payload = operation.payload as any;
  assert.equal(operation.command, "select_candidate");
  assert.equal(payload.operation.reviewMode, "edited");
  assert.deepEqual(payload.reviews.map((item: any) => item.state), ["accepted", "accepted", "rejected"]);
  assert.equal(payload.reviews[0].mergeGroupId, "llm-op-2");
  assert.equal(payload.mergeReviews.length, 1);
  assert.equal(payload.mergeReviews[0].geometry.bbox.height < 80, true);
});

test("Label Edit Engine accepts at most one mutually exclusive ROI variant", () => {
  const geometry = (y: number, height: number) => ({
    type: "quad", points: [{ x: 10, y }, { x: 90, y }, { x: 90, y: y + height }, { x: 10, y: y + height }], bbox: { x: 10, y, width: 80, height },
  });
  const observation = { operation: {
    helperId: "label-roi-detection", helperVersion: "6", initialConfig: {}, finalConfig: {},
    candidates: [
      { id: "roi-boundary", payload: { geometry: geometry(10, 80), variant: { groupId: "label-roi:1", kind: "boundary-probed", mutuallyExclusive: true } }, score: .92 },
      { id: "roi-tight", payload: { geometry: geometry(20, 60), variant: { groupId: "label-roi:1", kind: "tight", mutuallyExclusive: true } }, score: .88 },
    ],
  } };
  assert.doesNotThrow(() => buildLabelEditPlanOperation(observation, [
    { operationId: "op-1", type: "accept", inputIds: ["roi-boundary"], adjustment: null },
    { operationId: "op-2", type: "reject", inputIds: ["roi-tight"], adjustment: null },
  ]));
  assert.throws(() => buildLabelEditPlanOperation(observation, [
    { operationId: "op-1", type: "accept", inputIds: ["roi-boundary"], adjustment: null },
    { operationId: "op-2", type: "accept", inputIds: ["roi-tight"], adjustment: null },
  ]), /Only one mutually exclusive Label ROI variant/);
});

test("wizard command envelope keeps stage payload opaque but target identity strict", () => {
  const command = wizardCommandSchema.parse({
    command: "edit_region",
    target: { entityType: "label", id: "d73ec9a2-1a70-465e-b8c1-a8371072b92c" },
    payload: { geometry: { type: "quad" } },
  });
  assert.equal(command.command, "edit_region");
  assert.deepEqual(command.payload, { geometry: { type: "quad" } });
  assert.equal(wizardCommandSchema.safeParse({ command: "write_database", payload: {} }).success, false);
  assert.equal(wizardCommandSchema.safeParse({ command: "commit", extra: true }).success, false);
  assert.equal(wizardCommandSchema.safeParse({ command: "delete_region", target: { entityType: "label", id: "not-a-uuid" } }).success, false);
});

test("correction plan keeps proposal executor and commands explicit", () => {
  const plan = wizardCorrectionPlanSchema.parse({
    executor: "local_ml", controller: { id: "vision-controller", version: "1" }, proposedOutput: { labels: 2 },
    operations: [{ stage: "label", command: "run_helper", payload: { labelConfig: {} } }],
  });
  assert.equal(plan.executor, "local_ml");
  assert.equal(plan.interactionMode, "auto");
  assert.equal(plan.continueOnError, false);
  assert.equal(wizardCorrectionPlanSchema.safeParse({ controller: { id: "x" }, operations: [] }).success, false);
  assert.equal(resolveCorrectionPlanExecutor({ "x-auth-role": "ml-service", "x-auth-subject": "runner" }, "llm"), "llm");
  assert.equal(resolveCorrectionPlanExecutor({ "x-auth-role": "annotator", "x-auth-subject": "reviewer" }), "human");
  assert.throws(() => resolveCorrectionPlanExecutor({ "x-auth-role": "annotator", "x-auth-subject": "reviewer" }, "local_ml"));
});

test("human LLM review distinguishes false accept from false correction", () => {
  const falseAccept = llmHumanReviewSchema.parse({ stage: "label", finalEditor: "human", verdict: "llm_false_accept" });
  const falseCorrection = llmHumanReviewSchema.parse({ stage: "label", finalEditor: "human", verdict: "llm_false_correction" });
  assert.doesNotThrow(() => validateLlmReview("accepted_helper", falseAccept));
  assert.doesNotThrow(() => validateLlmReview("modified_helper", falseCorrection));
  assert.doesNotThrow(() => validateLlmReview("manual_created", { stage: "label", finalEditor: "human", verdict: "llm_partially_correct" }));
  assert.throws(() => validateLlmReview("modified_helper", falseAccept));
  assert.throws(() => validateLlmReview("accepted_helper", falseCorrection));
  assert.doesNotThrow(() => validateLlmReview("accepted_helper", { stage: "label", finalEditor: "helper", verdict: "llm_correct" }));
  assert.doesNotThrow(() => validateLlmReview("modified_helper", { stage: "label", finalEditor: "llm", verdict: "llm_correct" }));
});

test("system controller stops at review boundaries instead of accepting candidates", () => {
  const base = {
    visionContextId: "context", package: { objectContext: { status: "missing" } }, labels: [], stageState: { labels: {} },
  } as unknown as Parameters<typeof planSystemControllerOperations>[0];
  assert.deepEqual(planSystemControllerOperations(base).operations.map((item) => [item.stage, item.command]), [["label", "run_helper"]]);
  const suggested = { ...base, labels: [{ id: "label-1", geometryReviewStatus: "suggested", geometry: { bbox: {} }, ocr: [] }] } as unknown as Parameters<typeof planSystemControllerOperations>[0];
  assert.equal(planSystemControllerOperations(suggested).operations.length, 0);
  assert.match(planSystemControllerOperations(suggested).notes.join(" "), /human review boundary/);
});

test("system controller uses the largest reviewed Label for Object Context when neck and front labels coexist", () => {
  const context = {
    visionContextId: "context",
    package: { objectContext: { status: "missing" } },
    labels: [
      { id: "neck-label", geometryReviewStatus: "reviewed", geometry: { bbox: { x: 120, y: 185, width: 76, height: 77 } }, ocr: [] },
      { id: "front-label", geometryReviewStatus: "reviewed", geometry: { bbox: { x: 35, y: 849, width: 282, height: 138 } }, ocr: [] },
    ],
    stageState: { labels: {} },
  } as unknown as Parameters<typeof planSystemControllerOperations>[0];

  const result = planSystemControllerOperations(context);

  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0]?.stage, "bottle");
  assert.deepEqual(result.operations[0]?.payload, { verifiedLabel: { x: 35, y: 849, width: 282, height: 138 } });
  assert.match(result.notes.join(" "), /largest reviewed Label \(front-label\)/);
});

test("LLM decision evidence stores iteration trace at the canonical top level", () => {
  const trace = [{ iteration: 0, event: "human_required", decision: { action: "human_required" } }];
  const evidence = decisionEvidence({
    decision: { action: "human_required" }, adapter: { id: "adapter" }, providerEvidence: { usage: {} },
  } as any, {
    observationId: "observation-1", stage: "ocr", helper: { id: "ocr" }, candidates: [], policy: {}, runtimeState: {}, visuals: { renderer: "test" },
  }, undefined, undefined, trace);

  assert.deepEqual(evidence.iterationTrace, trace);
  assert.equal("iterationTrace" in evidence.observation, false);
  assert.equal(evidence.renderer, "test");
});

test("visual context uses one deterministic source-to-preview transform", () => {
  assert.deepEqual(projectSourcePoint({ x: 30, y: 50 }, { sourceViewport: { x: 10, y: 20, width: 100, height: 200 }, scaleX: 2, scaleY: 2 }), { x: 40, y: 60 });
  const quad = [{ x: 10, y: 20 }, { x: 110, y: 10 }, { x: 120, y: 210 }, { x: 0, y: 220 }] as const;
  assert.deepEqual(projectLabelPoint({ x: 0.5, y: 0.5 }, [...quad]), { x: 60, y: 115 });
  assert.equal(wizardVisualRenderSchema.parse({}).viewport.type, "source");
  assert.equal(wizardVisualRenderSchema.safeParse({ maxSide: 4096 }).success, false);
});

test("local ML adapter accepts only an explicit correction-plan response", () => {
  const request = localMlControllerPlanRequestSchema.parse({});
  assert.equal(request.render.maxSide, 768);
  assert.equal(localMlControllerResponseSchema.safeParse({
    status: "planned", controller: { id: "local-vision", model: "model-v1" }, proposedOutput: { score: 0.8 },
    operations: [{ stage: "label", command: "run_helper", payload: {} }],
  }).success, true);
  assert.equal(localMlControllerResponseSchema.safeParse({
    status: "planned", controller: { id: "local-vision" }, operations: [{ stage: "label", command: "write_database" }],
  }).success, false);
  assert.equal(localMlControllerResponseSchema.safeParse({ status: "planned", controller: { id: "local-vision" }, operations: [] }).success, false);
  assert.equal(localMlControllerResponseSchema.safeParse({ status: "no_action", controller: { id: "local-vision" }, reason: "review required" }).success, true);
});

test("local ML HTTP boundary sends the trusted token and accepts explicit no_action", async (context) => {
  const requests: Array<{ authorization?: string; body: unknown }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "no_action",
        controller: { id: "contract-test-controller", version: "1" },
        reason: "review required",
        operations: [],
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const result = await requestLocalMlController(
    { schemaVersion: 1, task: "annotation-correction-plan" },
    { url: `http://127.0.0.1:${address.port}/annotation/plan`, token: "test-token", timeoutMs: 2_000, maxResponseBytes: 4_096 },
  );

  assert.equal(result.status, "no_action");
  assert.equal(result.reason, "review required");
  assert.deepEqual(requests, [{
    authorization: "Bearer test-token",
    body: { schemaVersion: 1, task: "annotation-correction-plan" },
  }]);
});

test("LLM adapter shares the strict correction-plan boundary and retains LLM provenance", async (context) => {
  assert.equal(externalControllerPlanRequestSchema.parse({}).render.viewport.type, "source");
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "planned",
        controller: { id: "multimodal-annotator", version: "1", model: "provider-model", promptVersion: "wizard-v1" },
        interactionMode: "mixed",
        proposedOutput: { independentVisionPass: true },
        operations: [{ stage: "label", command: "run_helper", payload: {} }],
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const result = await requestLlmController(
    { schemaVersion: 1, task: "annotation-correction-plan" },
    { url: `http://127.0.0.1:${address.port}/plan`, timeoutMs: 2_000, maxResponseBytes: 4_096 },
  );
  assert.equal(result.status, "planned");
  assert.equal(result.interactionMode, "mixed");
  assert.equal(result.controller.promptVersion, "wizard-v1");
});

test("LLM adapter preserves a safe controller configuration detail and service status", async (context) => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: "OPENAI_API_KEY is not configured" }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  await assert.rejects(
    requestLlmController(
      { schemaVersion: 1, task: "annotation-correction-plan" },
      { url: `http://127.0.0.1:${address.port}/plan`, timeoutMs: 2_000, maxResponseBytes: 4_096 },
    ),
    (error: unknown) => error instanceof UpstreamServiceError
      && error.statusCode === 503
      && error.message === "LLM Wizard controller returned HTTP 503: OPENAI_API_KEY is not configured"
      && error.transport?.kind === "http"
      && error.transport.controllerStatus === 503
      && error.transport.retryable === true,
  );
});

test("LLM adapter distinguishes user cancellation from controller timeout", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    requestLlmController(
      { schemaVersion: 1, task: "annotation-correction-plan" },
      { url: "http://127.0.0.1:1/plan", timeoutMs: 2_000, maxResponseBytes: 4_096, signal: controller.signal },
    ),
    (error: unknown) => error instanceof ExternalControllerRequestCancelledError,
  );
});

test("stage LLM boundary accepts only a bounded Label decision", async (context) => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1, status: "decided",
        controller: { id: "qwen-stage", model: "qwen-test", promptVersion: "label-candidate-review-v1" },
        adapter: { id: "vision-stage-adapter-v1", stage: "label", provider: "qwen" },
        observationId: "19a35e8b-bfad-48bb-a563-56948873587c",
        decision: { schemaVersion: 1, stage: "label", action: "accept", candidateId: "candidate-a", confidence: 0.92, flags: ["clear_best_candidate"], paramsPatch: null, reviews: [], topologyEdits: [] },
        providerEvidence: { responseId: "qwen-response", model: "qwen-test", usage: {} },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const result = await requestLlmStageController(
    { schemaVersion: 1, task: "stage-evaluation", stageObservation: {} },
    { url: `http://127.0.0.1:${address.port}/plan`, timeoutMs: 2_000, maxResponseBytes: 4_096 },
  );
  assert.equal(result.decision.action, "accept");
  assert.equal(result.decision.candidateId, "candidate-a");
});

test("stage LLM boundary reports safe nested contract diagnostics", async (context) => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        schemaVersion: 1, status: "decided",
        controller: { id: "qwen-stage", model: "qwen-test", promptVersion: "ocr-review-v1" },
        adapter: { id: "vision-stage-adapter-v1", stage: "ocr", provider: "qwen" },
        observationId: "19a35e8b-bfad-48bb-a563-56948873587c",
        decision: {
          schemaVersion: 1, stage: "ocr", action: "review", candidateId: "ocr-run:1", confidence: 0.9,
          flags: [], paramsPatch: null, reviews: [], topologyEdits: [],
          editOperations: [{ operationId: "op-1", type: "edit_text", inputIds: ["ocr-1"], adjustment: null, geometry: null, text: "VIBES", transcriptionStatus: "certain" }],
        },
        providerEvidence: { responseId: "qwen-response", model: "qwen-test", usage: {} },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await assert.rejects(
    requestLlmStageController(
      { schemaVersion: 1, task: "stage-evaluation", stageObservation: {} },
      { url: `http://127.0.0.1:${address.port}/plan`, timeoutMs: 2_000, maxResponseBytes: 8_192 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamServiceError);
      assert.equal(error.transport?.kind, "contract");
      assert.ok(Array.isArray(error.transport?.contractIssues));
      assert.match(error.message, /decision\.editOperations\.0/);
      assert.deepEqual(error.transport?.responseSummary, {
        schemaVersion: 1, status: "decided", observationId: "19a35e8b-bfad-48bb-a563-56948873587c",
        decision: { stage: "ocr", action: "review", candidateId: "ocr-run:1", reviewCount: 0, topologyEditCount: 0, editOperationCount: 1, editOperationTypes: ["edit_text"] },
      });
      return true;
    },
  );
});

test("stage LLM response contract supports every bounded Wizard review stage including the Package gate", () => {
  const base = {
    schemaVersion: 1, status: "decided", controller: { id: "stage-controller" },
    observationId: "19a35e8b-bfad-48bb-a563-56948873587c",
    providerEvidence: { responseId: "", model: "test", usage: {} },
  };
  for (const stage of ["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"] as const) {
    assert.equal(stageLlmDecisionResponseSchema.safeParse({
      ...base, adapter: { id: "vision-stage-adapter-v1", stage, provider: "qwen" },
      decision: { schemaVersion: 1, stage, action: "human_required", candidateId: null, confidence: 0.5, flags: ["human_judgment_required"], paramsPatch: null, reviews: [], topologyEdits: [] },
    }).success, true, stage);
  }
  assert.equal(stageLlmDecisionResponseSchema.safeParse({
    ...base, adapter: { id: "vision-stage-adapter-v1", stage: "package", provider: "qwen" },
    decision: { schemaVersion: 1, stage: "package", action: "accept", candidateId: "package-count:single", confidence: 0.95, flags: ["clear_best_candidate"], paramsPatch: null, reviews: [], topologyEdits: [] },
  }).success, true);
});

test("Package multiplicity command binds the selected gate candidate to its helper run", () => {
  const operation = {
    helperId: "package-count-gate", helperVersion: "v1", initialConfig: { schemaVersion: 1 }, finalConfig: { schemaVersion: 1 },
    candidates: [
      { id: "package-count:single", payload: { multiplicity: "single" }, score: null },
      { id: "package-count:multiple", payload: { multiplicity: "multiple" }, score: null },
    ],
    selectedCandidateId: "package-count:multiple", reviewMode: "accepted" as const,
  };
  assert.equal(packageMultiplicityCommandSchema.safeParse({ value: "multiple", operation }).success, true);
  assert.equal(packageMultiplicityCommandSchema.safeParse({ value: "multiple", operation: { ...operation, selectedCandidateId: "missing" } }).success, false);
  assert.equal(wizardRuntimeDefinition("package").algorithms.includes("package-smart-lasso-v1"), true);
});

test("stage LLM response accepts semantic reruns but rejects raw config patches", () => {
  const base = {
    schemaVersion: 1, status: "decided", controller: { id: "stage-controller" },
    adapter: { id: "vision-stage-adapter-v1", stage: "mask", provider: "qwen" },
    observationId: "19a35e8b-bfad-48bb-a563-56948873587c",
    providerEvidence: { responseId: "", model: "test", usage: {} },
  };
  assert.equal(stageLlmDecisionResponseSchema.safeParse({ ...base, decision: {
    schemaVersion: 1, stage: "mask", action: "rerun", candidateId: null, confidence: .8, flags: [],
    paramsPatch: { adjustment: "include_more_foreground", strength: "small" }, reviews: [], topologyEdits: [],
  } }).success, true);
  assert.equal(stageLlmDecisionResponseSchema.safeParse({ ...base, decision: {
    schemaVersion: 1, stage: "mask", action: "rerun", candidateId: null, confidence: .8, flags: [], paramsPatch: { threshold: 220 }, reviews: [], topologyEdits: [],
  } }).success, false);
});

test("semantic adjustments map into bounded deterministic helper configs", () => {
  // Mask and morphology now commit a stable shortlist candidate. Blind numeric
  // reruns are intentionally unavailable for those visual-search stages.
  assert.throws(() => applyLlmSemanticAdjustment("mask", { threshold: 250, invert: false }, { adjustment: "include_more_foreground", strength: "medium" }));
  const contours = applyLlmSemanticAdjustment("contours", { contourSimplifyRatio: .005, maxContourPoints: 256 }, { adjustment: "preserve_detail", strength: "small" });
  assert.ok(Number(contours.contourSimplifyRatio) < .005);
  assert.ok(Number(contours.maxContourPoints) > 256);
  assert.equal(applyLlmSemanticAdjustment("components", { componentConnectivity: 4 }, { adjustment: "merge_fragments", strength: "small" }).componentConnectivity, 8);
  assert.equal(applyLlmSemanticAdjustment("components", { componentConnectivity: 8 }, { adjustment: "separate_regions", strength: "small" }).componentConnectivity, 4);
  assert.throws(() => applyLlmSemanticAdjustment("ocr", {}, { adjustment: "reduce_noise", strength: "small" }));
});

test("stage LLM response accepts strict granular reviews", () => {
  const response = {
    schemaVersion: 1, status: "decided", controller: { id: "stage-controller" },
    adapter: { id: "vision-stage-adapter-v1", stage: "components", provider: "qwen" },
    observationId: "19a35e8b-bfad-48bb-a563-56948873587c",
    decision: { schemaVersion: 1, stage: "components", action: "review", candidateId: "components-preview:1", confidence: .9, flags: ["excessive_noise"], paramsPatch: null,
      reviews: [{ id: "12", state: "rejected", text: null, transcriptionStatus: null, type: null, role: null }], topologyEdits: [] },
    providerEvidence: { responseId: "", model: "test", usage: {} },
  };
  assert.equal(stageLlmDecisionResponseSchema.safeParse(response).success, true);
  assert.equal(stageLlmDecisionResponseSchema.safeParse({ ...response, decision: { ...response.decision, reviews: [] } }).success, false);
});

test("stage LLM response accepts strict OCR Edit Engine operations", () => {
  const empty = { adjustment: null, geometry: null, text: null, transcriptionStatus: null };
  const response = {
    schemaVersion: 1, status: "decided", controller: { id: "stage-controller" },
    adapter: { id: "vision-stage-adapter-v1", stage: "ocr", provider: "qwen" },
    observationId: "19a35e8b-bfad-48bb-a563-56948873587c",
    decision: {
      schemaVersion: 1, stage: "ocr", action: "review", candidateId: "ocr-run:1", confidence: .9,
      flags: ["wrong_transcription"], paramsPatch: null, reviews: [], topologyEdits: [], editOperations: [
        { operationId: "op-1", type: "edit_text", inputIds: ["ocr-1"], adjustment: null, geometry: null, text: "CABERNET", transcriptionStatus: "verified" },
        { operationId: "op-2", type: "approve_region", inputIds: ["op-1"], ...empty },
      ],
    },
    providerEvidence: { responseId: "", model: "test", usage: {} },
  };
  assert.equal(stageLlmDecisionResponseSchema.safeParse(response).success, true);
  assert.equal(stageLlmDecisionResponseSchema.safeParse({ ...response, decision: { ...response.decision, editOperations: [
    { operationId: "op-1", type: "split_region", inputIds: ["ocr-1"], ...empty, split: { axis: "vertical", fractions: [.45] } },
    { operationId: "op-2", type: "approve_region", inputIds: ["op-1:1"], ...empty, split: null },
    { operationId: "op-3", type: "approve_region", inputIds: ["op-1:2"], ...empty, split: null },
  ] } }).success, true);
  assert.equal(stageLlmDecisionResponseSchema.safeParse({ ...response, decision: { ...response.decision, editOperations: [
    { operationId: "op-1", type: "approve_region", inputIds: ["ocr-1"], ...empty },
    { operationId: "op-2", type: "approve_region", inputIds: ["ocr-2"], ...empty },
    { operationId: "op-3", type: "compose_string", inputIds: ["ocr-1", "ocr-2"], ...empty,
      composition: { text: "CABERNET SAUVIGNON", transcriptionStatus: "verified", sortOrder: 0 } },
  ] } }).success, true);
  assert.equal(stageLlmDecisionResponseSchema.safeParse({ ...response, decision: {
    ...response.decision, editOperations: [{ operationId: "op-1", type: "edit_text", inputIds: ["ocr-1"], adjustment: null, geometry: null, text: null, transcriptionStatus: "verified" }],
  } }).success, false);
  const expandedOperations = Array.from({ length: 21 }, (_, index) => ({
    operationId: `op-${index + 1}`, type: index === 0 ? "approve_region" : "reject", inputIds: [`ocr-${index + 1}`], ...empty,
  }));
  assert.equal(stageLlmDecisionResponseSchema.safeParse({ ...response, decision: {
    ...response.decision, editOperations: expandedOperations,
  } }).success, true);
});

test("Elements topology review moves components and creates server-owned groups", () => {
  const topologyResponse = {
    schemaVersion: 1, status: "decided", controller: { id: "stage-controller" },
    adapter: { id: "vision-stage-adapter-v3", stage: "elements", provider: "qwen" },
    observationId: "19a35e8b-bfad-48bb-a563-56948873587d",
    decision: { schemaVersion: 1, stage: "elements", action: "review", candidateId: "elements-preview:1", confidence: .85, flags: ["overmerged"], paramsPatch: null,
      reviews: [], topologyEdits: [{ componentId: 2, destinationElementId: "element-b", newGroupKey: null }] },
    providerEvidence: { responseId: "", model: "test", usage: {} },
  };
  assert.equal(stageLlmDecisionResponseSchema.safeParse(topologyResponse).success, true);
  const original = [
    { id: "element-a", sourceComponentIds: [1, 2], type: "text", status: "accepted" },
    { id: "element-b", sourceComponentIds: [3], type: "graphic", status: "accepted" },
  ];
  const moved = applyElementTopology(original, [
    { componentId: 2, destinationElementId: "element-b", newGroupKey: null },
    { componentId: 3, destinationElementId: null, newGroupKey: "group-1" },
  ]);
  assert.deepEqual(moved.find((item) => item.id === "element-a")?.sourceComponentIds, [1]);
  assert.deepEqual(moved.find((item) => item.id === "element-b")?.sourceComponentIds, [2]);
  assert.equal(moved.find((item) => String(item.id).startsWith("element:llm:"))?.sourceComponentIds[0], 3);
  assert.throws(() => applyElementTopology(original, [
    { componentId: 2, destinationElementId: "element-b", newGroupKey: null },
    { componentId: 2, destinationElementId: null, newGroupKey: "group-1" },
  ]));
});
