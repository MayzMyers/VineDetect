import { getSourceItemForTrack, officialTargetForTrack, captureOfficialDraft } from "../../db/official-draft.repository.js";
import { sourceAssetRef } from "../../shared/officialReference.js";
import {
  getLabelAnnotationState,
  listDetectionProposals,
  putDetectionProposalState,
  putLabelAnnotationState,
  type LabelAnnotationState,
  type LabelRoiPrediction,
  getLatestReviewedLabelAnnotationRevision,
} from "../../db/annotation.repository.js";
import {
  getMetadata,
  deleteOperationalMetadataItems,
  deleteManualAnnotations,
  listGenerationJobsForSourceItem,
  listMetadata,
  patchMetadata,
  putManualAnnotations,
  getManualAnnotations,
  type MetaItemRow,
} from "../../db/meta.repository.js";
import { createBackendOcrSnapshot, getLatestOcrRegionReview, getLatestOcrSnapshot, getLatestOcrTextReview, putOcrRegionReview, putOcrTextReview } from "../../db/ocr.repository.js";
import { getLatestSourceAssociationReview, putSourceAssociationReview, sourceValueKey } from "../../db/source-association.repository.js";
import { getLatestAliasReview, putAliasReview } from "../../db/alias.repository.js";
import { getLatestLabelAnalysisReview, putLabelAnalysisReview } from "../../db/label-analysis-review.repository.js";
import { getLatestCatalogIdentityReview, putCatalogIdentityReview } from "../../db/catalog-identity.repository.js";
import { findCatalogCandidates, getSourceItem } from "../../db/source.repository.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import type { LabelAnalysisTextRegion, SourceName } from "../../shared/types.js";
import { buildSourceMatchCandidates, buildSourceValues } from "../ocr/sourceMatcher.js";
import { buildAliasCandidates } from "../recognize-core/aliasReview.js";
import { enqueueRecognizeJob } from "../jobs/jobs.service.js";
import { extractLabelCropFeatures, normalizeLabelAnalysisCvConfig, type ElementOcrRegion, type LabelCvReviewState, type LabelCvStage } from "../label-analysis/labelCropFeatures.js";
import { resolveGeneratedAssetPath, resolveLocalAssetPath } from "../recognize-node/assets.js";
import { detachLabelCvDebugArtifact, hydrateLabelCvDebugArtifact } from "../label-analysis/labelCvDebugArtifact.js";
import { buildCatalogSearchInput, rankCatalogCandidates } from "../ocr/catalogMatcher.js";
import { classifyOcrSemantic } from "../ocr/semantic.js";
import { runSourceAnalysis } from "../source-analysis/sourceAnalysis.js";
import { runPackageContext } from "../source-analysis/bottleContext.js";
import { exportManualMetadata } from "../../db/manual-metadata-export.repository.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { bindAllHelpersToCard, buildHelperConfigContract } from "../../shared/helperConfigContract.js";
import { buildStageSamplesV1 } from "../../shared/stageSampleContract.js";
import {
  getLatestWizardStageExecutions,
  reviewWizardStageExecution,
  startWizardStageExecution,
} from "../../db/wizard-stage-execution.repository.js";
import {
  ocrAlgorithm,
  ocrStageAutoOutput,
  ocrStageInput,
  ocrStageParams,
  ocrIntermediateStates,
  ocrStageReviewedOutput,
  summaryStageInput,
  summaryStageOutput,
  summaryStageParams,
} from "../../shared/wizardStageEvidence.js";
import { createAnnotationTrack, getAnnotationTrackState, listAnnotationTracks, patchAnnotationTrackState } from "../../db/annotation-track.repository.js";
import {
  captureActiveAnnotationVersion,
  createFreshAnnotationVersion,
  deleteAnnotationVersion,
  deleteMetadataVersion,
  forkAnnotationVersionForEditing,
  ensureAndListMetadataVersions,
  ensureAnnotationVersion,
  getAnnotationVersion,
  getAnnotationVersionPointers,
  listAnnotationVersions,
  makeMetadataVersionDefault,
  promoteAnnotationVersion,
} from "../../db/card-version.repository.js";
import { createGraphLabel, createGraphMeta, createGraphOcr, createGraphPackage, deleteGraphEntity, getAnnotationGraph, getGraphLabelCvState, putGraphLabelCvState, reparentGraphOcr, reviewGraphLabelCandidates, setItemPackageMultiplicity, syncLegacyLabelEntity, syncLegacyOcrEntities, syncLegacyPackageObjectContext, updateGraphEntity } from "../../db/annotation-graph.repository.js";
import { reviewParentScopedAutoOcr, reviewParentScopedAutoOcrActions, runManualOcrDedupePreflight, runParentScopedAutoOcr } from "../ocr/ocrAnnotationService.js";
import { createRectifiedLabelCrop } from "../label-analysis/labelQuadCrop.js";
import { runLabelRectificationHelper } from "../label-analysis/labelRectificationHelper.js";

export async function getAnnotationGraphRecord(source: SourceName, sourceItemId: string) {
  if (!await getSourceItem(source, sourceItemId)) throw new NotFoundError("Source item not found");
  return getAnnotationGraph(source, sourceItemId);
}

export async function listAnnotationVersionRecords(source: SourceName, sourceItemId: string) {
  if (!await getSourceItem(source, sourceItemId)) throw new NotFoundError("Source item not found");
  return listAnnotationVersions(source, sourceItemId);
}

export function getAnnotationVersionRecord(source: SourceName, sourceItemId: string, versionId: string) {
  return getAnnotationVersion(source, sourceItemId, versionId);
}

export async function createAnnotationVersionRecord(source: SourceName, sourceItemId: string, origin = "card-ui") {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const graph = await getAnnotationGraphRecord(source, sourceItemId);
  const pointers = await getAnnotationVersionPointers(source, sourceItemId);
  if (!pointers) {
    const created = await ensureAnnotationVersion(source, sourceItemId, graph as unknown as Record<string, unknown>, origin);
    const version = await getAnnotationVersion(source, sourceItemId, created.activeVersionId);
    return {
      versionId: version.id,
      revision: version.revision,
      annotationTrackId: version.annotationTrackId,
      status: version.status,
    };
  }
  return createFreshAnnotationVersion(source, sourceItemId, graph as unknown as Record<string, unknown>, origin, undefined, sourceItem.imageUrls[0] ?? null);
}

export async function bootstrapAnnotationVersionRecord(source: SourceName, sourceItemId: string) {
  const graph = await getAnnotationGraphRecord(source, sourceItemId);
  const existing = await getAnnotationVersionPointers(source, sourceItemId);
  const pointers = existing ?? await ensureAnnotationVersion(
    source,
    sourceItemId,
    graph as unknown as Record<string, unknown>,
    "package-approved",
  );
  const version = await getAnnotationVersion(source, sourceItemId, pointers.activeVersionId);
  return {
    created: !existing,
    versionId: version.id,
    revision: version.revision,
    annotationTrackId: version.annotationTrackId,
    status: version.status,
  };
}

export async function editAnnotationVersionRecord(source: SourceName, sourceItemId: string, versionId: string) {
  if((await getAnnotationVersion(source,sourceItemId,versionId)).origin === 'contest-official') throw new ConflictError('Open a separate official draft through the official reference selector');
  const currentGraph = await getAnnotationGraphRecord(source, sourceItemId);
  const created = await forkAnnotationVersionForEditing(source, sourceItemId, versionId, currentGraph as unknown as Record<string, unknown>);
  const restoredGraph = await getAnnotationGraphRecord(source, sourceItemId);
  await captureActiveAnnotationVersion(source, sourceItemId, restoredGraph as unknown as Record<string, unknown>);
  return created;
}

export function deleteAnnotationVersionRecord(source: SourceName, sourceItemId: string, versionId: string) {
  return deleteAnnotationVersion(source, sourceItemId, versionId);
}

export async function promoteAnnotationVersionRecord(source: SourceName, sourceItemId: string, versionId: string) {
  const graph = await getAnnotationGraphRecord(source, sourceItemId);
  await promoteAnnotationVersion(source, sourceItemId, versionId, graph as unknown as Record<string, unknown>);
  return getAnnotationVersion(source, sourceItemId, versionId);
}

export async function listMetadataVersionRecords(source: SourceName, sourceItemId: string) {
  if (!await getSourceItem(source, sourceItemId)) throw new NotFoundError("Source item not found");
  const current = await getMetadata(source, sourceItemId);
  return ensureAndListMetadataVersions(source, sourceItemId, current as unknown as Record<string, unknown> | null);
}

export function makeMetadataVersionDefaultRecord(source: SourceName, sourceItemId: string, versionId: string) {
  return makeMetadataVersionDefault(source, sourceItemId, versionId);
}

export function deleteMetadataVersionRecord(source: SourceName, sourceItemId: string, versionId: string) {
  return deleteMetadataVersion(source, sourceItemId, versionId);
}

export async function getGraphPackageOcrRecord(source: SourceName, sourceItemId: string, packageId: string) {
  const graph = await getAnnotationGraphRecord(source, sourceItemId);
  const packageRow = graph.packages.find((entry) => entry.id === packageId);
  if (!packageRow) throw new NotFoundError("Annotation package not found");
  return { packageId, items: packageRow.labels.flatMap((label) => label.ocr), direct: [], labels: packageRow.labels.map((label) => ({ labelId: label.id, items: label.ocr })) };
}

export async function createGraphPackageRecord(source: SourceName, sourceItemId: string, input: Parameters<typeof createGraphPackage>[2]) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return createGraphPackage(source, sourceItemId, { ...input, sourceAssetRef: input.sourceAssetRef ?? sourceItem.imageUrls[0] });
}

export async function runGraphPackageDetectionRecord(source: SourceName, sourceItemId: string, input: {
  scope: { type: "package"; id: string };
  config: Parameters<typeof runPackageContext>[3];
}) {
  const graph = await getAnnotationGraph(source, sourceItemId);
  const packageEntity = graph.packages.find((item) => item.id === input.scope.id);
  if (!packageEntity) throw new NotFoundError("Annotation package not found");
  const sourceAssetRef = packageEntity.sourceAssetRef;
  const imagePath = sourceAssetRef ? resolveLocalAssetPath(sourceAssetRef) : null;
  if (!sourceAssetRef || !imagePath) throw new ConflictError("Package has no local source asset for Auto Helper");
  const metadata = await sharp(imagePath, { failOn: "none" }).metadata();
  const swapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  const width = swapsAxes ? metadata.height ?? 0 : metadata.width ?? 0;
  const height = swapsAxes ? metadata.width ?? 0 : metadata.height ?? 0;
  if (!width || !height) throw new ConflictError("Package source dimensions are unavailable");
  const result = await runPackageContext(imagePath, width, height, input.config);
  return {
    schemaVersion: 1 as const,
    runId: randomUUID(),
    helper: { id: "package-smart-lasso" as const, version: result.algorithm },
    scope: input.scope,
    sourceImage: { width, height, imageUrl: sourceAssetRef },
    config: result.config,
    candidates: result.candidates,
    selectedCandidateId: result.selectedCandidateId,
    debug: result.debug,
    status: "draft" as const,
  };
}

