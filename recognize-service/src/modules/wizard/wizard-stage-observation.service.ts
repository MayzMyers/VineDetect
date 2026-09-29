import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getAnnotationTrackState } from "../../db/annotation-track.repository.js";
import { getAnnotationGraph } from "../../db/annotation-graph.repository.js";
import { getLatestWizardStageExecutions } from "../../db/wizard-stage-execution.repository.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import type { SourceName } from "../../shared/types.js";
import { resolveGeneratedAssetPath } from "../recognize-node/assets.js";
import { renderLabelCandidateOverlay, renderWizardVisualContext } from "./wizard-visual.service.js";

type VisualContext = Awaited<ReturnType<typeof renderWizardVisualContext>>;
type Candidate = {
  id: string;
  bbox: { x: number; y: number; width: number; height: number };
  polygon: Array<[number, number]>;
  score: number;
  metrics: Record<string, unknown>;
  detection: Record<string, unknown>;
  cvScore: number;
  semantic: Record<string, unknown> | null;
  fusion: Record<string, unknown> | null;
  ranking: Record<string, unknown>;
  geometrySemantic: Record<string, unknown> | null;
  variant: Record<string, unknown> | null;
};

export async function buildLabelStageObservation(source: SourceName, sourceItemId: string, annotationId: string, visualContext: VisualContext) {
  const [state, graph, executions] = await Promise.all([
    getAnnotationTrackState(source, sourceItemId, annotationId), getAnnotationGraph(source, sourceItemId),
    getLatestWizardStageExecutions(source, sourceItemId, annotationId),
  ]);
  const packageEntity = graph.packages.find((item) => item.legacyAnnotationTrackId === annotationId);
  if (!packageEntity) throw new NotFoundError("Package for annotation track was not found");
  const sourceAnalysis = object(object(state.visual_features).labelSourceAnalysis);
  const execution = executions.find((item) => item.stage === "label") ?? null;
  if (execution?.status === "reviewed") throw new ConflictError("The current Auto Label helper run is already reviewed; run the helper again to create a new observation");
  const helperRun = execution?.helperRuns.at(-1) ?? null;
  const persistedCandidates = array(sourceAnalysis.candidates);
  const executionCandidates = helperRun?.candidates.length ? helperRun.candidates : array(execution?.autoOutput?.candidates);
  const allCandidates = (persistedCandidates.length ? persistedCandidates : executionCandidates).map(normalizeCandidate).filter((value): value is Candidate => Boolean(value));
  if (!allCandidates.length) throw new ConflictError("Run Auto Label helper before requesting LLM candidate review");
  const candidates = selectLabelReviewCandidates(allCandidates, 4);
  const packageContext = object(sourceAnalysis.packageContext);
  const packageContour = pointTuples(packageContext.contour);
  const candidateVisual = await renderLabelCandidateOverlay(visualContext, candidates, packageContour);
  const [sourcePreview, candidateOverlay] = await Promise.all([
    readAsset(visualContext.assets.base.assetPath), readAsset(candidateVisual.asset.assetPath),
  ]);
  const config = Object.keys(object(object(sourceAnalysis.labelDetection).config)).length
    ? object(object(sourceAnalysis.labelDetection).config)
    : helperRun?.config ?? execution?.initialParams ?? {};
  const helperId = execution?.helperId ?? "label-roi-detection";
  const helperVersion = execution?.algorithmVersion ?? String(sourceAnalysis.version ?? "1");
  return {
    schemaVersion: 1,
    observationId: randomUUID(),
    stage: "label" as const,
    annotationId,
    packageId: packageEntity.id,
    helper: {
      id: helperId,
      algorithm: execution?.algorithm ?? string(sourceAnalysis.algorithm) ?? "source-label-helper-v1",
      version: helperVersion,
      runId: helperRun?.id ?? string(sourceAnalysis.runId) ?? null,
      config,
      intermediateStates: array(sourceAnalysis.intermediateStates).length
        ? sourceAnalysis.intermediateStates
        : object(sourceAnalysis.labelDetection).intermediateStates,
    },
    input: {
      sourceAssetRef: visualContext.sourceAssetRef,
      packageScope: packageEntity.scope.geometry,
      packageContext: packageContour.length >= 3 ? {
        source: string(packageContext.source), packageType: string(packageContext.packageType),
        confidence: number(packageContext.confidence), contour: packageContour, bbox: object(packageContext.bbox),
      } : null,
      coordinateSpace: "source-image-pixels",
    },
    candidates: candidates.map((candidate, index) => ({
      id: candidate.id, rank: index + 1, score: candidate.score,
      geometry: geometry(candidate), features: { geometry: candidate.metrics, geometrySemantic: candidate.geometrySemantic, variant: candidate.variant, cvScore: candidate.cvScore, semantic: candidate.semantic, fusion: candidate.fusion, ranking: candidate.ranking }, detection: candidate.detection,
    })),
    policy: { task: "rank_candidates", allowedActions: ["accept", "human_required"], maxCandidates: 4, paramsPatchAllowed: false, maxLLMIterations: 0 },
    visuals: {
      renderer: candidateVisual.renderer,
      sourcePreview: { assetPath: visualContext.assets.base.assetPath, mimeType: "image/webp", dataUrl: dataUrl(sourcePreview) },
      candidateOverlay: { assetPath: candidateVisual.asset.assetPath, mimeType: "image/webp", dataUrl: dataUrl(candidateOverlay) },
    },
    operation: {
      helperId,
      helperVersion,
      initialConfig: config,
      finalConfig: config,
      candidates: candidates.map((candidate) => ({ id: candidate.id, payload: { geometry: geometry(candidate), metrics: candidate.metrics, geometrySemantic: candidate.geometrySemantic, variant: candidate.variant, cvScore: candidate.cvScore, semantic: candidate.semantic, fusion: candidate.fusion, ranking: candidate.ranking, detection: candidate.detection }, score: candidate.score })),
    },
    editState: {
      schemaVersion: 1,
      nodes: candidates.map((candidate) => ({ id: `candidate:${candidate.id}`, origin: "autodetect", candidateId: candidate.id, geometry: geometry(candidate) })),
      operations: [],
      reviewedOutputIds: [],
      history: graph.operations.filter((operation) => operation.scope?.id === packageEntity.id && operation.roiReviewGraph).slice(-10).map((operation) => ({ operationId: operation.id, graph: operation.roiReviewGraph })),
    },
  };
}

