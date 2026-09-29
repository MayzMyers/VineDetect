import { officialTargetForTrack,captureOfficialDraft } from "../../db/official-draft.repository.js";
import { getAnnotationTrackState,patchAnnotationTrackState } from "../../db/annotation-track.repository.js";
import { randomUUID } from "node:crypto";
import { getAnnotationGraph } from "../../db/annotation-graph.repository.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import type { WizardStageId } from "../../shared/helperConfigContract.js";
import type { EditOperationActor } from "../../shared/editStageContract.js";
import type { SourceName } from "../../shared/types.js";
import {
  createGraphLabelRecord,
  bootstrapAnnotationVersionRecord,
  deleteGraphEntityRecord,
  previewLabelCvJobRecord,
  putLabelAnalysisReviewRecord,
  putLabelCvJobCheckpointRecord,
  putSourceAnalysisRecord,
  reparentGraphOcrRecord,
  reviewGraphAutoOcrRecord,
  reviewGraphLabelCandidatesRecord,
  runManualOcrDedupePreflightRecord,
  runGraphAutoOcrRecord,
  runGraphPackageDetectionRecord,
  runSourceAnalysisRecord,
  setItemPackageMultiplicityRecord,
  updateGraphEntityRecord,
} from "../metadata/metadata.service.js";
import {
  createGraphLabelSchema,
  labelAnalysisReviewSchema,
  labelCvJobCheckpointSchema,
  labelCvJobPreviewSchema,
  reparentGraphOcrSchema,
  reviewAutoOcrSchema,
  reviewGraphLabelCandidatesSchema,
  runAutoOcrSchema,
  runPackageDetectionSchema,
  sourceAnalysisRunSchema,
  sourceAnalysisStateSchema,
  updateGraphEntitySchema,
} from "../metadata/metadata.schemas.js";
import { packageMultiplicityCommandSchema, wizardManualOcrCreateSchema, type WizardCommandRequest } from "./wizard.schemas.js";
import { getWizardStageState } from "./wizard.service.js";

const CV_STAGES = new Set<WizardStageId>(["mask", "morphology", "components", "elements", "contours", "palette"]);

export async function executeWizardCommand(
  source: SourceName,
  sourceItemId: string,
  annotationId: string,
  stage: WizardStageId,
  labelId: string | undefined,
  request: WizardCommandRequest,
  options: { actor?: EditOperationActor; approvalActor?: EditOperationActor } = {},
) {
  const preflight = await validateWizardCommand(source, sourceItemId, annotationId, stage, labelId, request);
  const { packageEntity, selectedLabelId } = preflight;
  const result = await dispatch({
    source, sourceItemId, annotationId, stage, labelId: selectedLabelId, packageEntity, request,
    actor: options.actor ?? "human", approvalActor: options.approvalActor ?? options.actor ?? "human",
  });
  let state: Awaited<ReturnType<typeof getWizardStageState>> | null = null;
  try { state = await getWizardStageState(source, sourceItemId, annotationId, stage, selectedLabelId); }
  catch (error) { if (!(error instanceof NotFoundError)) throw error; }
  return { schemaVersion: 1, commandId: randomUUID(), annotationId, stage, command: request.command, result, state };
}

export async function validateWizardCommand(
  source: SourceName,
  sourceItemId: string,
  annotationId: string,
  stage: WizardStageId,
  labelId: string | undefined,
  request: WizardCommandRequest,
) {
  const before = await getWizardStageState(source, sourceItemId, annotationId, stage, labelId);
  if (!before.guide.availableActions.includes(request.command)) {
    throw new ConflictError(`${request.command} is not available on ${stage}`);
  }
  if (!before.validation.valid && request.command !== "delete_region") {
    throw new ConflictError(`Stage prerequisites are not satisfied: ${before.validation.missingPrerequisites.join(", ") || "explicit labelId is required"}`);
  }

  const graph = await getAnnotationGraph(source, sourceItemId);
  const packageEntity = graph.packages.find((item) => item.legacyAnnotationTrackId === annotationId);
  if (!packageEntity) throw new NotFoundError("Package for annotation track was not found");
  const label = labelId ? packageEntity.labels.find((item) => item.id === labelId) : packageEntity.labels.length === 1 ? packageEntity.labels[0] : null;
  validateCommandPayload(stage, label?.id, packageEntity, request);
  return { valid: true as const, state: before, packageEntity, selectedLabelId: label?.id };
}