export async function createGraphLabelRecord(source: SourceName, sourceItemId: string, packageId: string, input: Parameters<typeof createGraphLabel>[3]) {
  return createGraphLabel(source, sourceItemId, packageId, input);
}

export async function reviewGraphLabelCandidatesRecord(source: SourceName, sourceItemId: string, packageId: string, input: Parameters<typeof reviewGraphLabelCandidates>[3]) {
  return reviewGraphLabelCandidates(source, sourceItemId, packageId, input);
}

export async function createGraphOcrRecord(source: SourceName, sourceItemId: string, parent: Parameters<typeof createGraphOcr>[2], input: Parameters<typeof createGraphOcr>[3]) {
  return createGraphOcr(source, sourceItemId, parent, input);
}

export async function runGraphAutoOcrRecord(source: SourceName, sourceItemId: string, input: Parameters<typeof runParentScopedAutoOcr>[2]) {
  return runParentScopedAutoOcr(source, sourceItemId, input);
}

export async function runGraphLabelRectificationRecord(source: SourceName, sourceItemId: string, input: Parameters<typeof runLabelRectificationHelper>[2]) {
  return runLabelRectificationHelper(source, sourceItemId, input);
}

export async function reviewGraphAutoOcrRecord(source: SourceName, sourceItemId: string, input: Parameters<typeof reviewParentScopedAutoOcr>[2]) {
  return reviewParentScopedAutoOcr(source, sourceItemId, input);
}

export async function reviewGraphAutoOcrActionsRecord(source: SourceName, sourceItemId: string, input: Parameters<typeof reviewParentScopedAutoOcrActions>[2]) {
  return reviewParentScopedAutoOcrActions(source, sourceItemId, input);
}

export async function runManualOcrDedupePreflightRecord(source: SourceName, sourceItemId: string, input: Parameters<typeof runManualOcrDedupePreflight>[2]) {
  return runManualOcrDedupePreflight(source, sourceItemId, input);
}

export async function reparentGraphOcrRecord(source: SourceName, sourceItemId: string, ocrId: string, input: {
  target: { type: "label"; id: string };
  operation: Parameters<typeof reparentGraphOcr>[3]["operation"];
}) {
  return reparentGraphOcr(source, sourceItemId, ocrId, { type: "label", id: input.target.id, operation: input.operation });
}

export async function createGraphMetaRecord(source: SourceName, sourceItemId: string, input: Parameters<typeof createGraphMeta>[2]) {
  return createGraphMeta(source, sourceItemId, input);
}

export async function setItemPackageMultiplicityRecord(source: SourceName, sourceItemId: string, input: {
  value: "single" | "multiple";
  operation: Parameters<typeof setItemPackageMultiplicity>[3];
}) {
  return setItemPackageMultiplicity(source, sourceItemId, input.value, input.operation, "auto");
}

export async function deleteGraphEntityRecord(source: SourceName, sourceItemId: string, entityType: Parameters<typeof deleteGraphEntity>[2], entityId: string) {
  return deleteGraphEntity(source, sourceItemId, entityType, entityId);
}

export async function updateGraphEntityRecord(source: SourceName, sourceItemId: string, entityType: Parameters<typeof updateGraphEntity>[2], entityId: string, input: Parameters<typeof updateGraphEntity>[4], operationActor?: Parameters<typeof updateGraphEntity>[5]) {
  const graph=await getAnnotationGraph(source,sourceItemId);
  const packageEntity=graph.packages.find(p=>p.id===entityId || p.labels.some(l=>l.id===entityId));
  const official=packageEntity?.legacyAnnotationTrackId ? await officialTargetForTrack(source,sourceItemId,packageEntity.legacyAnnotationTrackId) : null;
  if(official && input.sourceAssetRef !== undefined && input.sourceAssetRef!==official.referencePath) throw new ConflictError("Official Package asset binding is immutable");
  const result=await updateGraphEntity(source, sourceItemId, entityType, entityId, input, operationActor);
  if(official) await captureOfficialDraft(official,await getAnnotationGraph(source,sourceItemId));
  return result;
}

export async function listAnnotationTrackRecords(source: SourceName, sourceItemId: string) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return { items: await listAnnotationTracks(source, sourceItemId) };
}

export async function createAnnotationTrackRecord(source: SourceName, sourceItemId: string, input: Parameters<typeof createAnnotationTrack>[2]) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return createAnnotationTrack(source, sourceItemId, {
    ...input,
    sourceAssetRef: input.sourceAssetRef ?? sourceItem.imageUrls[0],
  });
}

export async function listMetadataRecords(params: Parameters<typeof listMetadata>[0]) {
  const { rows, total } = await listMetadata(params);
  const items = await Promise.all(
    rows.map(async (row) => {
      const sourceItem = await getSourceItem(row.source, row.source_item_id);
      return toMetadataDto(row, sourceItem);
    }),
  );

  return {
    items,
    offset: (params.page - 1) * params.limit,
    limit: params.limit,
    total,
  };
}

export async function getMetadataSandbox(source: SourceName, sourceItemId: string) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const metadata = await getMetadata(source, sourceItem.sourceItemId);
  const jobs = await listGenerationJobsForSourceItem({
    source,
    sourceItemId: sourceItem.sourceItemId,
    limit: 100,
  });
  return {
    sourceItem,
    metadata: metadata ? toMetadataDto(metadata, sourceItem) : null,
    jobs: jobs.map(toItemJobDto),
  };
}

export async function getLabelAnnotationRecord(source: SourceName, sourceItemId: string, trackId: string) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return getLabelAnnotationState(source, sourceItem.sourceItemId, trackId, sourceAssetRef(sourceItem));
}

export async function putLabelAnnotationRecord(source: SourceName, sourceItemId: string, trackId: string, state: LabelAnnotationState) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const imageRef = sourceAssetRef(sourceItem);
  const saved = await putLabelAnnotationState(source, sourceItem.sourceItemId, trackId, state, imageRef);
  await syncLegacyLabelEntity(source, sourceItem.sourceItemId, trackId, saved);
  const prediction = saved.prediction;
  if (!prediction) return saved;
  if (!["reviewed", "no-label", "invalid-image"].includes(saved.status)) return saved;
  const stageExecution = await reviewWizardStageExecution({
    source, sourceItemId: sourceItem.sourceItemId, annotationTrackId: trackId, stage: "label", helperId: "label-roi-detection",
    algorithm: prediction.algorithm.id, algorithmVersion: prediction.algorithm.version ?? null,
    stageInput: { imageRef }, defaultParams: prediction.algorithm.defaultParams ?? null,
    finalParams: prediction.algorithm.params ?? {},
    reviewedOutput: { annotation: saved.annotation, status: saved.status },
    selection: prediction.candidateId ? { runId: prediction.helperRunId ?? null, candidateId: prediction.candidateId } : null,
    reviewMode: saved.source === "auto" ? "accepted" : saved.source === "manual" ? "manual" : "corrected",
  });
  return { ...saved, stageExecution };
}

export async function putDetectionProposalRecord(source: SourceName, sourceItemId: string, trackId: string, prediction: LabelRoiPrediction) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const imageRef = sourceAssetRef(sourceItem);
  const saved = await putDetectionProposalState(source, sourceItem.sourceItemId, trackId, prediction, imageRef);
  const canonicalPrediction = saved.prediction ?? prediction;
  const stageExecution = await startWizardStageExecution({
    source, sourceItemId: sourceItem.sourceItemId, annotationTrackId: trackId, stage: "label", helperId: "label-roi-detection",
    algorithm: canonicalPrediction.algorithm.id, algorithmVersion: canonicalPrediction.algorithm.version ?? null,
    stageInput: { imageRef }, defaultParams: canonicalPrediction.algorithm.defaultParams ?? null,
    initialParams: canonicalPrediction.algorithm.params ?? {}, autoOutput: { prediction: canonicalPrediction },
  });
  return { ...saved, stageExecution };
}

export async function getLabelAnalysisReviewRecord(source: SourceName, sourceItemId: string, trackId: string) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return getLatestLabelAnalysisReview(source, sourceItem.sourceItemId, trackId);
}

export async function putLabelAnalysisReviewRecord(source: SourceName, sourceItemId: string, trackId: string, input: Parameters<typeof putLabelAnalysisReview>[3]) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const saved = await putLabelAnalysisReview(source, sourceItem.sourceItemId, trackId, input);
  const workspace = await getLabelAnalysisWorkspaceRecord(source, sourceItem.sourceItemId, trackId);
  const stageInput = summaryExecutionStageInput(workspace);
  await startWizardStageExecution({
    source, sourceItemId: sourceItem.sourceItemId, annotationTrackId: trackId, stage: "summary", helperId: "label-summary",
    algorithm: "label-summary-v1", algorithmVersion: "1",
    stageInput, initialParams: summaryStageParams(), autoOutput: summaryStageOutput(workspace.summary),
  });
  const stageExecution = await reviewWizardStageExecution({
    source, sourceItemId: sourceItem.sourceItemId, annotationTrackId: trackId, stage: "summary", helperId: "label-summary",
    algorithm: "label-summary-v1", algorithmVersion: "1",
    stageInput, finalParams: summaryStageParams(),
    reviewedOutput: { ...summaryStageOutput(workspace.summary), review: saved },
    reviewMode: "accepted",
  });
  const official = await officialTargetForTrack(source, sourceItem.sourceItemId, trackId);
  if (official) await captureOfficialDraft(official, await getAnnotationGraph(source, sourceItem.sourceItemId));
  if (saved.status === "accepted" && !official) {
    const pointers = await getAnnotationVersionPointers(source, sourceItem.sourceItemId);
    if (pointers?.activeVersionId) {
      const activeVersion = await getAnnotationVersion(source, sourceItem.sourceItemId, pointers.activeVersionId);
      if (activeVersion.annotationTrackId === trackId) {
        const graph = await getAnnotationGraph(source, sourceItem.sourceItemId);
        await promoteAnnotationVersion(source, sourceItem.sourceItemId, pointers.activeVersionId, graph as unknown as Record<string, unknown>);
      }
    }
  }
  return { ...saved, stageExecution };
}

