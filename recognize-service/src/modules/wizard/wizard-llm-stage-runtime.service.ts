import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { getAnnotationGraph } from "../../db/annotation-graph.repository.js";
import { bindHelperToCard, type WizardStageId } from "../../shared/helperConfigContract.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import type { SourceName } from "../../shared/types.js";
import { DEFAULT_LABEL_ANALYSIS_CV_CONFIG, type LabelCvStage } from "../label-analysis/labelCropFeatures.js";
import { resolveGeneratedAssetPath } from "../recognize-node/assets.js";
import { previewLabelCvJobRecord, runGraphAutoOcrRecord, runGraphLabelRectificationRecord, runGraphPackageDetectionRecord, runSourceAnalysisRecord } from "../metadata/metadata.service.js";
import { createRectifiedLabelCropBuffer } from "../label-analysis/labelQuadCrop.js";
import { resolveLocalAssetPath } from "../recognize-node/assets.js";
import { rerunOcrOnLabelRegion } from "../ocr/ocrAnnotationService.js";
import { buildLabelStageObservation } from "./wizard-stage-observation.service.js";
import { renderMaskComparisonBoard, renderMorphologyComparisonBoard, renderStageResultOverlay, type renderWizardVisualContext } from "./wizard-visual.service.js";
import type { LabelEditOperation, OcrEditOperation, WizardCorrectionPlanRequest } from "./wizard.schemas.js";
import { getWizardStageState } from "./wizard.service.js";
import { buildStageRuntimeSnapshot, wizardRuntimeDefinition } from "../../shared/wizardRuntimeContract.js";
import { stageEditDefinition } from "../../shared/editStageContract.js";
import { enclosingLabelGeometry, executeEditOperationPlan, registeredEditOperationPrimitives, type ExecutableEditOperation, type OcrRerunOperation } from "./wizard-edit-operation-engine.service.js";
import type { SiglipLabelMode } from "../../vision/semanticEvidence.js";

type VisualContext = Awaited<ReturnType<typeof renderWizardVisualContext>>;
type Operation = WizardCorrectionPlanRequest["operations"][number];
export type LlmSemanticAdjustment = { adjustment: "expand_region" | "tighten_region" | "increase_background_tolerance" | "decrease_background_tolerance" | "include_more_foreground" | "include_less_foreground" | "invert_foreground" | "merge_fragments" | "separate_regions" | "reduce_noise" | "preserve_detail" | "increase_palette" | "decrease_palette"; strength: "small" | "medium" };
export type LlmGranularReview = { id: string; state: "accepted" | "rejected"; text: string | null; transcriptionStatus: "verified" | "partial" | "unreadable" | null; type: "text" | "graphic" | "separator" | "shape" | "unknown" | null; role: "brand" | "product_name" | "variety" | "producer" | "year" | "description" | "logo" | "signature" | "ornament" | "separator" | "unknown" | "other" | null };
export type LlmTopologyEdit = { componentId: number; destinationElementId: string | null; newGroupKey: string | null };
type ReviewOptions = { configOverride?: Record<string, unknown>; iteration?: number; visionEvidence?: { labelMode: SiglipLabelMode } };
const CV_STAGES = new Set<WizardStageId>(["mask", "morphology", "components", "elements", "contours", "palette"]);
const SEMANTIC_BY_STAGE: Partial<Record<WizardStageId, LlmSemanticAdjustment["adjustment"][]>> = {
  label: ["expand_region", "tighten_region", "increase_background_tolerance", "decrease_background_tolerance"],
  bottle: ["increase_background_tolerance", "decrease_background_tolerance", "merge_fragments", "reduce_noise", "preserve_detail"],
  // Mask and Morphology use immutable visual shortlists. Do not fall back to
  // blind JSON-parameter reruns; refinement must generate a new shortlist
  // explicitly anchored to a selected candidate.
  components: ["merge_fragments", "separate_regions", "reduce_noise", "preserve_detail"],
  contours: ["reduce_noise", "preserve_detail"],
  palette: ["increase_palette", "decrease_palette"],
};

export async function prepareLlmStageReview(
  source: SourceName, sourceItemId: string, annotationId: string, stage: WizardStageId,
  labelId: string | undefined, visualContext: VisualContext, options: ReviewOptions = {},
) {
  const stageState = await getWizardStageState(source, sourceItemId, annotationId, stage, labelId);
  if (stage !== "summary" && !stageState.validation.valid) {
    throw new ConflictError(`${stage} prerequisites are incomplete: ${stageState.validation.missingPrerequisites.join(", ") || "explicit Label selection required"}`);
  }
  const graph = await getAnnotationGraph(source, sourceItemId);
  const packageEntity = graph.packages.find((item) => item.legacyAnnotationTrackId === annotationId);
  if (!packageEntity) throw new NotFoundError("Package for annotation track was not found");
  const label = labelId ? packageEntity.labels.find((item) => item.id === labelId) : packageEntity.labels.length === 1 ? packageEntity.labels[0] : null;
  if (labelId && !label) throw new NotFoundError("Selected Label does not belong to this annotation track");

  const adapter = LLM_STAGE_ADAPTERS[stage];
  if (!adapter) throw new ConflictError(`${stage} has no LLM stage adapter`);
  const prepared = await adapter.prepare({ source, sourceItemId, annotationId, packageEntity, label, graph, visualContext, options });
  return stagePolicy(prepared, stage, options.iteration);
}

async function preparePackage(source: SourceName, sourceItemId: string, annotationId: string, packageEntity: any, visualContext: VisualContext) {
  const helperRun = await runGraphPackageDetectionRecord(source, sourceItemId, { scope: { type: "package", id: packageEntity.id }, config: {} });
  // StageObservation v1 is intentionally bounded to four candidates. Reserve
  // one slot for the semantic multipackage gate and expose the best contours.
  const visiblePackageCandidates = helperRun.candidates.slice(0, 3);
  const helperCandidates = visiblePackageCandidates.map((candidate, index) => ({
    id: candidate.id, rank: index + 1, score: candidate.score, geometry: rectangleGeometry(candidate.bbox),
    features: { classification: candidate.classification, contourMetrics: candidate.metrics },
  }));
  const candidates = [...helperCandidates, {
    id: "package-count:multiple", rank: helperCandidates.length + 1, score: null,
    features: { multiplicity: "multiple", meaning: "Two or more distinct physical packages are visible; no single crop may represent the item." },
  }];
  const overlay = await renderStageResultOverlay(visualContext, {
    stage: "package",
    sourcePolygons: visiblePackageCandidates.map((candidate) => ({
      id: candidate.id,
      points: candidate.contour.map(([x, y]) => ({ x, y })),
      color: candidate.classification.type === "bottle" ? "#7c3aed" : "#0284c7",
    })),
  });
  const observation: Record<string, any> = await observationOf("package", annotationId, packageEntity.id, null, {
    id: helperRun.helper.id, algorithm: helperRun.helper.version, version: "1", runId: helperRun.runId,
    config: helperRun.config, intermediateStates: [],
  }, candidates, "Review the smart-lasso candidates for the complete physical commercial package. Select one contour only when it encloses the whole bottle or box and its proposed type is plausible. Printed labels and graphics are not separate packages. Select package-count:multiple when two or more physical packages are visible; if no contour is safe, require human review.", visualContext, overlay);
  observation.phase = "package-shape-gate";
  return {
    observation,
    acceptOperation: (candidateId: string): Operation => {
      if (candidateId === "package-count:multiple") return {
        operationId: "llm-package-count-multiple", stage: "package", command: "set_semantic",
        payload: {
          value: "multiple",
          operation: {
            helperId: helperRun.helper.id, helperVersion: helperRun.helper.version,
            initialConfig: helperRun.config, finalConfig: helperRun.config,
            candidates: helperRun.candidates.map((candidate) => ({ id: candidate.id, payload: candidate, score: candidate.score })),
            selectedCandidateId: null, reviewMode: "accepted",
          },
        },
        proposedOutput: { phase: "package-shape-gate", multiplicity: "multiple", pipelineDisposition: "stop_multipackage" },
      };
      const candidate = helperRun.candidates.find((item) => item.id === candidateId);
      if (!candidate) throw new ConflictError("Selected Package candidate is not part of the helper run");
      return {
        operationId: `llm-package-shape-${candidate.id}`, stage: "package", command: "select_candidate",
        target: { entityType: "package", id: packageEntity.id },
        payload: {
          geometry: rectangleGeometry(candidate.bbox), status: "reviewed",
          packageType: { value: candidate.classification.type, status: "reviewed", source: "auto" },
          operation: {
            helperId: helperRun.helper.id, helperVersion: helperRun.helper.version,
            initialConfig: helperRun.config, finalConfig: helperRun.config,
            candidates: helperRun.candidates.map((item) => ({ id: item.id, payload: item, score: item.score })),
            selectedCandidateId: candidateId, reviewMode: "accepted",
          },
        },
        proposedOutput: { phase: "package-shape-gate", multiplicity: "single", packageType: candidate.classification.type, crop: candidate.bbox, pipelineDisposition: "continue" },
      };
    },
  };
}