function validateCommandPayload(
  stage: WizardStageId,
  labelId: string | undefined,
  packageEntity: Awaited<ReturnType<typeof getAnnotationGraph>>["packages"][number],
  request: WizardCommandRequest,
) {
  const payload = request.payload;
  if (stage === "package" && request.command === "run_helper") {
    const input = runPackageDetectionSchema.parse(payload); if (input.scope.id !== packageEntity.id) throw new ConflictError("Package helper scope does not match the active Package");
  }
  else if ((stage === "label" || stage === "bottle") && (request.command === "run_helper" || request.command === "update_params")) sourceAnalysisRunSchema.parse(payload);
  else if (stage === "ocr" && (request.command === "run_helper" || request.command === "update_params")) {
    const input = runAutoOcrSchema.parse(payload); requireSelectedLabel(labelId, input.scope.id);
  } else if (CV_STAGES.has(stage) && request.command !== "commit") {
    const input = labelCvJobPreviewSchema.parse(payload); requireCvStage(stage, input.stage); requireLabel(labelId);
  } else if (stage === "bottle" && ["select_candidate", "edit_region", "set_semantic"].includes(request.command)) sourceAnalysisStateSchema.parse(payload);
  else if (stage === "package" && request.command === "select_candidate") { requireOwnedTarget(request.target, packageEntity, "package"); updateGraphEntitySchema.parse(payload); }
  else if (stage === "package" && request.command === "set_semantic" && !request.target) packageMultiplicityCommandSchema.parse(payload);
  else if (stage === "ocr" && request.command === "edit_region" && request.target?.entityType === "label") {
    const target = requireOwnedTarget(request.target, packageEntity, "label");
    requireSelectedLabel(labelId, target.id);
    updateGraphEntitySchema.parse(payload);
  }
  else if (request.command === "select_candidate" || request.command === "merge") {
    if (stage === "label") reviewGraphLabelCandidatesSchema.parse(payload);
    else if (stage === "ocr") reviewAutoOcrSchema.parse(payload);
  } else if (request.command === "create_region") {
    if (stage === "label") createGraphLabelSchema.parse(payload);
    else if (stage === "ocr") {
      const input = wizardManualOcrCreateSchema.parse(payload); requireSelectedLabel(labelId, input.annotation.parent.id);
    } else if (stage === "package") updateGraphEntitySchema.parse(payload);
  } else if (["edit_region", "set_semantic"].includes(request.command)) {
    requireOwnedTarget(request.target, packageEntity, entityTypeForStage(stage), stage === "ocr" ? labelId : undefined);
    updateGraphEntitySchema.parse(payload);
  } else if (request.command === "delete_region") requireOwnedTarget(request.target, packageEntity, entityTypeForStage(stage), stage === "ocr" ? labelId : undefined);
  else if (request.command === "reparent") {
    if (stage !== "ocr") throw new ConflictError("reparent is only valid on OCR");
    requireOwnedTarget(request.target, packageEntity, "ocr");
    const input = reparentGraphOcrSchema.parse(payload); requireSelectedLabel(labelId, input.target.id);
  } else if (request.command === "commit") {
    if (stage === "bottle") sourceAnalysisStateSchema.parse(payload);
    else if (CV_STAGES.has(stage)) { const input = labelCvJobCheckpointSchema.parse(payload); requireCvStage(stage, input.stage); requireLabel(labelId); }
    else if (stage === "summary") labelAnalysisReviewSchema.parse(payload);
  }
}

