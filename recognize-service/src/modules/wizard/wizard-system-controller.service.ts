import { DEFAULT_LABEL_ANALYSIS_CV_CONFIG } from "../label-analysis/labelCropFeatures.js";
import type { SourceName } from "../../shared/types.js";
import type { WizardCorrectionPlanRequest } from "./wizard.schemas.js";
import { validateAndCreateCorrectionPlan } from "./wizard-correction-plan.service.js";
import { buildVisionContext } from "./wizard-vision-context.service.js";

const CV_STAGES = ["mask", "morphology", "components", "elements", "contours", "palette"] as const;

export async function createSystemControllerPlan(source: SourceName, sourceItemId: string, annotationId: string) {
  const context = await buildVisionContext(source, sourceItemId, annotationId);
  const { operations, notes } = planSystemControllerOperations(context);
  if (!operations.length) return { schemaVersion: 1, controller: "wizard-system-controller-v1", status: "no-action" as const, context, notes, plan: null };
  const request: WizardCorrectionPlanRequest = {
    executor: "system", interactionMode: "auto", controller: { id: "wizard-system-controller", version: "1" },
    proposedOutput: { visionContextId: context.visionContextId, notes }, operations, continueOnError: false,
  };
  const plan = await validateAndCreateCorrectionPlan(source, sourceItemId, annotationId, "system", request);
  return { schemaVersion: 1, controller: "wizard-system-controller-v1", status: "planned" as const, context, notes, plan };
}

export function planSystemControllerOperations(context: Awaited<ReturnType<typeof buildVisionContext>>) {
  const operations: WizardCorrectionPlanRequest["operations"] = [];
  const notes: string[] = [];
  const reviewedLabels = context.labels.filter((label) => label.geometryReviewStatus === "reviewed");

  if (!context.labels.length) {
    operations.push({ operationId: "detect-labels", stage: "label", command: "run_helper", payload: {} });
    notes.push("Run Label helper. Candidates remain unreviewed and are not promoted to GT.");
  } else if (!reviewedLabels.length) {
    notes.push("Label candidates exist but none is reviewed; controller stops at the human review boundary.");
  } else if (!["reviewed", "rejected"].includes(String(context.package.objectContext.status))) {
    const objectContextLabel = [...reviewedLabels].sort((left, right) => labelGeometryArea(right) - labelGeometryArea(left))[0]!;
    operations.push({ operationId: "detect-object-context", stage: "bottle", command: "run_helper", payload: { verifiedLabel: objectContextLabel.geometry.bbox } });
    notes.push(`Run Object Context helper using the largest reviewed Label (${objectContextLabel.id}) as exclusion geometry.`);
  } else {
    const labelsWithoutOcr = reviewedLabels.filter((label) => !label.ocr.length);
    if (labelsWithoutOcr.length) {
      for (const label of labelsWithoutOcr) operations.push({
        operationId: `run-ocr-${label.id}`, stage: "ocr", labelId: label.id, command: "run_helper",
        payload: { scope: { type: "label", id: label.id }, config: {} },
      });
      notes.push("Run Auto OCR independently for every reviewed Label without OCR. Results remain candidates.");
    } else {
      const cvTarget = reviewedLabels.find((label) => label.ocr.length && label.ocr.every((ocr) => ocr.regionStatus === "reviewed")
        && CV_STAGES.some((stage) => context.stageState.labels[label.id]?.[stage]?.status === "missing" && context.stageState.labels[label.id]?.[stage]?.valid));
      if (cvTarget) {
        const stage = CV_STAGES.find((item) => context.stageState.labels[cvTarget.id]?.[item]?.status === "missing" && context.stageState.labels[cvTarget.id]?.[item]?.valid)!;
        operations.push({ operationId: `preview-${stage}-${cvTarget.id}`, stage, labelId: cvTarget.id, command: "run_helper", payload: { stage, config: DEFAULT_LABEL_ANALYSIS_CV_CONFIG } });
        notes.push(`Run the next available Label CV helper (${stage}) for one branch.`);
      } else notes.push("No safe helper-only action is currently available; review existing candidates or complete the current stage.");
    }
  }

  return { operations, notes };
}

function labelGeometryArea(label: { geometry: { bbox: { width: number; height: number } } }) {
  return Math.max(0, Number(label.geometry.bbox.width) || 0) * Math.max(0, Number(label.geometry.bbox.height) || 0);
}
