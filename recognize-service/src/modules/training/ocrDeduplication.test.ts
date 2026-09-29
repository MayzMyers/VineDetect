import assert from "node:assert/strict";
import test from "node:test";
import { findDuplicateMatches, type DeduplicationConfig } from "../ocr/ocrAnnotationService.js";
import type { QuadGeometry } from "../../shared/quadGeometry.js";

const config: DeduplicationConfig = {
  geometryWeight: 0.55,
  textWeight: 0.45,
  possibleThreshold: 0.5,
  probableThreshold: 0.8,
  overlapThreshold: 0.45,
  minimumGeometryScore: 0.3,
  normalizeConfusions: true,
  maxMatches: 5,
};

function quad(x: number, y: number, width: number, height: number): QuadGeometry {
  return { type: "quad", points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], bbox: { x, y, width, height } };
}

test("dedupe treats a slightly wider OCR observation with normalized text as probable duplicate", () => {
  const existingGeometry = quad(105, 102, 190, 36);
  const matches = findDuplicateMatches(quad(100, 100, 200, 40), "CHATEAU PlNOT", [{
    id: "ocr-17", text: "CHATEAU PINOT", regionStatus: "reviewed", transcriptionStatus: "verified", labelId: "label-1",
    geometry: existingGeometry, sourceGeometry: existingGeometry,
  }], config);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.existingOcrId, "ocr-17");
  assert.equal(matches[0]?.classification, "probable_duplicate");
  assert.ok((matches[0]?.geometryScore ?? 0) > 0.8);
  assert.ok((matches[0]?.textScore ?? 0) > 0.9);
});

test("geometry-only overlap stays reviewable and never becomes an automatic merge", () => {
  const existingGeometry = quad(100, 100, 200, 40);
  const matches = findDuplicateMatches(quad(105, 102, 190, 36), "", [{
    id: "ocr-17", text: "", regionStatus: "reviewed", transcriptionStatus: "unreadable", labelId: null,
    geometry: existingGeometry, sourceGeometry: existingGeometry,
  }], config);
  assert.equal(matches[0]?.classification, "possible_duplicate");
  assert.equal(matches[0]?.textScore, null);
});

test("same text without spatial proximity is not a duplicate", () => {
  const existingGeometry = quad(500, 500, 200, 40);
  const matches = findDuplicateMatches(quad(10, 10, 200, 40), "MERLOT", [{
    id: "ocr-17", text: "MERLOT", regionStatus: "reviewed", transcriptionStatus: "verified", labelId: null,
    geometry: existingGeometry, sourceGeometry: existingGeometry,
  }], config);
  assert.deepEqual(matches, []);
});