export async function getLabelAnalysisWorkspaceRecord(source: SourceName, sourceItemId: string, trackId: string) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const [annotation, metadata, catalogMetadata, review, jobs, ocrReview, regionReview, associationReview, catalogIdentityReview, stageExecutions] = await Promise.all([
    getLabelAnnotationState(source, sourceItem.sourceItemId, trackId, sourceAssetRef(sourceItem)),
    getAnnotationTrackState(source, sourceItem.sourceItemId, trackId),
    getMetadata(source, sourceItem.sourceItemId),
    getLatestLabelAnalysisReview(source, sourceItem.sourceItemId, trackId),
    listGenerationJobsForSourceItem({ source, sourceItemId: sourceItem.sourceItemId, annotationTrackId: trackId, limit: 100 }),
    getLatestOcrTextReview(source, sourceItem.sourceItemId, trackId),
    getLatestOcrRegionReview(source, sourceItem.sourceItemId, trackId),
    getLatestSourceAssociationReview(source, sourceItem.sourceItemId, trackId),
    getLatestCatalogIdentityReview(source, sourceItem.sourceItemId, trackId),
    getLatestWizardStageExecutions(source, sourceItem.sourceItemId, trackId),
  ]);
  const visualFeatures = normalizeObject(metadata?.visual_features);
  const analysis = normalizeObject(visualFeatures.labelAnalysis);
  const sourceAnalysis = normalizeObject(visualFeatures.labelSourceAnalysis);
  const cvJob = await hydrateLabelCvDebugArtifact(normalizeObject(visualFeatures.labelCvJob));
  const reviewed = normalizeObject(annotation.annotation);
  const analysisJob = jobs.find((job) => String(job.job_type ?? job.mode ?? "") === "ANALYZE_LABEL");
  const hasAnalysis = Object.keys(analysis).length > 0;
  const stale = hasAnalysis && (
    String(analysis.annotationId ?? "") !== String(reviewed.id ?? "")
    || Number(analysis.annotationRevision ?? 0) !== Number(reviewed.revision ?? 0)
  );
  const summary = await buildLabelWorkflowSummary({ sourceItem, metadata: catalogMetadata, analysis, cvJob, ocrReview, regionReview, associationReview });
  const analysisOcr = normalizeObject(analysis.ocr);
  const labelPrediction = normalizeObject(annotation.prediction);
  const helperContract = buildHelperConfigContract(
    visualFeatures,
    normalizeObject(analysisOcr.evidence),
    analysisOcr.id,
    Object.keys(labelPrediction).length ? { ...labelPrediction, reviewStatus: annotation.status } : null,
  );
  const helperBindings = bindAllHelpersToCard(helperContract, source, sourceItem.sourceItemId);
  const stageSamples = buildStageSamplesV1({
    source, sourceItemId: sourceItem.sourceItemId, helperContract, labelRoi: annotation,
    sourceAnalysis, analysis, ocrRegions: regionReview,
    sourceAssociations: associationReview, cvJob, summary, finalReview: review,
    stageExecutions,
  });
  return {
    annotation,
    sourceAnalysis: Object.keys(sourceAnalysis).length > 0 ? sourceAnalysis : null,
    analysis: hasAnalysis ? analysis : null,
    review,
    stale,
    latestJob: analysisJob ? toItemJobDto(analysisJob) : null,
    cvJob: Object.keys(cvJob).length > 0 ? cvJob : null,
    summary,
    ocrRegionReview: regionReview,
    ocrRegionAnnotationSetId: regionReview?.id ?? null,
    catalogIdentityReview,
    helperBindings,
    stageSamples,
    stageExecutions,
  };
}

export async function getCanonicalLabelCvWorkspaceRecord(source: SourceName, sourceItemId: string, trackId: string, labelId: string) {
  const context = await getCurrentLabelAnalysisContext(source, sourceItemId, trackId, labelId);
  const cvJob = await hydrateLabelCvDebugArtifact(normalizeObject(context.visualFeatures.labelCvJob));
  const preview = normalizeObject(cvJob.preview);
  const reviewedOcr = context.canonicalOcrRegions.filter((region) => region.regionStatus === "reviewed");
  const components = Array.isArray(preview.components) ? preview.components : [];
  const elements = Array.isArray(preview.elements) ? preview.elements : [];
  const contours = Array.isArray(preview.contours) ? preview.contours : [];
  const palette = Array.isArray(cvJob.palette) ? cvJob.palette : Array.isArray(preview.palette) ? preview.palette : [];
  return {
    annotation: {
      schemaVersion: 2, prediction: null,
      annotation: { id: context.annotation.id, revision: context.annotation.revision, roi: context.annotation.bbox, geometry: context.annotation.geometry, rectification: context.annotation.rectification },
      status: "reviewed", reviewed: true, roiEdited: true, source: "manual", iou: null, labelRoiGt: true,
    },
    sourceAnalysis: null,
    analysis: context.analysis,
    review: null,
    stale: false,
    latestJob: null,
    cvJob: Object.keys(cvJob).length ? cvJob : null,
    summary: {
      schemaVersion: 1, computedAt: new Date().toISOString(),
      ocrText: reviewedOcr.flatMap((region) => region.transcription.status === "verified" && region.transcription.text ? [region.transcription.text] : []).join("\n"),
      reviewedRegionCount: reviewedOcr.length, sourceMatches: [], fixedAssociations: [], catalogCandidates: [], palette,
      componentCount: components.length, reviewedComponentCount: components.length,
      elementCount: elements.length, reviewedElementCount: elements.length,
      contourCount: contours.length,
      contourPointCount: contours.reduce((total, value) => total + (Array.isArray(normalizeObject(value).points) ? (normalizeObject(value).points as unknown[]).length : 0), 0),
      ocrEvidence: null,
    },
    ocrRegionReview: null,
    ocrRegionAnnotationSetId: null,
    catalogIdentityReview: null,
    helperBindings: [], stageSamples: [], stageExecutions: [],
    labelScope: { labelId, annotationTrackId: trackId },
  };
}

export async function exportManualMetadataRecords(source?: SourceName) {
  return exportManualMetadata(source);
}

export async function runSourceAnalysisRecord(source: SourceName, sourceItemId: string, trackId: string, input: { verifiedLabel?: { x: number; y: number; width: number; height: number }; packageScope?: { x: number; y: number; width: number; height: number }; labelConfig?: Parameters<typeof runSourceAnalysis>[0]["labelConfig"]; visionEvidence?: Parameters<typeof runSourceAnalysis>[0]["visionEvidence"]; outerConfig?: { processingMode?: "preview" | "final"; previewMaxSize?: number; colorDistanceThreshold?: number; backgroundThreshold?: number; labelExclusionDilate?: number; curveSegments?: number; paddingPercent?: number; silhouetteThreshold?: number; connectivity?: 4 | 8; simplifyTolerance?: number; closeKernel?: number; canny?: { blurKernel?: number; low?: number; high?: number }; morphology?: { closeKernel?: number; iterations?: number } } }) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const graph = await getAnnotationGraph(source, sourceItemId);
  const packageEntity = graph.packages.find((item) => item.legacyAnnotationTrackId === trackId);
  const canonicalPackageScope = packageEntity?.scope.geometry?.bbox;
  const packageContext = packageEntity ? acceptedPackageLabelContext(graph.operations, packageEntity) : null;
  const result = await runSourceAnalysis({
    annotationTrackId: trackId,
    source,
    sourceItemId,
    verifiedLabel: input.verifiedLabel,
    packageScope: packageEntity ? canonicalPackageScope : input.packageScope,
    packageContext,
    outerConfig: input.outerConfig,
    labelConfig: input.labelConfig,
    visionEvidence: input.visionEvidence,
  });
  const labelStageExecution = await startWizardStageExecution({
    source, sourceItemId, annotationTrackId: trackId, stage: "label", helperId: "label-roi-detection",
    algorithm: result.algorithm, algorithmVersion: String(result.version),
    stageInput: { imageRef: sourceAssetRef(sourceItem), packageScope: result.packageScope, packageContext: result.labelDetection.debug.packageAware, preview: result.labelDetection.debug.preview, visionEvidence: result.visionEvidenceConfig },
    initialParams: { ...result.labelDetection.config, visionEvidence: result.visionEvidenceConfig },
    autoOutput: { candidates: result.candidates, semanticEvidence: result.semanticEvidence },
    candidates: result.candidates,
    intermediateStates: result.intermediateStates,
  });
  const bottleDetection = normalizeObject(result.bottleDetection);
  if (!input.verifiedLabel || !Object.keys(bottleDetection).length) return { ...result, labelStageExecution };
  const stageExecution = await startWizardStageExecution({
    source, sourceItemId, annotationTrackId: trackId, stage: "bottle", helperId: "bottle-outline",
    algorithm: String(bottleDetection.algorithm ?? "bottle-border-flood-v2"),
    algorithmVersion: String(bottleDetection.version ?? result.version ?? "1"),
    stageInput: { reviewedLabelRoi: input.verifiedLabel, packageScope: result.packageScope, sourceImage: result.sourceImage },
    initialParams: normalizeObject(bottleDetection.config),
    autoOutput: bottleAutoOutput(bottleDetection),
  });
  return { ...result, labelStageExecution, stageExecution };
}

export async function putSourceAnalysisRecord(source: SourceName, sourceItemId: string, trackId: string, state: Record<string, unknown>) {
  if (!await getSourceItemForTrack(source, sourceItemId, trackId)) throw new NotFoundError("Source item not found");
  const { stageExecution: _transientExecution, labelStageExecution: _transientLabelExecution, stageSample: _transientStageSample, ...persistedState } = state;
  const current = await getAnnotationTrackState(source, sourceItemId, trackId);
  const metadata = await patchAnnotationTrackState(source, sourceItemId, trackId, {
    annotations: current?.annotations ?? {},
    visualFeatures: { ...(current?.visual_features ?? {}), labelSourceAnalysis: { ...persistedState, savedAt: new Date().toISOString() } },
    status: current?.status ?? "reviewed",
  });
  const saved = normalizeObject(metadata.visual_features.labelSourceAnalysis);
  const bottleDetection = normalizeObject(saved.bottleDetection);
  if (!Object.keys(bottleDetection).length) return saved;
  await syncLegacyPackageObjectContext(source, sourceItemId, trackId, bottleDetection);
  const stageExecution = await reviewWizardStageExecution({
    source, sourceItemId, annotationTrackId: trackId, stage: "bottle", helperId: "bottle-outline",
    algorithm: String(bottleDetection.algorithm ?? "bottle-border-flood-v2"),
    algorithmVersion: String(bottleDetection.version ?? saved.version ?? "1"),
    stageInput: { reviewedLabelRoi: bottleDetection.verifiedLabel ?? normalizeObject(saved.outerObject).verifiedLabel, packageScope: saved.packageScope ?? null, sourceImage: saved.sourceImage },
    finalParams: normalizeObject(bottleDetection.config),
    reviewedOutput: {
      annotation: normalizeObject(bottleDetection.annotation),
      palette: Array.isArray(bottleDetection.palette) ? bottleDetection.palette : [],
    },
    selection: bottleSelection(bottleDetection),
    reviewMode: bottleReviewMode(bottleDetection),
  });
  return { ...saved, stageExecution };
}

