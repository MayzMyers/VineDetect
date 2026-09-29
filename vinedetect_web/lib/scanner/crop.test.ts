import assert from "node:assert/strict";
import test from "node:test";
import { projectRectToObjectCover } from "./crop.ts";

test("projects source ROI into a taller object-cover viewport", () => {
  assert.deepEqual(
    projectRectToObjectCover(
      { x: 160, y: 340, width: 680, height: 340 },
      1000,
      1000,
      500,
      1000
    ),
    { x: -90, y: 340, width: 680, height: 340 }
  );
});

test("keeps proportional ROI when source and viewport aspect ratios match", () => {
  assert.deepEqual(
    projectRectToObjectCover(
      { x: 160, y: 340, width: 680, height: 340 },
      1000,
      1000,
      500,
      500
    ),
    { x: 80, y: 170, width: 340, height: 170 }
  );
});