async function prepareLabel(source: SourceName, sourceItemId: string, annotationId: string, packageEntity: any, visualContext: VisualContext, options: ReviewOptions) {
  if (packageEntity.labels.length && packageEntity.labels.every((item: any) => item.geometryReviewStatus === "reviewed")) throw new ConflictError("All current Label regions are already reviewed; run Auto Label again to create a new helper observation");
  if (options.configOverride || options.visionEvidence) await runSourceAnalysisRecord(source, sourceItemId, annotationId, { labelConfig: options.configOverride, visionEvidence: options.visionEvidence });
  let observation: Record<string, any>;
  try { observation = await buildLabelStageObservation(source, sourceItemId, annotationId, visualContext); }
  catch (error) {
    if (!(error instanceof ConflictError) || !/Run Auto Label helper/.test(error.message)) throw error;
    await runSourceAnalysisRecord(source, sourceItemId, annotationId, { labelConfig: helperConfig(source, sourceItemId, "label-roi-detection"), visionEvidence: options.visionEvidence });
    observation = await buildLabelStageObservation(source, sourceItemId, annotationId, visualContext);
  }
  return {
    observation,
    acceptOperation: null as Operation | null,
    reviewOperation: (_candidateId: string, _reviews: LlmGranularReview[], _topology: LlmTopologyEdit[], editOperations: LabelEditOperation[]) =>
      buildLabelEditPlanOperation(observation, editOperations),
  };
}

export function buildLabelEditPlanOperation(observation: Record<string, any>, operations: LabelEditOperation[]): Operation {
  if (!operations.length) throw new ConflictError("Label review requires at least one Edit Engine operation");
  const sourceCandidates = array(object(observation.operation).candidates).map(object);
  const initialNodes = [];
  for (const candidate of sourceCandidates) {
    const id = string(candidate.id); const geometry = object(object(candidate.payload).geometry);
    if (!id || !validBox(object(geometry.bbox))) throw new ConflictError("Label Edit Engine requires candidate quad geometry");
    initialNodes.push({ id, payload: geometry, sources: new Map([[id, geometry]]) });
  }
  const execution = executeEditOperationPlan({ stage: "label", initialNodes, operations });
  const accepted = execution.accepted;
  const explicitRejected = execution.rejectedSourceIds;
  if (!accepted.length) throw new ConflictError("Label Edit Engine plan must accept at least one final node for human review");
  const variantGroupByCandidate = new Map(sourceCandidates.flatMap((candidate) => {
    const id = string(candidate.id); const groupId = string(object(object(candidate.payload).variant).groupId);
    return id && groupId ? [[id, groupId] as const] : [];
  }));
  const acceptedVariantGroups = new Map<string, string>();
  for (const output of accepted) for (const candidateId of output.sources.keys()) {
    const groupId = variantGroupByCandidate.get(candidateId); if (!groupId) continue;
    const owner = acceptedVariantGroups.get(groupId);
    if (owner && owner !== candidateId) throw new ConflictError("Only one mutually exclusive Label ROI variant may be accepted");
    acceptedVariantGroups.set(groupId, candidateId);
  }
  const ownerByCandidate = new Map<string, (typeof accepted)[number]>();
  for (const output of accepted) for (const candidateId of output.sources.keys()) {
    if (explicitRejected.has(candidateId)) throw new ConflictError("A rejected Label candidate cannot contribute to an accepted output");
    if (ownerByCandidate.has(candidateId)) throw new ConflictError("One Label candidate cannot contribute to multiple accepted outputs");
    ownerByCandidate.set(candidateId, output);
  }
  const mergeGroupByOutput = new Map(accepted.filter((output) => output.sources.size > 1).map((output) => [output.id, `llm-${output.id}`]));
  const reviews = sourceCandidates.map((candidate) => {
    const candidateId = string(candidate.id)!; const output = ownerByCandidate.get(candidateId);
    if (!output) return { candidateId, state: "rejected" as const };
    const geometry = output.sources.get(candidateId)!;
    const original = object(object(candidate.payload).geometry);
    return {
      candidateId, state: stableJson(geometry) === stableJson(original) ? "accepted" as const : "edited" as const,
      geometry, ...(output.sources.size > 1 ? { mergeGroupId: mergeGroupByOutput.get(output.id) } : {}),
    };
  });
  const mergeReviews = accepted.filter((output) => output.sources.size > 1).flatMap((output) => {
    const deterministic = enclosingLabelGeometry([...output.sources.values()]);
    return stableJson(deterministic) === stableJson(output.payload) ? [] : [{ candidateIds: [...output.sources.keys()], geometry: output.payload }];
  });
  const reviewMode = operations.some((item) => item.type === "edit" || item.type === "merge") ? "edited" as const : "accepted" as const;
  return {
    operationId: `llm-label-edit-${randomUUID()}`, stage: "label", command: "select_candidate",
    payload: { operation: { ...object(observation.operation), reviewMode }, reviews, mergeReviews },
    proposedOutput: {
      editEngineVersion: "edit-engine-v1", operations,
      derivedOutputs: accepted.map((output) => ({ id: output.id, sourceCandidateIds: [...output.sources.keys()], geometry: output.payload })),
    },
  };
}

async function prepareBottle(source: SourceName, sourceItemId: string, annotationId: string, packageEntity: any, label: any, visualContext: VisualContext, configOverride?: Record<string, unknown>) {
  if (["reviewed", "rejected"].includes(String(packageEntity.objectContext.status))) throw new ConflictError("Object Context is already reviewed");
  const reviewedLabels = packageEntity.labels.filter((item: any) => item.geometryReviewStatus === "reviewed");
  const reviewed = label?.geometryReviewStatus === "reviewed"
    ? label
    : [...reviewedLabels].sort((left: any, right: any) => geometryArea(right.geometry) - geometryArea(left.geometry))[0] ?? null;
  if (!reviewed) throw new ConflictError("A reviewed Label is required as the Object Context exclusion source");
  const output = await runSourceAnalysisRecord(source, sourceItemId, annotationId, {
    verifiedLabel: reviewed.geometry.bbox,
    outerConfig: configOverride ?? helperConfig(source, sourceItemId, "bottle-outline"),
  });
  const bottle = object(output.bottleDetection); const candidates = array(bottle.candidates).map(object)
    .filter((item) => string(item.id) && array(item.contour).length >= 3)
    .sort((left, right) => number(right.score) - number(left.score)).slice(0, 4);
  if (!candidates.length) throw new ConflictError("Object Context helper produced no reviewable candidates");
  const overlay = await renderStageResultOverlay(visualContext, {
    stage: "bottle",
    sourcePolygons: candidates.map((candidate) => ({ id: string(candidate.id)!, points: pointObjects(candidate.contour), color: "#ef4444" })),
  });
  const observation = await observationOf("bottle", annotationId, packageEntity.id, null, {
    id: "bottle-outline", algorithm: string(bottle.algorithm) ?? "bottle-border-flood-v2", version: String(bottle.version ?? "1"),
    runId: string(output.runId), config: object(bottle.config), intermediateStates: bottle.intermediateStates,
  }, candidates.map((candidate, index) => ({ id: string(candidate.id)!, rank: index + 1, score: numberOrNull(candidate.score), geometry: { type: "polygon", points: pointObjects(candidate.contour), bbox: candidate.bbox }, features: { method: candidate.method, metrics: candidate.metrics } })),
  "Select the external physical package contour; it must contain the reviewed Label and exclude background artifacts.", visualContext, overlay);
  return { observation, acceptOperation: (candidateId: string): Operation => {
    const candidate = candidates.find((item) => item.id === candidateId)!;
    return {
      operationId: `llm-accept-bottle-${candidateId}`, stage: "bottle", command: "select_candidate",
      payload: { ...output, bottleDetection: { ...bottle, selectedCandidateId: candidateId, annotation: { status: "verified", source: "auto-confirmed", candidateId, contour: candidate.contour, bbox: candidate.bbox } } },
      proposedOutput: { candidateId, candidate },
    };
  }};
}

