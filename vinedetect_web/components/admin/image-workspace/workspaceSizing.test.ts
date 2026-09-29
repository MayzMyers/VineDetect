import assert from "node:assert/strict";
import test from "node:test";
import { containedCanvasSize } from "./workspaceSizing.ts";

test("a tall catalog image is contained by both host width and viewport height", () => {
  const size = containedCanvasSize(620, 700, 3000, 900);
  assert.equal(size.height, 680);
  assert.equal(size.width, 159);
});

test("a landscape image still uses the available host width", () => {
  const size = containedCanvasSize(620, 1200, 600, 900);
  assert.deepEqual(size, { width: 620, height: 310 });
});
