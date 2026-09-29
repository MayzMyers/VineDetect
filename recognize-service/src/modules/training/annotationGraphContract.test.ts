import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { z } from "zod";
import { createGraphOcrSchema, createGraphPackageSchema, manualOcrDedupePreflightSchema, parseGraphEntityUpdate, reparentGraphOcrSchema, reviewAutoOcrActionsSchema, reviewAutoOcrSchema, reviewGraphLabelCandidatesSchema, runAutoOcrSchema, updateGraphEntitySchema } from "../metadata/metadata.schemas.js";

const quad = {
  type: "quad" as const,
  points: [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 5 }, { x: 1, y: 5 }] as const,
  bbox: { x: 1, y: 1, width: 8, height: 4 },
};
const layout = { type: "string" as const, flow: "linear" as const, baselineAngleDeg: 0, baseline: null, characterOrientation: "upright" as const };
const labelId = "4c4a73b7-291d-4a17-bc4a-7e57ca245257";
const labelSpace = { type: "label-rectified" as const, units: "normalized" as const, labelId, cropRevision: 3, width: 640, height: 320 };

test("Label candidate review accepts explicit merge groups only for retained candidates", () => {
  const operation = { helperId: "label-helper", reviewMode: "accepted" as const, candidates: [
    { id: "candidate-a", payload: { bbox: quad.bbox } }, { id: "candidate-b", payload: { bbox: quad.bbox } },
  ] };
  assert.equal(reviewGraphLabelCandidatesSchema.safeParse({ operation, reviews: [
    { candidateId: "candidate-a", state: "accepted", geometry: quad, mergeGroupId: "manual-1" },
    { candidateId: "candidate-b", state: "accepted", geometry: quad, mergeGroupId: "manual-1" },
  ], mergeReviews: [{ candidateIds: ["candidate-a", "candidate-b"], geometry: quad }] }).success, true);
  assert.equal(reviewGraphLabelCandidatesSchema.safeParse({ operation, reviews: [
    { candidateId: "candidate-a", state: "rejected", mergeGroupId: "manual-1" },
    { candidateId: "candidate-b", state: "accepted", geometry: quad },
  ] }).success, false);
  assert.equal(reviewGraphLabelCandidatesSchema.safeParse({ operation, reviews: [
    { candidateId: "candidate-a", state: "accepted", geometry: quad },
    { candidateId: "candidate-b", state: "accepted", geometry: quad },
  ], mergeReviews: [{ candidateIds: ["candidate-a", "unknown"], geometry: quad }] }).success, false);
});

test("annotation graph helper selection must reference a candidate from the same operation", () => {
  const result = createGraphPackageSchema.safeParse({
    geometry: quad,
    operation: {
      helperId: "package-helper",
      candidates: [{ id: "candidate-a", payload: { geometry: quad } }],
      selectedCandidateId: "candidate-b",
      reviewMode: "accepted",
    },
  });
  assert.equal(result.success, false);
});

test("annotation graph OCR keeps text detection separate from verified transcription", () => {
  assert.equal(createGraphOcrSchema.safeParse({
    geometry: quad, coordinateSpace: labelSpace, regionStatus: "reviewed", transcription: { text: null, status: "unreadable" }, layout,
    operation: { helperId: "manual", reviewMode: "manual" },
  }).success, true);
  assert.equal(createGraphOcrSchema.safeParse({
    geometry: quad, coordinateSpace: labelSpace, regionStatus: "reviewed", transcription: { text: "guess", status: "unreadable" }, layout,
    operation: { helperId: "manual", reviewMode: "manual" },
  }).success, false);
  assert.equal(createGraphOcrSchema.safeParse({
    geometry: quad, coordinateSpace: labelSpace, regionStatus: "reviewed", transcription: { text: "MERLOT", status: "verified" }, layout,
    operation: { helperId: "ocr", reviewMode: "edited" },
  }).success, true);
  assert.equal(createGraphOcrSchema.safeParse({
    geometry: quad, coordinateSpace: labelSpace, regionStatus: "reviewed", transcription: { text: "КАБЕРНЕ-???", status: "partial" }, layout,
    operation: { helperId: "manual", reviewMode: "edited" },
  }).success, true);
});

