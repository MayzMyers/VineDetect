import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { classifyBottleLabelCandidates, createBoundaryReviewVariants, deriveBottleZoneModel, extendToStrongerLowerBoundary, mergeAlignedConsensusFragments, refineCandidatesWithPackageContext, removeAdjacentSingleFamilyBodyBands, removeNestedDetectorCandidates, removePortraitBottleBodyCandidates, runLabelDetection, snapBottomCandidateToTextureBand, trimDarkBottleTail, type DetectorCandidate } from "./labelDetection.js";

test("bottle geometry helper separates independent neck and front labels and rejects the bottle shell", () => {
  const candidate = (id: string, bbox: DetectorCandidate["bbox"]): DetectorCandidate => ({
    id, bbox, polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]], score: .8,
    metrics: { edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .8, areaRatio: bbox.width * bbox.height / 180_000 },
    detection: { passId: "multi-profile-consensus", passIds: ["edge", "color"], config: {} },
  });
  const result = classifyBottleLabelCandidates([
    candidate("neck", { x: 122, y: 105, width: 56, height: 48 }),
    candidate("main", { x: 67, y: 330, width: 166, height: 155 }),
    candidate("shell", { x: 55, y: 150, width: 190, height: 430 }),
  ], {
    bbox: { x: 50, y: 20, width: 200, height: 560 }, packageType: "bottle", source: "accepted-package-helper", confidence: .95,
    contour: [[125, 20], [175, 20], [180, 130], [235, 210], [245, 560], [55, 560], [65, 210], [120, 130]],
  });
  assert.equal(result.find((item) => item.id === "neck")?.geometrySemantic?.verdict, "likely");
  assert.equal(result.find((item) => item.id === "main")?.geometrySemantic?.verdict, "likely");
  assert.equal(result.find((item) => item.id === "shell")?.geometrySemantic?.verdict, "unlikely");
  assert.equal(result.find((item) => item.id === "main")?.geometrySemantic?.features.independentAlternatives, 1);
  assert.equal(result.find((item) => item.id === "neck")?.geometrySemantic?.features.packageZone, "neck");
  assert.equal(result.find((item) => item.id === "main")?.geometrySemantic?.features.packageZone, "body");
  assert.equal(result.find((item) => item.id === "neck")?.geometrySemantic?.role, "neck-label");
  assert.equal(result.find((item) => item.id === "main")?.geometrySemantic?.role, "front-label");
});

test("bottle zones follow contour widening instead of fixed image percentages", () => {
  const shortShoulder = deriveBottleZoneModel({
    bbox: { x: 50, y: 20, width: 200, height: 560 }, packageType: "bottle", source: "accepted-package-helper",
    contour: [[125, 20], [175, 20], [178, 95], [238, 155], [245, 560], [55, 560], [62, 155], [122, 95]],
  });
  const longNeck = deriveBottleZoneModel({
    bbox: { x: 50, y: 20, width: 200, height: 560 }, packageType: "bottle", source: "accepted-package-helper",
    contour: [[125, 20], [175, 20], [178, 245], [238, 330], [245, 560], [55, 560], [62, 330], [122, 245]],
  });
  assert.ok(longNeck.normalizedBoundaries.neckEnd > shortShoulder.normalizedBoundaries.neckEnd + .16, JSON.stringify({ shortShoulder, longNeck }));
  assert.ok(longNeck.normalizedBoundaries.shoulderEnd > shortShoulder.normalizedBoundaries.shoulderEnd + .16, JSON.stringify({ shortShoulder, longNeck }));
  assert.ok(shortShoulder.confidence >= .7 && longNeck.confidence >= .7, JSON.stringify({ shortShoulder, longNeck }));
});

test("bottle label geometry helper is bottle-only", () => {
  const bbox = { x: 20, y: 30, width: 80, height: 100 };
  const candidate: DetectorCandidate = { id: "box-label", bbox, polygon: [[20, 30], [100, 30], [100, 130], [20, 130]], score: .8,
    metrics: { edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .8, areaRatio: .2 }, detection: { passId: "box", passIds: [], config: {} } };
  const [result] = classifyBottleLabelCandidates([candidate], { bbox: { x: 0, y: 0, width: 120, height: 180 }, contour: [[0, 0], [120, 0], [120, 180], [0, 180]], packageType: "box", source: "reviewed-package-geometry" });
  assert.equal(result?.geometrySemantic, undefined);
});