async function dispatch(context: {
  source: SourceName;
  sourceItemId: string;
  annotationId: string;
  stage: WizardStageId;
  labelId?: string;
  packageEntity: Awaited<ReturnType<typeof getAnnotationGraph>>["packages"][number];
  request: WizardCommandRequest;
  actor: EditOperationActor;
  approvalActor: EditOperationActor;
}) {
  const { source, sourceItemId, annotationId, stage, labelId, packageEntity, request, actor, approvalActor } = context;
  const payload = request.payload;

  if (stage === "package" && request.command === "run_helper") return runGraphPackageDetectionRecord(source, sourceItemId, runPackageDetectionSchema.parse(payload));
  if ((stage === "label" || stage === "bottle") && (request.command === "run_helper" || request.command === "update_params")) {
    return runSourceAnalysisRecord(source, sourceItemId, annotationId, sourceAnalysisRunSchema.parse(payload));
  }
  if (stage === "ocr" && (request.command === "run_helper" || request.command === "update_params")) {
    const input = runAutoOcrSchema.parse(payload);
    requireSelectedLabel(labelId, input.scope.id);
    return runGraphAutoOcrRecord(source, sourceItemId, input);
  }
  if (CV_STAGES.has(stage) && request.command !== "commit") {
    const input = labelCvJobPreviewSchema.parse(payload);
    requireCvStage(stage, input.stage);
    return previewLabelCvJobRecord(source, sourceItemId, annotationId, input, requireLabel(labelId));
  }

  if (stage === "bottle" && ["select_candidate", "edit_region", "set_semantic"].includes(request.command)) {
    return putSourceAnalysisRecord(source, sourceItemId, annotationId, sourceAnalysisStateSchema.parse(payload));
  }
  if (stage === "package" && request.command === "set_semantic" && !request.target) {
    const input = packageMultiplicityCommandSchema.parse(payload);
    const official=await officialTargetForTrack(source,sourceItemId,annotationId);
    if(official) {
      const current=await getAnnotationTrackState(source,sourceItemId,annotationId);
      await patchAnnotationTrackState(source,sourceItemId,annotationId,{annotations:{...current.annotations,officialPackageMultiplicity:input.value}});
      await captureOfficialDraft(official,await getAnnotationGraph(source,sourceItemId));
      return {officialReference:official,value:input.value,annotationVersion:{versionId:official.annotationVersionId,annotationTrackId:annotationId}};
    }
    const result = await setItemPackageMultiplicityRecord(source, sourceItemId, input);
    if (input.value !== "single") return result;
    const annotationVersion = await bootstrapAnnotationVersionRecord(source, sourceItemId);
    return { ...result, annotationVersion };
  }
  if (stage === "package" && request.command === "select_candidate") {
    const target = requireOwnedTarget(request.target, packageEntity, "package");
    const updated = await updateGraphEntityRecord(source, sourceItemId, "package", target.id, updateGraphEntitySchema.parse(payload), actor);
    await setItemPackageMultiplicityRecord(source, sourceItemId, {
      value: "single",
      operation: { helperId: "package-count-gate", helperVersion: "v2", initialConfig: {}, finalConfig: {}, reviewMode: "accepted" },
    });
    const annotationVersion = await bootstrapAnnotationVersionRecord(source, sourceItemId);
    return { updated, annotationVersion };
  }
  if (stage === "ocr" && request.command === "edit_region" && request.target?.entityType === "label") {
    const target = requireOwnedTarget(request.target, packageEntity, "label");
    requireSelectedLabel(labelId, target.id);
    return updateGraphEntityRecord(source, sourceItemId, "label", target.id, updateGraphEntitySchema.parse(payload), actor);
  }
  if (request.command === "select_candidate" || request.command === "merge") {
    if (stage === "label") return reviewGraphLabelCandidatesRecord(source, sourceItemId, packageEntity.id, {
      ...reviewGraphLabelCandidatesSchema.parse(payload), operationActor: actor, approvalActor,
    });
    if (stage === "ocr") return reviewGraphAutoOcrRecord(source, sourceItemId, reviewAutoOcrSchema.parse(payload));
    throw new ConflictError(`${request.command} has no server-side mapping on ${stage}`);
  }

  if (request.command === "create_region") {
    if (stage === "label") return createGraphLabelRecord(source, sourceItemId, packageEntity.id, { ...createGraphLabelSchema.parse(payload), operationActor: actor });
    if (stage === "ocr") {
      const input = wizardManualOcrCreateSchema.parse(payload);
      const selectedLabelId = requireLabel(labelId);
      requireSelectedLabel(selectedLabelId, input.annotation.parent.id);
      const preflight = await runManualOcrDedupePreflightRecord(source, sourceItemId, input.annotation);
      const duplicateMatches = preflight.matches.filter((item) => item.classification === "probable_duplicate" || item.classification === "possible_duplicate");
      if (duplicateMatches.length && !input.duplicateDecision) {
        return { preflight, review: null, decisionRequired: true, allowedDecisions: ["create", "merge"] };
      }
      if (input.duplicateDecision === "merge" && !duplicateMatches.some((item) => item.existingOcrId === input.mergeTargetId)) {
        throw new ConflictError("OCR merge target must be one of the dedupe matches");
      }
      const review = await reviewGraphAutoOcrRecord(source, sourceItemId, {
        operationId: preflight.operationId,
        reviews: input.duplicateDecision === "merge"
          ? [{ candidateId: preflight.candidateId, state: "merged", resultEntityId: input.mergeTargetId }]
          : [{ candidateId: preflight.candidateId, state: "accepted", finalParent: { type: "label", packageId: packageEntity.id, labelId: selectedLabelId } }],
      });
      return { preflight, review };
    }
    if (stage === "package") return updateGraphEntityRecord(source, sourceItemId, "package", packageEntity.id, updateGraphEntitySchema.parse(payload));
    throw new ConflictError(`create_region has no server-side mapping on ${stage}`);
  }

  if (["edit_region", "set_semantic"].includes(request.command)) {
    const target = requireOwnedTarget(request.target, packageEntity, entityTypeForStage(stage), stage === "ocr" ? labelId : undefined);
    return updateGraphEntityRecord(source, sourceItemId, target.entityType, target.id, updateGraphEntitySchema.parse(payload), actor);
  }
  if (request.command === "delete_region") {
    const target = requireOwnedTarget(request.target, packageEntity, entityTypeForStage(stage), stage === "ocr" ? labelId : undefined);
    return deleteGraphEntityRecord(source, sourceItemId, target.entityType, target.id);
  }
  if (request.command === "reparent") {
    if (stage !== "ocr") throw new ConflictError("reparent is only valid on OCR");
    const target = requireOwnedTarget(request.target, packageEntity, "ocr");
    const input = reparentGraphOcrSchema.parse(payload);
    requireSelectedLabel(labelId, input.target.id);
    return reparentGraphOcrRecord(source, sourceItemId, target.id, input);
  }

  if (request.command === "commit") {
    if (stage === "bottle") return putSourceAnalysisRecord(source, sourceItemId, annotationId, sourceAnalysisStateSchema.parse(payload));
    if (CV_STAGES.has(stage)) {
      const input = labelCvJobCheckpointSchema.parse(payload);
      requireCvStage(stage, input.stage);
      return putLabelCvJobCheckpointRecord(source, sourceItemId, annotationId, input, requireLabel(labelId));
    }
    if (stage === "summary") return putLabelAnalysisReviewRecord(source, sourceItemId, annotationId, labelAnalysisReviewSchema.parse(payload));
    if (["reviewed", "ready", "skipped"].includes(contextStateStatus(context))) return { committed: true };
    throw new ConflictError(`${stage} has no reviewed state to commit`);
  }
  throw new ConflictError(`${request.command} has no server-side mapping on ${stage}`);
}

