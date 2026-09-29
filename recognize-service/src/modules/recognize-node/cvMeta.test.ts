import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { autoOrientedDimensions, extractCvMetaFromFile, normalizeExtractRect } from "./cvMeta.js";

test("extract crop clips recoverable rounding and border overflow", () => {
  assert.deepEqual(normalizeExtractRect({ x: 242.8, y: 608.7, width: 431.6, height: 961.8 }, 674, 1570), {
    left: 242, top: 608, width: 432, height: 962,
  });
  assert.deepEqual(normalizeExtractRect({ x: -0.4, y: 10, width: 20, height: 30 }, 100, 100), {
    left: 0, top: 10, width: 20, height: 30,
  });
});

test("extract crop rejects empty and non-intersecting areas", () => {
  assert.throws(() => normalizeExtractRect({ x: 10, y: 10, width: 0, height: 10 }, 100, 100), /must be positive/);
  assert.throws(() => normalizeExtractRect({ x: 100, y: 10, width: 5, height: 10 }, 100, 100), /does not intersect/);
  assert.throws(() => normalizeExtractRect({ x: Number.NaN, y: 0, width: 1, height: 1 }, 100, 100), /must be finite/);
});

test("EXIF orientations with transposed axes use post-rotation dimensions", () => {
  assert.deepEqual(autoOrientedDimensions(600, 1200, 6), { width: 1200, height: 600 });
  assert.deepEqual(autoOrientedDimensions(600, 1200, 1), { width: 600, height: 1200 });
});

test("main-label ranking prefers the containing label over neck and salient inner artwork", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cv-meta-main-label-"));
  const imagePath = path.join(directory, "bottle.png");
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="1400">
      <rect width="800" height="1400" fill="#fff"/>
      <path d="M310 70h180v250c0 45 125 125 125 285v690c0 35-25 55-55 55H240c-30 0-55-20-55-55V605c0-160 125-240 125-285z" fill="#17221b"/>
      <rect x="315" y="95" width="170" height="205" rx="12" fill="#d8ad32"/>
      <path d="M305 110h190v55H305z M335 190h130v45H335z" fill="#fff2b0"/>
      <rect x="220" y="700" width="360" height="390" rx="12" fill="#eee4c9" stroke="#b7a67c" stroke-width="10"/>
      <rect x="275" y="765" width="250" height="180" rx="8" fill="#a51e32"/>
      <path d="M305 900l95-115 95 115-95-48z" fill="#f4d15f" stroke="#35121a" stroke-width="12"/>
      <text x="400" y="1025" text-anchor="middle" font-family="Arial" font-size="58" font-weight="bold" fill="#231b17">MERLOT</text>
    </svg>
  `);
  try {
    await sharp(svg).png().toFile(imagePath);
    const meta = await extractCvMetaFromFile(imagePath, "synthetic-main-label");
    const roi = meta.label?.roi as { x: number; y: number; width: number; height: number } | null | undefined;
    assert.ok(roi, "expected a detected label ROI");
    assert.ok(roi.width >= 0.35, `expected main-label width, got ${JSON.stringify(roi)}`);
    assert.ok(roi.height >= 0.18, `expected main-label height, got ${JSON.stringify(roi)}`);
    assert.ok(roi.y >= 0.38, `neck/capsule won ranking: ${JSON.stringify(roi)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