export async function deleteMetadataRecords(items: Array<{ source: SourceName; sourceItemId: string }>) {
  for (const item of items) {
    if (!await getSourceItem(item.source, item.sourceItemId)) {
      throw new NotFoundError(`Source item not found: ${item.source}:${item.sourceItemId}`);
    }
  }
  return deleteOperationalMetadataItems(items);
}

export async function getCatalogIdentityReviewRecord(source: SourceName, sourceItemId: string, trackId: string) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return getLatestCatalogIdentityReview(source, sourceItem.sourceItemId, trackId);
}

export async function putCatalogIdentityReviewRecord(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
  input: Parameters<typeof putCatalogIdentityReview>[3],
) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return putCatalogIdentityReview(source, sourceItem.sourceItemId, trackId, input);
}

export async function previewLabelCvJobRecord(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
  input: { config: Record<string, unknown>; stage: LabelCvStage; review?: LabelCvReviewState },
  labelId?: string,
) {
  const context = await getCurrentLabelAnalysisContext(source, sourceItemId, trackId, labelId);
  const cropPath = resolveGeneratedAssetPath(String(context.analysis.cropAssetPath));
  if (!cropPath) throw new ConflictError("Current label analysis crop is unavailable");
  const existing = normalizeObject(context.visualFeatures.labelCvJob);
  const config = normalizeLabelAnalysisCvConfig(input.config);
  const review = input.review ?? normalizeObject(existing.review) as LabelCvReviewState;
  const preview = await extractLabelCropFeatures(cropPath, config, input.stage, review, await getElementOcrRegions(context));
  const helper = cvStageHelper(input.stage);
  const stageExecution = await startLabelCvStageExecution(context, {
    source, sourceItemId: context.sourceItemId, annotationTrackId: trackId, stage: input.stage, helperId: helper.helperId,
    algorithm: helper.algorithm, algorithmVersion: "1",
    stageInput: cvExecutionStageInput(context),
    initialParams: cvStageParams(input.stage, config),
    autoOutput: cvStageOutput(input.stage, preview, review),
  });
  const cvJob = {
    ...existing,
    schemaVersion: 4,
    annotationId: context.annotation.id,
    annotationRevision: context.annotation.revision,
    analysisJobId: context.analysis.jobId,
    config,
    previewStage: input.stage,
    preview,
    review,
    updatedAt: new Date().toISOString(),
    stageExecution,
  };
  return cvJob;
}

export async function putLabelCvJobCheckpointRecord(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
  input: { config: Record<string, unknown>; stage: LabelCvStage; review?: LabelCvReviewState; palette?: Array<Record<string, unknown>> },
  labelId?: string,
) {
  const context = await getCurrentLabelAnalysisContext(source, sourceItemId, trackId, labelId);
  const cropPath = resolveGeneratedAssetPath(String(context.analysis.cropAssetPath));
  if (!cropPath) throw new ConflictError("Current label analysis crop is unavailable");
  const existing = normalizeObject(context.visualFeatures.labelCvJob);
  const config = normalizeLabelAnalysisCvConfig(input.config);
  const review = input.review ?? normalizeObject(existing.review) as LabelCvReviewState;
  const palette = input.palette ?? (Array.isArray(existing.palette) ? existing.palette as Array<Record<string, unknown>> : undefined);
  const preview = await extractLabelCropFeatures(cropPath, config, input.stage, review, await getElementOcrRegions(context));
  const workflow = updateLabelCvWorkflow(normalizeObject(existing.workflow), input.stage, config, review, preview, palette);
  const helper = cvStageHelper(input.stage);
  const stageInput = cvExecutionStageInput(context);
  const finalParams = cvStageParams(input.stage, config);
  await startLabelCvStageExecution(context, {
    source, sourceItemId: context.sourceItemId, annotationTrackId: trackId, stage: input.stage, helperId: helper.helperId,
    algorithm: helper.algorithm, algorithmVersion: "1",
    stageInput, initialParams: finalParams,
    autoOutput: cvStageOutput(input.stage, preview, review),
  });
  const stageExecution = await reviewLabelCvStageExecution(context, {
    source, sourceItemId: context.sourceItemId, annotationTrackId: trackId, stage: input.stage, helperId: helper.helperId,
    algorithm: helper.algorithm, algorithmVersion: "1",
    stageInput, finalParams,
    reviewedOutput: cvStageOutput(input.stage, preview, review, palette),
  });
  const cvJob = {
    ...existing,
    schemaVersion: 4,
    annotationId: context.annotation.id,
    annotationRevision: context.annotation.revision,
    analysisJobId: context.analysis.jobId,
    config,
    previewStage: input.stage,
    preview,
    review,
    ...(palette ? { palette } : {}),
    workflow,
    updatedAt: new Date().toISOString(),
  };
  await saveLabelCvJob(context.metadata, source, context.sourceItemId, trackId, context.visualFeatures, cvJob, context.labelId);
  return { ...cvJob, stageExecution };
}

