import { getAnnotationGraphForTrack } from "../../db/official-draft.repository.js";
import { getAnnotationGraph } from "../../db/annotation-graph.repository.js";
import { requireAnnotationTrack } from "../../db/annotation-track.repository.js";
import { NotFoundError } from "../../shared/errors.js";
import type { WizardStageId } from "../../shared/helperConfigContract.js";
import type { AnnotationGraph } from "../../shared/annotationGraphContract.js";
import type { SourceName } from "../../shared/types.js";
import { wizardStageGuide, wizardWorkflowContract } from "../../shared/wizardWorkflowContract.js";

export function getWizardWorkflowContract() { return wizardWorkflowContract(); }

export async function getWizardStageState(source: SourceName, sourceItemId: string, annotationId: string, stage: WizardStageId, labelId?: string) {
  await requireAnnotationTrack(source, sourceItemId, annotationId);
  const graph = await getAnnotationGraphForTrack(source, sourceItemId, annotationId);
  const packageEntity = graph.packages.find((item) => item.legacyAnnotationTrackId === annotationId);
  if (!packageEntity) throw new NotFoundError("Package for annotation track was not found");
  const guide = wizardStageGuide(stage);
  const explicitLabel = labelId ? packageEntity.labels.find((item) => item.id === labelId) : null;
  if (labelId && !explicitLabel) throw new NotFoundError("Label does not belong to this annotation track");
  const label = explicitLabel ?? (packageEntity.labels.length === 1 ? packageEntity.labels[0]! : null);
  const prerequisites = Object.fromEntries(guide.prerequisites.map((item) => [item,
    item === "label" && guide.scope === "label" && label ? label.geometryReviewStatus : stageStatus(item, packageEntity, label, graph),
  ]));
  const missingPrerequisites = Object.entries(prerequisites).filter(([, status]) => !["ready", "reviewed", "skipped"].includes(status)).map(([item]) => item);
  const status = stage === "summary"
    ? missingPrerequisites.length === 0 && graph.validation.readyForCanonicalExport ? "ready" : "not-ready"
    : stageStatus(stage, packageEntity, label, graph);
  return {
    schemaVersion: 1,
    annotationId,
    card: { source, sourceItemId },
    stage,
    guide,
    context: {
      packageId: packageEntity.id,
      labelId: label?.id ?? null,
      labelSelectionRequired: guide.scope === "label" && packageEntity.labels.length !== 1 && !labelId,
      availableLabelIds: packageEntity.labels.map((item) => item.id),
    },
    status,
    prerequisites,
    validation: {
      valid: missingPrerequisites.length === 0 && !(guide.scope === "label" && !label),
      missingPrerequisites,
      warnings: [
        ...(guide.scope === "label" && !label ? ["Explicit labelId is required for this Label-scoped stage."] : []),
        ...(graph.validation.unresolvedIdentityConflicts ? [`${graph.validation.unresolvedIdentityConflicts} unresolved identity conflict(s).`] : []),
      ],
    },
    state: stageValue(stage, packageEntity, label, graph),
  };
}

function stageStatus(stage: WizardStageId, packageEntity: AnnotationGraph["packages"][number], label: AnnotationGraph["packages"][number]["labels"][number] | null, graph: AnnotationGraph) {
  if (stage === "package") return packageEntity.scope.geometry || packageEntity.scope.source === "default-full-image" ? "reviewed" : "missing";
  if (stage === "label") return packageEntity.labels.length && packageEntity.labels.every((item) => item.geometryReviewStatus === "reviewed") ? "reviewed" : packageEntity.labels.length ? "draft" : "missing";
  if (stage === "bottle") return packageEntity.objectContext.status === "reviewed" ? "reviewed" : packageEntity.objectContext.status === "rejected" ? "skipped" : packageEntity.objectContext.status;
  if (stage === "ocr") {
    if (!label) return "blocked";
    const regions = currentLabelOcr(label);
    return regions.length && regions.every((item) => item.regionStatus === "reviewed") ? "reviewed" : regions.length ? "draft" : "missing";
  }
  if (["mask", "morphology", "components", "elements", "contours", "palette"].includes(stage)) {
    if (!label) return "blocked";
    const checkpoint = objectValue(objectValue(objectValue(label.cv.job).workflow).checkpoints)[stage];
    const value = objectValue(checkpoint);
    return value.status === "valid" ? "reviewed" : Object.keys(value).length ? "draft" : "missing";
  }
  return graph.validation.readyForCanonicalExport ? "ready" : "not-ready";
}

function stageValue(stage: WizardStageId, packageEntity: AnnotationGraph["packages"][number], label: AnnotationGraph["packages"][number]["labels"][number] | null, graph: AnnotationGraph) {
  if (stage === "package") return { scope: packageEntity.scope, packageType: packageEntity.packageType };
  if (stage === "label") return { labels: packageEntity.labels.map(({ id, origin, geometryReviewStatus, visualRegionKind, geometry, revision, status }) => ({ id, origin, geometryReviewStatus, visualRegionKind, geometry, revision, status })) };
  if (stage === "bottle") return packageEntity.objectContext;
  if (stage === "ocr") return { labelId: label?.id ?? null, labelRevision: label?.revision ?? null, regions: label ? currentLabelOcr(label) : [] };
  if (["mask", "morphology", "components", "elements", "contours", "palette"].includes(stage)) return { labelId: label?.id ?? null, checkpoint: objectValue(objectValue(objectValue(label?.cv.job).workflow).checkpoints)[stage] ?? null };
  return { validation: graph.validation, packages: graph.packages.map((item) => ({ id: item.id, labels: item.labels.map((value) => value.id) })) };
}

function objectValue(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }

function currentLabelOcr(label: AnnotationGraph["packages"][number]["labels"][number]) {
  return label.ocr.filter((item) => item.coordinateSpace.type !== "label-rectified"
    || item.coordinateSpace.cropRevision === label.revision
    || (item.coordinateSpace.cropRevision === null && label.rectification === null));
}