test("Fastify validation preserves null for unreadable OCR transcription", () => {
  const body = {
    parent: { type: "label", id: labelId },
    geometry: structuredClone(quad),
    coordinateSpace: structuredClone(labelSpace),
    regionStatus: "reviewed",
    transcription: { text: null, status: "unreadable" },
    layout: structuredClone(layout),
    rectification: null,
  };
  const jsonSchema = z.toJSONSchema(manualOcrDedupePreflightSchema, { target: "draft-7" }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  const AjvConstructor = Ajv as unknown as new (options: Record<string, unknown>) => { compile: (schema: Record<string, unknown>) => ((value: unknown) => boolean) & { errors?: unknown } };
  const validate = new AjvConstructor({ coerceTypes: "array", removeAdditional: true, strict: false }).compile(jsonSchema);
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
  assert.equal(body.transcription.text, null);
  assert.equal(manualOcrDedupePreflightSchema.safeParse(body).success, true);
});

test("annotation graph OCR requires an explicit coordinate space", () => {
  assert.equal(createGraphOcrSchema.safeParse({
    geometry: quad, regionStatus: "reviewed", transcription: { text: null, status: "unreadable" }, layout,
    operation: { helperId: "manual", reviewMode: "manual" },
  }).success, false);
});

test("OCR rectification is independent from detection geometry", () => {
  const parsed = createGraphOcrSchema.safeParse({
    geometry: quad, coordinateSpace: labelSpace, regionStatus: "reviewed",
    transcription: { text: "MERLOT", status: "verified" }, layout: { ...layout, baselineAngleDeg: 23 },
    rectification: { type: "rotation", angleDeg: -23 }, operation: { helperId: "manual", reviewMode: "edited" },
  });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.deepEqual(parsed.data.geometry, quad);
  assert.equal(createGraphOcrSchema.safeParse({
    geometry: quad, coordinateSpace: labelSpace, regionStatus: "reviewed",
    transcription: { text: "ARC", status: "verified" },
    layout: { ...layout, flow: "curved", baseline: null, characterOrientation: "tangent-aligned" },
    operation: { helperId: "manual", reviewMode: "manual" },
  }).success, false);
});

test("annotation graph edit requires a changed entity field in addition to provenance", () => {
  assert.equal(updateGraphEntitySchema.safeParse({ operation: { helperId: "manual", reviewMode: "manual" } }).success, false);
  assert.equal(updateGraphEntitySchema.safeParse({ note: "review note", operation: { helperId: "manual", reviewMode: "manual" } }).success, true);
  assert.equal(updateGraphEntitySchema.safeParse({ packageType: { value: "tube", status: "reviewed", source: "human" }, operation: { helperId: "manual", reviewMode: "edited" } }).success, true);
});

test("generic entity PATCH does not strip guided Label rectification before entity-specific validation", () => {
  const rectification = {
    type: "guided-cylindrical" as const,
    guides: {
      centerLine: [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }],
      leftBoundary: [{ x: 0, y: 0 }, { x: 0, y: 1 }],
      rightBoundary: [{ x: 1, y: 0 }, { x: 1, y: 1 }],
      horizontalGuides: [
        [{ x: 0, y: 0 }, { x: 1, y: 0 }],
        [{ x: 0, y: 1 }, { x: 1, y: 1 }],
      ],
    },
    transform: {
      schemaVersion: 1 as const, model: "guided-grid-v1" as const, coordinateSpace: "label-perspective-normalized" as const,
      columns: [0, 1], rows: [
        { v: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
        { v: 1, points: [{ x: 0, y: 1 }, { x: 1, y: 1 }] },
      ], curvature: 0.01, surfaceWidth: 1,
    },
  };
  const body = { rectification: structuredClone(rectification), operation: { helperId: "label-rectification", reviewMode: "accepted" } };
  const jsonSchema = z.toJSONSchema(updateGraphEntitySchema, { target: "draft-7" }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  const AjvConstructor = Ajv as unknown as new (options: Record<string, unknown>) => { compile: (schema: Record<string, unknown>) => ((value: unknown) => boolean) & { errors?: unknown } };
  const validate = new AjvConstructor({ removeAdditional: true, strict: false }).compile(jsonSchema);
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
  assert.deepEqual(body.rectification, rectification);
  assert.deepEqual(parseGraphEntityUpdate("label", body).rectification, rectification);
  assert.throws(() => parseGraphEntityUpdate("ocr", body));
});

test("Label-scoped Auto OCR persists one reviewed VisualRegion parent", () => {
  const packageId = "122ad6f4-f466-4dc3-bf78-cfb37e941dae";
  const operationId = "2c132ba1-62fb-46aa-8775-f2dd58ddcc64";
  assert.equal(runAutoOcrSchema.safeParse({ scope: { type: "label", id: labelId }, config: {} }).success, true);
  assert.equal(runAutoOcrSchema.safeParse({ scope: { type: "package", id: packageId }, config: {} }).success, false);
  assert.equal(reviewAutoOcrSchema.safeParse({ operationId, reviews: [
    { candidateId: "candidate-1", state: "accepted", finalParent: { type: "label", packageId, labelId }, transcription: { text: "MERLOT", status: "verified" }, regionStatus: "reviewed", layout },
    { candidateId: "candidate-2", state: "rejected" },
  ] }).success, true);
  assert.equal(reviewAutoOcrSchema.safeParse({ operationId, reviews: [
    { candidateId: "candidate-1", state: "accepted", transcription: { text: "MERLOT", status: "verified" }, regionStatus: "reviewed", layout },
  ] }).success, false);
  assert.equal(reviewAutoOcrSchema.safeParse({ operationId, reviews: [
    { candidateId: "candidate-1", state: "merged", resultEntityId: labelId },
  ] }).success, true);
  assert.equal(reviewAutoOcrSchema.safeParse({ operationId, reviews: [
    { candidateId: "candidate-1", state: "merged" },
  ] }).success, false);
  const splitOutputs = ["op-1:1", "op-1:2"].map((sourceOperationId) => ({
    geometry: quad,
    regionStatus: "reviewed" as const,
    transcription: { text: null, status: "unreadable" as const },
    layout,
    rectification: null,
    confidence: null,
    sourceOperationId,
  }));
  assert.equal(reviewAutoOcrSchema.safeParse({ operationId, reviews: [
    { candidateId: "candidate-1", state: "edited", finalParent: { type: "label", packageId, labelId }, splitOutputs },
  ] }).success, true);
  assert.equal(reviewAutoOcrSchema.safeParse({ operationId, reviews: [
    { candidateId: "candidate-1", state: "accepted", finalParent: { type: "label", packageId, labelId }, splitOutputs },
  ] }).success, false);
  assert.equal(reviewAutoOcrSchema.safeParse({ operationId, reviews: [
    { candidateId: "candidate-1", state: "edited", finalParent: { type: "label", packageId, labelId }, geometry: quad, splitOutputs },
  ] }).success, false);
  assert.equal(reviewAutoOcrSchema.safeParse({ operationId, reviews: [
    { candidateId: "candidate-1", state: "accepted", finalParent: { type: "label", packageId, labelId }, sourceOperationId: "ocr-1" },
    { candidateId: "candidate-2", state: "accepted", finalParent: { type: "label", packageId, labelId }, sourceOperationId: "ocr-2" },
  ], compositions: [{ sourceOperationId: "op-3", memberSourceOperationIds: ["ocr-1", "ocr-2"], text: "MERLOT 2022", transcriptionStatus: "verified", sortOrder: 0 }] }).success, true);
  assert.equal(reviewAutoOcrSchema.safeParse({ operationId, reviews: [
    { candidateId: "candidate-1", state: "accepted", finalParent: { type: "label", packageId, labelId }, sourceOperationId: "ocr-1" },
  ], compositions: [{ sourceOperationId: "op-3", memberSourceOperationIds: ["ocr-1", "ocr-1"], text: null, transcriptionStatus: "unreadable", sortOrder: 0 }] }).success, false);
});

test("manual OCR dedupe and parent review are explicit independent contracts", () => {
  const packageId = "122ad6f4-f466-4dc3-bf78-cfb37e941dae";
  assert.equal(manualOcrDedupePreflightSchema.safeParse({
    parent: { type: "label", id: labelId }, geometry: quad,
    coordinateSpace: labelSpace, regionStatus: "reviewed", transcription: { text: "MERLOT", status: "verified" }, layout,
  }).success, true);
  assert.equal(manualOcrDedupePreflightSchema.safeParse({
    parent: { type: "package", id: packageId }, geometry: quad, coordinateSpace: labelSpace,
    regionStatus: "reviewed", transcription: { text: "MERLOT", status: "verified" }, layout,
  }).success, false);
  assert.equal(reparentGraphOcrSchema.safeParse({
    target: { type: "label", id: labelId }, operation: { helperId: "manual-graph-editor", reviewMode: "edited" },
  }).success, true);
});

test("human OCR review sends Edit Engine actions instead of calculated candidate states", () => {
  const operationId = "2c132ba1-62fb-46aa-8775-f2dd58ddcc64";
  const base = { adjustment: null, geometry: null, layout: null, rectification: null, text: null, transcriptionStatus: null, split: null, composition: null };
  const parsed = reviewAutoOcrActionsSchema.parse({ operationId, editOperations: [
    { ...base, operationId: "human-op-1", type: "edit_region", inputIds: ["ocr-1"], geometry: quad, layout },
    { ...base, operationId: "human-op-2", type: "edit_text", inputIds: ["human-op-1"], text: "VIBES", transcriptionStatus: "verified" },
    { ...base, operationId: "human-op-3", type: "approve_region", inputIds: ["human-op-2"] },
  ], reuseExisting: [] });
  assert.deepEqual(parsed.editOperations.map((operation) => operation.type), ["edit_region", "edit_text", "approve_region"]);
  assert.equal("reviews" in parsed, false);
  assert.equal(reviewAutoOcrActionsSchema.safeParse({ operationId, editOperations: [
    { ...base, operationId: "human-op-1", type: "edit_text", inputIds: ["ocr-1"], text: null, transcriptionStatus: "verified" },
  ], reuseExisting: [] }).success, false);
});
