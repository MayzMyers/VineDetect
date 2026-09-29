import assert from "node:assert/strict";
import test from "node:test";
import { planLabelCandidateMerges } from "../../shared/labelCandidateMerge.js";
import { rectangleGeometry } from "../../shared/quadGeometry.js";

const candidate = (candidateId: string, x: number, y: number, width: number, height: number, mergeGroupId?: string) => ({
  candidateId, geometry: rectangleGeometry({ x, y, width, height }), mergeGroupId,
});

test("partially overlapping Label candidates become one enclosing reviewed geometry", () => {
  const groups = planLabelCandidateMerges([candidate("upper", 10, 10, 80, 50), candidate("lower", 12, 45, 76, 55)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.mode, "automatic");
  assert.deepEqual(groups[0]!.candidateIds, ["upper", "lower"]);
  assert.deepEqual(groups[0]!.geometry.bbox, { x: 10, y: 10, width: 80, height: 90 });
});

test("contained Label hypotheses stay separate instead of producing a container union", () => {
  const groups = planLabelCandidateMerges([candidate("body", 10, 10, 100, 160), candidate("label", 25, 85, 70, 55)]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.candidateIds), [["body"], ["label"]]);
});

test("separated Label candidates stay separate unless the annotator groups them", () => {
  assert.equal(planLabelCandidateMerges([candidate("upper", 10, 10, 80, 30), candidate("lower", 10, 50, 80, 30)]).length, 2);
  const groups = planLabelCandidateMerges([candidate("upper", 10, 10, 80, 30, "manual-1"), candidate("lower", 10, 50, 80, 30, "manual-1")]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.mode, "manual");
  assert.deepEqual(groups[0]!.geometry.bbox, { x: 10, y: 10, width: 80, height: 70 });
});

test("automatic Label candidate merge is transitive", () => {
  const groups = planLabelCandidateMerges([
    candidate("a", 0, 0, 20, 20), candidate("b", 10, 10, 20, 20), candidate("c", 25, 25, 20, 20),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0]!.candidateIds, ["a", "b", "c"]);
});
