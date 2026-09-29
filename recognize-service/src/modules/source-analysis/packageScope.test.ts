import assert from "node:assert/strict";
import test from "node:test";
import { filterCandidatesToPackageScope } from "./sourceAnalysis.js";

test("Package scope keeps candidates inside the track crop and rejects unrelated objects", () => {
  const candidates = [
    { id: "label", bbox: { x: 120, y: 100, width: 200, height: 300 } },
    { id: "tube", bbox: { x: 520, y: 80, width: 180, height: 340 } },
    { id: "edge", bbox: { x: 300, y: 100, width: 80, height: 100 } },
  ];

  assert.deepEqual(
    filterCandidatesToPackageScope(candidates, { x: 80, y: 60, width: 260, height: 380 }).map((candidate) => candidate.id),
    ["label", "edge"],
  );
});

test("full-image Package scope is equivalent to no spatial filtering", () => {
  const candidates = [
    { id: "a", bbox: { x: 0, y: 0, width: 20, height: 20 } },
    { id: "b", bbox: { x: 80, y: 80, width: 20, height: 20 } },
  ];
  assert.deepEqual(filterCandidatesToPackageScope(candidates, { x: 0, y: 0, width: 100, height: 100 }), candidates);
});