export async function putLabelCvJobRecord(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
  input: { config: Record<string, unknown>; palette: Array<Record<string, unknown>>; review?: LabelCvReviewState },
  labelId?: string,
) {
  const context = await getCurrentLabelAnalysisContext(source, sourceItemId, trackId, labelId);
  const existing = normalizeObject(context.visualFeatures.labelCvJob);
  const cropPath = resolveGeneratedAssetPath(String(context.analysis.cropAssetPath));
  if (!cropPath) throw new ConflictError("Current label analysis crop is unavailable");
  const config = normalizeLabelAnalysisCvConfig(input.config);
  const review = input.review ?? normalizeObject(existing.review) as LabelCvReviewState;
  const preview = await extractLabelCropFeatures(cropPath, config, "palette", review, await getElementOcrRegions(context));
  const workflow = updateLabelCvWorkflow(normalizeObject(existing.workflow), "palette", config, review, preview, input.palette);
  const helper = cvStageHelper("palette");
  const stageInput = cvExecutionStageInput(context);
  const finalParams = cvStageParams("palette", config);
  await startLabelCvStageExecution(context, {
    source, sourceItemId: context.sourceItemId, annotationTrackId: trackId, stage: "palette", helperId: helper.helperId,
    algorithm: helper.algorithm, algorithmVersion: "1",
    stageInput, initialParams: finalParams,
    autoOutput: cvStageOutput("palette", preview, review),
  });
  const stageExecution = await reviewLabelCvStageExecution(context, {
    source, sourceItemId: context.sourceItemId, annotationTrackId: trackId, stage: "palette", helperId: helper.helperId,
    algorithm: helper.algorithm, algorithmVersion: "1",
    stageInput, finalParams,
    reviewedOutput: cvStageOutput("palette", preview, review, input.palette),
  });
  const cvJob = {
    ...existing,
    schemaVersion: 4,
    annotationId: context.annotation.id,
    annotationRevision: context.annotation.revision,
    analysisJobId: context.analysis.jobId,
    config,
    previewStage: "palette",
    preview,
    review,
    palette: input.palette,
    workflow,
    reviewedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveLabelCvJob(context.metadata, source, context.sourceItemId, trackId, context.visualFeatures, cvJob, context.labelId);
  const [ocrReview, regionReview, associationReview] = await Promise.all([
    getLatestOcrTextReview(source, context.sourceItemId, trackId),
    getLatestOcrRegionReview(source, context.sourceItemId, trackId),
    getLatestSourceAssociationReview(source, context.sourceItemId, trackId),
  ]);
  const summary = await buildLabelWorkflowSummary({
    sourceItem: context.sourceItem, metadata: context.catalogMetadata, analysis: context.analysis, cvJob,
    ocrReview, regionReview, associationReview,
  });
  const summaryInput = summaryExecutionStageInput({
    annotation: { annotation: context.annotation }, analysis: context.analysis, cvJob, regionReview,
  });
  const summaryStageExecution = await startLabelCvStageExecution(context, {
    source, sourceItemId: context.sourceItemId, annotationTrackId: trackId, stage: "summary", helperId: "label-summary",
    algorithm: "label-summary-v1", algorithmVersion: "1",
    stageInput: summaryInput, initialParams: summaryStageParams(), autoOutput: summaryStageOutput(summary),
  });
  return { ...cvJob, stageExecution, summaryStageExecution };
}

const LABEL_CV_STAGES: LabelCvStage[] = ["mask", "morphology", "components", "elements", "contours", "palette"];

function updateLabelCvWorkflow(
  existing: Record<string, unknown>,
  completedStage: LabelCvStage,
  config: ReturnType<typeof normalizeLabelAnalysisCvConfig>,
  review: LabelCvReviewState,
  preview: Record<string, unknown>,
  palette?: Array<Record<string, unknown>>,
) {
  const now = new Date().toISOString();
  const previousCheckpoints = normalizeObject(existing.checkpoints);
  const checkpoints: Record<string, Record<string, unknown>> = {};
  for (const stage of LABEL_CV_STAGES) {
    const previous = normalizeObject(previousCheckpoints[stage]);
    if (Object.keys(previous).length === 0) continue;
    const currentSignature = labelCvStageSignature(stage, config, review, palette);
    checkpoints[stage] = previous.inputSignature === currentSignature
      ? previous
      : { ...previous, status: "stale", invalidatedAt: now, invalidatedBy: completedStage };
  }
  checkpoints[completedStage] = {
    status: "valid",
    completedAt: now,
    inputSignature: labelCvStageSignature(completedStage, config, review, palette),
    execution: buildCvStageExecution(previousCheckpoints[completedStage], completedStage, config, review, preview, palette),
  };
  return { schemaVersion: 1, lastCompletedStage: completedStage, checkpoints, updatedAt: now };
}

function buildCvStageExecution(
  previousValue: unknown,
  stage: LabelCvStage,
  config: ReturnType<typeof normalizeLabelAnalysisCvConfig>,
  review: LabelCvReviewState,
  preview: Record<string, unknown>,
  palette?: Array<Record<string, unknown>>,
) {
  const previousExecution = normalizeObject(normalizeObject(previousValue).execution);
  const initialParams = Object.keys(normalizeObject(previousExecution.initialParams)).length
    ? previousExecution.initialParams
    : { availability: "unavailable", reason: "not-captured" };
  const autoOutput = Object.keys(normalizeObject(previousExecution.autoOutput)).length
    ? previousExecution.autoOutput
    : { availability: "unavailable", reason: "not-captured" };
  const finalParams = cvStageParams(stage, config);
  const reviewedOutput = cvStageOutput(stage, preview, review, palette);
  const helperOutput = cvStageOutput(stage, preview, {}, palette);
  const intermediateStates = cvIntermediateStates(stage, preview);
  const previousRuns = Array.isArray(previousExecution.helperRuns) ? previousExecution.helperRuns.map(normalizeObject) : [];
  const runFingerprint = createHash("sha256").update(JSON.stringify({ config: finalParams, output: helperOutput, intermediateStates })).digest("hex");
  const previousRun = previousRuns.at(-1);
  const helperRuns = previousRun?.fingerprint === runFingerprint ? previousRuns : [...previousRuns, {
    id: randomUUID(), runIndex: previousRuns.length + 1, config: finalParams,
    candidates: cvStageCandidates(stage, helperOutput), output: helperOutput, artifact: preview.debugArtifact ?? null,
    intermediateStates, fingerprint: runFingerprint, createdAt: new Date().toISOString(),
  }].slice(-20).map((run, index) => ({ ...run, runIndex: index + 1 }));
  const initialObject = normalizeObject(initialParams);
  const paramsComparable = initialObject.availability !== "unavailable";
  return {
    initialParams,
    finalParams,
    autoOutput,
    reviewedOutput,
    helperRuns,
    humanCorrection: {
      reviewed: true,
      paramsEdited: paramsComparable ? JSON.stringify(initialObject) !== JSON.stringify(finalParams) : null,
      outputEdited: null,
      changedFields: [],
      reviewedAt: new Date().toISOString(),
    },
  };
}

function cvIntermediateStates(stage: LabelCvStage, preview: Record<string, unknown>) {
  const metrics = normalizeObject(preview.stageMetrics);
  const steps: Record<LabelCvStage, Array<{ id: string; algorithm: string }>> = {
    mask: [{ id: "variant-search", algorithm: "binary-mask-variant-search-v1" }, { id: "components-probe", algorithm: "connected-components-v2" }],
    morphology: [{ id: "mask-input", algorithm: "binary-mask-variant-search-v1" }, { id: "morphology", algorithm: "label-morphology-v1" }],
    components: [{ id: "morphology-input", algorithm: "label-morphology-v1" }, { id: "connected-components", algorithm: "connected-components-v2" }],
    elements: [{ id: "component-input", algorithm: "connected-components-v2" }, { id: "grouping", algorithm: "element-grouping-v1" }],
    contours: [{ id: "element-input", algorithm: "element-grouping-v1" }, { id: "contour-extraction", algorithm: "component-contours-v2" }],
    palette: [{ id: "color-sampling", algorithm: "label-color-sampling-v1" }, { id: "palette-clustering", algorithm: "label-palette-v1" }],
  };
  return [
    { id: `cv.${stage}`, parentId: null, sequence: 0, status: "completed" as const, algorithm: cvStageHelper(stage).algorithm, summary: metrics },
    ...steps[stage].map((step, index) => ({ id: `cv.${stage}.${step.id}`, parentId: `cv.${stage}`, sequence: index + 1, status: "completed" as const, algorithm: step.algorithm, summary: {} })),
  ];
}

function cvStageCandidates(stage: LabelCvStage, output: Record<string, unknown>) {
  if (stage === "mask") return Array.isArray(output.candidates) ? output.candidates : [];
  if (stage === "morphology") return Array.isArray(output.candidates) ? output.candidates : [];
  const key = stage === "components" ? "components" : stage === "elements" ? "elements" : stage === "contours" ? "contours" : stage === "palette" ? "palette" : null;
  return key && Array.isArray(output[key]) ? output[key] : [];
}

function cvStageParams(stage: LabelCvStage, config: ReturnType<typeof normalizeLabelAnalysisCvConfig>) {
  if (stage === "mask") return { threshold: config.threshold, invert: config.invert, maskSize: config.maskSize, maskMode: config.maskMode };
  if (stage === "morphology") return {
    morphologyEnabled: config.morphologyEnabled, morphologyOperation: config.morphologyOperation,
    morphologyKernelWidth: config.morphologyKernelWidth, morphologyKernelHeight: config.morphologyKernelHeight,
    morphologyIterations: config.morphologyIterations, morphologyMode: config.morphologyMode,
    morphologyPipeline: config.morphologyPipeline ?? null,
  };
  if (stage === "components") return {
    componentFilterPreset: config.componentFilterPreset, componentMode: config.componentMode, componentConnectivity: config.componentConnectivity,
    minComponentAreaRatio: config.minComponentAreaRatio, maxComponentAreaRatio: config.maxComponentAreaRatio,
  };
  if (stage === "elements") return { groupingPrimary: "ocr-overlap", groupingFallback: "proximity-alignment" };
  if (stage === "contours") return {
    maxContourPoints: config.maxContourPoints, contourDetail: config.contourDetail,
    contourSimplifyRatio: config.contourSimplifyRatio, contourVectorization: config.contourVectorization,
  };
  return { paletteColors: config.paletteColors, paletteMinRatio: config.paletteMinRatio };
}

function cvStageOutput(stage: LabelCvStage, preview: Record<string, unknown>, review: LabelCvReviewState, palette?: Array<Record<string, unknown>>) {
  const debug = normalizeObject(preview.cvDebug);
  if (stage === "mask") {
    const labelDebug = normalizeObject(normalizeObject(debug.label).debug);
    const rawMask = (Array.isArray(labelDebug.layers) ? labelDebug.layers : [])
      .map((value) => normalizeObject(value)).find((layer) => layer.id === "raw-mask");
    const data = typeof rawMask?.data === "string" ? rawMask.data : null;
    const { data: _rawData, ...maskDescriptor } = rawMask ?? {};
    const search = normalizeObject(debug.maskSearch);
    const evaluated = Array.isArray(search.evaluatedCandidates) ? search.evaluatedCandidates : Array.isArray(search.candidates) ? search.candidates : [];
    return {
      debugArtifact: preview.debugArtifact ?? null,
      mask: rawMask ? { ...maskDescriptor, dataSha256: data ? createHash("sha256").update(data).digest("hex") : null, dataLength: data?.length ?? 0 } : null,
      source: debug.source ?? null,
      metrics: normalizeObject(preview.stageMetrics),
      effectiveConfig: debug.effectiveMaskConfig ?? null,
      search: { generatedCount: search.generatedCount ?? 0, baselineMetrics: search.baselineMetrics ?? {}, candidateIds: evaluated.map((value) => normalizeObject(value).id ?? null) },
      candidates: evaluated.map((value) => {
        const candidate = normalizeObject(value);
        return { id: candidate.id ?? null, family: candidate.family ?? null, strength: candidate.strength ?? null, config: candidate.config ?? null, score: candidate.score ?? null, metrics: candidate.metrics ?? {} };
      }),
    };
  }
  if (stage === "morphology") {
    const search = normalizeObject(debug.morphologySearch);
    const evaluatedCandidates = Array.isArray(search.evaluatedCandidates) ? search.evaluatedCandidates : [];
    const candidates = (evaluatedCandidates.length ? evaluatedCandidates : Array.isArray(search.candidates) ? search.candidates : []).map((value) => {
      const candidate = normalizeObject(value);
      const summarizeMask = (maskValue: unknown) => {
        const mask = normalizeObject(maskValue); const data = typeof mask.data === "string" ? mask.data : null;
        const { data: _data, ...descriptor } = mask;
        return { ...descriptor, dataSha256: data ? createHash("sha256").update(data).digest("hex") : null, dataLength: data?.length ?? 0 };
      };
      return {
        id: candidate.id ?? null, family: candidate.family ?? null, strength: candidate.strength ?? null,
        pipeline: candidate.pipeline ?? [], config: candidate.config ?? null, score: candidate.score ?? null,
        metrics: candidate.metrics ?? {},
        ...(candidate.mask ? { mask: summarizeMask(candidate.mask) } : {}),
        ...(candidate.addedMask ? { addedMask: summarizeMask(candidate.addedMask) } : {}),
        ...(candidate.removedMask ? { removedMask: summarizeMask(candidate.removedMask) } : {}),
      };
    });
    return {
      autoConfig: debug.autoMorphologyConfig ?? null, effectiveConfig: debug.effectiveMorphologyConfig ?? null,
      score: debug.autoMorphologyScore ?? null,
      search: { generatedCount: search.generatedCount ?? 0, baselineMetrics: search.baselineMetrics ?? {}, candidateIds: candidates.map((candidate) => candidate.id) },
      candidates,
    };
  }
  if (stage === "components") return { components: Array.isArray(preview.components) ? preview.components : [], decisions: review.componentDecisions ?? {} };
  if (stage === "elements") return { elements: Array.isArray(preview.elements) ? preview.elements : [] };
  if (stage === "contours") return { contours: Array.isArray(preview.contours) ? preview.contours : [] };
  return { palette: palette ?? (Array.isArray(preview.palette) ? preview.palette : []) };
}

function bottleAutoOutput(bottleDetection: Record<string, unknown>) {
  const candidates = Array.isArray(bottleDetection.candidates) ? bottleDetection.candidates : [];
  return {
    candidates,
    selectedCandidateId: bottleDetection.selectedCandidateId ?? null,
    palette: Array.isArray(bottleDetection.palette) ? bottleDetection.palette : [],
    coordinateSpace: bottleDetection.coordinateSpace ?? null,
  };
}

function bottleSelection(bottleDetection: Record<string, unknown>) {
  const annotation = normalizeObject(bottleDetection.annotation);
  const candidateId = typeof annotation.candidateId === "string"
    ? annotation.candidateId
    : typeof bottleDetection.selectedCandidateId === "string" ? bottleDetection.selectedCandidateId : null;
  return candidateId ? { candidateId } : null;
}

function bottleReviewMode(bottleDetection: Record<string, unknown>): "accepted" | "corrected" | "manual" {
  const source = String(normalizeObject(bottleDetection.annotation).source ?? "");
  if (source === "auto-confirmed") return "accepted";
  if (source === "manual") return "manual";
  return "corrected";
}

function ocrReviewMode(review: Awaited<ReturnType<typeof putOcrRegionReview>>): "accepted" | "corrected" | "manual" {
  if (review.regions.length && review.regions.every((region) => region.source === "manual")) return "manual";
  if (review.regions.some((region) => region.source !== "auto")) return "corrected";
  return "accepted";
}

function cvExecutionStageInput(context: Awaited<ReturnType<typeof getCurrentLabelAnalysisContext>>) {
  const crop = normalizeObject("crop" in context.analysis ? context.analysis.crop : {});
  return {
    labelAnnotationId: context.annotation.id,
    labelRevision: context.annotation.revision,
    analysisJobId: context.analysis.jobId,
    cropAssetPath: context.analysis.cropAssetPath,
    cropTransformMode: typeof crop.transformMode === "string" ? crop.transformMode : "legacy-implicit",
  };
}

function cvStageHelper(stage: LabelCvStage) {
  const algorithms: Record<LabelCvStage, string> = {
    mask: "binary-mask-variant-search-v1",
    morphology: "label-morphology-v1",
    components: "connected-components-v2",
    elements: "element-grouping-v1",
    contours: "component-contours-v2",
    palette: "label-palette-v1",
  };
  return { helperId: `label-${stage}`, algorithm: algorithms[stage] };
}

async function startLabelCvStageExecution(
  context: Awaited<ReturnType<typeof getCurrentLabelAnalysisContext>>,
  input: Parameters<typeof startWizardStageExecution>[0],
) {
  // Canonical Label executions are already captured in cv_job.workflow. The legacy
  // track-wide execution table cannot safely key two Labels until its identity is migrated.
  if (context.labelId) return undefined;
  return startWizardStageExecution(input);
}

async function reviewLabelCvStageExecution(
  context: Awaited<ReturnType<typeof getCurrentLabelAnalysisContext>>,
  input: Parameters<typeof reviewWizardStageExecution>[0],
) {
  if (context.labelId) return undefined;
  return reviewWizardStageExecution(input);
}

function labelCvStageSignature(
  stage: LabelCvStage,
  config: ReturnType<typeof normalizeLabelAnalysisCvConfig>,
  review: LabelCvReviewState,
  palette?: Array<Record<string, unknown>>,
) {
  const mask = { threshold: config.threshold, invert: config.invert, maskSize: config.maskSize, mode: config.maskMode };
  const morphology = { ...mask, enabled: config.morphologyEnabled, operation: config.morphologyOperation, kernelWidth: config.morphologyKernelWidth, kernelHeight: config.morphologyKernelHeight, iterations: config.morphologyIterations, mode: config.morphologyMode, pipeline: config.morphologyPipeline ?? null };
  const components = { ...morphology, preset: config.componentFilterPreset, mode: config.componentMode, connectivity: config.componentConnectivity, minArea: config.minComponentAreaRatio, maxArea: config.maxComponentAreaRatio };
  const decisions = review.componentDecisions ?? {};
  const value = stage === "mask" ? mask
    : stage === "morphology" ? morphology
      : stage === "components" ? components
        : stage === "elements" ? { ...components, decisions, elementsReviewed: review.elementsReviewed === true, elements: review.elements ?? [] }
          : stage === "contours" ? { ...components, decisions, elementsReviewed: review.elementsReviewed === true, elements: review.elements ?? [], maxPoints: config.maxContourPoints, detail: config.contourDetail, simplifyRatio: config.contourSimplifyRatio, vectorization: config.contourVectorization }
            : { colors: config.paletteColors, minRatio: config.paletteMinRatio, palette: palette ?? [] };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function runLabelAnalysisRecord(source: SourceName, sourceItemId: string, trackId: string, input: { force: boolean; config?: Record<string, unknown> }) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const annotation = await getLatestReviewedLabelAnnotationRevision(source, sourceItem.sourceItemId, trackId);
  if (!annotation) throw new ConflictError("A reviewed label ROI is required before label analysis");
  return enqueueRecognizeJob({
    type: "ANALYZE_LABEL",
    target: { source, sourceItemId: sourceItem.sourceItemId },
    options: {
      force: input.force,
      annotationTrackId: trackId,
      annotationId: annotation.id,
      annotationRevision: annotation.revision,
      analysisConfigSnapshot: input.config,
    },
  });
}

export async function listDetectionProposalRecords(source: SourceName, sourceItemId: string, trackId: string) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return {
    items: await listDetectionProposals(source, sourceItem.sourceItemId, trackId),
  };
}

