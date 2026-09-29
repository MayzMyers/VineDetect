import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildCylindricalControls, buildCylindricalTransform, defaultCylindricalGuides, normalizeLabelRectification } from "../../shared/labelRectificationContract.js";
import type { QuadGeometry } from "../../shared/quadGeometry.js";
import { createRectifiedLabelCropBuffer, createRectifiedNormalizedQuadCropBuffer } from "./labelQuadCrop.js";

test("Label crop keeps corrected and uncorrected processing contours distinct", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "label-transform-mode-"));
  const sourcePath = path.join(directory, "source.png");
  try {
    await sharp({ create: { width: 120, height: 80, channels: 3, background: "white" } }).png().toFile(sourcePath);
    const geometry: QuadGeometry = {
      type: "quad" as const,
      points: [{ x: 25, y: 12 }, { x: 88, y: 18 }, { x: 96, y: 58 }, { x: 18, y: 62 }],
      bbox: { x: 18, y: 12, width: 78, height: 50 },
    };
    const source = await createRectifiedLabelCropBuffer(sourcePath, geometry.bbox, geometry, null);
    const perspective = await createRectifiedLabelCropBuffer(sourcePath, geometry.bbox, geometry, { type: "perspective", transform: { schemaVersion: 1, model: "quad-homography-v1" } });
    const cylindrical = await createRectifiedLabelCropBuffer(sourcePath, geometry.bbox, geometry, {
      type: "guided-cylindrical", guides: defaultCylindricalGuides(), transform: buildCylindricalTransform(defaultCylindricalGuides()),
    });
    assert.deepEqual({ width: source.width, height: source.height, mode: source.transformMode }, { width: 78, height: 50, mode: "source-bbox" });
    assert.equal(perspective.transformMode, "perspective");
    assert.equal(cylindrical.transformMode, "guided-cylindrical");
    assert.notDeepEqual({ width: perspective.width, height: perspective.height }, { width: source.width, height: source.height });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("guided cylindrical transform is deterministic and remains in normalized Label space", () => {
  const guides = defaultCylindricalGuides();
  guides.horizontalGuides[1]![2] = { x: 0.5, y: 0.42 };
  const transform = buildCylindricalTransform(guides);
  assert.equal(transform.model, "guided-grid-v1");
  assert.equal(transform.coordinateSpace, "label-perspective-normalized");
  assert.deepEqual(transform.columns, [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(transform.rows.length, 5);
  assert.equal(transform.rows[0]!.v, 0);
  assert.equal(transform.rows[transform.rows.length - 1]!.v, 1);
  assert.ok(transform.curvature > 0);
  for (const row of transform.rows) for (const point of row.points) {
    assert.ok(point.x >= 0 && point.x <= 1);
    assert.ok(point.y >= 0 && point.y <= 1);
  }
});

test("normalization rebuilds transform from reviewed guides instead of trusting stale client values", () => {
  const guides = defaultCylindricalGuides();
  const normalized = normalizeLabelRectification({
    type: "guided-cylindrical",
    guides,
    transform: { schemaVersion: 1, model: "guided-grid-v1", coordinateSpace: "label-perspective-normalized", columns: [0, 1], rows: [], curvature: 99, surfaceWidth: 99 },
  });
  assert.equal(normalized?.type, "guided-cylindrical");
  if (normalized?.type !== "guided-cylindrical") return;
  assert.deepEqual(normalized.transform.columns, [0, 0.25, 0.5, 0.75, 1]);
  assert.notEqual(normalized.transform.curvature, 99);
  assert.deepEqual(normalized.controls, buildCylindricalControls(guides));
});

test("normalization preserves bounded guide overscan and derives signed slider parameters", () => {
  const guides = defaultCylindricalGuides();
  guides.horizontalGuides.forEach((row) => { row[0]!.x = -0.15; row[4]!.x = 1.15; row[2]!.y -= 0.07; });
  const normalized = normalizeLabelRectification({ type: "guided-cylindrical", guides, controls: { signedCurvature: 99, horizontalScale: 99 }, transform: buildCylindricalTransform(guides) });
  assert.equal(normalized?.type, "guided-cylindrical");
  if (normalized?.type !== "guided-cylindrical") return;
  assert.equal(normalized.guides.horizontalGuides[0]![0]!.x, -0.15);
  assert.ok(Math.abs(normalized.controls!.signedCurvature + 0.07) < 1e-9);
  assert.ok(Math.abs(normalized.controls!.horizontalScale - 1.3) < 1e-9);
});

test("perspective rectification remains a distinct explicit Label transform", () => {
  assert.deepEqual(normalizeLabelRectification({ type: "perspective", homography: [1, 0, 0, 0, 1, 0, 0, 0, 1] }), {
    type: "perspective", transform: { schemaVersion: 1, model: "quad-homography-v1" },
  });
});

test("OCR region crop rectifies the free quad instead of extracting its enclosing bbox", async () => {
  const source = await sharp({ create: { width: 200, height: 120, channels: 3, background: "white" } }).png().toBuffer();
  const crop = await createRectifiedNormalizedQuadCropBuffer(source, 200, 120, {
    type: "quad",
    points: [{ x: .2, y: .2 }, { x: .7, y: .25 }, { x: .8, y: .75 }, { x: .1, y: .7 }],
    bbox: { x: .1, y: .2, width: .7, height: .55 },
  });
  assert.equal(crop.width, 120);
  assert.equal(crop.height, 63);
  assert.notEqual(crop.width, 140);
  const metadata = await sharp(crop.buffer).metadata();
  assert.equal(metadata.width, crop.width);
  assert.equal(metadata.height, crop.height);
});
