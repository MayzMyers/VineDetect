import assert from "node:assert/strict";
import test from "node:test";
import { previewLabelCandidateMerges } from "./labelCandidateMerge.ts";

test("Label merge preview combines partially overlapping candidates", () => {
  const groups = previewLabelCandidateMerges([
    { id: "a", bbox: { x: 0, y: 0, width: 20, height: 20 } },
    { id: "b", bbox: { x: 10, y: 10, width: 20, height: 20 } },
  ]);
  assert.deepEqual(groups, [{ candidateIds: ["a", "b"], bbox: { x: 0, y: 0, width: 30, height: 30 }, mode: "automatic" }]);
});

test("Label merge preview keeps contained alternatives separate", () => {
  const groups = previewLabelCandidateMerges([
    { id: "body", bbox: { x: 0, y: 0, width: 100, height: 180 } },
    { id: "label", bbox: { x: 15, y: 85, width: 70, height: 60 } },
  ]);
  assert.deepEqual(groups, [
    { candidateIds: ["body"], bbox: { x: 0, y: 0, width: 100, height: 180 }, mode: "none" },
    { candidateIds: ["label"], bbox: { x: 15, y: 85, width: 70, height: 60 }, mode: "none" },
  ]);
});

test("Label merge preview combines manually grouped candidates across a gap", () => {
  const groups = previewLabelCandidateMerges([
    { id: "a", bbox: { x: 0, y: 0, width: 20, height: 10 }, manualMergeGroupId: "manual-1" },
    { id: "b", bbox: { x: 0, y: 20, width: 20, height: 10 }, manualMergeGroupId: "manual-1" },
  ]);
  assert.deepEqual(groups, [{ candidateIds: ["a", "b"], bbox: { x: 0, y: 0, width: 20, height: 30 }, mode: "manual" }]);
});
