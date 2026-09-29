import assert from "node:assert/strict";
import test from "node:test";
import { isPersistedLabelCandidateRunReviewed } from "./labelCandidateReviewState.ts";

const reviewedOperation = {
  scope: { type: "package", id: "package-1" },
  helper: { id: "label-roi-detection" },
  status: "reviewed",
  candidates: [{ id: "label-consensus-1" }, { id: "label-consensus-2" }],
};

test("a fresh helper execution is not hidden by reused candidate ids from an old review", () => {
  assert.equal(isPersistedLabelCandidateRunReviewed({
    packageId: "package-1",
    candidateIds: ["label-consensus-1", "label-consensus-2"],
    transientExecutionId: "fresh-stage-execution",
    operations: [reviewedOperation],
  }), false);
});

test("a persisted candidate snapshot without a transient execution can remain marked reviewed", () => {
  assert.equal(isPersistedLabelCandidateRunReviewed({
    packageId: "package-1",
    candidateIds: ["label-consensus-1", "label-consensus-2"],
    transientExecutionId: null,
    operations: [reviewedOperation],
  }), true);
});
