import type { RegionGeometry, RoiReviewGraph } from "./annotationGraphContract.js";
import type { EditOperationActor } from "./editStageContract.js";

type Candidate = { id: string; payload: Record<string, unknown> };
type Review = {
  candidateId: string;
  state: "accepted" | "edited" | "rejected" | "merged";
  geometry?: RegionGeometry;
};
type MergeGroup = {
  candidateIds: string[];
  resultEntityId: string | null;
  geometry: RegionGeometry;
  reviewedGeometry?: RegionGeometry;
  mode: "automatic" | "manual" | "mixed";
};

export function buildLabelCandidateRoiReviewGraph(input: {
  candidates: Candidate[];
  reviews: Review[];
  mergeGroups: MergeGroup[];
  resultEntityByCandidate: ReadonlyMap<string, string>;
  actor?: EditOperationActor;
  approvalActor?: EditOperationActor;
}): RoiReviewGraph {
  const nodes: RoiReviewGraph["nodes"] = [];
  const operations: RoiReviewGraph["operations"] = [];
  const currentNodeByCandidate = new Map<string, string>();
  const actor = input.actor ?? "human";
  const approvalActor = input.approvalActor ?? actor;

  for (const candidate of input.candidates) {
    const geometry = candidateGeometry(candidate.payload);
    if (!geometry) continue;
    const nodeId = `candidate:${candidate.id}`;
    nodes.push({ id: nodeId, origin: "autodetect", geometry, candidateId: candidate.id });
    currentNodeByCandidate.set(candidate.id, nodeId);
  }

  for (const review of input.reviews) {
    const inputNodeId = currentNodeByCandidate.get(review.candidateId);
    if (review.state !== "edited" || !review.geometry || !inputNodeId) continue;
    const outputNodeId = `derived:edit:${review.candidateId}`;
    nodes.push({ id: outputNodeId, origin: "derived", geometry: review.geometry, candidateId: review.candidateId });
    operations.push({ type: "edit", actor, input: inputNodeId, output: outputNodeId });
    currentNodeByCandidate.set(review.candidateId, outputNodeId);
  }

  const groupedCandidates = new Set<string>();
  input.mergeGroups.forEach((group, index) => {
    if (!group.resultEntityId) return;
    const inputs = group.candidateIds.map((id) => currentNodeByCandidate.get(id)).filter((id): id is string => Boolean(id));
    if (inputs.length < 2) return;
    group.candidateIds.forEach((id) => groupedCandidates.add(id));
    const mergeOutput = `derived:merge:${index + 1}`;
    nodes.push({ id: mergeOutput, origin: "derived", geometry: group.geometry });
    operations.push({ type: "merge", actor, inputs, output: mergeOutput, mode: group.mode });
    let finalOutput = mergeOutput;
    if (group.reviewedGeometry && !sameGeometry(group.geometry, group.reviewedGeometry)) {
      finalOutput = `derived:merge-edit:${index + 1}`;
      nodes.push({ id: finalOutput, origin: "derived", geometry: group.reviewedGeometry });
      operations.push({ type: "edit", actor, input: mergeOutput, output: finalOutput });
    }
    const finalNode = nodes.find((item) => item.id === finalOutput);
    if (finalNode) finalNode.entity = { type: "label", id: group.resultEntityId };
    operations.push({ type: "approve", actor: approvalActor, input: finalOutput, outputEntity: { type: "label", id: group.resultEntityId } });
  });

  for (const review of input.reviews) {
    if (review.state === "rejected") {
      const nodeId = currentNodeByCandidate.get(review.candidateId);
      if (nodeId) operations.push({ type: "reject", actor, input: nodeId });
      continue;
    }
    if ((review.state !== "accepted" && review.state !== "edited") || groupedCandidates.has(review.candidateId)) continue;
    const nodeId = currentNodeByCandidate.get(review.candidateId);
    const entityId = input.resultEntityByCandidate.get(review.candidateId);
    if (!nodeId || !entityId) continue;
    const node = nodes.find((item) => item.id === nodeId);
    if (node) node.entity = { type: "label", id: entityId };
    operations.push({ type: "approve", actor: approvalActor, input: nodeId, outputEntity: { type: "label", id: entityId } });
  }

  return {
    schemaVersion: 1,
    nodes,
    operations,
    reviewedOutputIds: operations.filter((operation) => operation.type === "approve").map((operation) => operation.input),
  };
}

export function buildManualLabelRoiReviewGraph(entityId: string, geometry: RegionGeometry, actor: EditOperationActor = "human"): RoiReviewGraph {
  const nodeId = "manual:1";
  return {
    schemaVersion: 1,
    nodes: [{ id: nodeId, origin: "manual", geometry, entity: { type: "label", id: entityId } }],
    operations: [{ type: "approve", actor, input: nodeId, outputEntity: { type: "label", id: entityId } }],
    reviewedOutputIds: [nodeId],
  };
}

export function buildLabelEditRoiReviewGraph(entityId: string, previous: RegionGeometry, resulting: RegionGeometry, actor: EditOperationActor = "human"): RoiReviewGraph {
  const input = `canonical:label:${entityId}:before`;
  const output = "derived:edit:1";
  return {
    schemaVersion: 1,
    nodes: [
      { id: input, origin: "canonical", geometry: previous, entity: { type: "label", id: entityId } },
      { id: output, origin: "derived", geometry: resulting, entity: { type: "label", id: entityId } },
    ],
    operations: [
      { type: "edit", actor, input, output },
      { type: "approve", actor, input: output, outputEntity: { type: "label", id: entityId } },
    ],
    reviewedOutputIds: [output],
  };
}

export function readRoiReviewGraph(value: unknown): RoiReviewGraph | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const graph = value as Partial<RoiReviewGraph>;
  if (graph.schemaVersion !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.operations) || !Array.isArray(graph.reviewedOutputIds)) return null;
  return {
    ...graph as RoiReviewGraph,
    operations: graph.operations.map((operation) => ({ ...operation, actor: operationActor(operation) })) as RoiReviewGraph["operations"],
  };
}

function operationActor(value: unknown): EditOperationActor {
  const actor = objectValue(value)?.actor;
  return actor === "autodetect" || actor === "llm" || actor === "human" || actor === "local_ml" || actor === "system" ? actor : "unknown";
}

function candidateGeometry(payload: Record<string, unknown>): RegionGeometry | null {
  const explicit = geometryValue(payload.geometry);
  if (explicit) return explicit;
  const bbox = objectValue(payload.bbox);
  const x = numberValue(bbox?.x), y = numberValue(bbox?.y), width = numberValue(bbox?.width), height = numberValue(bbox?.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return {
    type: "quad",
    points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }],
    bbox: { x, y, width, height },
  };
}

function geometryValue(value: unknown): RegionGeometry | null {
  const geometry = objectValue(value);
  if (!geometry || (geometry.type !== "quad" && geometry.type !== "polygon") || !Array.isArray(geometry.points)) return null;
  return geometry as RegionGeometry;
}
function objectValue(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function sameGeometry(left: RegionGeometry, right: RegionGeometry) { return JSON.stringify(left) === JSON.stringify(right); }