function normalizeCandidate(value: unknown): Candidate | null {
  const item = object(value); const bbox = object(item.bbox); const polygon = array(item.polygon);
  const id = string(item.id); const score = number(item.score);
  if (!id || score === null || !["x", "y", "width", "height"].every((key) => number(bbox[key]) !== null) || polygon.length !== 4) return null;
  const points = polygon.map((point) => Array.isArray(point) && point.length === 2 ? [number(point[0]), number(point[1])] as const : null);
  if (points.some((point) => !point || point[0] === null || point[1] === null)) return null;
  return {
    id, score,
    bbox: { x: number(bbox.x)!, y: number(bbox.y)!, width: number(bbox.width)!, height: number(bbox.height)! },
    polygon: points as Array<[number, number]>, metrics: object(item.metrics), detection: object(item.detection),
    cvScore: number(item.cvScore) ?? score,
    semantic: Object.keys(object(item.semantic)).length ? object(item.semantic) : null,
    fusion: Object.keys(object(item.fusion)).length ? object(item.fusion) : null,
    ranking: object(item.ranking),
    geometrySemantic: Object.keys(object(item.geometrySemantic)).length ? object(item.geometrySemantic) : null,
    variant: Object.keys(object(item.variant)).length ? object(item.variant) : null,
  };
}
function selectLabelReviewCandidates(candidates: Candidate[], limit: number) {
  const sorted = [...candidates].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const groups = new Map<string, Candidate[]>();
  for (const candidate of sorted) {
    const groupId = string(candidate.variant?.groupId) ?? `candidate:${candidate.id}`;
    const group = groups.get(groupId) ?? [];
    group.push(candidate); groups.set(groupId, group);
  }
  const primary = [...groups.values()].map((group) => group[0]!).sort((left, right) => right.score - left.score);
  const alternatives = [...groups.values()].flatMap((group) => group.slice(1)).sort((left, right) => right.score - left.score);
  return [...primary, ...alternatives].slice(0, limit);
}
function geometry(candidate: Candidate) {
  return { type: "quad" as const, points: candidate.polygon.map(([x, y]) => ({ x, y })), bbox: candidate.bbox };
}
async function readAsset(assetPath: string) { const local = resolveGeneratedAssetPath(assetPath); if (!local) throw new ConflictError("Stage visual asset path is unavailable"); return readFile(local); }
function dataUrl(value: Buffer) { return `data:image/webp;base64,${value.toString("base64")}`; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function pointTuples(value: unknown): Array<[number, number]> {
  return array(value).flatMap((point) => Array.isArray(point) && point.length >= 2 && number(point[0]) !== null && number(point[1]) !== null
    ? [[number(point[0])!, number(point[1])!] as [number, number]] : []);
}