test("accepted package contour trims a label candidate that incorrectly follows the bottle to its base", async () => {
  const width = 300, height = 600;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="300" height="600" fill="#fff"/>
    <path d="M120 10H180V145Q235 205 240 300V565Q235 585 200 590H100Q65 585 60 565V300Q65 205 120 145Z" fill="#161916"/>
    <rect x="62" y="330" width="176" height="105" fill="#d43b40"/>
    <rect x="62" y="435" width="176" height="78" fill="#eeeeea"/>
    <rect x="102" y="460" width="96" height="16" fill="#222"/>
  </svg>`;
  const raw = await sharp(Buffer.from(svg)).removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const bbox = { x: 60, y: 330, width: 180, height: 255 };
  const candidate: DetectorCandidate = {
    id: "bottle-tail", bbox, polygon: [[60, 330], [240, 330], [240, 585], [60, 585]], score: .81,
    metrics: { edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .8, areaRatio: bbox.width * bbox.height / (width * height) },
    detection: { passId: "multi-profile-consensus", passIds: ["horizontal-balanced", "color-boundary-soft"], config: {} },
  };
  const [refined] = refineCandidatesWithPackageContext([candidate], { data: raw.data, width: raw.info.width, height: raw.info.height, channels: raw.info.channels }, width, height, {
    bbox: { x: 60, y: 10, width: 180, height: 580 },
    contour: [[120, 10], [180, 10], [180, 145], [235, 205], [240, 300], [240, 565], [235, 585], [200, 590], [100, 590], [65, 585], [60, 565], [60, 300], [65, 205], [120, 145]],
    packageType: "bottle", source: "accepted-package-helper",
  });
  assert.ok(refined, "refined candidate is missing");
  assert.ok(refined.bbox.y + refined.bbox.height >= 505 && refined.bbox.y + refined.bbox.height <= 520, JSON.stringify(refined));
  assert.ok((refined.metrics.packageEdgeAffinity ?? 0) > .7, JSON.stringify(refined.metrics));
  assert.ok((refined.metrics.bodyColorContinuation ?? 0) > .7, JSON.stringify(refined.metrics));
});

test("accepted package contour independently removes captured bottle body from all four label edges", async () => {
  const width = 300, height = 600;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="300" height="600" fill="#fff"/>
    <rect x="40" y="20" width="220" height="560" rx="40" fill="#18201b"/>
    <rect x="75" y="210" width="150" height="180" fill="#e8d6ac"/>
    <rect x="105" y="265" width="90" height="25" fill="#702c38"/>
  </svg>`;
  const raw = await sharp(Buffer.from(svg)).removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const bbox = { x: 50, y: 160, width: 200, height: 280 };
  const candidate: DetectorCandidate = {
    id: "four-sided-shell", bbox, polygon: [[50, 160], [250, 160], [250, 440], [50, 440]], score: .78,
    metrics: { edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .75, areaRatio: bbox.width * bbox.height / (width * height) },
    detection: { passId: "multi-profile-consensus", passIds: ["horizontal-balanced", "color-boundary-soft"], config: {} },
  };
  const [refined] = refineCandidatesWithPackageContext([candidate], { data: raw.data, width: raw.info.width, height: raw.info.height, channels: raw.info.channels }, width, height, {
    bbox: { x: 40, y: 20, width: 220, height: 560 },
    contour: [[80, 20], [220, 20], [260, 60], [260, 540], [220, 580], [80, 580], [40, 540], [40, 60]],
    packageType: "bottle", source: "accepted-package-helper",
  });
  assert.ok(refined, "refined candidate is missing");
  assert.ok(Math.abs(refined.bbox.x - 75) <= 8, JSON.stringify(refined));
  assert.ok(Math.abs(refined.bbox.y - 210) <= 8, JSON.stringify(refined));
  assert.ok(Math.abs(refined.bbox.x + refined.bbox.width - 225) <= 8, JSON.stringify(refined));
  assert.ok(Math.abs(refined.bbox.y + refined.bbox.height - 390) <= 8, JSON.stringify(refined));
  assert.deepEqual(new Set(refined.metrics.refinedEdges), new Set(["top", "right", "bottom", "left"]));
});

test("package-aware refinement keeps a full-width box label when no package-material strip exists inside it", async () => {
  const width = 300, height = 600;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="300" height="600" fill="#fff"/>
    <rect x="20" y="20" width="260" height="560" fill="#50555b"/>
    <rect x="20" y="160" width="260" height="280" fill="#c84a42"/>
  </svg>`;
  const raw = await sharp(Buffer.from(svg)).removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const bbox = { x: 20, y: 160, width: 260, height: 280 };
  const candidate: DetectorCandidate = {
    id: "box-wrap-label", bbox, polygon: [[20, 160], [280, 160], [280, 440], [20, 440]], score: .8,
    metrics: { edgeSupport: .8, rectangularity: 1, solidity: 1, stability: .8, areaRatio: bbox.width * bbox.height / (width * height) },
    detection: { passId: "multi-profile-consensus", passIds: ["horizontal-balanced", "color-boundary-soft"], config: {} },
  };
  const [refined] = refineCandidatesWithPackageContext([candidate], { data: raw.data, width: raw.info.width, height: raw.info.height, channels: raw.info.channels }, width, height, {
    bbox: { x: 20, y: 20, width: 260, height: 560 }, contour: [[20, 20], [280, 20], [280, 580], [20, 580]],
    packageType: "box", source: "accepted-package-helper",
  });
  assert.deepEqual(refined?.bbox, bbox);
  assert.deepEqual(refined?.metrics.refinedEdges, undefined);
});

test("local boundary probe keeps a multilayer label together and removes dark bottle glass below it", async () => {
  const width = 300, height = 600;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="300" height="600" fill="#fff"/>
    <path d="M120 10H180V145Q235 205 240 300V565Q235 590 200 594H100Q65 590 60 565V300Q65 205 120 145Z" fill="#182018"/>
    <rect x="65" y="300" width="170" height="115" fill="#91ad58"/>
    <path d="M70 320L220 395M90 305L230 370M75 390L180 305" stroke="#286845" stroke-width="9"/>
    <rect x="65" y="415" width="170" height="115" fill="#201e1c"/>
    <rect x="96" y="455" width="108" height="8" fill="#ddd7c5"/>
    <rect x="82" y="480" width="136" height="6" fill="#aaa490"/>
    <rect x="112" y="507" width="76" height="5" fill="#d6b454"/>
  </svg>`;
  const raw = await sharp(Buffer.from(svg)).removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const bbox = { x: 58, y: 294, width: 184, height: 292 };
  const candidate: DetectorCandidate = {
    id: "multilayer-with-glass-tail", bbox, polygon: [[58, 294], [242, 294], [242, 586], [58, 586]], score: .82,
    metrics: { edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .8, areaRatio: bbox.width * bbox.height / (width * height) },
    detection: { passId: "multi-profile-consensus", passIds: ["horizontal-balanced", "color-boundary-soft", "text-density-envelope"], config: { families: ["edge", "color", "text"] } },
  };
  const [refined] = refineCandidatesWithPackageContext([candidate], { data: raw.data, width, height, channels: raw.info.channels }, width, height, {
    bbox: { x: 60, y: 10, width: 180, height: 584 },
    contour: [[120, 10], [180, 10], [180, 145], [235, 205], [240, 300], [240, 565], [235, 585], [200, 594], [100, 594], [65, 585], [60, 565], [60, 300], [65, 205], [120, 145]],
    packageType: "bottle", source: "accepted-package-helper",
  });
  assert.ok(refined, "refined candidate is missing");
  assert.ok(refined.bbox.y <= 305, JSON.stringify(refined));
  assert.ok(refined.bbox.y + refined.bbox.height >= 522 && refined.bbox.y + refined.bbox.height <= 538, JSON.stringify(refined));
  assert.ok(refined.metrics.boundaryProbe, JSON.stringify(refined.metrics));
  assert.ok((refined.metrics.boundaryProbe?.baseIntrusion ?? 1) < .5, JSON.stringify(refined.metrics.boundaryProbe));
});

