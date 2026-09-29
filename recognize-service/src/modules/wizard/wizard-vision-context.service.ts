import { getAnnotationGraphForTrack } from "../../db/official-draft.repository.js";
import { getAnnotationTrackState } from "../../db/annotation-track.repository.js";
import { getSourceItemForTrack } from "../../db/official-draft.repository.js";
import { sourceAssetRef } from "../../shared/officialReference.js";
import { randomUUID } from "node:crypto";
import { getAnnotationGraph } from "../../db/annotation-graph.repository.js";
import { getSourceItem } from "../../db/source.repository.js";
import { getLatestWizardStageExecutions } from "../../db/wizard-stage-execution.repository.js";
import { getLatestCatalogIdentityReview } from "../../db/catalog-identity.repository.js";
import { getMetadata } from "../../db/meta.repository.js";
import { NotFoundError } from "../../shared/errors.js";
import type { WizardStageId } from "../../shared/helperConfigContract.js";
import type { SourceName } from "../../shared/types.js";
import { getWizardStageState } from "./wizard.service.js";

const PACKAGE_STAGES: WizardStageId[] = ["package", "label", "bottle", "summary"];
const LABEL_STAGES: WizardStageId[] = ["ocr", "mask", "morphology", "components", "elements", "contours", "palette"];

export async function buildVisionContext(source: SourceName, sourceItemId: string, annotationId: string) {
  const [graph, sourceItem, executions, sourceMetadata, catalogIdentityReview] = await Promise.all([
    getAnnotationGraphForTrack(source, sourceItemId, annotationId), getSourceItemForTrack(source, sourceItemId, annotationId),
    getLatestWizardStageExecutions(source, sourceItemId, annotationId),
    getMetadata(source, sourceItemId),
    getLatestCatalogIdentityReview(source, sourceItemId, annotationId),
  ]);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const packageEntity = graph.packages.find((item) => item.legacyAnnotationTrackId === annotationId);
  if (!packageEntity) throw new NotFoundError("Package for annotation track was not found");
  const packageStates = Object.fromEntries(await Promise.all(PACKAGE_STAGES.map(async (stage) => {
    const state = await getWizardStageState(source, sourceItemId, annotationId, stage);
    return [stage, compactState(state)] as const;
  })));
  const labelStates = Object.fromEntries(await Promise.all(packageEntity.labels.map(async (label) => [label.id,
    Object.fromEntries(await Promise.all(LABEL_STAGES.map(async (stage) => {
      const state = await getWizardStageState(source, sourceItemId, annotationId, stage, label.id);
      return [stage, compactState(state)] as const;
    }))),
  ] as const)));
  const graphConsistentForExport = graph.validation.readyForCanonicalExport;
  const workflowReadyForExport = packageStates.summary.status === "ready" && packageStates.summary.valid;
  const multiplicityMeta = graph.meta.find((item) => item.tags.includes("package-multiplicity"));
  const officialState=sourceItem.officialReference ? await getAnnotationTrackState(source,sourceItemId,annotationId) : null;
  const packageMultiplicity = officialState ? (officialState.annotations.officialPackageMultiplicity ?? "unknown") : multiplicityMeta?.tags.includes("multipackage") ? "multiple"
    : multiplicityMeta?.tags.includes("single-package") ? "single" : "unknown";
  const selectedSource = catalogIdentityReview?.selectedSource ?? source;
  const selectedSourceItemId = catalogIdentityReview?.selectedSourceItemId ?? sourceItemId;
  const selectedDiffers = selectedSource !== source || selectedSourceItemId !== sourceItemId;
  const [catalogItem, catalogMetadata] = selectedDiffers
    ? await Promise.all([getSourceItem(selectedSource, selectedSourceItemId), getMetadata(selectedSource, selectedSourceItemId)])
    : [sourceItem, sourceMetadata];
  const catalogEvidence = buildCatalogEvidence(
    catalogItem ?? sourceItem,
    catalogMetadata ?? sourceMetadata,
    catalogIdentityReview,
    { source: selectedSource, sourceItemId: selectedSourceItemId },
  );
  return {
    schemaVersion: 1,
    visionContextId: randomUUID(),
    generatedAt: new Date().toISOString(),
    card: { source, sourceItemId, title: sourceItem.title, manufacturer: sourceItem.manufacturer ?? null },
    catalogEvidence,
    annotationId,
    assets: {
      source: sourceAssetRef(sourceItem),
      alternatives: sourceItem.officialReference ? [sourceItem.officialReference.referencePath] : sourceItem.imageUrls,
      coordinateSpace: "source-image-pixels",
    },
    package: {
      id: packageEntity.id, scope: packageEntity.scope, packageType: packageEntity.packageType,
      objectContext: packageEntity.objectContext,
      multiplicity: { value: packageMultiplicity, source: multiplicityMeta?.source ?? null, metaId: multiplicityMeta?.id ?? null },
    },
    labels: packageEntity.labels.map((label) => ({
      id: label.id, origin: label.origin, geometryReviewStatus: label.geometryReviewStatus,
      visualRegionKind: label.visualRegionKind, geometry: label.geometry, rectification: label.rectification,
      revision: label.revision,
      ocr: label.ocr.map((ocr) => ({
        id: ocr.id, geometry: ocr.geometry, coordinateSpace: ocr.coordinateSpace, regionStatus: ocr.regionStatus,
        transcription: ocr.transcription, layout: ocr.layout, rectification: ocr.rectification,
      })),
      cv: { crop: assetProjection(label.cv.crop), job: cvProjection(label.cv.job) },
    })),
    stageState: { package: packageStates, labels: labelStates },
    executionEvidence: executions.map((execution) => ({
      id: execution.id, stage: execution.stage, revision: execution.revision, status: execution.status,
      helperId: execution.helperId, algorithm: execution.algorithm,
      hasAutoOutput: Boolean(execution.autoOutput), hasProposedOutput: Boolean(execution.proposedOutput),
      hasReviewedOutput: Boolean(execution.reviewedOutput), proposalExecutor: execution.proposalExecutor,
      proposalInteractionMode: execution.proposalInteractionMode, proposalPlanId: execution.proposalPlanId, reviewMode: execution.reviewMode,
    })),
    recentOperations: graph.operations.slice(-50).map((operation) => ({
      id: operation.id, operationType: operation.operationType, scope: operation.scope, helper: operation.helper,
      status: operation.status, result: operation.result, results: operation.results, reviewMode: operation.reviewMode,
    })),
    validation: {
      ...graph.validation,
      graphConsistentForExport,
      readyForCanonicalExport: graphConsistentForExport && workflowReadyForExport,
    },
  };
}

