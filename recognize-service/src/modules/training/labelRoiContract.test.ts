import assert from "node:assert/strict";
import test from "node:test";
import { labelAnnotationSchema } from "../metadata/metadata.schemas.js";

const roi = { x: 10, y: 20, width: 300, height: 400 };

test("label ROI review keeps immutable prediction and separate human annotation", () => {
  const parsed = labelAnnotationSchema.parse({
    schemaVersion: 2,
    prediction: {
      helperRunId: "93fcb6b8-bbe7-4a28-a571-2041bb574153",
      candidateId: "label-region-1",
      roi,
      confidence: 0.84,
      algorithm: { id: "label-canny-v1", version: "1", params: { low: 40, high: 100 } },
    },
    annotation: { roi: { ...roi, x: 12 } },
    status: "reviewed",
    reviewed: false,
    source: "manual",
  });

  assert.deepEqual(parsed.prediction?.roi, roi);
  assert.equal(parsed.prediction?.helperRunId, "93fcb6b8-bbe7-4a28-a571-2041bb574153");
  assert.equal(parsed.prediction?.candidateId, "label-region-1");
  assert.equal(parsed.annotation?.roi.x, 12);
  assert.equal("reviewed" in parsed, false, "derived UI/API flags are not accepted as persisted input");
  assert.equal("source" in parsed, false, "ROI source must be computed from prediction and annotation");
});

test("reviewed label ROI requires a human annotation", () => {
  assert.throws(() => labelAnnotationSchema.parse({
    schemaVersion: 2,
    prediction: { roi, algorithm: { id: "label-canny-v1" } },
    annotation: null,
    status: "reviewed",
  }));
});

test("no-label does not masquerade as a label ROI annotation", () => {
  assert.throws(() => labelAnnotationSchema.parse({
    schemaVersion: 2,
    prediction: null,
    annotation: { roi },
    status: "no-label",
  }));
});
