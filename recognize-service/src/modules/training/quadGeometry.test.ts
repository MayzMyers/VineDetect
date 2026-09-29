import assert from "node:assert/strict";
import test from "node:test";
import { isValidConvexQuad, normalizeQuadGeometry, rectangleGeometry } from "../../shared/quadGeometry.js";

test("rectangle bbox becomes canonical clockwise quad", () => {
  assert.deepEqual(rectangleGeometry({ x: 10, y: 20, width: 30, height: 40 }), {
    type: "quad",
    points: [{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 60 }, { x: 10, y: 60 }],
    bbox: { x: 10, y: 20, width: 30, height: 40 },
  });
});

test("unordered perspective points normalize and derive enclosing bbox", () => {
  const geometry = normalizeQuadGeometry({ type: "quad", points: [{ x: 0.8, y: 0.9 }, { x: 0.1, y: 0.2 }, { x: 0.9, y: 0.1 }, { x: 0.2, y: 0.8 }] });
  assert.ok(geometry);
  assert.equal(isValidConvexQuad(geometry.points, { min: 0, max: 1 }), true);
  assert.deepEqual(geometry.bbox, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
});

test("self-intersecting or concave edits are rejected instead of persisted", () => {
  assert.equal(isValidConvexQuad([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }]), false);
  assert.equal(isValidConvexQuad([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.4, y: 0.4 }, { x: 0, y: 1 }]), false);
});