function contextStateStatus(context: { packageEntity: Awaited<ReturnType<typeof getAnnotationGraph>>["packages"][number]; stage: WizardStageId; labelId?: string }) {
  const label = context.labelId ? context.packageEntity.labels.find((item) => item.id === context.labelId) : null;
  if (context.stage === "package") return context.packageEntity.scope.geometry || context.packageEntity.scope.source === "default-full-image" ? "reviewed" : "missing";
  if (context.stage === "label") return context.packageEntity.labels.length && context.packageEntity.labels.every((item) => item.geometryReviewStatus === "reviewed") ? "reviewed" : "missing";
  if (context.stage === "ocr") return label?.ocr.length && label.ocr.every((item) => item.regionStatus === "reviewed") ? "reviewed" : "missing";
  return "missing";
}

function requireOwnedTarget(target: WizardCommandRequest["target"], packageEntity: Awaited<ReturnType<typeof getAnnotationGraph>>["packages"][number], expected?: "package" | "label" | "ocr" | "meta", labelId?: string) {
  if (!target) throw new ConflictError("Command target is required");
  if (expected && target.entityType !== expected) throw new ConflictError(`${expected} target is required`);
  const owned = target.entityType === "package" ? target.id === packageEntity.id
    : target.entityType === "label" ? packageEntity.labels.some((item) => item.id === target.id)
      : target.entityType === "ocr" ? packageEntity.labels.some((item) => item.ocr.some((ocr) => ocr.id === target.id))
        : packageEntity.meta.some((item) => item.id === target.id) || packageEntity.labels.some((item) => item.meta.some((meta) => meta.id === target.id) || item.ocr.some((ocr) => ocr.meta.some((meta) => meta.id === target.id)));
  if (!owned) throw new NotFoundError("Command target does not belong to this annotation track");
  if (target.entityType === "ocr" && labelId) {
    const label = packageEntity.labels.find((item) => item.id === labelId);
    if (!label?.ocr.some((item) => item.id === target.id)) throw new NotFoundError("Command target does not belong to the selected Label branch");
  }
  return target;
}

function entityTypeForStage(stage: WizardStageId): "package" | "label" | "ocr" {
  if (stage === "package") return "package";
  if (stage === "label") return "label";
  if (stage === "ocr") return "ocr";
  throw new ConflictError(`${stage} does not expose canonical entity mutations`);
}

function requireLabel(labelId?: string) {
  if (!labelId) throw new ConflictError("Explicit labelId is required");
  return labelId;
}
function requireSelectedLabel(selected: string | undefined, payload: string) {
  if (requireLabel(selected) !== payload) throw new ConflictError("Command payload Label does not match the selected Label branch");
}
function requireCvStage(pathStage: WizardStageId, payloadStage: WizardStageId) {
  if (pathStage !== payloadStage) throw new ConflictError("Command payload stage does not match the route stage");
}