async function prepareOcr(source: SourceName, sourceItemId: string, annotationId: string, packageEntity: any, operations: any[], label: any, visualContext: VisualContext) {
  if (label.geometryReviewStatus !== "reviewed") throw new ConflictError("A reviewed Label is required before OCR helper review");
  if (requiresOcrNormalization(label, operations)) return prepareOcrNormalization(source, sourceItemId, annotationId, packageEntity, label, visualContext);
  const existingDraft = [...operations].reverse().find((operation: any) => operation.operationType === "run_ocr" && operation.status === "draft" && operation.scope?.id === label.id);
  const reusableDraft = existingDraft && existingDraft.candidates.length > 0 ? existingDraft : null;
  const helperRun = reusableDraft ? {
    operationId: reusableDraft.id, helper: reusableDraft.helper, config: reusableDraft.finalConfig ?? reusableDraft.initialConfig ?? {},
    candidates: reusableDraft.candidates.map((candidate: any) => ({ id: candidate.id, payload: candidate.payload, score: candidate.score })),
  } : await runGraphAutoOcrRecord(source, sourceItemId, { scope: { type: "label", id: label.id }, config: helperConfig(source, sourceItemId, "label-ocr-cascade") });
  const run = { ...helperRun, compositions: array(label.ocrCompositions) };
  const overlay = await renderStageResultOverlay(visualContext, {
    stage: "ocr",
    sourcePolygons: run.candidates.map((candidate: any) => ({ id: candidate.id, points: geometryPoints(object(candidate.payload).sourceGeometry), color: "#a855f7" })),
  });
  const aggregateId = `ocr-run:${run.operationId}`;
  const canAcceptWholeRun = run.candidates.length > 0 && run.candidates.every((candidate: any) => {
    const payload = object(candidate.payload);
    return !payload.duplicateOfOcrId && object(payload.suggestedParent).id;
  });
  const observation: Record<string, any> = await observationOf("ocr", annotationId, packageEntity.id, label.id, {
    id: string(run.helper?.id) ?? "auto-ocr", algorithm: string(run.helper?.id) ?? "label-ocr-cascade", version: string(run.helper?.version) ?? "1", runId: run.operationId, config: object(run.config), intermediateStates: object(run).intermediateStates ?? run.helper?.intermediateStates,
  }, [{ id: aggregateId, rank: 1, score: mean(run.candidates.map((candidate: any) => numberOrNull(candidate.score))), features: {
    regionCount: run.candidates.length,
    regions: run.candidates.slice(0, 80).map((candidate: any) => ({ id: candidate.id, text: object(candidate.payload).transcription ?? null, confidence: candidate.score ?? null, duplicateOfOcrId: object(candidate.payload).duplicateOfOcrId ?? null })),
  } }], run.candidates.length
    ? "Review the complete OCR region set. Accept only if the visible regions and transcriptions are usable without human correction."
    : "The OCR cascade produced no regions. Inspect the rectified Label directly. Use create_region followed by approve_region for visible text regions, or require human review when geometry or transcription is uncertain.", visualContext, overlay);
  observation.reviewTargets = run.candidates.slice(0, 100).map((candidate: any) => ({
    id: candidate.id, geometry: object(candidate.payload).geometry, text: object(candidate.payload).transcription ?? null,
    transcriptionStatus: object(candidate.payload).transcriptionStatus ?? null, confidence: candidate.score ?? null,
    duplicateOfOcrId: object(candidate.payload).duplicateOfOcrId ?? null,
  }));
  (observation as Record<string, any>).compositionTargets = run.compositions.slice(0, 100).map((composition: any) => ({
    id: composition.id, memberIds: composition.memberIds, text: composition.text,
    transcriptionStatus: composition.transcriptionStatus, sortOrder: composition.sortOrder,
  }));
  const buildOcrOperation = (candidateId: string, granular: LlmGranularReview[] = [], _topology: LlmTopologyEdit[] = [], editOperations: OcrEditOperation[] = [], previousOperations: ExecutableEditOperation[] = []): Operation | Operation[] => {
    if (editOperations.length) return buildOcrEditPlanOperations(run, aggregateId, label.id, appendOcrOperations(previousOperations, editOperations));
    const byId = new Map(granular.map((item) => [item.id, item]));
    return {
    operationId: `llm-accept-${aggregateId}`, stage: "ocr", labelId: label.id, command: "select_candidate",
    payload: {
      operationId: run.operationId,
      reviews: run.candidates.map((candidate: any) => {
        const item = byId.get(candidate.id); const payload = object(candidate.payload);
        if (item?.state === "rejected" || (!item && payload.duplicateOfOcrId)) return { candidateId: candidate.id, state: "rejected" };
        const corrected = item && (item.text !== null || item.transcriptionStatus !== null);
        return {
          candidateId: candidate.id, state: corrected ? "edited" : "accepted", finalParent: payload.suggestedParent,
          ...(corrected ? { transcription: { text: item!.transcriptionStatus === "unreadable" ? null : item!.text ?? payload.transcription ?? null, status: item!.transcriptionStatus ?? payload.transcriptionStatus } } : {}),
        };
      }),
    }, proposedOutput: { candidateId, granularReviews: granular, acceptedRegionIds: run.candidates.filter((candidate: any) => byId.get(candidate.id)?.state !== "rejected" && (!object(candidate.payload).duplicateOfOcrId || byId.has(candidate.id))).map((candidate: any) => candidate.id) },
    };
  };
  const refineReview = (editOperations: OcrEditOperation[], previousOperations: ExecutableEditOperation[] = [], iteration = 1) =>
    refineOcrReview(source, sourceItemId, annotationId, packageEntity.id, label.id, run, visualContext, previousOperations, editOperations, iteration);
  return { observation, acceptOperation: canAcceptWholeRun ? (candidateId: string) => buildOcrOperation(candidateId) as Operation : null, reviewOperation: buildOcrOperation, refineReview };
}

export function requiresOcrNormalization(label: Record<string, any>, operations: Array<Record<string, any>>) {
  if (label.rectification) return false;
  return !operations.some((operation) =>
    operation.operationType === "edit_label"
    && operation.helper?.id === "label-rectification"
    && operation.result?.id === label.id
    && operation.status === "reviewed"
    && operation.reviewMode === "accepted",
  );
}

async function prepareOcrNormalization(source: SourceName, sourceItemId: string, annotationId: string, packageEntity: any, label: any, visualContext: VisualContext) {
  const run = await runGraphLabelRectificationRecord(source, sourceItemId, { scope: { type: "label", id: label.id }, config: helperConfig(source, sourceItemId, "label-rectification") });
  const candidates = array(run.candidates).map(object);
  if (!candidates.length) throw new ConflictError("Label rectification helper produced no reviewable candidates");
  const overlay = await renderStageResultOverlay(visualContext, {
    stage: "ocr",
    sourcePolygons: candidates.map((candidate) => ({ id: string(candidate.id)!, points: geometryPoints(object(object(candidate.payload).geometry)), color: object(candidate.payload).mode === "none" ? "#71717a" : object(candidate.payload).mode === "perspective" ? "#0ea5e9" : "#7c3aed" })),
  });
  const observation: Record<string, any> = await observationOf("ocr", annotationId, packageEntity.id, label.id, {
    id: "label-rectification", algorithm: "cv-label-rectification-v1", version: string(object(run.helper).version) ?? "1",
    runId: string(run.operationId), config: object(run.config), intermediateStates: [],
  }, candidates.map((candidate, index) => ({
    id: string(candidate.id)!, rank: index + 1, score: numberOrNull(candidate.score),
    geometry: object(object(candidate.payload).geometry),
    features: {
      mode: object(candidate.payload).mode,
      diagnostics: object(object(candidate.payload).diagnostics),
      cylindricalControls: object(object(candidate.payload).rectification).controls,
    },
  })), "Choose the Label-wide surface normalization that makes horizontal text baselines and glyph proportions most regular before OCR. Prefer Original when correction evidence is weak.", visualContext, overlay);
  observation.phase = "label-normalization";
  observation.visuals.rectificationCandidates = await rectificationCandidatePreviews(packageEntity.sourceAssetRef, candidates);
  return {
    observation,
    acceptOperation: (candidateId: string): Operation => {
      const candidate = candidates.find((item) => item.id === candidateId)!;
      const payload = object(candidate.payload);
      return {
        operationId: `llm-accept-rectification-${candidateId}`, stage: "ocr", labelId: label.id, command: "edit_region",
        target: { entityType: "label", id: label.id },
        payload: {
          geometry: payload.geometry, rectification: payload.rectification, status: "reviewed",
          operation: {
            helperId: "label-rectification", helperVersion: string(object(run.helper).version) ?? "cv-label-rectification-v1",
            initialConfig: object(run.config), finalConfig: object(run.config),
            candidates: candidates.map((item) => ({ id: string(item.id)!, payload: object(item.payload), score: numberOrNull(item.score) })),
            selectedCandidateId: candidateId, reviewMode: "accepted",
          },
        },
        proposedOutput: { phase: "label-normalization", candidateId, mode: payload.mode, diagnostics: payload.diagnostics, cylindricalControls: object(payload.rectification).controls },
      };
    },
  };
}

async function rectificationCandidatePreviews(sourceAssetRef: unknown, candidates: Array<Record<string, any>>) {
  if (typeof sourceAssetRef !== "string" || !sourceAssetRef) return [];
  const sourcePath = resolveLocalAssetPath(sourceAssetRef);
  if (!sourcePath) return [];
  const metadata = await sharp(sourcePath).metadata();
  if (!metadata.width || !metadata.height) return [];
  return Promise.all(candidates.slice(0, 4).flatMap(async (candidate) => {
    const payload = object(candidate.payload); const geometry = object(payload.geometry) as any; const bbox = object(geometry.bbox);
    if (!validBox(bbox)) return [];
    const left = Math.max(0, Math.floor(number(bbox.x))); const top = Math.max(0, Math.floor(number(bbox.y)));
    const right = Math.min(metadata.width!, Math.ceil(number(bbox.x) + number(bbox.width))); const bottom = Math.min(metadata.height!, Math.ceil(number(bbox.y) + number(bbox.height)));
    const crop = await createRectifiedLabelCropBuffer(sourcePath, { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }, geometry, payload.rectification as any);
    const preview = await sharp(crop.buffer).resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    return [{ id: string(candidate.id), mode: payload.mode, mimeType: "image/webp", dataUrl: dataUrl(preview) }];
  })).then((items) => items.flat());
}

