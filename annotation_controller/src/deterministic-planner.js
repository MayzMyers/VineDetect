import { asArray, asObject } from "./contract.js";

const CONTROLLER = { id: "vinedetect-reference-local-controller", version: "1", model: "deterministic-frontier-v1" };
const CV_STAGES = ["mask", "morphology", "components", "elements", "contours", "palette"];

export function planDeterministic(payload) {
  const context = asObject(payload.visionContext);
  const labels = asArray(context.labels).map(asObject);
  const reviewed = labels.filter((value) => value.geometryReviewStatus === "reviewed");
  const objectContext = asObject(asObject(context.package).objectContext);
  const evidence = asArray(context.executionEvidence).map(asObject);
  const input = asObject(payload.input);

  if (!labels.length) return planned(context, [operation("detect-labels", "label", "run_helper", {})], ["Generate Label candidates without accepting them as ground truth."]);
  if (!reviewed.length) return noAction(context, "Label candidates require human review before downstream planning.");
  if (!["reviewed", "rejected"].includes(objectContext.status)) {
    if (hasUnreviewedOutput(evidence, "bottle")) return noAction(context, "Object Context helper output already exists and requires review.");
    if (reviewed.length === 1) {
      const bbox = asObject(asObject(reviewed[0].geometry).bbox);
      return planned(context, [operation("detect-object-context", "bottle", "run_helper", { verifiedLabel: bbox })], ["Generate Object Context candidates from the single reviewed Label exclusion."]);
    }
  }
  const labelsWithoutOcr = reviewed.filter((value) => !asArray(value.ocr).length);
  if (labelsWithoutOcr.length) {
    if (hasUnreviewedOutput(evidence, "ocr")) return noAction(context, "OCR helper output already exists and requires review.");
    const operations = labelsWithoutOcr.map((label) => operation(`run-ocr-${label.id}`, "ocr", "run_helper", { scope: { type: "label", id: String(label.id) }, config: asObject(input.ocrConfig) }, String(label.id)));
    return planned(context, operations, ["Generate OCR candidates independently for reviewed Labels without canonical OCR."]);
  }
  const cvConfig = asObject(input.cvConfig);
  if (Object.keys(cvConfig).length) {
    const labelStates = asObject(asObject(context.stageState).labels);
    for (const label of reviewed) {
      if (!asArray(label.ocr).length || asArray(label.ocr).some((value) => asObject(value).regionStatus !== "reviewed")) continue;
      const states = asObject(labelStates[String(label.id)]);
      for (const stage of CV_STAGES) {
        const state = asObject(states[stage]);
        if (state.status === "missing" && state.valid === true) {
          return planned(context, [operation(`preview-${stage}-${label.id}`, stage, "run_helper", { stage, config: cvConfig }, String(label.id))], [`Generate the next available ${stage} preview using caller-supplied cvConfig.`]);
        }
      }
    }
  }
  return noAction(context, "No safe helper frontier is available; review existing output or supply cvConfig.");
}

const operation = (operationId, stage, command, payload, labelId) => ({ operationId, stage, command, payload, ...(labelId ? { labelId } : {}) });
const planned = (context, operations, notes) => ({ status: "planned", controller: CONTROLLER, proposedOutput: { visionContextId: context.visionContextId, notes }, operations, continueOnError: false });
const noAction = (context, reason) => ({ status: "no_action", controller: CONTROLLER, proposedOutput: { visionContextId: context.visionContextId }, reason, operations: [] });
const hasUnreviewedOutput = (evidence, stage) => evidence.some((value) => value.stage === stage && value.hasAutoOutput === true && value.hasReviewedOutput !== true);