export async function getLabelAnnotationOcrRecord(source: SourceName, sourceItemId: string, trackId: string) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return getLatestOcrSnapshot(source, sourceItem.sourceItemId, trackId);
}

export async function runLabelAnnotationOcrRecord(source: SourceName, sourceItemId: string, trackId: string) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const snapshot = await createBackendOcrSnapshot(source, sourceItem.sourceItemId, trackId, sourceAssetRef(sourceItem));
  const helper = ocrAlgorithm(snapshot);
  const stageExecution = await startWizardStageExecution({
    source, sourceItemId: sourceItem.sourceItemId, annotationTrackId: trackId, stage: "ocr", helperId: "label-ocr-cascade",
    algorithm: helper.id, algorithmVersion: helper.version,
    stageInput: ocrStageInput(snapshot), initialParams: ocrStageParams(snapshot), autoOutput: ocrStageAutoOutput(snapshot),
    intermediateStates: ocrIntermediateStates(snapshot),
  });
  return { ...snapshot, stageExecution };
}

export async function getLabelAnnotationOcrReviewRecord(source: SourceName, sourceItemId: string, trackId: string) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return getLatestOcrTextReview(source, sourceItem.sourceItemId, trackId);
}

export async function putLabelAnnotationOcrReviewRecord(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
  input: Parameters<typeof putOcrTextReview>[3],
) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return putOcrTextReview(source, sourceItem.sourceItemId, trackId, input);
}

export async function getLabelAnnotationOcrRegionReviewRecord(source: SourceName, sourceItemId: string, trackId: string) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return getLatestOcrRegionReview(source, sourceItem.sourceItemId, trackId);
}

export async function putLabelAnnotationOcrRegionReviewRecord(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
  input: Parameters<typeof putOcrRegionReview>[3],
) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const saved = await putOcrRegionReview(source, sourceItem.sourceItemId, trackId, input);
  await syncLegacyOcrEntities(source, sourceItem.sourceItemId, trackId, saved);
  if (!input.ocrRunId || !["reviewed", "rejected"].includes(saved.status)) return saved;
  const snapshot = await getLatestOcrSnapshot(source, sourceItem.sourceItemId, trackId);
  if (!snapshot || snapshot.ocr.id !== input.ocrRunId) return saved;
  const helper = ocrAlgorithm(snapshot);
  await startWizardStageExecution({
    source, sourceItemId: sourceItem.sourceItemId, annotationTrackId: trackId, stage: "ocr", helperId: "label-ocr-cascade",
    algorithm: helper.id, algorithmVersion: helper.version,
    stageInput: ocrStageInput(snapshot), initialParams: ocrStageParams(snapshot), autoOutput: ocrStageAutoOutput(snapshot),
    intermediateStates: ocrIntermediateStates(snapshot),
  });
  const stageExecution = await reviewWizardStageExecution({
    source, sourceItemId: sourceItem.sourceItemId, annotationTrackId: trackId, stage: "ocr", helperId: "label-ocr-cascade",
    algorithm: helper.id, algorithmVersion: helper.version,
    stageInput: ocrStageInput(snapshot), finalParams: ocrStageParams(snapshot),
    reviewedOutput: ocrStageReviewedOutput(snapshot, saved),
    reviewMode: ocrReviewMode(saved),
  });
  return { ...saved, stageExecution };
}

export async function getOcrSourceAssociationWorkspace(source: SourceName, sourceItemId: string, trackId: string) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const [metadata, regionReview, review] = await Promise.all([
    getMetadata(source, sourceItem.sourceItemId),
    getLatestOcrRegionReview(source, sourceItem.sourceItemId, trackId),
    getLatestSourceAssociationReview(source, sourceItem.sourceItemId, trackId),
  ]);
  const sourceValues = buildSourceValues(sourceItem, metadata);
  return {
    ocrRegionReview: regionReview,
    sourceValues,
    candidates: buildSourceMatchCandidates(regionReview, sourceValues),
    review,
  };
}

export async function putOcrSourceAssociationReviewRecord(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
  input: Parameters<typeof putSourceAssociationReview>[3],
) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const metadata = await getMetadata(source, sourceItem.sourceItemId);
  const sourceValues = buildSourceValues(sourceItem, metadata);
  return putSourceAssociationReview(
    source,
    sourceItem.sourceItemId,
    trackId,
    input,
    new Set(sourceValues.map(({ field, value }) => sourceValueKey(field, value))),
  );
}

export async function getAliasReviewWorkspace(source: SourceName, sourceItemId: string, trackId: string) {
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const [latestAssociationReview, regionReview, review] = await Promise.all([
    getLatestSourceAssociationReview(source, sourceItem.sourceItemId, trackId),
    getLatestOcrRegionReview(source, sourceItem.sourceItemId, trackId),
    getLatestAliasReview(source, sourceItem.sourceItemId, trackId),
  ]);
  const associationReview = latestAssociationReview?.status === "reviewed"
    && latestAssociationReview.ocrRegionAnnotationSetId === regionReview?.id
    ? latestAssociationReview
    : null;
  return {
    sourceAssociationReview: associationReview,
    candidates: buildAliasCandidates(sourceItem, associationReview),
    review,
  };
}

export async function putAliasReviewRecord(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
  input: Parameters<typeof putAliasReview>[3],
) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return putAliasReview(source, sourceItem.sourceItemId, trackId, input);
}

export async function patchMetadataRecord(
  source: SourceName,
  sourceItemId: string,
  patch: Parameters<typeof patchMetadata>[2],
) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const metadata = await patchMetadata(source, sourceItem.sourceItemId, patch);
  return toMetadataDto(metadata, sourceItem);
}

export async function getManualAnnotationRecord(source: SourceName, sourceItemId: string) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return getManualAnnotations(source, sourceItem.sourceItemId);
}

export async function putManualAnnotationRecord(
  source: SourceName,
  sourceItemId: string,
  annotations: Record<string, unknown>,
) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return putManualAnnotations(source, sourceItem.sourceItemId, annotations);
}

