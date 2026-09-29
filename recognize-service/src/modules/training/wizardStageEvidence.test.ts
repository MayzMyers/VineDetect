import assert from "node:assert/strict";
import test from "node:test";
import {
  ocrStageAutoOutput,
  ocrStageInput,
  ocrStageParams,
  ocrStageReviewedOutput,
  summaryStageInput,
  summaryStageOutput,
} from "../../shared/wizardStageEvidence.js";

test("OCR stage evidence keeps actual crop, passes and reviewed regions separate", () => {
  const snapshot = {
    crop: { id: "crop-1", bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.7 }, geometry: { type: "quad", points: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.8 }, { x: 0.1, y: 0.8 }], bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.7 } }, width: 400, height: 200, assetPath: "crop.png" },
    ocr: {
      id: "run-1", executionMode: "backend", engine: "tesseract", engineVersion: "7",
      rawText: "AUTO", normalizedText: "auto", confidence: 70, status: "completed",
      evidence: { profileVersion: "cascade-v1", passes: [{ id: "p1", stage: "cheap", psm: 6, ignored: true }] },
    },
    regions: [{ id: "auto-region", rawText: "AUTO" }],
  };
  assert.deepEqual(ocrStageInput(snapshot), {
    cropId: "crop-1", bbox: snapshot.crop.bbox, geometry: snapshot.crop.geometry, width: 400, height: 200, assetPath: "crop.png",
  });
  assert.deepEqual(ocrStageParams(snapshot), {
    profileVersion: "cascade-v1", engine: "tesseract", engineVersion: "7",
    passes: [{ id: "p1", stage: "cheap", psm: 6 }],
  });
  assert.equal((ocrStageAutoOutput(snapshot).regions as unknown[]).length, 1);
  const reviewed = ocrStageReviewedOutput(snapshot, {
    id: "review-1", revision: 2, status: "reviewed", regions: [{ id: "human-region", text: "TEXT" }],
    compositions: [{ id: "string-1", memberIds: ["word-1", "word-2"] }],
    reviewOperations: [{ id: "op-1", type: "compose_string" }],
  });
  assert.equal(reviewed.reviewId, "review-1");
  assert.deepEqual(reviewed.regions, [{ id: "human-region", text: "TEXT" }]);
  assert.deepEqual(reviewed.compositions, [{ id: "string-1", memberIds: ["word-1", "word-2"] }]);
  assert.deepEqual(reviewed.reviewOperations, [{ id: "op-1", type: "compose_string" }]);
});

test("Summary evidence excludes volatile computedAt while retaining its input identity", () => {
  assert.deepEqual(summaryStageInput({
    labelAnnotationId: "label-1", labelRevision: 2, analysisJobId: "job-1",
    ocrRegionAnnotationSetId: "ocr-review-1", cvWorkflowUpdatedAt: "time", ignored: true,
  }), {
    labelAnnotationId: "label-1", labelRevision: 2, analysisJobId: "job-1",
    ocrRegionAnnotationSetId: "ocr-review-1", cvWorkflowUpdatedAt: "time",
  });
  assert.deepEqual(summaryStageOutput({ schemaVersion: 1, computedAt: "volatile", contourCount: 3 }), {
    schemaVersion: 1, contourCount: 3,
  });
});
