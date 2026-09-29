import assert from "node:assert/strict";
import test from "node:test";
import { moveQuadCorner, rectangleQuad, visualRegionOverlapRatio } from "./quadGeometry.ts";
import { cylindricalRectification, inverseQuadUnitPoint, mapQuadUnitPoint, setCylindricalCurvature, setCylindricalHorizontalScale, updateCylindricalGuide } from "./labelRectification.ts";

test("moving one OCR/label corner derives a new enclosing bbox", () => {
  const initial = rectangleQuad({ x: 0.2, y: 0.2, width: 0.4, height: 0.3 });
  const changed = moveQuadCorner(initial, 1, { x: 0.7, y: 0.1 });
  assert.ok(changed);
  assert.equal(changed.bbox.x, 0.2);
  assert.equal(changed.bbox.y, 0.1);
  assert.ok(Math.abs(changed.bbox.width - 0.5) < 1e-12);
  assert.ok(Math.abs(changed.bbox.height - 0.4) < 1e-12);
});

test("corner dragging cannot create a concave or self-intersecting quad", () => {
  const initial = rectangleQuad({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
  assert.equal(moveQuadCorner(initial, 1, { x: 0.2, y: 0.8 }), null);
});

test("visual-region overlap catches a nearly contained duplicate", () => {
  const existing = rectangleQuad({ x: 10, y: 10, width: 100, height: 100 });
  const redraw = rectangleQuad({ x: 15, y: 20, width: 80, height: 75 });
  assert.equal(visualRegionOverlapRatio(existing, redraw), 1);
});

test("visual-region overlap ignores a small incidental intersection", () => {
  const existing = rectangleQuad({ x: 10, y: 10, width: 100, height: 100 });
  const separate = rectangleQuad({ x: 100, y: 100, width: 100, height: 100 });
  assert.equal(visualRegionOverlapRatio(existing, separate), 0.01);
});

test("Label cylindrical guide coordinates round-trip through a perspective quad", () => {
  const quad = rectangleQuad({ x: 100, y: 50, width: 320, height: 640 });
  const source = mapQuadUnitPoint(quad.points, 0.37, 0.62);
  const normalized = inverseQuadUnitPoint(quad.points, source);
  assert.ok(Math.abs(normalized.x - 0.37) < 1e-6);
  assert.ok(Math.abs(normalized.y - 0.62) < 1e-6);
});

test("editing a Label cylindrical guide rebuilds the persisted transform", () => {
  const initial = cylindricalRectification();
  if (initial.type !== "guided-cylindrical") throw new Error("Expected cylindrical rectification");
  const changed = updateCylindricalGuide(initial, { guide: "horizontalGuides", rowIndex: 1, pointIndex: 2 }, { x: 0.5, y: 0.44 });
  if (changed.type !== "guided-cylindrical") throw new Error("Expected cylindrical rectification");
  assert.equal(changed.guides.horizontalGuides[1]![2]!.y, 0.44);
  assert.notEqual(changed.transform.curvature, initial.transform.curvature);
  assert.equal(initial.guides.horizontalGuides[1]![2]!.y, 0.5);
});

test("cylindrical sliders move every row with deterministic semantic controls", () => {
  const initial = cylindricalRectification();
  if (initial.type !== "guided-cylindrical") throw new Error("Expected cylindrical rectification");
  const curved = setCylindricalCurvature(initial, -0.08);
  if (curved.type !== "guided-cylindrical") throw new Error("Expected cylindrical rectification");
  assert.ok(Math.abs(curved.controls.signedCurvature + 0.08) < 1e-9);
  for (const row of curved.guides.horizontalGuides) assert.ok(Math.abs(row[2]!.y - (row[0]!.y + row[4]!.y) / 2 + 0.08) < 1e-9);
  const widened = setCylindricalHorizontalScale(curved, 1.2);
  if (widened.type !== "guided-cylindrical") throw new Error("Expected cylindrical rectification");
  assert.ok(Math.abs(widened.controls.horizontalScale - 1.2) < 1e-9);
  assert.ok(Math.abs(widened.guides.horizontalGuides[0]![0]!.x + 0.1) < 1e-9);
  assert.ok(Math.abs(widened.guides.horizontalGuides[0]![4]!.x - 1.1) < 1e-9);
});

test("guide handles can move into the bounded control margin outside the Label quad", () => {
  const initial = cylindricalRectification();
  if (initial.type !== "guided-cylindrical") throw new Error("Expected cylindrical rectification");
  const changed = updateCylindricalGuide(initial, { guide: "horizontalGuides", rowIndex: 1, pointIndex: 0 }, { x: -0.18, y: 1.12 });
  if (changed.type !== "guided-cylindrical") throw new Error("Expected cylindrical rectification");
  assert.deepEqual(changed.guides.horizontalGuides[1]![0], { x: -0.18, y: 1.12 });
});