export function buildOcrEditPlanOperation(run: Record<string, any>, aggregateId: string, labelId: string, operations: OcrEditOperation[]): Operation {
  const result = buildOcrEditPlanOperations(run, aggregateId, labelId, operations);
  if (result.length !== 1) throw new ConflictError("OCR plan contains create_region commands and must be applied as an operation sequence");
  return result[0]!;
}

export function buildOcrEditPlanOperations(run: Record<string, any>, aggregateId: string, labelId: string, operations: ExecutableEditOperation[]): Operation[] {
  if (!operations.length) throw new ConflictError("OCR review requires at least one Edit Engine operation");
  assertNoDanglingOcrDerivedRegions(operations);
  const candidates = array(run.candidates).map(object);
  const regionNodes = candidates.map((candidate) => {
    const id = string(candidate.id); const payload = object(candidate.payload);
    if (!id || !validBox(object(object(payload.geometry).bbox))) throw new ConflictError("OCR Edit Engine requires normalized candidate geometry");
    return { id, payload, sources: new Map([[id, payload]]) };
  });
  const existingCompositions = array(run.compositions).map(object);
  const compositionNodes = existingCompositions.map((composition) => ({
    id: string(composition.id)!, payload: { ...composition, kind: "string-composition" }, sources: new Map<string, Record<string, unknown>>(),
  }));
  const initialNodes = [...regionNodes, ...compositionNodes];
  const execution = executeEditOperationPlan({ stage: "ocr", initialNodes, operations });
  const accepted = [...new Map(execution.accepted.map((node) => [node.id, node])).values()];
  if (!accepted.length) throw new ConflictError("OCR Edit Engine plan must approve at least one final region");
  const ownerByCandidate = new Map<string, Array<(typeof accepted)[number]>>();
  for (const output of accepted) for (const sourceId of output.sources.keys()) {
    if (execution.rejectedSourceIds.has(sourceId)) throw new ConflictError("Rejected OCR candidate cannot contribute to an approved output");
    ownerByCandidate.set(sourceId, [...(ownerByCandidate.get(sourceId) ?? []), output]);
  }
  const operationById = new Map(operations.map((operation) => [operation.operationId, operation]));
  const splitBranch = (nodeId: string, visited = new Set<string>()): { splitId: string; branchId: string } | null => {
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);
    const directSplit = operations.find((operation) => operation.type === "split_region" && nodeId.startsWith(`${operation.operationId}:`));
    if (directSplit) {
      const nextSeparator = nodeId.indexOf(":", directSplit.operationId.length + 1);
      return { splitId: directSplit.operationId, branchId: nextSeparator < 0 ? nodeId : nodeId.slice(0, nextSeparator) };
    }
    const operation = operationById.get(nodeId);
    if (!operation) return null;
    if (operation.type === "split_region") return { splitId: operation.operationId, branchId: operation.operationId };
    const ancestors = operation.inputIds.map((inputId) => splitBranch(inputId, new Set(visited))).filter((value): value is { splitId: string; branchId: string } => Boolean(value));
    return ancestors.length && ancestors.every((value) => value.splitId === ancestors[0]!.splitId && value.branchId === ancestors[0]!.branchId) ? ancestors[0]! : null;
  };
  for (const [sourceId, outputs] of ownerByCandidate) if (outputs.length > 1) {
    const branches = outputs.map((output) => splitBranch(output.id));
    if (branches.some((branch) => !branch) || branches.some((branch) => branch!.splitId !== branches[0]!.splitId) || new Set(branches.map((branch) => branch!.branchId)).size !== branches.length) {
      throw new ConflictError(`OCR candidate ${sourceId} may produce multiple approved outputs only through distinct branches of one split_region`);
    }
  }
  const reviews = candidates.map((candidate) => {
    const candidateId = string(candidate.id)!; const original = object(candidate.payload); const outputs = ownerByCandidate.get(candidateId) ?? [];
    if (!outputs.length) return { candidateId, state: "rejected" as const };
    if (outputs.length > 1) return {
      candidateId, state: "edited" as const, finalParent: original.suggestedParent,
      splitOutputs: outputs.map((output) => ({
        geometry: output.payload.geometry,
        regionStatus: "reviewed" as const,
        transcription: { text: output.payload.transcription ?? null, status: output.payload.transcriptionStatus ?? "unreadable" },
        layout: output.payload.layout,
        rectification: output.payload.rectification ?? null,
        confidence: output.payload.recognitionConfidence ?? null,
        sourceOperationId: output.id,
      })),
    };
    const output = outputs[0]!;
    const finalPayload = output.payload;
    const merged = output.sources.size > 1;
    const geometryChanged = stableJson(finalPayload.geometry) !== stableJson(original.geometry);
    const textChanged = finalPayload.transcription !== original.transcription || finalPayload.transcriptionStatus !== original.transcriptionStatus;
    return {
      candidateId, state: geometryChanged || textChanged || merged ? "edited" as const : "accepted" as const,
      sourceOperationId: output.id,
      finalParent: original.suggestedParent,
      ...(geometryChanged || merged ? { geometry: finalPayload.geometry } : {}),
      ...(textChanged || merged ? { transcription: { text: finalPayload.transcription ?? null, status: finalPayload.transcriptionStatus ?? "unreadable" } } : {}),
      ...(merged ? { mergeGroupId: `llm-${output.id}` } : {}),
    };
  });
  const decomposedNodeIds = new Set(operations.filter((operation) => operation.type === "decompose_string").flatMap((operation) => operation.inputIds));
  const acceptedById = new Map(accepted.map((node) => [node.id, node]));
  const compositions = operations.flatMap((operation) => {
    if (operation.type !== "compose_string" || decomposedNodeIds.has(operation.operationId)) return [];
    const node = execution.nodes.get(operation.operationId);
    const payload = object(node?.payload);
    const memberSourceOperationIds = array(payload.memberNodeIds).map(String);
    if (memberSourceOperationIds.some((id) => !acceptedById.has(id))) throw new ConflictError("OCR composition may reference final approved regions only");
    if (memberSourceOperationIds.some((id) => acceptedById.get(id)!.sources.size === 0)) throw new ConflictError("A newly created OCR region must be persisted before it can join a semantic composition");
    return [{
      sourceOperationId: operation.operationId,
      memberSourceOperationIds,
      text: payload.transcriptionStatus === "unreadable" ? null : string(payload.text) ?? null,
      transcriptionStatus: payload.transcriptionStatus as "verified" | "partial" | "unreadable",
      sortOrder: Number(payload.sortOrder ?? 0),
    }];
  });
  const existingCompositionIds = new Set(existingCompositions.map((composition) => string(composition.id)).filter((id): id is string => Boolean(id)));
  const decomposeCompositionIds = [...decomposedNodeIds].filter((id) => existingCompositionIds.has(id));
  const reviewOperation: Operation = {
    operationId: `llm-ocr-edit-${randomUUID()}`, stage: "ocr", labelId, command: "select_candidate",
    payload: { operationId: run.operationId, reviews, compositions, decomposeCompositionIds },
    proposedOutput: {
      editEngineVersion: "edit-engine-v1", aggregateId, operations,
      derivedOutputs: accepted.map((output) => ({ id: output.id, sourceCandidateIds: [...output.sources.keys()], output: output.payload })),
    },
  };
  const reference = object(candidates[0]?.payload);
  const coordinateSpace = object(reference.coordinateSpace).type ? reference.coordinateSpace : {
    type: "label-rectified", units: "normalized", labelId, cropRevision: null, width: null, height: null,
  };
  const createdOperations = accepted.filter((output) => output.sources.size === 0).map((output): Operation => ({
    operationId: `llm-ocr-create-${randomUUID()}`, stage: "ocr", labelId, command: "create_region",
    payload: {
      annotation: {
        parent: { type: "label", id: labelId }, geometry: output.payload.geometry, coordinateSpace,
        regionStatus: "reviewed",
        transcription: { text: output.payload.transcription ?? null, status: output.payload.transcriptionStatus ?? "unreadable" },
        layout: output.payload.layout ?? { type: "word", flow: "linear", baselineAngleDeg: 0, baseline: null, characterOrientation: "aligned" },
        rectification: output.payload.rectification ?? null, confidence: null, config: object(run.config),
      },
      duplicateDecision: "create",
    },
    proposedOutput: { editEngineVersion: "edit-engine-v1", sourceOperationId: output.id, output: output.payload },
  }));
  return [reviewOperation, ...createdOperations];
}

