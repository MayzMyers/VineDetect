import assert from "node:assert/strict";
import test from "node:test";
import type { AnnotationGraphOperation } from "../../lib/admin/api.ts";
import { ocrStatusForEntity } from "./ocrStatus.ts";

function operation(overrides: Partial<AnnotationGraphOperation>): AnnotationGraphOperation {
  return {
    id: "op-1", operationType: "run_ocr", result: null,
    results: [{ type: "ocr", id: "ocr-1" }], scope: { type: "label", id: "label-1" },
    helper: { id: "auto-ocr", version: "v6" }, reviewMode: "accepted", selectedCandidateId: null,
    candidateReviews: [{ candidateId: "candidate-1", state: "accepted", resultEntityId: "ocr-1", resultEntityIds: ["ocr-1"],
      finalPackageId: null, finalLabelId: null, reviewedGeometry: null, reviewedTranscription: null,
      reviewedRegionStatus: null, reviewedTranscriptionStatus: null, reviewedLayout: null, reviewedRectification: null }],
    reviewOperations: [], roiReviewGraph: null, status: "reviewed",
    helperOutput: { ocrReview: { reviewActor: "human" } }, candidates: [], initialConfig: {}, finalConfig: {},
    previousEntitySnapshot: null, resultingEntitySnapshot: null,
    resultDeletedAt: null, createdAt: "2026-01-01T00:00:00Z", ...overrides,
  };
}

test("unchanged Auto OCR reviewed by annotator keeps three separate status axes", () => {
  assert.deepEqual(ocrStatusForEntity({ id: "ocr-1", legacyManaged: false }, [operation({})]),
    { origin: "auto-helper", reviewer: "human", change: "unchanged" });
});

test("LLM-edited Auto OCR reports changed and LLM", () => {
  assert.deepEqual(ocrStatusForEntity({ id: "ocr-1", legacyManaged: false }, [operation({
    candidateReviews: [{ ...operation({}).candidateReviews[0]!, state: "edited" }],
    helperOutput: { ocrReview: { reviewActor: "llm" } },
  })]), { origin: "auto-helper", reviewer: "llm", change: "edited" });
});

test("manually drawn OCR is not classified as an unchanged Auto candidate", () => {
  assert.deepEqual(ocrStatusForEntity({ id: "ocr-1", legacyManaged: false }, [operation({
    helper: { id: "ocr-dedupe-preflight", version: "v1" },
    helperOutput: { entryPoint: "manual-create", ocrReview: { reviewActor: null } },
  })]), { origin: "manual", reviewer: "human", change: "not-applicable" });
});

test("split outputs are linked through resultEntityIds", () => {
  assert.deepEqual(ocrStatusForEntity({ id: "ocr-2", legacyManaged: false }, [operation({
    results: [{ type: "ocr", id: "ocr-2" }],
    candidateReviews: [{ ...operation({}).candidateReviews[0]!, state: "edited", resultEntityId: null, resultEntityIds: ["ocr-2"] }],
  })]), { origin: "auto-helper", reviewer: "human", change: "edited" });
});

test("later manual OCR edit marks the Auto result changed", () => {
  assert.deepEqual(ocrStatusForEntity({ id: "ocr-1", legacyManaged: false }, [operation({}), operation({
    id: "op-2", operationType: "edit_ocr", result: { type: "ocr", id: "ocr-1" },
    helper: { id: "manual-graph-editor", version: "v1" }, candidateReviews: [],
    previousEntitySnapshot: { transcription: "vibes" }, resultingEntitySnapshot: { transcription: "VIBES" },
    createdAt: "2026-01-02T00:00:00Z",
  })]), { origin: "auto-helper", reviewer: "human", change: "edited" });
});

test("a no-op save does not mark an Auto result changed", () => {
  assert.deepEqual(ocrStatusForEntity({ id: "ocr-1", legacyManaged: false }, [operation({}), operation({
    id: "op-2", operationType: "edit_ocr", result: { type: "ocr", id: "ocr-1" },
    helper: { id: "manual-graph-editor", version: "v1" }, candidateReviews: [],
    previousEntitySnapshot: { transcription: "vibes", updated_at: "2026-01-01" },
    resultingEntitySnapshot: { transcription: "vibes", updated_at: "2026-01-02" },
    createdAt: "2026-01-02T00:00:00Z",
  })]), { origin: "auto-helper", reviewer: "human", change: "unchanged" });
});

test("missing lineage and legacy OCR remain unknown", () => {
  assert.deepEqual(ocrStatusForEntity({ id: "ocr-1", legacyManaged: true }, [operation({})]),
    { origin: "unknown", reviewer: "unknown", change: "unknown" });
  assert.deepEqual(ocrStatusForEntity({ id: "ocr-1", legacyManaged: false }, []),
    { origin: "unknown", reviewer: "unknown", change: "unknown" });
});