function buildCatalogEvidence(
  item: Awaited<ReturnType<typeof getSourceItem>>,
  metadata: Awaited<ReturnType<typeof getMetadata>>,
  review: Awaited<ReturnType<typeof getLatestCatalogIdentityReview>>,
  selected: { source: SourceName; sourceItemId: string },
) {
  const text = (value: unknown, limit: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
  return {
    schemaVersion: 1,
    authority: "untrusted-catalog-evidence",
    usagePolicy: "prior_only",
    identity: {
      status: review?.status ?? "unreviewed",
      reviewId: review?.id ?? null,
      revision: review?.revision ?? null,
      selectedSource: selected.source,
      selectedSourceItemId: selected.sourceItemId,
      score: review?.score ?? null,
    },
    fields: {
      title: text(item?.title, 500),
      manufacturer: text(item?.manufacturer, 300),
      category: text(item?.category, 200),
      region: text(item?.region, 200),
      year: Number.isInteger(item?.year) ? item!.year : null,
      barcode: text(item?.barcode, 32),
      color: text(item?.color, 100),
      description: text(item?.description, 1000),
    },
    aliases: (metadata?.aliases ?? []).filter((value): value is string => typeof value === "string" && Boolean(value.trim())).slice(0, 32).map((value) => value.trim().slice(0, 200)),
    normalizedTokens: (metadata?.normalized_tokens ?? []).filter((value): value is string => typeof value === "string" && Boolean(value.trim())).slice(0, 64).map((value) => value.trim().slice(0, 100)),
  };
}

function compactState(state: Awaited<ReturnType<typeof getWizardStageState>>) {
  return { status: state.status, valid: state.validation.valid, missingPrerequisites: state.validation.missingPrerequisites, warnings: state.validation.warnings, availableActions: state.guide.availableActions };
}
function assetProjection(value: unknown) {
  const item = object(value); return Object.keys(item).length ? { id: item.id ?? null, assetPath: item.assetPath ?? null, sourceImage: item.sourceImage ?? null, labelRevision: item.labelRevision ?? null } : null;
}
function cvProjection(value: unknown) {
  const job = object(value); const workflow = object(job.workflow); const checkpoints = object(workflow.checkpoints);
  return Object.keys(job).length ? {
    analysisJobId: job.analysisJobId ?? null, debugArtifact: job.debugArtifact ?? null,
    checkpoints: Object.fromEntries(Object.entries(checkpoints).map(([stage, checkpoint]) => [stage, {
      status: object(checkpoint).status ?? null, completedAt: object(checkpoint).completedAt ?? null,
    }])),
  } : null;
}
function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