export async function deleteManualAnnotationRecord(source: SourceName, sourceItemId: string) {
  const sourceItem = await getSourceItem(source, sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  return deleteManualAnnotations(source, sourceItem.sourceItemId);
}

async function getCurrentLabelAnalysisContext(source: SourceName, sourceItemId: string, trackId: string, labelId?: string) {
  if (labelId) return getCanonicalLabelAnalysisContext(source, sourceItemId, trackId, labelId);
  const sourceItem = await getSourceItemForTrack(source, sourceItemId, trackId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const [annotation, metadata, catalogMetadata] = await Promise.all([
    getLatestReviewedLabelAnnotationRevision(source, sourceItem.sourceItemId, trackId),
    getAnnotationTrackState(source, sourceItem.sourceItemId, trackId),
    getMetadata(source, sourceItem.sourceItemId),
  ]);
  if (!annotation) throw new ConflictError("A reviewed label ROI is required before CV preview");
  const visualFeatures = normalizeObject(metadata?.visual_features);
  const analysis = normalizeObject(visualFeatures.labelAnalysis);
  const crop = normalizeObject(analysis.crop);
  if (!Object.keys(analysis).length || String(analysis.annotationId ?? "") !== annotation.id
    || Number(analysis.annotationRevision ?? 0) !== annotation.revision) {
    throw new ConflictError("Current label analysis is required before CV preview");
  }
  const cropAssetPath = typeof crop.assetPath === "string" ? crop.assetPath : "";
  if (!cropAssetPath) throw new ConflictError("Current label analysis crop is unavailable");
  return {
    source,
    sourceItemId: sourceItem.sourceItemId,
    annotationTrackId: trackId,
    sourceItem,
    metadata,
    catalogMetadata,
    annotation,
    visualFeatures,
    analysis: { ...analysis, jobId: String(analysis.jobId ?? ""), cropAssetPath },
    labelId: null,
    canonicalOcrRegions: [],
  };
}

async function getCanonicalLabelAnalysisContext(source: SourceName, sourceItemId: string, trackId: string, labelId: string) {
  const [sourceItem, state, metadata, catalogMetadata, graph] = await Promise.all([
    getSourceItemForTrack(source, sourceItemId, trackId),
    getGraphLabelCvState(source, sourceItemId, trackId, labelId),
    getAnnotationTrackState(source, sourceItemId, trackId),
    getMetadata(source, sourceItemId),
    getAnnotationGraph(source, sourceItemId),
  ]);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  if (state.geometry.type !== "quad") throw new ConflictError("Canonical Label CV requires quad geometry");
  const sourceImage = state.sourceAssetRef ?? sourceAssetRef(sourceItem);
  const sourcePath = sourceImage ? resolveLocalAssetPath(sourceImage) : null;
  if (!sourceImage || !sourcePath) throw new ConflictError("Selected Package has no local source asset");
  let crop = normalizeObject(state.crop);
  let cvJobState = normalizeObject(state.job);
  if (Number(crop.labelRevision ?? 0) !== state.revision || typeof crop.assetPath !== "string" || typeof crop.transformMode !== "string") {
    const assetPath = `label-analysis/graph-cv/${labelId}/r${state.revision}.webp`;
    const cropPath = resolveGeneratedAssetPath(assetPath);
    if (!cropPath) throw new ConflictError("Canonical Label crop path is invalid");
    await mkdir(path.dirname(cropPath), { recursive: true });
    const size = await createRectifiedLabelCrop(sourcePath, cropPath, state.geometry.bbox, state.geometry, state.rectification);
    crop = { id: `graph-label:${labelId}:r${state.revision}`, assetPath, sourceImage, sourceRect: state.geometry.bbox, sourceGeometry: state.geometry, width: size.width, height: size.height, transformMode: size.transformMode, labelRevision: state.revision };
    // A crop coordinate-space change invalidates every downstream CV geometry,
    // even when this is only a one-time upgrade from the legacy implicit warp.
    cvJobState = {};
    await putGraphLabelCvState(source, sourceItemId, trackId, labelId, { crop, job: cvJobState });
  }
  const configSnapshot = normalizeLabelAnalysisCvConfig(cvJobState.config);
  const configHash = createHash("sha256").update(JSON.stringify(configSnapshot)).digest("hex");
  const jobId = `graph-label:${labelId}:r${state.revision}`;
  const label = graph.packages.flatMap((packageItem) => packageItem.labels).find((item) => item.id === labelId);
  const canonicalOcrRegions = label?.ocr ?? [];
  const analysis = {
    schemaVersion: 2,
    jobId,
    annotationId: labelId,
    annotationRevision: state.revision,
    crop,
    ocr: { runId: "canonical-graph", engine: "reviewed-graph", engineVersion: null, rawText: "", normalizedText: "", confidence: null, runtimeMs: null, evidence: null },
    textRegions: [], sourceMatches: [], catalogCandidates: [],
    visualFeatures: normalizeObject(cvJobState.preview),
    configSnapshot, warnings: [], runtimeMs: 0,
    provenance: { pipelineVersion: "canonical-label-cv-v1", analysisProfileVersion: "canonical-label-cv-v1", engine: "reviewed-graph", configHash },
  };
  return {
    source, sourceItemId, annotationTrackId: trackId, sourceItem, metadata, catalogMetadata,
    annotation: { id: labelId, revision: state.revision, bbox: state.geometry.bbox, geometry: state.geometry, rectification: state.rectification },
    visualFeatures: { labelCvJob: cvJobState }, analysis: { ...analysis, cropAssetPath: String(crop.assetPath) },
    labelId, canonicalOcrRegions,
  };
}

function summaryExecutionStageInput(value: unknown) {
  const workspace = normalizeObject(value);
  const annotationState = normalizeObject(workspace.annotation);
  const annotation = normalizeObject(annotationState.annotation);
  const analysis = normalizeObject(workspace.analysis);
  const cvJob = normalizeObject(workspace.cvJob);
  const workflow = normalizeObject(cvJob.workflow);
  const regionReview = normalizeObject(workspace.regionReview);
  return summaryStageInput({
    labelAnnotationId: annotation.id ?? analysis.annotationId ?? null,
    labelRevision: annotation.revision ?? analysis.annotationRevision ?? null,
    analysisJobId: analysis.jobId ?? cvJob.analysisJobId ?? null,
    ocrRegionAnnotationSetId: workspace.ocrRegionAnnotationSetId ?? regionReview.id ?? null,
    cvWorkflowUpdatedAt: workflow.updatedAt ?? cvJob.updatedAt ?? null,
  });
}

async function getElementOcrRegions(context: Awaited<ReturnType<typeof getCurrentLabelAnalysisContext>>): Promise<ElementOcrRegion[]> {
  if (context.labelId) {
    return context.canonicalOcrRegions.flatMap((region) => {
      const bbox = normalizedSummaryBox(normalizeObject(region.geometry.bbox));
      return bbox && region.regionStatus === "reviewed" && region.transcription.status === "verified" && region.transcription.text?.trim()
        ? [{ id: region.id, level: region.layout.type === "string" ? "line" as const : "word" as const, bbox, text: region.transcription.text, confidence: region.confidence }]
        : [];
    });
  }
  const reviewed = await getLatestOcrRegionReview(context.source, context.sourceItemId, context.annotationTrackId);
  if (reviewed?.regions.length) {
    return reviewed.regions.flatMap((region) => {
      const bbox = normalizedSummaryBox(normalizeObject(region.bbox));
      const level = region.level === "line" ? "line" : "word";
      return bbox && region.status !== "rejected" && region.transcriptionStatus === "verified" && region.text?.trim()
        ? [{ id: region.id, level, bbox, text: region.text, confidence: null }]
        : [];
    });
  }
  const analysis = normalizeObject(context.analysis);
  const generated: unknown[] = Array.isArray(analysis.textRegions) ? analysis.textRegions : [];
  return generated.flatMap((value: unknown) => {
    const region = normalizeObject(value);
    const bbox = normalizedSummaryBox(normalizeObject(region.bbox));
    const text = String(region.normalizedText ?? region.rawText ?? "").trim();
    const level = region.level === "line" ? "line" : "word";
    return bbox && text ? [{ id: String(region.id ?? ""), level, bbox, text,
      confidence: typeof region.confidence === "number" ? region.confidence : null }] : [];
  });
}

async function saveLabelCvJob(
  metadata: { annotations?: Record<string, unknown>; status?: string } | null,
  source: SourceName,
  sourceItemId: string,
  trackId: string,
  visualFeatures: Record<string, unknown>,
  cvJob: Record<string, unknown>,
  labelId?: string | null,
) {
  const persistedCvJob = await detachLabelCvDebugArtifact(source, sourceItemId, cvJob);
  if (labelId) {
    await putGraphLabelCvState(source, sourceItemId, trackId, labelId, { job: persistedCvJob });
    return persistedCvJob;
  }
  return patchAnnotationTrackState(source, sourceItemId, trackId, {
    annotations: metadata?.annotations ?? {},
    visualFeatures: { ...visualFeatures, labelCvJob: persistedCvJob },
    status: metadata?.status ?? "reviewed",
  });
}

async function buildLabelWorkflowSummary(input: {
  sourceItem: NonNullable<Awaited<ReturnType<typeof getSourceItem>>>;
  metadata: MetaItemRow | null;
  analysis: Record<string, unknown>;
  cvJob: Record<string, unknown>;
  ocrReview: Awaited<ReturnType<typeof getLatestOcrTextReview>>;
  regionReview: Awaited<ReturnType<typeof getLatestOcrRegionReview>>;
  associationReview: Awaited<ReturnType<typeof getLatestSourceAssociationReview>>;
}) {
  const analysisOcr = normalizeObject(input.analysis.ocr);
  const ocrEvidence = normalizeObject(analysisOcr.evidence);
  const ocrQuality = normalizeObject(ocrEvidence.quality);
  const ocrGeometry = normalizeObject(ocrEvidence.geometry);
  const ocrPerspective = normalizeObject(ocrGeometry.perspective);
  const analysisVisual = normalizeObject(input.analysis.visualFeatures);
  const preview = normalizeObject(input.cvJob.preview);
  const reviewedRegions = input.regionReview?.regions.filter((region) => region.status === "reviewed") ?? [];
  const recalculatedMatches = buildSourceMatchCandidates(input.regionReview, buildSourceValues(input.sourceItem, input.metadata));
  const associationReviewIsCurrent = Boolean(
    input.regionReview
    && input.associationReview?.ocrRegionAnnotationSetId === input.regionReview.id,
  );
  const fixedAssociations = associationReviewIsCurrent && input.associationReview?.status === "reviewed"
    ? input.associationReview.associations.filter((association) => association.status === "accepted")
    : [];
  const palette = Array.isArray(input.cvJob.palette)
    ? input.cvJob.palette
    : Array.isArray(preview.palette) ? preview.palette : Array.isArray(analysisVisual.palette) ? analysisVisual.palette : [];
  const contours = Array.isArray(preview.contours)
    ? preview.contours
    : Array.isArray(analysisVisual.contours) ? analysisVisual.contours : [];
  const components = Array.isArray(preview.components) ? preview.components : [];
  const elements = Array.isArray(preview.elements) ? preview.elements : [];
  const cvReview = normalizeObject(input.cvJob.review);
  const componentDecisions = normalizeObject(cvReview.componentDecisions);
  const catalogRegions = summaryCatalogRegions(input.regionReview, input.analysis);
  const catalogSearch = buildCatalogSearchInput(catalogRegions);
  const catalogPool = catalogRegions.length ? await findCatalogCandidates({
    ...catalogSearch,
    include: { source: input.sourceItem.source, sourceItemId: input.sourceItem.sourceItemId },
    limit: 250,
  }) : [];
  const catalogCandidates = rankCatalogCandidates(catalogRegions, catalogPool, {
    source: input.sourceItem.source,
    sourceItemId: input.sourceItem.sourceItemId,
  });
  return {
    schemaVersion: 1,
    computedAt: new Date().toISOString(),
    ocrText: input.ocrReview?.normalizedText || input.ocrReview?.text
      || String(analysisOcr.normalizedText ?? analysisOcr.rawText ?? ""),
    reviewedRegionCount: reviewedRegions.length,
    sourceMatches: recalculatedMatches,
    fixedAssociations,
    catalogCandidates,
    palette,
    componentCount: components.length,
    reviewedComponentCount: Object.keys(componentDecisions).length,
    elementCount: elements.length,
    reviewedElementCount: elements.filter((element) => normalizeObject(element).status !== "unreviewed").length,
    contourCount: contours.length,
    contourPointCount: contours.reduce((sum, contour) => {
      const points = normalizeObject(contour).points;
      return sum + (Array.isArray(points) ? points.length : 0);
    }, 0),
    ocrEvidence: Number(ocrEvidence.schemaVersion) === 1 ? {
      completedStage: ocrEvidence.completedStage === "cheap" ? "cheap" : ocrEvidence.completedStage === "rescue" ? "rescue" : "deep",
      stopReason: String(ocrEvidence.stopReason ?? ""),
      passCount: Array.isArray(ocrEvidence.passes) ? ocrEvidence.passes.length : 0,
      validObservationCount: Number(ocrQuality.validObservationCount ?? 0),
      rejectedObservationCount: Number(ocrQuality.rejectedObservationCount ?? 0),
      consensusRegionCount: Number(ocrQuality.consensusRegionCount ?? 0),
      supportedConsensusRegionCount: Number(ocrQuality.supportedConsensusRegionCount ?? 0),
      averageConsensus: Number(ocrQuality.averageConsensus ?? 0),
      semanticRegionCount: Number(ocrQuality.semanticRegionCount ?? 0),
      highConfidenceSemanticRegionCount: Number(ocrQuality.highConfidenceSemanticRegionCount ?? 0),
      deskewEvaluated: ocrGeometry.evaluated === true,
      deskewApplied: ocrGeometry.applied === true,
      deskewAngleDegrees: typeof ocrGeometry.angleDegrees === "number" ? ocrGeometry.angleDegrees : null,
      deskewConfidence: Number(ocrGeometry.confidence ?? 0),
      perspectiveEvaluated: ocrPerspective.evaluated === true,
      perspectiveApplied: ocrPerspective.applied === true,
      perspectiveConfidence: Number(ocrPerspective.confidence ?? 0),
      perspectiveDistortion: Number(ocrPerspective.distortion ?? 0),
    } : null,
  };
}

function summaryCatalogRegions(regionReview: Awaited<ReturnType<typeof getLatestOcrRegionReview>>, analysis: Record<string, unknown>): LabelAnalysisTextRegion[] {
  const reviewed = regionReview?.regions.filter((region) => region.status === "reviewed") ?? [];
  if (reviewed.length) return reviewed.flatMap((region) => {
    const bbox = normalizedSummaryBox(region.bbox); const text = region.normalizedText || region.text || "";
    const level = region.level === "line" ? "line" : "word";
    return bbox && region.transcriptionStatus === "verified" && text.trim() ? [{ id: region.id, parentId: null, level, bbox, rawText: region.text ?? "",
      normalizedText: region.normalizedText ?? "", confidence: 100,
      textDirection: normalizeTextDirection(region.textDirection), glyphOrientation: normalizeGlyphOrientation(region.glyphOrientation),
      semantic: classifyOcrSemantic(text, level, bbox) }] : [];
  });
  const generated = Array.isArray(analysis.textRegions) ? analysis.textRegions : [];
  return generated.flatMap((value) => {
    const region = normalizeObject(value); const bbox = normalizedSummaryBox(normalizeObject(region.bbox));
    const rawText = String(region.rawText ?? ""); const normalizedText = String(region.normalizedText ?? "");
    const level = region.level === "line" ? "line" : "word"; const text = normalizedText || rawText;
    return bbox && text.trim() ? [{ id: String(region.id ?? ""), parentId: typeof region.parentId === "string" ? region.parentId : null,
      level, bbox, rawText, normalizedText, confidence: typeof region.confidence === "number" ? region.confidence : null,
      textDirection: normalizeTextDirection(region.textDirection), glyphOrientation: normalizeGlyphOrientation(region.glyphOrientation),
      semantic: classifyOcrSemantic(text, level, bbox) }] : [];
  });
}

function normalizeTextDirection(value: unknown): LabelAnalysisTextRegion["textDirection"] {
  return value === "left" || value === "down" || value === "up" || value === "mixed" ? value : "right";
}

function normalizeGlyphOrientation(value: unknown): LabelAnalysisTextRegion["glyphOrientation"] {
  return value === "clockwise" || value === "counterclockwise" || value === "upside-down" || value === "mixed" ? value : "upright";
}

function normalizedSummaryBox(value: Record<string, unknown>) {
  const x = Number(value.x); const y = Number(value.y); const width = Number(value.width); const height = Number(value.height);
  return [x, y, width, height].every(Number.isFinite) ? { x, y, width, height } : null;
}

function toItemJobDto(row: Record<string, unknown>) {
  return {
    jobId: String(row.id),
    parentJobId: row.parent_job_id ? String(row.parent_job_id) : null,
    scope: row.parent_job_id ? "batch-child" : row.source_item_id ? "single-item" : "batch-parent",
    type: String(row.job_type ?? row.mode ?? ""),
    status: String(row.status),
    cancelRequested: row.cancel_requested === true,
    annotationVersionId: typeof row.annotation_version_id === "string" ? row.annotation_version_id : row.annotation_version_id ? String(row.annotation_version_id) : null,
    pipelineVersion: typeof row.pipeline_version === "string" ? row.pipeline_version : null,
    sourceHash: typeof row.source_hash === "string" ? row.source_hash : null,
    options: normalizeObject(row.options),
    result: normalizeObject(row.result),
    error: typeof row.error === "string" ? row.error : null,
    reused: false,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : null,
    finishedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : null,
  };
}

function normalizeObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function acceptedPackageLabelContext(
  operations: Awaited<ReturnType<typeof getAnnotationGraph>>["operations"],
  packageEntity: Awaited<ReturnType<typeof getAnnotationGraph>>["packages"][number],
) {
  const geometry = packageEntity.scope.geometry;
  if (!geometry || packageEntity.status !== "reviewed") return null;
  const operation = [...operations].reverse().find((item) => item.scope?.type === "package"
    && item.scope.id === packageEntity.id
    && item.helper.id === "package-smart-lasso"
    && item.status === "reviewed"
    && item.selectedCandidateId);
  const selected = operation?.selectedCandidateId
    ? operation.candidates.find((candidate) => candidate.id === operation.selectedCandidateId)
    : null;
  const payload = normalizeObject(selected?.payload);
  const rawContour = Array.isArray(payload.contour) ? payload.contour : Array.isArray(payload.polygon) ? payload.polygon : [];
  const helperContour = rawContour.flatMap((value) => {
    if (!Array.isArray(value) || value.length < 2) return [];
    const x = Number(value[0]), y = Number(value[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? [[x, y] as [number, number]] : [];
  });
  const geometryContour = geometry.points.map((point) => [point.x, point.y] as [number, number]);
  const useUnchangedHelperContour = packageEntity.scope.source === "auto"
    && operation?.reviewMode === "accepted"
    && helperContour.length >= 3;
  const contour = useUnchangedHelperContour
    ? helperContour
    : helperContour.length >= 3
      ? remapContourToBbox(helperContour, candidatePayloadBbox(payload), geometry.bbox)
      : geometryContour;
  if (contour.length < 3) return null;
  const classification = normalizeObject(payload.classification);
  const packageType = ["bottle", "box", "tube", "other", "unknown"].includes(String(classification.type))
    ? String(classification.type) as "bottle" | "box" | "tube" | "other" | "unknown"
    : packageEntity.packageType.value;
  return {
    bbox: geometry.bbox,
    contour,
    packageType,
    confidence: useUnchangedHelperContour && typeof classification.confidence === "number" ? classification.confidence : null,
    source: useUnchangedHelperContour ? "accepted-package-helper" as const : "reviewed-package-geometry" as const,
  };
}

function candidatePayloadBbox(payload: Record<string, unknown>) {
  const value = normalizeObject(payload.bbox);
  const x = Number(value.x), y = Number(value.y), width = Number(value.width), height = Number(value.height);
  return Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0 ? { x, y, width, height } : null;
}

function remapContourToBbox(contour: Array<[number, number]>, from: { x: number; y: number; width: number; height: number } | null, to: { x: number; y: number; width: number; height: number }) {
  if (!from) return toBboxContour(to);
  return contour.map(([x, y]) => [
    to.x + (x - from.x) / from.width * to.width,
    to.y + (y - from.y) / from.height * to.height,
  ] as [number, number]);
}

function toBboxContour(bbox: { x: number; y: number; width: number; height: number }): Array<[number, number]> {
  return [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]];
}

export function toMetadataDto(row: MetaItemRow, sourceItem?: Awaited<ReturnType<typeof getSourceItem>>) {
  return {
    id: row.id,
    source: row.source,
    sourceItemId: row.source_item_id,
    sourceTitle: sourceItem?.title ?? null,
    sourceProducer: sourceItem?.manufacturer ?? null,
    imageUrls: sourceItem?.imageUrls ?? [],
    aliases: row.aliases,
    normalizedTokens: row.normalized_tokens,
    visualFeatures: row.visual_features,
    annotations: row.annotations,
    status: row.status,
    generationVersion: Number(row.generation_version?.replace(/\D/g, "") || 1),
    sourceHash: row.source_hash,
    updatedAt: row.updated_at.toISOString(),
  };
}
