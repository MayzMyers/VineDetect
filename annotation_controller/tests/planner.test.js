import assert from "node:assert/strict";
import test from "node:test";
import { planDeterministic } from "../src/deterministic-planner.js";

test("fresh context proposes label helper only", () => {
  const result = planDeterministic({ visionContext: { visionContextId: "ctx", labels: [], package: {}, executionEvidence: [] } });
  assert.equal(result.status, "planned");
  assert.equal(result.operations[0].stage, "label");
  assert.equal(result.operations[0].command, "run_helper");
});

test("suggested label stops at review boundary", () => {
  const result = planDeterministic({ visionContext: { visionContextId: "ctx", package: {}, executionEvidence: [], labels: [{ id: "label", geometryReviewStatus: "suggested", ocr: [] }] } });
  assert.equal(result.status, "no_action");
  assert.deepEqual(result.operations, []);
});

test("existing unreviewed OCR output is not repeated", () => {
  const result = planDeterministic({ visionContext: {
    visionContextId: "ctx", package: { objectContext: { status: "reviewed" } },
    labels: [{ id: "00000000-0000-4000-8000-000000000001", geometryReviewStatus: "reviewed", ocr: [] }],
    executionEvidence: [{ stage: "ocr", hasAutoOutput: true, hasReviewedOutput: false }]
  } });
  assert.equal(result.status, "no_action");
});
