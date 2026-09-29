import assert from "node:assert/strict";
import test from "node:test";
import { buildLabelCandidateRoiReviewGraph, buildLabelEditRoiReviewGraph, buildManualLabelRoiReviewGraph, readRoiReviewGraph } from "../../shared/roiReviewGraph.js";
import type { QuadGeometry } from "../../shared/quadGeometry.js";

const roi1 = quad(0, 0, 100, 60);
const roi1Edited = quad(2, 0, 98, 60);
const roi2 = quad(0, 55, 100, 45);
const merged = quad(2, 0, 98, 100);

test("ROI review graph preserves candidates and represents edit before merge", () => {
  const graph = buildLabelCandidateRoiReviewGraph({
    candidates: [
      { id: "roi1", payload: { geometry: roi1 } },
      { id: "roi2", payload: { bbox: roi2.bbox } },
      { id: "rejected", payload: { bbox: quad(200, 200, 10, 10).bbox } },
    ],
    reviews: [
      { candidateId: "roi1", state: "edited", geometry: roi1Edited },
      { candidateId: "roi2", state: "accepted", geometry: roi2 },
      { candidateId: "rejected", state: "rejected" },
    ],
    mergeGroups: [{ candidateIds: ["roi1", "roi2"], resultEntityId: "label-1", geometry: merged, reviewedGeometry: quad(3, 1, 96, 98), mode: "automatic" }],
    resultEntityByCandidate: new Map([["roi1", "label-1"], ["roi2", "label-1"]]),
  });

  assert.deepEqual(graph.nodes.find((node) => node.id === "candidate:roi1")?.geometry, roi1);
  assert.deepEqual(graph.operations, [
    { type: "edit", actor: "human", input: "candidate:roi1", output: "derived:edit:roi1" },
    { type: "merge", actor: "human", inputs: ["derived:edit:roi1", "candidate:roi2"], output: "derived:merge:1", mode: "automatic" },
    { type: "edit", actor: "human", input: "derived:merge:1", output: "derived:merge-edit:1" },
    { type: "approve", actor: "human", input: "derived:merge-edit:1", outputEntity: { type: "label", id: "label-1" } },
    { type: "reject", actor: "human", input: "candidate:rejected" },
  ]);
  assert.deepEqual(graph.reviewedOutputIds, ["derived:merge-edit:1"]);
  assert.equal(graph.nodes.some((node) => node.id === "candidate:rejected"), true);
});

test("manual and post-review Label edits use the same ROI primitives", () => {
  const manual = buildManualLabelRoiReviewGraph("label-1", roi1);
  assert.deepEqual(manual.operations, [{ type: "approve", actor: "human", input: "manual:1", outputEntity: { type: "label", id: "label-1" } }]);

  const edit = buildLabelEditRoiReviewGraph("label-1", roi1, roi1Edited);
  assert.deepEqual(edit.operations, [
    { type: "edit", actor: "human", input: "canonical:label:label-1:before", output: "derived:edit:1" },
    { type: "approve", actor: "human", input: "derived:edit:1", outputEntity: { type: "label", id: "label-1" } },
  ]);
  assert.deepEqual(edit.reviewedOutputIds, ["derived:edit:1"]);
});

test("automated controllers are retained as operation actors", () => {
  const graph = buildLabelCandidateRoiReviewGraph({
    candidates: [{ id: "roi1", payload: { geometry: roi1 } }],
    reviews: [{ candidateId: "roi1", state: "accepted", geometry: roi1 }],
    mergeGroups: [], resultEntityByCandidate: new Map([["roi1", "label-1"]]), actor: "llm",
  });
  assert.deepEqual(graph.operations, [{ type: "approve", actor: "llm", input: "candidate:roi1", outputEntity: { type: "label", id: "label-1" } }]);
});

test("LLM transformations and human approval retain distinct actors", () => {
  const graph = buildLabelCandidateRoiReviewGraph({
    candidates: [
      { id: "roi1", payload: { geometry: roi1 } },
      { id: "roi2", payload: { geometry: roi2 } },
    ],
    reviews: [
      { candidateId: "roi1", state: "edited", geometry: roi1Edited },
      { candidateId: "roi2", state: "accepted", geometry: roi2 },
    ],
    mergeGroups: [{ candidateIds: ["roi1", "roi2"], resultEntityId: "label-1", geometry: merged, mode: "manual" }],
    resultEntityByCandidate: new Map([["roi1", "label-1"], ["roi2", "label-1"]]),
    actor: "llm",
    approvalActor: "human",
  });
  assert.equal(graph.operations.find((operation) => operation.type === "edit")?.actor, "llm");
  assert.equal(graph.operations.find((operation) => operation.type === "merge")?.actor, "llm");
  assert.equal(graph.operations.find((operation) => operation.type === "approve")?.actor, "human");
});

test("legacy ROI graphs expose unknown actor instead of fabricated provenance", () => {
  const graph = readRoiReviewGraph({
    schemaVersion: 1, nodes: [{ id: "manual:1", origin: "manual", geometry: roi1 }],
    operations: [{ type: "approve", input: "manual:1", outputEntity: { type: "label", id: "label-1" } }], reviewedOutputIds: ["manual:1"],
  });
  assert.equal(graph?.operations[0]?.actor, "unknown");
});

function quad(x: number, y: number, width: number, height: number): QuadGeometry {
  return {
    type: "quad" as const,
    points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }],
    bbox: { x, y, width, height },
  };
}
