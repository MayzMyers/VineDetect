import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { estimateLabelCylindricalGuides } from "./labelRectificationHelper.js";

const OPTIONS = {
  previewMaxSide: 640,
  minCylindricalConfidence: 0.4,
  minCylindricalCurvature: 0.006,
  maxCylindricalCurvature: 0.12,
};

test("cylindrical estimator recognizes repeated curved horizontal evidence", async () => {
  const image = await linePattern(320, 420, 11);
  const result = await estimateLabelCylindricalGuides(image, OPTIONS);
  assert.ok(result);
  assert.ok(result.evidenceRows >= 2);
  assert.ok(result.signedCurvature > 0.015);
  assert.equal(result.guides.horizontalGuides.length, 3);
  assert.ok(result.guides.horizontalGuides[1]![2]!.y > result.guides.horizontalGuides[1]![0]!.y);
});

test("cylindrical estimator does not invent curvature for straight rows", async () => {
  const image = await linePattern(320, 420, 0);
  assert.equal(await estimateLabelCylindricalGuides(image, OPTIONS), null);
});

async function linePattern(width: number, height: number, amplitude: number) {
  const pixels = Buffer.alloc(width * height, 245);
  for (const baseline of [70, 135, 205, 285, 350]) {
    for (let x = 10; x < width - 10; x += 1) {
      const u = x / (width - 1);
      const y = Math.round(baseline + amplitude * 4 * u * (1 - u));
      for (let thickness = -1; thickness <= 1; thickness += 1) pixels[(y + thickness) * width + x] = 20;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
}