function assertNoDanglingOcrDerivedRegions(operations: ExecutableEditOperation[]) {
  const derivedRegionIds = new Set<string>();
  const consumedByTransform = new Set<string>();
  const explicitlyResolved = new Set<string>();
  const regionTransforms = new Set(["edit_region", "edit_text", "merge_region", "split_region", "create_region", "set_status", "rerun_ocr"]);
  for (const operation of operations) {
    if (regionTransforms.has(operation.type) && operation.type !== "create_region") for (const input of operation.inputIds) consumedByTransform.add(input);
    if (operation.type === "split_region") {
      const childCount = (operation.split?.fractions.length ?? 0) + 1;
      for (let index = 1; index <= childCount; index += 1) derivedRegionIds.add(`${operation.operationId}:${index}`);
    } else if (regionTransforms.has(operation.type)) derivedRegionIds.add(operation.operationId);
    if (["approve_region", "approve_text", "reject"].includes(operation.type)) for (const input of operation.inputIds) explicitlyResolved.add(input);
  }
  const dangling = [...derivedRegionIds].filter((id) => !consumedByTransform.has(id) && !explicitlyResolved.has(id));
  if (dangling.length) throw new ConflictError(`OCR Edit Engine plan leaves derived region node(s) uncommitted: ${dangling.slice(0, 8).join(", ")}`);
}

async function refineOcrReview(source: SourceName, sourceItemId: string, annotationId: string, packageId: string, labelId: string, run: Record<string, any>, visualContext: VisualContext, previousOperations: ExecutableEditOperation[], nextOperations: OcrEditOperation[], iteration: number) {
  const combined = appendOcrOperations(previousOperations, nextOperations);
  const candidates = array(run.candidates).map(object);
  const initialNodes = [
    ...candidates.map((candidate) => ({ id: string(candidate.id)!, payload: object(candidate.payload), sources: new Map([[string(candidate.id)!, object(candidate.payload)]]) })),
    ...array(run.compositions).map(object).map((composition) => ({ id: string(composition.id)!, payload: { ...composition, kind: "string-composition" }, sources: new Map<string, Record<string, unknown>>() })),
  ];
  const execution = executeEditOperationPlan({ stage: "ocr", initialNodes, operations: combined });
  const accepted = [...new Map(execution.accepted.map((node) => [node.id, node])).values()];
  const operationById = new Map(combined.map((operation) => [operation.operationId, operation]));
  const geometryChanged = (id: string, visited = new Set<string>()): boolean => {
    if (visited.has(id)) return false;
    visited.add(id);
    const operation = operationById.get(id);
    if (!operation) return false;
    if (["edit_region", "merge_region", "split_region", "create_region"].includes(operation.type)) return true;
    return operation.inputIds.some((inputId) => geometryChanged(inputId, visited));
  };
  const rerunnable = accepted.filter((node) => geometryChanged(node.id));
  if (!rerunnable.length) return null;
  if (rerunnable.length > 4) throw new ConflictError("OCR correction loop may rerun at most four changed regions per iteration");
  const withoutApprovals = combined.filter((operation) => !["approve_region", "approve_text", "compose_string", "decompose_string"].includes(operation.type));
  const rerunResults = await Promise.all(rerunnable.map((node) => rerunOcrOnLabelRegion(source, sourceItemId, labelId, object(node.payload.geometry) as any)));
  const rerunOperations: OcrRerunOperation[] = rerunnable.map((node, index) => ({
    operationId: `system-rerun-${iteration}-${index + 1}`, type: "rerun_ocr", actor: "system", inputIds: [node.id],
    helper: { id: "tesseract-cascade", version: "v6", config: object(run.config) }, result: rerunResults[index]!,
  }));
  const program: ExecutableEditOperation[] = [...withoutApprovals, ...rerunOperations];
  const afterRerun = executeEditOperationPlan({ stage: "ocr", initialNodes, operations: program });
  const rerunByInput = new Map(rerunOperations.map((operation) => [operation.inputIds[0], afterRerun.nodes.get(operation.operationId)!]));
  const finalNodes = accepted.map((node) => rerunByInput.get(node.id) ?? afterRerun.nodes.get(node.id) ?? node);
  const overlay = await renderStageResultOverlay(visualContext, { stage: `ocr-rerun-${iteration}`, normalizedPolygons: finalNodes.map((node) => ({ id: node.id, points: geometryPoints(object(node.payload.geometry)), color: "#7c3aed" })) });
  const aggregateId = `ocr-derived:${randomUUID()}`;
  const intermediateStates = rerunOperations.map((operation, index) => ({
    id: operation.operationId, parentId: operation.inputIds[0], sequence: index, status: "completed", algorithm: "tesseract-cascade-v6",
    summary: { transcription: operation.result.transcription, confidence: operation.result.recognitionConfidence, evidence: operation.result.evidence },
  }));
  const refined = await observationOf("ocr", annotationId, packageId, labelId, {
    id: "auto-ocr", algorithm: "tesseract-cascade-v6", version: "6", runId: run.operationId, config: object(run.config), intermediateStates,
  }, [{ id: aggregateId, rank: 1, score: mean(finalNodes.map((node) => numberOrNull(node.payload.recognitionConfidence))), features: { regionCount: finalNodes.length, correctionIteration: iteration } }],
  "Verify the OCR nodes produced after deterministic geometry correction and local OCR rerun. Approve, reject, or derive another bounded correction; do not recreate prior operations.", visualContext, overlay);
  refined.reviewTargets = finalNodes.map((node) => ({ id: node.id, geometry: node.payload.geometry, text: node.payload.transcription ?? null, transcriptionStatus: node.payload.transcriptionStatus ?? null, confidence: node.payload.recognitionConfidence ?? null, duplicateOfOcrId: null }));
  (refined as Record<string, any>).compositionTargets = array(run.compositions).map(object).map((composition) => ({
    id: composition.id, memberIds: composition.memberIds, text: composition.text,
    transcriptionStatus: composition.transcriptionStatus, sortOrder: composition.sortOrder,
  }));
  (refined as Record<string, any>).context = { ...object(refined.context), priorEditOperations: program, correctionIteration: iteration };
  return { observation: stagePolicy({ observation: refined, acceptOperation: null as Operation | null }, "ocr", iteration).observation, operations: program };
}