test("local boundary probe expands a clipped Label ROI on all supported sides", async () => {
  const width = 300, height = 600;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="300" height="600" fill="#fff"/>
    <rect x="45" y="20" width="210" height="560" rx="42" fill="#172019"/>
    <rect x="60" y="250" width="180" height="220" fill="#d6c7a4"/>
    <rect x="60" y="250" width="180" height="92" fill="#6f9f59"/>
    <rect x="82" y="365" width="136" height="12" fill="#332b25"/>
    <rect x="95" y="410" width="110" height="9" fill="#675748"/>
  </svg>`;
  const raw = await sharp(Buffer.from(svg)).removeAlpha().toColorspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const bbox = { x: 75, y: 275, width: 150, height: 170 };
  const candidate: DetectorCandidate = {
    id: "clipped-label", bbox, polygon: [[75, 275], [225, 275], [225, 445], [75, 445]], score: .74,
    metrics: { edgeSupport: .7, rectangularity: 1, solidity: 1, stability: .7, areaRatio: bbox.width * bbox.height / (width * height) },
    detection: { passId: "multi-profile-consensus", passIds: ["horizontal-soft", "text-density-envelope"], config: { families: ["edge", "text"] } },
  };
  const [refined] = refineCandidatesWithPackageContext([candidate], { data: raw.data, width, height, channels: raw.info.channels }, width, height, {
    bbox: { x: 45, y: 20, width: 210, height: 560 }, contour: [[87, 20], [213, 20], [255, 62], [255, 538], [213, 580], [87, 580], [45, 538], [45, 62]],
    packageType: "bottle", source: "accepted-package-helper",
  });
  assert.ok(refined, "refined candidate is missing");
  assert.ok(refined.bbox.x <= 64, JSON.stringify(refined));
  assert.ok(refined.bbox.y <= 255, JSON.stringify(refined));
  assert.ok(refined.bbox.x + refined.bbox.width >= 236, JSON.stringify(refined));
  assert.ok(refined.bbox.y + refined.bbox.height >= 465, JSON.stringify(refined));
  const actions = Object.values(refined.metrics.boundaryProbe?.edges ?? {}).map((edge) => edge.action);
  assert.ok(actions.filter((action) => action === "expand").length >= 3, JSON.stringify(refined.metrics.boundaryProbe));
});

test("a material boundary correction exposes tight and boundary-probed review variants", () => {
  const bbox = { x: 108, y: 864, width: 328, height: 340 };
  const candidate: DetectorCandidate = {
    id: "label-consensus-1", bbox, polygon: [[108, 864], [436, 864], [436, 1204], [108, 1204]], score: .92,
    metrics: {
      edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .8, areaRatio: .12,
      boundaryProbe: {
        algorithm: "package-local-boundary-probe-v1", baseIntrusion: 0,
        edges: { top: { action: "expand", position: 864, score: .54, contrast: 14, coverage: .41, outsideBodySimilarity: .82, insideBodyDifference: .34, textLikeDrop: .15, sideTermination: .16, discardedTextLike: 0, retainedTextLike: .54 } },
      },
    },
    detection: {
      passId: "multi-profile-consensus", passIds: ["color", "text"],
      config: { boundaryProbe: { from: { x: 108, y: 1024, width: 328, height: 180 }, to: bbox } },
    },
  };
  const variants = createBoundaryReviewVariants([candidate]);
  assert.equal(variants.length, 2);
  assert.deepEqual(variants.map((item) => item.variant?.kind), ["boundary-probed", "tight"]);
  assert.equal(variants[0]?.variant?.groupId, variants[1]?.variant?.groupId);
  assert.deepEqual(variants[1]?.bbox, { x: 108, y: 1024, width: 328, height: 180 });
  assert.ok((variants[0]?.score ?? 0) > (variants[1]?.score ?? 0));
});

test("outer label region outranks its internal logo and text components", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "label-region-"));
  const imagePath = path.join(directory, "bottle.webp");
  try {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="343" height="1280">
        <rect width="343" height="1280" fill="#fff"/>
        <path d="M115 0 H228 V260 Q330 420 341 660 V1200 Q341 1275 270 1278 H73 Q2 1275 2 1200 V660 Q13 420 115 260 Z" fill="#efaaa2" stroke="#c66f69" stroke-width="5"/>
        <rect x="10" y="823" width="323" height="315" fill="#e9e9e7" stroke="#d7d7d4" stroke-width="2"/>
        <ellipse cx="245" cy="855" rx="45" ry="30" fill="#c93889"/>
        <rect x="92" y="924" width="160" height="18" fill="#666"/>
        <rect x="70" y="970" width="205" height="30" fill="#333"/>
        <rect x="125" y="1020" width="95" height="20" fill="#555"/>
      </svg>`;
    await sharp(Buffer.from(svg)).webp().toFile(imagePath);
    const result = await runLabelDetection(imagePath, 343, 1280, { previewMaxSide: 320, chromaTolerance: 28, rowGapRatio: .12 });
    const winner = result.candidates[0];
    assert.equal(result.algorithm, "label-multi-family-consensus-v4");
    assert.equal(result.config.previewMaxSide, 320);
    assert.equal(result.config.chromaTolerance, 28);
    assert.equal(result.config.rowGapRatio, .12);
    assert.equal(result.debug.preview.maxSide, 320);
    assert.ok(result.debug.neutralBands.length > 0);
    assert.equal(winner?.detection.passId, "multi-profile-consensus");
    assert.ok(winner!.detection.passIds.length >= 2);
    const winnerConfig = winner!.detection.config as {
      families: string[];
      confidence: string;
      scoreParts: Record<string, number>;
      contributors: Array<{ candidateId: string }>;
    };
    assert.equal(new Set(winnerConfig.families).size, winnerConfig.families.length, "one detector family must contribute at most one consensus vote");
    assert.equal(winnerConfig.contributors.length, winnerConfig.families.length);
    assert.ok(winnerConfig.families.includes("edge"));
    assert.ok(winnerConfig.families.includes("color"));
    assert.ok(Object.keys(winnerConfig.scoreParts).length >= 5, "consensus score must remain explainable");
    assert.ok(result.debug.consensusClusters.length > 0);
    assert.ok(result.debug.familyCandidates.some((candidate) => candidate.family === "edge"));
    assert.ok(result.debug.familyCandidates.some((candidate) => candidate.family === "color"));
    assert.deepEqual(result.passes.slice(0, 9).map((pass) => pass.id), [
      "neutral-balanced", "neutral-permissive", "neutral-strict",
      "saturated-color-regions",
      "horizontal-soft", "horizontal-balanced", "horizontal-strong",
      "color-boundary-soft", "color-boundary-strong",
    ]);
    assert.ok(result.passes.slice(0, 9).every((pass) => Object.keys(pass.config).length > 0));
    assert.ok(rectIoU(winner!.bbox, { x: 10, y: 823, width: 323, height: 315 }) >= .9, JSON.stringify(winner));
    assert.ok(result.candidates.every((candidate) => candidate.bbox.width >= 250), "internal text/logo boxes leaked into ROI candidates");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("neutral label band keeps a centered tapered continuation", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "label-taper-"));
  const imagePath = path.join(directory, "shield-label.webp");
  try {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="400" height="1000">
        <rect width="400" height="1000" fill="#fff"/>
        <path d="M145 5 H255 V190 Q330 270 335 450 V950 Q330 995 275 998 H125 Q70 995 65 950 V450 Q70 270 145 190 Z" fill="#171512"/>
        <path d="M92 575 H308 V700 Q300 790 200 825 Q100 790 92 700 Z" fill="#f4f5f2"/>
        <rect x="125" y="620" width="150" height="24" fill="#207a9f"/>
        <rect x="145" y="665" width="110" height="18" fill="#555"/>
        <rect x="160" y="720" width="80" height="14" fill="#777"/>
      </svg>`;
    await sharp(Buffer.from(svg)).webp().toFile(imagePath);
    const result = await runLabelDetection(imagePath, 400, 1000, { previewMaxSide: 400 });
    const winner = result.candidates[0];
    assert.ok(winner, JSON.stringify(result.debug));
    assert.ok(winner.bbox.y <= 590, JSON.stringify(winner));
    assert.ok(winner.bbox.y + winner.bbox.height >= 790, JSON.stringify(winner));
    assert.ok(winner.bbox.width >= 190, JSON.stringify(winner));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a stronger outer edge replaces an internal same-tone label divider", () => {
  const width = 100; const height = 200; const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const insideLabel = x >= 20 && x < 80 && y >= 50 && y < 128;
    const color = insideLabel ? (y < 110 ? [235, 230, 210] : [190, 185, 170]) : [30, 25, 20];
    const offset = (y * width + x) * 3;
    data[offset] = color[0]!; data[offset + 1] = color[1]!; data[offset + 2] = color[2]!;
  }
  const bbox = { x: 20, y: 50, width: 60, height: 60 };
  const candidate: DetectorCandidate = {
    id: "internal-divider", bbox,
    polygon: [[20, 50], [80, 50], [80, 110], [20, 110]], score: .8,
    metrics: { edgeSupport: .8, rectangularity: 1, solidity: 1, stability: .8, areaRatio: .18 },
    detection: { passId: "multi-profile-consensus", passIds: ["horizontal-soft"], config: {} },
  };
  const result = extendToStrongerLowerBoundary(candidate, { data, width, height, channels: 3 }, width, height);
  assert.ok(result.bbox.y + result.bbox.height >= 126, JSON.stringify(result));
  assert.equal((result.detection.config.lowerBoundaryCompletion as { from: number }).from, 110);
});

test("an oversized lower-edge candidate drops the dark bottle tail but keeps the decorative footer", () => {
  const width = 100; const height = 200; const data = Buffer.alloc(width * height * 3, 255);
  for (let y = 0; y < height; y += 1) for (let x = 20; x < 80; x += 1) {
    const color = y >= 40 && y < 130 ? [225, 214, 180]
      : y >= 130 && y < 155 ? [58, 45, 32]
        : y >= 155 && y < 195 ? [20, 18, 16]
          : [255, 255, 255];
    const offset = (y * width + x) * 3;
    data[offset] = color[0]!; data[offset + 1] = color[1]!; data[offset + 2] = color[2]!;
  }
  const bbox = { x: 20, y: 40, width: 60, height: 155 };
  const candidate: DetectorCandidate = {
    id: "bottle-bottom-pair", bbox,
    polygon: [[20, 40], [80, 40], [80, 195], [20, 195]], score: .76,
    metrics: { edgeSupport: .7, rectangularity: 1, solidity: 1, stability: .7, areaRatio: .465 },
    detection: { passId: "multi-profile-consensus", passIds: ["horizontal-soft"], config: {} },
  };
  const result = trimDarkBottleTail(candidate, { data, width, height, channels: 3 }, width, height);
  assert.ok(result.bbox.y + result.bbox.height >= 152 && result.bbox.y + result.bbox.height <= 158, JSON.stringify(result));
  assert.equal((result.detection.config.lowerBoundaryTrim as { from: number }).from, 195);
});

test("a compact bottom label also drops captured glass below its real boundary", () => {
  const width = 100; const height = 400; const data = Buffer.alloc(width * height * 3, 255);
  for (let y = 0; y < height; y += 1) for (let x = 20; x < 80; x += 1) {
    const color = y >= 295 && y < 360 ? [232, 205, 192]
      : y >= 360 && y < 375 ? [181, 101, 82]
        : y >= 375 && y < 395 ? [91, 58, 48]
          : [255, 255, 255];
    const offset = (y * width + x) * 3;
    data[offset] = color[0]!; data[offset + 1] = color[1]!; data[offset + 2] = color[2]!;
  }
  const bbox = { x: 20, y: 295, width: 60, height: 100 };
  const candidate: DetectorCandidate = {
    id: "compact-bottom-label", bbox,
    polygon: [[20, 295], [80, 295], [80, 395], [20, 395]], score: .82,
    metrics: { edgeSupport: .8, rectangularity: 1, solidity: 1, stability: .8, areaRatio: .15 },
    detection: { passId: "multi-profile-consensus", passIds: ["horizontal-soft"], config: {} },
  };
  const result = trimDarkBottleTail(candidate, { data, width, height, channels: 3 }, width, height);
  assert.ok(result.bbox.y + result.bbox.height >= 372 && result.bbox.y + result.bbox.height <= 378, JSON.stringify(result));
});

test("a dark label drops a brighter glass tail captured below it", () => {
  const width = 100; const height = 400; const data = Buffer.alloc(width * height * 3, 255);
  for (let y = 0; y < height; y += 1) for (let x = 20; x < 80; x += 1) {
    const color = y >= 295 && y < 365 ? [47, 43, 39]
      : y >= 365 && y < 395 ? [151, 112, 65]
        : [255, 255, 255];
    const offset = (y * width + x) * 3;
    data[offset] = color[0]!; data[offset + 1] = color[1]!; data[offset + 2] = color[2]!;
  }
  const bbox = { x: 20, y: 295, width: 60, height: 100 };
  const candidate: DetectorCandidate = {
    id: "dark-label-with-bright-glass", bbox,
    polygon: [[20, 295], [80, 295], [80, 395], [20, 395]], score: .78,
    metrics: { edgeSupport: .72, rectangularity: 1, solidity: 1, stability: .72, areaRatio: .15 },
    detection: { passId: "multi-profile-consensus", passIds: ["horizontal-soft"], config: {} },
  };
  const result = trimDarkBottleTail(candidate, { data, width, height, channels: 3 }, width, height);
  assert.ok(result.bbox.y + result.bbox.height >= 362 && result.bbox.y + result.bbox.height <= 368, JSON.stringify(result));
});

test("a pale label drops a chromatically different glass tail with the same average lightness", () => {
  const width = 100; const height = 400; const data = Buffer.alloc(width * height * 3, 255);
  for (let y = 0; y < height; y += 1) for (let x = 20; x < 80; x += 1) {
    const color = y >= 295 && y < 360 ? [235, 215, 190]
      : y >= 360 && y < 395 ? [170, 220, 250]
        : [255, 255, 255];
    const offset = (y * width + x) * 3;
    data[offset] = color[0]!; data[offset + 1] = color[1]!; data[offset + 2] = color[2]!;
  }
  const bbox = { x: 20, y: 295, width: 60, height: 100 };
  const candidate: DetectorCandidate = {
    id: "pale-label-with-equal-lightness-tail", bbox,
    polygon: [[20, 295], [80, 295], [80, 395], [20, 395]], score: .8,
    metrics: { edgeSupport: .76, rectangularity: 1, solidity: 1, stability: .76, areaRatio: .15 },
    detection: { passId: "multi-profile-consensus", passIds: ["horizontal-soft"], config: {} },
  };
  const result = trimDarkBottleTail(candidate, { data, width, height, channels: 3 }, width, height);
  assert.ok(result.bbox.y + result.bbox.height >= 357 && result.bbox.y + result.bbox.height <= 363, JSON.stringify(result));
  const diagnostic = result.detection.config.lowerBoundaryTrim as { bodyLightness: number; tailLightness: number; bodyTailColorDistance: number };
  assert.ok(Math.abs(diagnostic.bodyLightness - diagnostic.tailLightness) < 1, JSON.stringify(diagnostic));
  assert.ok(diagnostic.bodyTailColorDistance >= 24, JSON.stringify(diagnostic));
});

test("a supported label suppresses the enclosing bottle-body candidate", () => {
  const candidate = (id: string, bbox: DetectorCandidate["bbox"], score: number, families: string[]): DetectorCandidate => ({
    id, bbox, score,
    polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]],
    metrics: { edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .8, areaRatio: bbox.width * bbox.height / 240_000 },
    detection: { passId: "multi-profile-consensus", passIds: families, config: { families } },
  });
  const body = candidate("body", { x: 55, y: 210, width: 150, height: 390 }, .83, ["edge", "color"]);
  const label = candidate("label", { x: 58, y: 405, width: 144, height: 145 }, .88, ["edge", "color", "text"]);
  const result = removeNestedDetectorCandidates([body, label], 300, 800);
  assert.deepEqual(result.map((item) => item.id), ["label"]);
});

test("a stronger text-supported shaped label suppresses weaker body containers", () => {
  const candidate = (id: string, bbox: DetectorCandidate["bbox"], score: number, families: string[]): DetectorCandidate => ({
    id, bbox, score,
    polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]],
    metrics: { edgeSupport: .7, rectangularity: .75, solidity: .8, stability: .7, areaRatio: bbox.width * bbox.height / 189_000 },
    detection: { passId: "multi-profile-consensus", passIds: families, config: { families } },
  });
  const upperBody = candidate("upper-body", { x: 55, y: 270, width: 140, height: 350 }, .76, ["edge", "color"]);
  const lowerBody = candidate("lower-body", { x: 25, y: 435, width: 180, height: 190 }, .74, ["edge", "color"]);
  const diamond = candidate("diamond", { x: 38, y: 480, width: 165, height: 110 }, .84, ["text"]);
  const result = removeNestedDetectorCandidates([upperBody, lowerBody, diamond], 230, 630);
  assert.deepEqual(result.map((item) => item.id), ["diamond"]);
});

test("bright label evidence suppresses a higher-ranked dark upper-body container", () => {
  const width = 200; const height = 600; const data = Buffer.alloc(width * height * 3, 255);
  for (let y = 160; y < 560; y += 1) for (let x = 30; x < 170; x += 1) {
    const insideLabel = x >= 40 && x < 160 && y >= 300 && y < 520;
    const value = insideLabel ? 218 : 28;
    const offset = (y * width + x) * 3;
    data[offset] = value; data[offset + 1] = value; data[offset + 2] = value;
  }
  const candidate = (id: string, bbox: DetectorCandidate["bbox"], score: number, families: string[]): DetectorCandidate => ({
    id, bbox, score,
    polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]],
    metrics: { edgeSupport: .75, rectangularity: .85, solidity: .85, stability: .75, areaRatio: bbox.width * bbox.height / (width * height) },
    detection: { passId: "multi-profile-consensus", passIds: families, config: { families } },
  });
  const body = candidate("body", { x: 30, y: 160, width: 140, height: 400 }, .95, ["edge", "color"]);
  const label = candidate("label", { x: 40, y: 300, width: 120, height: 220 }, .7, ["color"]);
  const result = removeNestedDetectorCandidates([body, label], width, height, { data, width, height, channels: 3 });
  assert.deepEqual(result.map((item) => item.id), ["label"]);
});

test("two vertically separated labels suppress their shared shell candidate", () => {
  const candidate = (id: string, bbox: DetectorCandidate["bbox"], score: number): DetectorCandidate => ({
    id, bbox, score,
    polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]],
    metrics: { edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .8, areaRatio: bbox.width * bbox.height / 180_000 },
    detection: { passId: "multi-profile-consensus", passIds: ["edge", "color"], config: { families: ["edge", "color"] } },
  });
  const shell = candidate("shell", { x: 35, y: 200, width: 130, height: 320 }, .88);
  const upper = candidate("upper-label", { x: 36, y: 202, width: 128, height: 58 }, .8);
  const main = candidate("main-label", { x: 36, y: 268, width: 128, height: 245 }, .82);
  const result = removeNestedDetectorCandidates([shell, upper, main], 200, 600);
  assert.deepEqual(result.map((item) => item.id), ["upper-label", "main-label"]);
});

test("a large saturated bottle band touching a supported lower label is suppressed", () => {
  const candidate = (id: string, bbox: DetectorCandidate["bbox"], score: number, families: string[], passIds = families): DetectorCandidate => ({
    id, bbox, score,
    polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]],
    metrics: { edgeSupport: .85, rectangularity: .9, solidity: .9, stability: .85, areaRatio: bbox.width * bbox.height / (640 * 1920) },
    detection: { passId: "multi-profile-consensus", passIds, config: { families } },
  });
  const label = candidate("label", { x: 130, y: 1301, width: 390, height: 501 }, .8258, ["color", "edge"]);
  const colouredGlass = candidate("coloured-glass", { x: 152, y: 976, width: 341, height: 328 }, .7535, ["color"], ["saturated-color-regions"]);
  const result = removeAdjacentSingleFamilyBodyBands([label, colouredGlass], 640, 1920);
  assert.deepEqual(result.map((item) => item.id), ["label"]);
});

test("an adjacent upper label with independent evidence is preserved", () => {
  const candidate = (id: string, bbox: DetectorCandidate["bbox"], families: string[]): DetectorCandidate => ({
    id, bbox, score: .8,
    polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]],
    metrics: { edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .8, areaRatio: bbox.width * bbox.height / 480_000 },
    detection: { passId: "multi-profile-consensus", passIds: families, config: { families } },
  });
  const upper = candidate("upper-label", { x: 52, y: 300, width: 196, height: 140 }, ["color", "edge"]);
  const main = candidate("main-label", { x: 50, y: 440, width: 200, height: 245 }, ["color", "edge"]);
  const result = removeAdjacentSingleFamilyBodyBands([upper, main], 300, 800);
  assert.deepEqual(result.map((item) => item.id), ["upper-label", "main-label"]);
});

test("a small saturated neck label above the main label is preserved", () => {
  const candidate = (id: string, bbox: DetectorCandidate["bbox"], score: number, families: string[], passIds = families): DetectorCandidate => ({
    id, bbox, score,
    polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]],
    metrics: { edgeSupport: .75, rectangularity: .85, solidity: .85, stability: .75, areaRatio: bbox.width * bbox.height / 480_000 },
    detection: { passId: "multi-profile-consensus", passIds, config: { families } },
  });
  const neck = candidate("neck-label", { x: 95, y: 420, width: 110, height: 55 }, .74, ["color"], ["saturated-color-regions"]);
  const main = candidate("main-label", { x: 50, y: 475, width: 200, height: 210 }, .82, ["color", "edge"]);
  const result = removeAdjacentSingleFamilyBodyBands([neck, main], 300, 800);
  assert.deepEqual(result.map((item) => item.id), ["neck-label", "main-label"]);
});

test("a tall portrait bottle-body proposal yields to its supported bottom label", () => {
  const candidate = (id: string, bbox: DetectorCandidate["bbox"], score: number, families: string[]): DetectorCandidate => ({
    id, bbox, score,
    polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]],
    metrics: { edgeSupport: .8, rectangularity: .85, solidity: .85, stability: .75, areaRatio: bbox.width * bbox.height / 304_000 },
    detection: { passId: "multi-profile-consensus", passIds: families, config: { families } },
  });
  const body = candidate("body", { x: 20, y: 355, width: 251, height: 429 }, .8085, ["edge", "color", "text"]);
  const label = candidate("label", { x: 4, y: 740, width: 296, height: 256 }, .7614, ["edge", "color"]);
  const result = removePortraitBottleBodyCandidates([body, label], 304, 1000);
  assert.deepEqual(result.map((item) => item.id), ["label"]);
});

test("two ordinary vertically arranged labels are not treated as bottle body", () => {
  const candidate = (id: string, bbox: DetectorCandidate["bbox"]): DetectorCandidate => ({
    id, bbox, score: .8,
    polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]],
    metrics: { edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .8, areaRatio: bbox.width * bbox.height / 180_000 },
    detection: { passId: "multi-profile-consensus", passIds: ["edge", "color"], config: { families: ["edge", "color"] } },
  });
  const upper = candidate("upper", { x: 36, y: 260, width: 128, height: 120 });
  const lower = candidate("lower", { x: 36, y: 395, width: 128, height: 120 });
  const result = removePortraitBottleBodyCandidates([upper, lower], 200, 600);
  assert.deepEqual(result.map((item) => item.id), ["upper", "lower"]);
});

test("a dark bottom candidate snaps to its dense texture band instead of keeping bottle glass", () => {
  const width = 304; const height = 1000; const channels = 3;
  const data = Buffer.alloc(width * height * channels, 30);
  for (let y = 710; y < 906; y += 1) for (let x = 18; x < 290; x += 1) {
    const value = x % 4 < 2 ? 38 : 78;
    const offset = (y * width + x) * channels;
    data[offset] = value; data[offset + 1] = value; data[offset + 2] = value;
  }
  const bbox = { x: 4, y: 740, width: 296, height: 256 };
  const candidate: DetectorCandidate = {
    id: "dark-label", bbox, score: .79,
    polygon: [[4, 740], [300, 740], [300, 996], [4, 996]],
    metrics: { edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .8, areaRatio: bbox.width * bbox.height / (width * height) },
    detection: { passId: "multi-profile-consensus", passIds: ["color-boundary-soft", "horizontal-soft"], config: { families: ["color", "edge"] } },
  };
  const result = snapBottomCandidateToTextureBand(candidate, { data, width, height, channels }, width, height);
  assert.ok(result.bbox.y >= 709 && result.bbox.y <= 711, JSON.stringify(result.bbox));
  assert.ok(result.bbox.y + result.bbox.height >= 905 && result.bbox.y + result.bbox.height <= 907, JSON.stringify(result.bbox));
});

test("zero-result portrait search retries inside the bottle and keeps two separated labels", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "label-bottle-window-recovery-"));
  const imagePath = path.join(directory, "two-narrow-labels.webp");
  try {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="420" height="900">
        <rect width="420" height="900" fill="#fff"/>
        <path d="M170 5 H250 V185 Q292 230 294 330 V850 Q290 892 250 896 H170 Q130 892 126 850 V330 Q128 230 170 185 Z" fill="#24382d" stroke="#17241d" stroke-width="5"/>
        <rect x="165" y="410" width="90" height="220" fill="#bd79a8" stroke="#e1b9d4" stroke-width="4"/>
        <rect x="165" y="665" width="90" height="92" fill="#d5b260" stroke="#f1d8a2" stroke-width="4"/>
        <rect x="178" y="475" width="64" height="18" fill="#f1dedf"/>
        <rect x="178" y="700" width="64" height="15" fill="#eee"/>
      </svg>`;
    await sharp(Buffer.from(svg)).webp().toFile(imagePath);
    const result = await runLabelDetection(imagePath, 420, 900, { previewMaxSide: 420 });
    assert.equal(result.debug.recoveryMode, "bottle-window", JSON.stringify(result.debug));
    assert.ok(result.candidates.length >= 2, JSON.stringify(result.candidates));
    assert.ok(result.candidates.some((candidate) => candidate.bbox.y <= 430 && candidate.bbox.y + candidate.bbox.height >= 610), JSON.stringify(result.candidates));
    assert.ok(result.candidates.some((candidate) => candidate.bbox.y <= 680 && candidate.bbox.y + candidate.bbox.height >= 740), JSON.stringify(result.candidates));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("saturated color bands recover two labels despite stronger internal decoration", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "label-saturated-bands-"));
  const imagePath = path.join(directory, "blue-purple-labels.webp");
  try {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="300" height="700">
        <rect width="300" height="700" fill="#fff"/>
        <path d="M115 5 H185 V180 Q245 240 248 350 V680 H52 V350 Q55 240 115 180 Z" fill="#090b0d"/>
        <rect x="54" y="300" width="192" height="150" fill="#243f9c"/>
        <path d="M54 420 L246 330 V365 L54 450 Z" fill="#d6ae38"/>
        <rect x="82" y="495" width="136" height="88" rx="5" fill="#513b91" stroke="#d6ae69" stroke-width="4"/>
        <rect x="105" y="530" width="90" height="14" fill="#eee"/>
      </svg>`;
    await sharp(Buffer.from(svg)).webp().toFile(imagePath);
    const result = await runLabelDetection(imagePath, 300, 700, { previewMaxSide: 420 });
    assert.ok(result.candidates.some((candidate) => candidate.bbox.y <= 320 && candidate.bbox.y + candidate.bbox.height >= 430), JSON.stringify(result.candidates));
    assert.ok(result.candidates.some((candidate) => candidate.bbox.y <= 510 && candidate.bbox.y + candidate.bbox.height >= 570), JSON.stringify(result.candidates));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("colored label boundaries outrank a large internal illustration", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "label-boundary-"));
  const imagePath = path.join(directory, "colored-label.webp");
  try {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="400" height="1000">
        <rect width="400" height="1000" fill="#fff"/>
        <path d="M150 10 H250 V210 Q330 300 330 440 V940 Q320 985 270 990 H130 Q80 985 70 940 V440 Q70 300 150 210 Z" fill="#151515"/>
        <rect x="72" y="585" width="256" height="275" fill="#cf654d" stroke="#b64f3c" stroke-width="4"/>
        <rect x="125" y="635" width="150" height="95" fill="#f3d3c8"/>
        <path d="M140 705 Q200 625 260 705" fill="none" stroke="#8b3229" stroke-width="15"/>
        <rect x="115" y="770" width="170" height="14" fill="#f4dfd8"/>
        <rect x="145" y="805" width="110" height="10" fill="#f4dfd8"/>
      </svg>`;
    await sharp(Buffer.from(svg)).webp().toFile(imagePath);
    const result = await runLabelDetection(imagePath, 400, 1000, { previewMaxSide: 320 });
    const winner = result.candidates[0];
    assert.ok(winner?.id.startsWith("label-consensus"), JSON.stringify(result.candidates));
    assert.ok(rectIoU(winner!.bbox, { x: 72, y: 585, width: 256, height: 275 }) >= .78, JSON.stringify(winner));
    assert.ok(winner!.bbox.width > 220 && winner!.bbox.height > 220, "internal illustration won instead of the outer label");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("color-boundary profiles detect a label whose grayscale contrast is weak", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "label-color-boundary-"));
  const imagePath = path.join(directory, "same-luma-label.webp");
  try {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="400" height="1000">
        <rect width="400" height="1000" fill="#fff"/>
        <path d="M150 10 H250 V210 Q330 300 330 440 V940 Q320 985 270 990 H130 Q80 985 70 940 V440 Q70 300 150 210 Z" fill="#640000"/>
        <rect x="80" y="590" width="240" height="260" fill="#002500"/>
        <rect x="120" y="660" width="160" height="18" fill="#d8d8c8"/>
        <rect x="140" y="720" width="120" height="12" fill="#d8d8c8"/>
      </svg>`;
    await sharp(Buffer.from(svg)).webp().toFile(imagePath);
    const result = await runLabelDetection(imagePath, 400, 1000, { previewMaxSide: 320 });
    const winner = result.candidates[0];
    assert.ok(winner?.detection.passIds.some((passId) => passId.startsWith("color-boundary-")), JSON.stringify(result.candidates));
    assert.ok(rectIoU(winner!.bbox, { x: 80, y: 590, width: 240, height: 260 }) >= .76, JSON.stringify(winner));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("boundary profiles use the detected bottle width on a square catalog image", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "label-search-window-"));
  const imagePath = path.join(directory, "square-catalog.webp");
  try {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200">
        <rect width="1200" height="1200" fill="#fff"/>
        <path d="M545 60 H655 V300 Q750 390 758 570 V1100 Q750 1140 700 1145 H500 Q450 1140 442 1100 V570 Q450 390 545 300 Z" fill="#090909"/>
        <path d="M442 705 Q600 690 758 705 V1015 Q600 1040 442 1015 Z" fill="#dce4ad"/>
        <rect x="510" y="820" width="180" height="28" fill="#222"/>
        <rect x="540" y="900" width="120" height="18" fill="#555"/>
      </svg>`;
    await sharp(Buffer.from(svg)).webp().toFile(imagePath);
    const result = await runLabelDetection(imagePath, 1200, 1200, { previewMaxSide: 570 });
    const winner = result.candidates[0];
    assert.ok(result.debug.searchWindow, "bottle search window was not derived");
    assert.equal(winner?.detection.passId, "multi-profile-consensus");
    assert.ok(rectIoU(winner!.bbox, { x: 442, y: 690, width: 316, height: 350 }) >= .78, JSON.stringify(winner));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("aligned overlapping partial proposals collapse into one physical label", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "label-fragments-"));
  const imagePath = path.join(directory, "divided-label.webp");
  try {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="400" height="1000">
        <rect width="400" height="1000" fill="#fff"/>
        <path d="M150 10 H250 V210 Q330 300 330 440 V940 Q320 985 270 990 H130 Q80 985 70 940 V440 Q70 300 150 210 Z" fill="#17120f"/>
        <rect x="76" y="535" width="248" height="315" rx="3" fill="#dba744" stroke="#c68c29" stroke-width="4"/>
        <rect x="77" y="643" width="246" height="8" fill="#8a5a1f"/>
        <rect x="105" y="575" width="190" height="22" fill="#7b5121"/>
        <rect x="95" y="690" width="210" height="28" fill="#68461f"/>
        <rect x="125" y="760" width="150" height="18" fill="#68461f"/>
      </svg>`;
    await sharp(Buffer.from(svg)).webp().toFile(imagePath);
    const result = await runLabelDetection(imagePath, 400, 1000, { previewMaxSide: 320 });
    assert.ok(rectIoU(result.candidates[0]!.bbox, { x: 76, y: 535, width: 248, height: 315 }) >= .78, JSON.stringify(result.candidates));
    const sameShell = result.candidates.filter((candidate) => candidate.bbox.x <= 90 && candidate.bbox.x + candidate.bbox.width >= 310);
    assert.equal(sameShell.length, 1, JSON.stringify(result.candidates));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("post-consensus merges aligned top and bottom fragments instead of exposing two Labels", () => {
  const candidate = (id: string, bbox: DetectorCandidate["bbox"]): DetectorCandidate => ({
    id,
    bbox,
    polygon: [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y], [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]],
    score: .82,
    metrics: { edgeSupport: .8, rectangularity: .9, solidity: .9, stability: .8, areaRatio: bbox.width * bbox.height / 400_000 },
    detection: { passId: "multi-profile-consensus", passIds: ["horizontal-balanced", "color-boundary-soft"], config: { families: ["edge", "color"], contributors: [{ candidateId: id }] } },
  });
  const result = mergeAlignedConsensusFragments([
    candidate("upper", { x: 76, y: 535, width: 248, height: 145 }),
    candidate("lower", { x: 78, y: 625, width: 244, height: 225 }),
  ], 400, 1000);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0]!.bbox, { x: 76, y: 535, width: 248, height: 315 });
  assert.deepEqual(result.merges[0]!.sourceCandidateIds, ["upper", "lower"]);
});

test("package material evidence survives family aggregation on a dark bottle", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "label-package-material-"));
  const imagePath = path.join(directory, "dark-bottle.webp");
  try {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="348" height="1080">
        <rect width="348" height="1080" fill="#fff"/>
        <path d="M135 5 H213 V175 Q302 300 322 545 V1035 Q315 1072 270 1076 H78 Q33 1072 26 1035 V545 Q46 300 135 175 Z" fill="#171815"/>
        <rect x="135" y="82" width="78" height="68" fill="#eeeeea"/>
        <rect x="151" y="108" width="46" height="12" fill="#39352b"/>
        <path d="M43 845 H305 V987 H43 Z" fill="#ecece8"/>
        <rect x="88" y="892" width="172" height="22" fill="#30302d"/>
        <rect x="112" y="940" width="124" height="14" fill="#5a5a55"/>
      </svg>`;
    await sharp(Buffer.from(svg)).webp().toFile(imagePath);
    const context = {
      bbox: { x: 26, y: 5, width: 296, height: 1071 },
      contour: [[135, 5], [213, 5], [213, 175], [302, 300], [322, 545], [322, 1035], [315, 1072], [270, 1076], [78, 1076], [33, 1072], [26, 1035], [26, 545], [46, 300], [135, 175]] as Array<[number, number]>,
      packageType: "bottle" as const,
      source: "accepted-package-helper" as const,
    };
    const result = await runLabelDetection(imagePath, 348, 1080, undefined, context);
    const materialPass = result.passes.find((pass) => pass.id === "package-material-deviation");
    assert.ok(materialPass && Number(materialPass.stats.acceptedCount) >= 1, JSON.stringify(result.debug));
    assert.ok(result.candidates.some((candidate) => candidate.detection.passIds.includes("package-material-deviation")), JSON.stringify(result.candidates));
    assert.ok(result.candidates.some((candidate) => rectIoU(candidate.bbox, { x: 43, y: 845, width: 262, height: 142 }) >= .72), JSON.stringify(result.candidates));
    assert.ok(result.candidates.some((candidate) => rectIoU(candidate.bbox, { x: 135, y: 82, width: 78, height: 68 }) >= .65), JSON.stringify(result.candidates));
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function rectIoU(left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }) {
  const x1 = Math.max(left.x, right.x); const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width); const y2 = Math.min(left.y + left.height, right.y + right.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return intersection / Math.max(1, left.width * left.height + right.width * right.height - intersection);
}
