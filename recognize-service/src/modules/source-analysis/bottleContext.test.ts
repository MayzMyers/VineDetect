import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { runBottleContext, runPackageContext } from "./bottleContext.js";

test("package smart lasso proposes crops and distinguishes bottle from box", async () => {
  const directory = await mkdtemp(join(tmpdir(), "package-context-"));
  try {
    const bottlePath = join(directory, "bottle.png");
    const boxPath = join(directory, "box.png");
    await sharp(Buffer.from(`<svg width="300" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="300" height="600" fill="white"/><path d="M125 20h50v145c0 25 65 45 72 120v275q-97 32-194 0V285c7-75 72-95 72-120z" fill="#17352d"/></svg>`)).png().toFile(bottlePath);
    await sharp(Buffer.from(`<svg width="500" height="600" xmlns="http://www.w3.org/2000/svg"><rect width="500" height="600" fill="white"/><rect x="85" y="45" width="330" height="510" rx="4" fill="#5c2637"/></svg>`)).png().toFile(boxPath);

    const bottle = await runPackageContext(bottlePath, 300, 600, { previewMaxSize: 600 });
    const box = await runPackageContext(boxPath, 500, 600, { previewMaxSize: 600 });
    assert.equal(bottle.algorithm, "package-smart-lasso-v1");
    assert.equal(bottle.candidates[0]?.classification.type, "bottle");
    assert.equal(box.candidates[0]?.classification.type, "box");
    assert.ok((bottle.candidates[0]?.bbox.height ?? 0) > 500);
    assert.ok((box.candidates[0]?.bbox.width ?? 0) > 300);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("thin catalog-image streaks do not become part of the bottle contour", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bottle-context-"));
  const imagePath = join(directory, "streaked-bottle.png");
  try {
    const svg = Buffer.from(`
      <svg width="420" height="420" xmlns="http://www.w3.org/2000/svg">
        <rect width="420" height="420" fill="white"/>
        <path d="M185 20 H235 V95 C235 115 275 135 275 190 V385 Q210 405 145 385 V190 C145 135 185 115 185 95 Z" fill="#111"/>
        <rect x="150" y="190" width="120" height="135" fill="#ddd"/>
        <rect x="235" y="48" width="175" height="3" fill="#aaa"/>
        <rect x="235" y="57" width="175" height="3" fill="#aaa"/>
        <rect x="275" y="379" width="135" height="3" fill="#aaa"/>
        <rect x="275" y="388" width="135" height="3" fill="#aaa"/>
      </svg>`);
    const sourceSize = 1_680;
    await sharp(svg).resize(sourceSize, sourceSize).png().toFile(imagePath);

    const label = { x: 600, y: 760, width: 480, height: 540 };
    const preview = await runBottleContext(imagePath, sourceSize, sourceSize, label, {
      processingMode: "preview",
      previewMaxSize: 420,
      paddingPercent: 8,
      silhouetteThreshold: 18,
      connectivity: 4,
      simplifyTolerance: 2,
    });
    const final = await runBottleContext(imagePath, sourceSize, sourceSize, label, {
      ...preview.config,
      processingMode: "final",
    });
    const fuzzyBackground = await runBottleContext(imagePath, sourceSize, sourceSize, label, {
      ...preview.config,
      silhouetteThreshold: 30,
    });
    const previewCandidate = preview.candidates[0];
    const finalCandidate = final.candidates[0];
    assert.ok(previewCandidate);
    assert.ok(finalCandidate);
    assert.ok(["border-flood", "combined-fill"].includes(fuzzyBackground.candidates[0]?.origin ?? ""));
    assert.equal(final.algorithm, "bottle-border-flood-v2");
    for (const candidate of [previewCandidate, finalCandidate]) {
      assert.ok(candidate.bbox.x + candidate.bbox.width < 1_200, `unexpected contour bbox: ${JSON.stringify(candidate.bbox)}`);
      assert.ok(Math.max(...candidate.rawContour.map(([x]) => x)) < 1_200);
    }
    assert.ok(Math.abs(previewCandidate.bbox.x - finalCandidate.bbox.x) <= 8);
    assert.ok(Math.abs(previewCandidate.bbox.width - finalCandidate.bbox.width) <= 8);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("edge-assisted silhouette keeps a pale transparent neck attached to the colored bottle body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bottle-context-pale-neck-"));
  const imagePath = join(directory, "pale-neck-bottle.png");
  try {
    const svg = Buffer.from(`
      <svg width="240" height="600" xmlns="http://www.w3.org/2000/svg">
        <rect width="240" height="600" fill="white"/>
        <path d="M96 18 H144 V175 H96 Z" fill="#fbfbfb" stroke="#f0f0f0" stroke-width="2"/>
        <path d="M96 145 C96 175 62 180 55 235 V565 Q120 585 185 565 V235 C178 180 144 175 144 145 Z" fill="#f0bd79" stroke="#9b6b48" stroke-width="3"/>
        <rect x="58" y="245" width="124" height="230" fill="#12a9c5"/>
      </svg>`);
    await sharp(svg).png().toFile(imagePath);

    const result = await runBottleContext(imagePath, 240, 600, { x: 58, y: 245, width: 124, height: 230 }, {
      processingMode: "preview",
      previewMaxSize: 600,
      paddingPercent: 8,
      silhouetteThreshold: 18,
      connectivity: 4,
      simplifyTolerance: 2,
    });

    const candidate = result.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.origin, "combined-fill");
    assert.ok(candidate.bbox.y < 35, `transparent neck was lost: ${JSON.stringify(candidate.bbox)}`);
    assert.ok(candidate.bbox.height > 520, `bottle height was truncated: ${JSON.stringify(candidate.bbox)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("alpha-backed catalog cutout keeps translucent glass in the package contour", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bottle-context-alpha-"));
  const imagePath = join(directory, "alpha-bottle.png");
  try {
    const svg = Buffer.from(`
      <svg width="180" height="600" xmlns="http://www.w3.org/2000/svg">
        <path d="M68 15 H112 V180 H68 Z" fill="#e8d9c8" fill-opacity="0.18" stroke="#d7c9bb" stroke-opacity="0.35" stroke-width="2"/>
        <path d="M68 150 C68 180 36 190 30 245 V570 Q90 590 150 570 V245 C144 190 112 180 112 150 Z" fill="#efbd79"/>
        <rect x="32" y="260" width="116" height="220" fill="#0ba8c5"/>
      </svg>`);
    await sharp(svg).png().toFile(imagePath);

    const result = await runBottleContext(imagePath, 180, 600, { x: 32, y: 260, width: 116, height: 220 }, {
      processingMode: "preview",
      previewMaxSize: 600,
      paddingPercent: 8,
      silhouetteThreshold: 18,
      connectivity: 4,
      simplifyTolerance: 2,
    });

    const candidate = result.candidates[0];
    assert.ok(candidate);
    assert.ok(candidate.bbox.y < 30, `translucent glass was lost: ${JSON.stringify(candidate.bbox)}`);
    assert.ok(candidate.bbox.height > 530, `package contour was truncated: ${JSON.stringify(candidate.bbox)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
