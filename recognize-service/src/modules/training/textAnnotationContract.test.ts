import assert from "node:assert/strict";
import test from "node:test";
import { ocrRegionReviewSchema } from "../metadata/metadata.schemas.js";
import { deriveOcrReviewOperations } from "../../db/ocr.repository.js";

const bbox = { x: 0.1, y: 0.2, width: 0.3, height: 0.1 };

test("OCR review accepts separate prediction and partial human annotation", () => {
  const parsed = ocrRegionReviewSchema.parse({
    baseRevision: 0,
    ocrRunId: null,
    regions: [{
      sourceRegionIds: [],
      level: "word",
      prediction: { bbox, text: "COBMHbOH", confidence: 42 },
      annotation: { bbox, text: "СОВ...ОН", transcriptionStatus: "partial" },
      textDirection: "right",
      glyphOrientation: "upright",
    }],
  });
  assert.equal(parsed.regions[0]?.annotation.transcriptionStatus, "partial");
  assert.equal(parsed.regions[0]?.prediction?.text, "COBMHbOH");
});

test("OCR review rejects contradictory transcription ground truth", () => {
  const base = { baseRevision: 0, regions: [{ sourceRegionIds: [], level: "word", prediction: null, textDirection: "right", glyphOrientation: "upright" }] };
  assert.throws(() => ocrRegionReviewSchema.parse({ ...base, regions: [{ ...base.regions[0], annotation: { bbox, text: null, transcriptionStatus: "verified" } }] }));
  assert.throws(() => ocrRegionReviewSchema.parse({ ...base, regions: [{ ...base.regions[0], annotation: { bbox, text: "guess", transcriptionStatus: "unreadable" } }] }));
});

test("OCR review keeps semantic string composition separate from physical regions", () => {
  const parsed = ocrRegionReviewSchema.parse({
    baseRevision: 0,
    regions: ["CABERNET", "SAUVIGNON"].map((text, index) => ({
      clientId: `word-${index + 1}`,
      sourceRegionIds: [], level: "word", prediction: null,
      annotation: { bbox: { ...bbox, x: bbox.x + index * 0.3 }, text, transcriptionStatus: "verified" },
      textDirection: "right", glyphOrientation: "upright",
    })),
    compositions: [{
      clientId: "string-1", kind: "string", memberClientIds: ["word-1", "word-2"],
      text: "CABERNET SAUVIGNON", transcriptionStatus: "verified",
    }],
  });
  assert.equal(parsed.regions.length, 2);
  assert.deepEqual(parsed.compositions[0]?.memberClientIds, ["word-1", "word-2"]);
});

test("OCR review trace distinguishes physical merge from semantic composition", () => {
  const region = {
    id: "reviewed-1", sourceRegionIds: ["auto-1", "auto-2"], bboxEdited: false, textEdited: false,
    transcriptionStatus: "verified",
  } as any;
  const operations = deriveOcrReviewOperations([region], ["auto-1", "auto-2"], [{
    id: "string-1", kind: "string", memberIds: ["reviewed-1", "reviewed-2"], text: "A B",
    transcriptionStatus: "verified", sortOrder: 0,
  }]);
  assert.deepEqual(operations.map((operation) => operation.type), ["merge_region", "compose_string"]);
  assert.deepEqual(operations[0]?.inputIds, ["auto-1", "auto-2"]);
  assert.deepEqual(operations[1]?.inputIds, ["reviewed-1", "reviewed-2"]);
});