export function appendOcrOperations(previous: ExecutableEditOperation[], next: OcrEditOperation[]): ExecutableEditOperation[] {
  const used = new Set(previous.map((operation) => operation.operationId));
  const mapping = new Map<string, string>();
  let sequence = previous.reduce((maximum, operation) => {
    const match = /^op-([1-9][0-9]?)$/.exec(operation.operationId);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  for (const operation of next) {
    let id = operation.operationId;
    if (used.has(id)) {
      do { sequence += 1; id = `op-${sequence}`; } while (used.has(id));
    }
    mapping.set(operation.operationId, id); used.add(id);
  }
  const mappedId = (id: string) => {
    const direct = mapping.get(id);
    if (direct) return direct;
    const parent = [...mapping].find(([source]) => id.startsWith(`${source}:`));
    return parent ? `${parent[1]}${id.slice(parent[0].length)}` : id;
  };
  return [...previous, ...next.map((operation) => ({ ...operation, operationId: mapping.get(operation.operationId)!, inputIds: operation.inputIds.map(mappedId) }) as OcrEditOperation)];
}

async function prepareCv(source: SourceName, sourceItemId: string, annotationId: string, packageId: string, label: any, stage: LabelCvStage, visualContext: VisualContext, configOverride?: Record<string, unknown>) {
  if (label.geometryReviewStatus !== "reviewed") throw new ConflictError("A reviewed Label is required before Label CV helper review");
  if (!label.ocr.length || label.ocr.some((item: any) => item.regionStatus !== "reviewed")) throw new ConflictError("Reviewed OCR is required before Label CV helper review");
  const existingJob = object(label.cv?.job); const config = { ...DEFAULT_LABEL_ANALYSIS_CV_CONFIG, ...object(existingJob.config), ...object(configOverride) };
  const cvJob = await previewLabelCvJobRecord(source, sourceItemId, annotationId, { stage, config, review: object(existingJob.review) }, label.id);
  const preview = object(cvJob.preview); const visual = cvVisual(stage, preview);
  const acceptedReview = cvAcceptedReview(stage, preview, object(cvJob.review));
  const overlay = await renderStageResultOverlay(visualContext, { stage, ...visual });
  const aggregateId = `${stage}-preview:${string(cvJob.analysisJobId) ?? label.id}`;
  const observation: Record<string, any> = await observationOf(stage, annotationId, packageId, label.id, {
    id: `label-${stage}`, algorithm: `label-${stage}-v1`, version: "1", runId: string(cvJob.analysisJobId), config: object(cvJob.config), intermediateStates: object(cvJob).intermediateStates ?? preview.intermediateStates,
  }, [{ id: aggregateId, rank: 1, score: null, features: { metrics: preview.stageMetrics ?? {}, summary: cvSummary(stage, preview) } }], objective(stage), visualContext, overlay);
  const cropTransformMode = label.rectification?.type === "guided-cylindrical" ? "guided-cylindrical"
    : label.rectification?.type === "perspective" ? "perspective" : "source-bbox";
  observation.context = {
    ...object(observation.context),
    geometryProcessing: {
      branch: cropTransformMode === "source-bbox" ? "uncorrected" : "corrected",
      transformMode: cropTransformMode,
      rule: "Every CV stage and its overlay use this same immutable Label crop coordinate space.",
    },
  };
  const maskCandidates = stage === "mask" ? array(object(object(preview.cvDebug).maskSearch).candidates).map(object) : [];
  if (stage === "mask" && maskCandidates.length) {
    const comparison = await renderMaskComparisonBoard(visualContext, maskCandidates.map((candidate) => ({
      id: string(candidate.id)!, config: object(candidate.config), score: Number(candidate.score), metrics: object(candidate.metrics), mask: object(candidate.mask) as any,
    })));
    const comparisonBoard = await readAsset(comparison.asset.assetPath);
    const search = object(object(preview.cvDebug).maskSearch);
    observation.helper = {
      ...object(observation.helper), algorithm: "binary-mask-variant-search-v1",
      config: { ...object(object(observation.helper).config), search: { generatedCount: Number(search.generatedCount), shortlistLimit: 4, polarities: ["dark-foreground", "light-foreground"], sizes: [256, 400, 512] } },
    };
    observation.candidates = maskCandidates.map((candidate, index) => ({
      id: string(candidate.id), rank: index + 1, score: Number(candidate.score),
      features: {
        family: candidate.family, strength: candidate.strength,
        config: { threshold: object(candidate.config).threshold, maskSize: object(candidate.config).maskSize, foregroundPolarity: object(candidate.config).invert ? "light" : "dark" },
        metrics: candidate.metrics,
        downstreamProbe: { helper: "connected-components-v2", metrics: {
          componentCount: object(candidate.metrics).connectedComponentCount, noiseCount: object(candidate.metrics).smallNoiseCount,
          largestBlobRatio: object(candidate.metrics).largestBlobRatio, fragmentation: object(candidate.metrics).fragmentation,
          textLikeRegionCoverage: object(candidate.metrics).textLikeRegionCoverage,
        } },
      },
    }));
    observation.context.objective = "Select the binary mask candidate that best separates meaningful label foreground from background, preserves visible lettering and graphics, suppresses incidental texture/noise, and provides usable structure for Morphology and connected-components. Both foreground polarities are legitimate; rely on the rendered candidates rather than guessing numeric parameters.";
    observation.visuals = { ...object(observation.visuals), renderer: comparison.renderer, candidateOverlay: { ...comparison.asset, dataUrl: dataUrl(comparisonBoard) } };
  }
  const morphologyCandidates = stage === "morphology"
    ? array(object(object(preview.cvDebug).morphologySearch).candidates).map(object)
    : [];
  if (stage === "morphology" && morphologyCandidates.length) {
    const labelDebug = object(object(object(preview.cvDebug).label).debug);
    const rawMask = array(labelDebug.layers).map(object).find((layer) => layer.id === "raw-mask");
    if (rawMask && string(rawMask.data) && Number(rawMask.width) > 0 && Number(rawMask.height) > 0) {
      const comparison = await renderMorphologyComparisonBoard(
        visualContext,
        { width: Number(rawMask.width), height: Number(rawMask.height), data: string(rawMask.data)! },
        morphologyCandidates.map((candidate) => ({
          id: string(candidate.id)!,
          pipeline: array(candidate.pipeline).map(object).map((step) => ({
            operation: string(step.operation)!,
            kernel: array(step.kernel).map(Number).slice(0, 2) as [number, number],
            iterations: Number(step.iterations),
          })),
          score: Number(candidate.score),
          metrics: object(candidate.metrics) as any,
          mask: object(candidate.mask) as any,
        })),
      );
      const [inputMask, comparisonBoard] = await Promise.all([
        readAsset(comparison.inputAsset.assetPath), readAsset(comparison.boardAsset.assetPath),
      ]);
      observation.helper = {
        ...object(observation.helper),
        algorithm: "label-morphology-variant-search-v1",
        config: {
          ...object(object(observation.helper).config),
          search: { generatedCount: Number(object(object(preview.cvDebug).morphologySearch).generatedCount), shortlistLimit: 4, families: ["identity", "erode", "dilate", "open", "close", "open-dilate", "close-erode"] },
        },
      };
      observation.candidates = morphologyCandidates.map((candidate, index) => ({
        id: string(candidate.id), rank: index + 1, score: Number(candidate.score),
        features: {
          family: candidate.family, strength: candidate.strength, pipeline: candidate.pipeline,
          metrics: candidate.metrics,
          downstreamProbe: { helper: "connected-components-v2", metrics: {
            componentCount: object(candidate.metrics).connectedComponentCount,
            smallComponentCount: object(candidate.metrics).smallComponentCount,
            largestComponentRatio: object(candidate.metrics).largestComponentRatio,
            fragmentation: object(candidate.metrics).fragmentation,
            holesCount: object(candidate.metrics).holesCount,
            boundaryDelta: object(candidate.metrics).boundaryDelta,
          } },
        },
      }));
      observation.context.objective = "Select the morphology candidate that best preserves meaningful glyph and graphic foreground while improving connectivity for downstream connected-components analysis. Reject candidates that merge unrelated regions, erase thin letter strokes, or materially inflate foreground. Identity is valid when every transform is harmful.";
      observation.visuals = {
        ...object(observation.visuals), renderer: comparison.renderer,
        inputMask: { ...comparison.inputAsset, dataUrl: dataUrl(inputMask) },
        candidateOverlay: { ...comparison.boardAsset, dataUrl: dataUrl(comparisonBoard) },
      };
    }
  }
  if (stage === "components") observation.reviewTargets = array(preview.components).slice(0, 100).map(object).map((item, index) => ({ id: String(item.id), displayId: `C${index + 1}`, displayIndex: index + 1, bbox: item.bbox, proposalAccepted: item.proposalAccepted !== false }));
  if (stage === "elements") {
    observation.reviewTargets = array(preview.elements).slice(0, 100).map(object).map((item, index) => ({ id: String(item.id), displayId: `E${index + 1}`, displayIndex: index + 1, bbox: item.bbox, sourceComponentIds: item.sourceComponentIds, type: item.type, role: item.role ?? null, text: item.text ?? null }));
    observation.availableComponentIds = [...new Set(array(preview.elements).flatMap((item) => array(object(item).sourceComponentIds).map(Number).filter(Number.isInteger)))];
  }
  const buildCvOperation = (candidateId: string, review = acceptedReview): Operation => {
    const visualCandidate = stage === "mask" ? maskCandidates.find((candidate) => candidate.id === candidateId)
      : stage === "morphology" ? morphologyCandidates.find((candidate) => candidate.id === candidateId) : null;
    const selectedConfig = visualCandidate ? object(visualCandidate.config) : object(cvJob.config);
    return ({
    operationId: `llm-accept-${stage}-${label.id}`, stage, labelId: label.id, command: "commit",
    payload: { stage, config: selectedConfig, review, ...(stage === "palette" ? { palette: preview.palette } : {}) },
    proposedOutput: { candidateId, metrics: visualCandidate ? visualCandidate.metrics : preview.stageMetrics ?? {}, ...(stage === "morphology" && visualCandidate ? { pipeline: visualCandidate.pipeline } : {}) },
  });
  };
  const reviewOperation = stage === "components" || stage === "elements" ? (candidateId: string, granular: LlmGranularReview[], topologyEdits: LlmTopologyEdit[] = []) => {
    if (stage === "components") {
      const decisions = { ...object(acceptedReview.componentDecisions) };
      for (const item of granular) decisions[item.id] = item.state;
      return buildCvOperation(candidateId, { ...acceptedReview, componentDecisions: decisions });
    }
    const byId = new Map(granular.map((item) => [item.id, item]));
    let elements = array(acceptedReview.elements).map(object).map((element) => {
      const item = byId.get(String(element.id));
      return item ? { ...element, status: item.state, ...(item.type ? { type: item.type } : {}), ...(item.role ? { role: item.role } : {}) } : element;
    });
    elements = applyElementTopology(elements, topologyEdits);
    return buildCvOperation(candidateId, { ...acceptedReview, elementsReviewed: true, elements });
  } : null;
  return { observation, acceptOperation: (candidateId: string) => buildCvOperation(candidateId), reviewOperation };
}
export function applyElementTopology(elementsValue: Array<Record<string, any>>, edits: LlmTopologyEdit[]) {
  if (!edits.length) return elementsValue;
  const elements: Array<Record<string, any>> = elementsValue.map((element) => ({ ...element, sourceComponentIds: array(element.sourceComponentIds).map(Number).filter(Number.isInteger) }));
  const existingIds = new Set(elements.map((element) => String(element.id)));
  const available = new Set(elements.flatMap((element) => element.sourceComponentIds));
  const moved = new Set<number>(); const newIds = new Map<string, string>();
  for (const edit of edits) {
    if (!available.has(edit.componentId) || moved.has(edit.componentId)) throw new ConflictError("Element topology edits must reference each available component at most once");
    if (Boolean(edit.destinationElementId) === Boolean(edit.newGroupKey)) throw new ConflictError("Element topology edit requires exactly one destination");
    if (edit.destinationElementId && !existingIds.has(edit.destinationElementId)) throw new ConflictError("Element topology destination does not exist");
    moved.add(edit.componentId);
  }
  for (const edit of edits) {
    for (const element of elements) element.sourceComponentIds = element.sourceComponentIds.filter((id: number) => id !== edit.componentId);
    let destination: Record<string, any> | null = edit.destinationElementId ? elements.find((element) => String(element.id) === edit.destinationElementId) ?? null : null;
    if (!destination) {
      const groupKey = edit.newGroupKey!;
      let id = newIds.get(groupKey);
      if (!id) { id = `element:llm:${randomUUID()}`; newIds.set(groupKey, id); }
      destination = elements.find((element) => String(element.id) === id) ?? null;
      if (!destination) {
        destination = { id, sourceComponentIds: [], type: "unknown", status: "accepted", provenance: { source: "model", grouping: { method: "model" } } };
        elements.push(destination);
      }
    }
    destination.sourceComponentIds.push(edit.componentId);
  }
  const result = elements.filter((element) => element.sourceComponentIds.length);
  const claims = result.flatMap((element) => element.sourceComponentIds);
  if (new Set(claims).size !== claims.length || new Set(claims).size !== available.size || claims.some((id) => !available.has(id))) throw new ConflictError("Element topology must retain unique ownership of every existing component");
  return result;
}

async function prepareSummary(validation: Record<string, unknown>, annotationId: string, packageId: string, visualContext: VisualContext) {
  const overlay = await renderStageResultOverlay(visualContext, { stage: "summary" });
  const candidateId = `summary:${annotationId}`;
  const observation = await observationOf("summary", annotationId, packageId, null, { id: "label-summary", algorithm: "canonical-summary-validation", version: "1", runId: null, config: {} },
    [{ id: candidateId, rank: 1, score: validation.readyForCanonicalExport === true ? 1 : 0, features: { validation } }],
    "Review final composition warnings. This LLM pass is advisory and cannot commit Summary ground truth.", visualContext, overlay);
  return { observation, acceptOperation: null as Operation | null };
}

type StageAdapterContext = {
  source: SourceName; sourceItemId: string; annotationId: string; packageEntity: any; label: any; graph: any;
  visualContext: VisualContext; options: ReviewOptions;
};
type StageAdapter = { prepare(context: StageAdapterContext): Promise<{ observation: Record<string, any>; acceptOperation: Operation | null | ((candidateId: string) => Operation); reviewOperation?: ((...args: any[]) => Operation | Operation[]) | null; refineReview?: ((...args: any[]) => Promise<{ observation: Record<string, any>; operations: ExecutableEditOperation[] } | null>) | null }> };

const LLM_STAGE_ADAPTERS: Partial<Record<WizardStageId, StageAdapter>> = {
  package: { prepare: ({ source, sourceItemId, annotationId, packageEntity, visualContext }) => preparePackage(source, sourceItemId, annotationId, packageEntity, visualContext) },
  label: { prepare: ({ source, sourceItemId, annotationId, packageEntity, visualContext, options }) => prepareLabel(source, sourceItemId, annotationId, packageEntity, visualContext, options) },
  bottle: { prepare: ({ source, sourceItemId, annotationId, packageEntity, label, visualContext, options }) => prepareBottle(source, sourceItemId, annotationId, packageEntity, label, visualContext, options.configOverride) },
  ocr: { prepare: ({ source, sourceItemId, annotationId, packageEntity, label, graph, visualContext }) => prepareOcr(source, sourceItemId, annotationId, packageEntity, graph.operations, requireLabel(label), visualContext) },
  mask: cvAdapter("mask"),
  morphology: cvAdapter("morphology"),
  components: cvAdapter("components"),
  elements: cvAdapter("elements"),
  contours: cvAdapter("contours"),
  palette: cvAdapter("palette"),
  summary: { prepare: ({ graph, annotationId, packageEntity, visualContext }) => prepareSummary(graph.validation, annotationId, packageEntity.id, visualContext) },
};

function cvAdapter(stage: LabelCvStage): StageAdapter {
  return { prepare: ({ source, sourceItemId, annotationId, packageEntity, label, visualContext, options }) =>
    prepareCv(source, sourceItemId, annotationId, packageEntity.id, requireLabel(label), stage, visualContext, options.configOverride) };
}

async function observationOf(stage: WizardStageId, annotationId: string, packageId: string | null, labelId: string | null, helper: Record<string, unknown>, candidates: Array<Record<string, unknown>>, objectiveText: string, visualContext: VisualContext, overlay: Awaited<ReturnType<typeof renderStageResultOverlay>>) {
  const [sourcePreview, resultOverlay] = await Promise.all([readAsset(visualContext.assets.base.assetPath), readAsset(overlay.asset.assetPath)]);
  return {
    schemaVersion: 1, observationId: randomUUID(), stage, annotationId, packageId, labelId, helper,
    context: { objective: objectiveText, coordinateSpace: visualContext.viewport, transform: visualContext.transform },
    candidates, reviewTargets: [] as Array<Record<string, unknown>>, availableComponentIds: [] as number[],
    policy: { task: "review_candidate", allowedActions: ["accept", "human_required"], maxCandidates: 4, paramsPatchAllowed: false, maxLLMIterations: 2, remainingLLMIterations: 0, allowedSemanticAdjustments: [] },
    visuals: {
      renderer: overlay.renderer,
      sourcePreview: { assetPath: visualContext.assets.base.assetPath, mimeType: "image/webp", dataUrl: dataUrl(sourcePreview) },
      candidateOverlay: { assetPath: overlay.asset.assetPath, mimeType: "image/webp", dataUrl: dataUrl(resultOverlay) },
    },
  };
}
function stagePolicy<T extends { observation: Record<string, any>; acceptOperation?: Operation | null | ((candidateId: string) => Operation) }>(result: T, stage: WizardStageId, iteration = 0): T {
  const definition = wizardRuntimeDefinition(stage);
  const rectificationPhase = stage === "ocr" && object(result.observation.helper).id === "label-rectification";
  const allowed = SEMANTIC_BY_STAGE[stage] ?? [];
  const remaining = Math.max(0, definition.maxLlmIterations - iteration);
  const decisionActions = rectificationPhase ? ["accept", "human_required"] : definition.actions.filter((action) => {
    if (action === "accept" && result.acceptOperation === null) return false;
    return action !== "rerun" || Boolean(allowed.length && remaining);
  });
  const reviewTargetCount = array(result.observation.reviewTargets).length;
  const compositionTargetCount = array(result.observation.compositionTargets).length;
  const maxEditOperations = stage === "ocr"
    ? Math.min(99, Math.max(20, reviewTargetCount * 2 + compositionTargetCount + 8))
    : 20;
  result.observation.policy = {
    ...object(result.observation.policy),
    allowedActions: decisionActions, paramsPatchAllowed: Boolean(allowed.length && remaining), maxLLMIterations: definition.maxLlmIterations,
    iteration, remainingLLMIterations: remaining, allowedSemanticAdjustments: allowed,
    granularReviewAllowed: !rectificationPhase && ["label", "ocr", "components", "elements"].includes(stage),
    maxEditOperations,
  };
  result.observation.runtimeState = buildStageRuntimeSnapshot({
    stage, algorithm: string(object(result.observation.helper).algorithm) ?? definition.algorithms[0] ?? "unknown",
    iteration, intermediateStates: object(result.observation.helper).intermediateStates,
  });
  const editDefinition = stageEditDefinition(stage, definition.maxLlmIterations);
  result.observation.editEngine = {
    ...editDefinition,
    declaredPrimitives: editDefinition.primitives,
    primitives: registeredEditOperationPrimitives(stage).filter((primitive) => primitive !== "rerun_ocr"),
    systemPrimitives: registeredEditOperationPrimitives(stage).filter((primitive) => primitive === "rerun_ocr"),
  };
  return result;
}

export function applyLlmSemanticAdjustment(stage: WizardStageId, configValue: unknown, patch: LlmSemanticAdjustment): Record<string, unknown> {
  const allowed = SEMANTIC_BY_STAGE[stage] ?? [];
  if (!allowed.includes(patch.adjustment)) throw new ConflictError(`${patch.adjustment} is not supported for ${stage}`);
  const config = { ...object(configValue) };
  const factor = patch.strength === "medium" ? 2 : 1;
  const add = (key: string, delta: number, min: number, max: number) => { config[key] = clamp(number(config[key]) + delta * factor, min, max); };
  const multiply = (key: string, ratio: number, min: number, max: number) => { config[key] = clamp(number(config[key]) * Math.pow(ratio, factor), min, max); };
  switch (stage) {
    case "label":
      if (patch.adjustment === "expand_region") { add("minRegionWidthRatio", -.06, .1, .9); add("maxRegionWidthRatio", .01, .5, 1); add("minimumBandCoverage", -.06, .15, .95); add("envelopeSizeMultiplier", .2, 1, 4); }
      if (patch.adjustment === "tighten_region") { add("minRegionWidthRatio", .06, .1, .9); add("minimumBandCoverage", .06, .15, .95); add("envelopeSizeMultiplier", -.2, 1, 4); }
      if (patch.adjustment === "increase_background_tolerance") { add("chromaTolerance", 8, 4, 80); add("minimumLightness", -12, 40, 240); }
      if (patch.adjustment === "decrease_background_tolerance") { add("chromaTolerance", -8, 4, 80); add("minimumLightness", 12, 40, 240); }
      break;
    case "bottle":
      if (patch.adjustment === "increase_background_tolerance") add("silhouetteThreshold", 8, 2, 80);
      if (patch.adjustment === "decrease_background_tolerance") add("silhouetteThreshold", -8, 2, 80);
      if (patch.adjustment === "merge_fragments") { config.connectivity = 8; config.morphology = { ...object(config.morphology), closeKernel: 7, iterations: 2 }; }
      if (patch.adjustment === "reduce_noise") add("simplifyTolerance", 1, .5, 8);
      if (patch.adjustment === "preserve_detail") add("simplifyTolerance", -0.75, .5, 8);
      break;
    case "mask":
      if (patch.adjustment === "include_more_foreground") add("threshold", 18, 0, 255);
      if (patch.adjustment === "include_less_foreground") add("threshold", -18, 0, 255);
      if (patch.adjustment === "invert_foreground") config.invert = !Boolean(config.invert);
      break;
    case "morphology": {
      config.morphologyMode = "manual"; config.morphologyEnabled = true;
      if (patch.adjustment === "merge_fragments") { config.morphologyOperation = "close"; add("morphologyKernelWidth", 2, 1, 21); add("morphologyKernelHeight", 2, 1, 21); add("morphologyIterations", 1, 1, 5); }
      if (patch.adjustment === "separate_regions") { config.morphologyOperation = "open"; add("morphologyKernelWidth", 2, 1, 21); add("morphologyKernelHeight", 2, 1, 21); }
      if (patch.adjustment === "reduce_noise") { config.morphologyOperation = "open"; add("morphologyIterations", 1, 1, 5); }
      if (patch.adjustment === "preserve_detail") { add("morphologyKernelWidth", -2, 1, 21); add("morphologyKernelHeight", -2, 1, 21); add("morphologyIterations", -1, 1, 5); }
      break;
    }
    case "components":
      if (patch.adjustment === "merge_fragments") { config.componentMode = "manual"; config.componentConnectivity = 8; }
      if (patch.adjustment === "separate_regions") { config.componentMode = "manual"; config.componentConnectivity = 4; }
      if (patch.adjustment === "reduce_noise") multiply("minComponentAreaRatio", 2, 0, .25);
      if (patch.adjustment === "preserve_detail") multiply("minComponentAreaRatio", .5, 0, .25);
      config.componentFilterPreset = "custom";
      break;
    case "contours":
      config.contourDetail = "custom";
      if (patch.adjustment === "reduce_noise") { multiply("contourSimplifyRatio", 1.6, .0005, .05); multiply("maxContourPoints", .75, 32, 2048); }
      if (patch.adjustment === "preserve_detail") { multiply("contourSimplifyRatio", .625, .0005, .05); multiply("maxContourPoints", 1.35, 32, 2048); }
      break;
    case "palette":
      if (patch.adjustment === "increase_palette") { add("paletteColors", 2, 1, 12); multiply("paletteMinRatio", .7, 0, .5); }
      if (patch.adjustment === "decrease_palette") { add("paletteColors", -2, 1, 12); multiply("paletteMinRatio", 1.4, 0, .5); }
      break;
  }
  return config;
}

function cvVisual(stage: LabelCvStage, preview: Record<string, unknown>) {
  const layers = array(object(object(object(preview.cvDebug).label).debug).layers).map(object);
  const maskId = stage === "mask" ? "raw-mask" : "morphology-mask";
  const maskLayer = layers.find((layer) => layer.id === maskId);
  const mask = maskLayer && string(maskLayer.data) && number(maskLayer.width) && number(maskLayer.height)
    ? { width: number(maskLayer.width), height: number(maskLayer.height), data: string(maskLayer.data)! } : null;
  const rectangles = stage === "components" ? array(preview.components).map(object)
    : stage === "elements" ? array(preview.elements).map(object) : [];
  const normalizedPolygons = rectangles.flatMap((item) => rectPoints(object(item.bbox)).length ? [{ id: String(item.id), points: rectPoints(object(item.bbox)) }] : []);
  if (stage === "contours") for (const contour of array(preview.contours).map(object)) normalizedPolygons.push({ id: String(contour.elementId ?? contour.componentId ?? "contour"), points: pointObjects(contour.points) });
  return { mask, normalizedPolygons, palette: stage === "palette" ? array(preview.palette).map((item) => object(item) as { rgb: number[]; ratio?: number }) : [] };
}
function cvSummary(stage: LabelCvStage, preview: Record<string, unknown>) {
  if (stage === "components") return { components: array(preview.components).length };
  if (stage === "elements") return { elements: array(preview.elements).length };
  if (stage === "contours") return { contours: array(preview.contours).length };
  if (stage === "palette") return { colors: array(preview.palette).length };
  return { mask: true };
}
function cvAcceptedReview(stage: LabelCvStage, preview: Record<string, unknown>, current: Record<string, unknown>) {
  if (stage === "components") {
    return {
      ...current,
      componentDecisions: Object.fromEntries(array(preview.components).map(object).filter((item) => item.id !== undefined).map((item) => [String(item.id), item.proposalAccepted === false ? "rejected" : "accepted"])),
    };
  }
  if (stage === "elements") {
    return {
      ...current,
      elementsReviewed: true,
      elements: array(preview.elements).map(object).filter((item) => item.id !== undefined).map((item) => ({
        id: String(item.id), sourceComponentIds: array(item.sourceComponentIds).map(Number).filter(Number.isFinite),
        type: string(item.type) ?? "unknown", role: string(item.role) ?? undefined,
        status: item.status === "rejected" ? "rejected" : "accepted", text: string(item.text) ?? undefined,
        provenance: item.provenance,
      })),
    };
  }
  return current;
}
function objective(stage: LabelCvStage) {
  const values: Record<LabelCvStage, string> = {
    mask: "Review whether the binary foreground mask captures meaningful dark/light label artwork without flooding the background.",
    morphology: "Review whether morphology improves continuity without merging unrelated artwork.",
    components: "Review the complete connected-component proposal set for excessive noise or missing meaningful regions.",
    elements: "Review automatic grouping of components into coherent semantic visual elements.",
    contours: "Review whether contours follow accepted visual elements without excessive noise or clipping.",
    palette: "Review whether the extracted palette represents the visible Label colours.",
  }; return values[stage];
}
function helperConfig(source: string, sourceItemId: string, helperId: string) { return bindHelperToCard({ schemaVersion: 1, records: [] }, source, sourceItemId, helperId).config; }
function requireLabel<T>(value: T | null): T { if (!value) throw new ConflictError("Explicit selectedLabelId is required for this Label-scoped stage"); return value; }
function geometryPoints(value: Record<string, unknown>) { return pointObjects(value.points); }
function pointObjects(value: unknown): Array<{ x: number; y: number }> { return array(value).flatMap((point) => { const item = Array.isArray(point) ? { x: point[0], y: point[1] } : object(point); return Number.isFinite(Number(item.x)) && Number.isFinite(Number(item.y)) ? [{ x: Number(item.x), y: Number(item.y) }] : []; }); }
function rectPoints(value: Record<string, unknown>) { const x = numberOrNull(value.x), y = numberOrNull(value.y), width = numberOrNull(value.width), height = numberOrNull(value.height); return x === null || y === null || width === null || height === null ? [] : [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]; }
function rectangleGeometry(bbox: { x: number; y: number; width: number; height: number }) {
  return { type: "quad" as const, points: rectPoints(bbox), bbox };
}
function geometryArea(geometry: unknown) {
  const bbox = object(object(geometry).bbox);
  return Math.max(0, number(bbox.width)) * Math.max(0, number(bbox.height));
}
async function readAsset(assetPath: string) { const local = resolveGeneratedAssetPath(assetPath); if (!local) throw new ConflictError("Stage visual asset path is unavailable"); return readFile(local); }
function dataUrl(value: Buffer) { return `data:image/webp;base64,${value.toString("base64")}`; }
function object(value: unknown): Record<string, any> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }
function array(value: unknown): any[] { return Array.isArray(value) ? value : []; }
function string(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function numberOrNull(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function mean(values: Array<number | null>) { const numbers = values.filter((value): value is number => value !== null); return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null; }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function validBox(value: Record<string, unknown>) {
  return ["x", "y", "width", "height"].every((key) => Number.isFinite(Number(value[key]))) && Number(value.width) > 0 && Number(value.height) > 0;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
