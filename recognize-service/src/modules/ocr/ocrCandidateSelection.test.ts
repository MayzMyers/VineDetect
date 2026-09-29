import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOcrConfidence, selectReviewableOcrRegions } from "./ocrAnnotationService.js";
import type { OcrConsensusRegion } from "./standardOcr.js";

function region(overrides: Partial<OcrConsensusRegion>): OcrConsensusRegion {
  return {
    key: "candidate",
    parentKey: null,
    level: "word",
    bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.08 },
    rawText: "noise",
    normalizedText: "noise",
    confidence: 25,
    support: 1,
    passIds: ["pass-1"],
    observationIds: ["observation-1"],
    validityScore: 0.45,
    textConsensus: 0.4,
    spatialConsensus: 0.4,
    consensus: 0.4,
    semantic: { type: "unknown", confidence: 0.2, reasons: [] },
    textDirection: "right",
    glyphOrientation: "upright",
    ...overrides,
  };
}

test("OCR confidence accepts Tesseract percentages and canonical unit values", () => {
  assert.equal(normalizeOcrConfidence(80.38), 0.8038);
  assert.equal(normalizeOcrConfidence(0.8038), 0.8038);
  assert.equal(normalizeOcrConfidence(2600), 1);
});

test("review candidate pruning keeps VIBES-like strong text and removes weak cascade noise", () => {
  const strong = region({ key: "vibes", rawText: "VIBES", normalizedText: "VIBES", confidence: 80.38, validityScore: 0.76 });
  const weak = region({ key: "noise", rawText: "ix a", normalizedText: "ix a", confidence: 15, validityScore: 0.42 });
  const supported = region({ key: "vintage", rawText: "2021", normalizedText: "2021", confidence: 48, validityScore: 0.68, support: 3, consensus: 0.72 });

  assert.deepEqual(selectReviewableOcrRegions([weak, supported, strong]).map((item) => item.key), ["vibes", "vintage"]);
});
