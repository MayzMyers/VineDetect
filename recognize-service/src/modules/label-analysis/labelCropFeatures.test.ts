import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildElementContours, buildElements, DEFAULT_LABEL_ANALYSIS_CV_CONFIG, quantizedPalette, searchComponentVariants, searchMaskVariants, searchMorphologyVariants } from "./labelCropFeatures.js";

test("palette groups discretized shades before filtering and selecting basic colors", () => {
  const samples: Array<[[number, number, number], number]> = [
    [[224, 224, 224], 70], [[192, 192, 192], 20],
    [[32, 32, 32], 35], [[64, 64, 64], 10],
    [[160, 192, 96], 25], [[128, 160, 96], 15],
    [[64, 128, 96], 20],
    [[230, 55, 55], 6], [[215, 45, 50], 6],
  ];
  const data = Buffer.from(samples.flatMap(([rgb, count]) => Array.from({ length: count }, () => rgb).flat()));
  const palette = quantizedPalette(data, 3, 5, .05);
  assert.equal(palette.length, 5);
  assert.equal(palette.filter((color) => Math.max(...color.rgb) - Math.min(...color.rgb) < 10).length, 2);
  assert.equal(palette.filter((color) => color.rgb[1] > color.rgb[0] && color.rgb[1] > color.rgb[2]).length, 2);
  const red = palette.find((color) => color.rgb[0] > color.rgb[1] * 2 && color.rgb[0] > color.rgb[2] * 2);
  assert.ok(red, "red survives because its separate RGB bins are grouped before the minimum-ratio filter");
  assert.equal(red.ratio, Math.round(12 / 207 * 10000) / 10000);
  assert.deepEqual(palette[0]?.rgb, [224, 224, 224]);
});

test("palette minimum ratio applies to whole color families", () => {
  const data = Buffer.from([...
    Array.from({ length: 90 }, () => [220, 220, 220]),
    ...Array.from({ length: 6 }, () => [230, 55, 55]),
    ...Array.from({ length: 6 }, () => [215, 45, 50]),
  ].flat());
  assert.equal(quantizedPalette(data, 3, 5, .1).length, 2);
  assert.equal(quantizedPalette(data, 3, 5, .15).length, 1);
});

type InputComponent = Parameters<typeof buildElements>[0][number];

function component(id: number, x: number, y: number): InputComponent {
  return {
    id,
    area: 20,
    bbox: { x, y, width: 0.04, height: 0.08 },
    centroid: { x: x + 0.02, y: y + 0.04 },
    accepted: true,
    proposalAccepted: true,
    touchesBorder: false,
    areaRatio: 0.002,
    width: 10,
    height: 20,
    aspectRatio: 0.5,
    fillRatio: 0.8,
    borderTouch: { top: false, right: false, bottom: false, left: false },
    reviewStatus: "unreviewed",
  };
}

test("OCR line groups disconnected components into one text element", () => {
  const elements = buildElements(
    [component(1, 0.1, 0.2), component(2, 0.16, 0.2), component(3, 0.75, 0.7)],
    [],
    [{ id: "ocr-line-1", level: "line", bbox: { x: 0.08, y: 0.18, width: 0.16, height: 0.12 }, text: "FANAGORIA", confidence: 91 }],
  );

  const text = elements.find((element) => element.provenance?.sourceRef?.id === "ocr-line-1");
  assert.ok(text);
  assert.deepEqual(text.sourceComponentIds, [1, 2]);
  assert.equal(text.type, "text");
  assert.equal(text.text, "FANAGORIA");
  assert.equal(text.provenance?.source, "ocr");
  assert.deepEqual(text.provenance?.sourceRef, { kind: "ocr-region", id: "ocr-line-1" });
  assert.equal(text.provenance?.grouping?.method, "ocr-overlap");
  assert.equal(typeof text.provenance?.grouping?.confidence, "number");

  const geometric = elements.find((element) => element.sourceComponentIds.includes(3));
  assert.ok(geometric);
  assert.equal(geometric.provenance?.source, "geometry");
  assert.equal(geometric.provenance?.grouping?.method, "proximity");
});

test("an explicitly reviewed empty element list stays empty", () => {
  const elements = buildElements(
    [component(1, 0.1, 0.2), component(2, 0.16, 0.2)],
    [],
    [{ id: "ocr-line-1", level: "line", bbox: { x: 0.08, y: 0.18, width: 0.16, height: 0.12 }, text: "FANAGORIA", confidence: 91 }],
    true,
  );

  assert.deepEqual(elements, []);
});

test("legacy semantic labels are normalized without losing component membership", () => {
  const [element] = buildElements([component(1, 0.1, 0.2)], [{
    id: "legacy-logo", sourceComponentIds: [1], type: "logo", status: "accepted",
  }], [], true);

  assert.ok(element);
  assert.equal(element.type, "graphic");
  assert.equal(element.role, "logo");
  assert.deepEqual(element.sourceComponentIds, [1]);
});

test("legacy OCR element fields migrate into canonical provenance", () => {
  const [element] = buildElements([component(1, 0.1, 0.2)], [{
    id: "legacy-ocr", sourceComponentIds: [1], type: "text", status: "accepted",
    textRegionId: "ocr-line-legacy", confidence: 88,
    provenance: { source: "ocr", confidence: 0.73, grouping: { method: "ocr-overlap" } },
  }], [], true);

  assert.ok(element);
  assert.deepEqual(element.provenance, {
    source: "ocr",
    sourceRef: { kind: "ocr-region", id: "ocr-line-legacy" },
    grouping: { method: "ocr-overlap", confidence: 0.73 },
  });
  assert.equal("textRegionId" in element, false);
  assert.equal("confidence" in element, false);
});

test("a reviewed component belongs to at most one semantic object", () => {
  const elements = buildElements([component(1, 0.1, 0.2), component(2, 0.2, 0.2)], [
    { id: "first", sourceComponentIds: [1], type: "text", status: "accepted" },
    { id: "duplicate", sourceComponentIds: [1, 2], type: "graphic", status: "accepted" },
  ], [], true);

  assert.deepEqual(elements.map((element) => [element.id, element.sourceComponentIds]), [["first", [1]], ["duplicate", [2]]]);
});

test("contours exclude accepted components that are not assigned to an element", () => {
  const width = 100; const height = 100; const mask = new Uint8Array(width * height);
  for (const [left, top] of [[10, 20], [60, 20]]) {
    for (let y = top; y < top + 8; y += 1) for (let x = left; x < left + 4; x += 1) mask[y * width + x] = 1;
  }
  const grouped = component(1, 0.1, 0.2);
  const ungrouped = component(2, 0.6, 0.2);
  const contours = buildElementContours(mask, width, height, [grouped, ungrouped], [{
    id: "group-1", bbox: grouped.bbox, sourceComponentIds: [1], type: "text", status: "accepted", source: "modified",
  }], DEFAULT_LABEL_ANALYSIS_CV_CONFIG);

  assert.deepEqual(contours.map((contour) => contour.componentId), [1]);
  assert.ok(contours.every((contour) => contour.elementId === "group-1"));
});

test("contours trace a concave boundary in edge order and emit automatic Bezier segments", () => {
  const width = 24; const height = 24; const mask = new Uint8Array(width * height);
  for (let y = 4; y < 18; y += 1) for (let x = 4; x < 9; x += 1) mask[y * width + x] = 1;
  for (let y = 13; y < 18; y += 1) for (let x = 9; x < 19; x += 1) mask[y * width + x] = 1;
  const shape = { ...component(1, 4 / width, 4 / height), bbox: { x: 4 / width, y: 4 / height, width: 15 / width, height: 14 / height } };
  const contours = buildElementContours(mask, width, height, [shape], [{ id: "ornament", bbox: shape.bbox, sourceComponentIds: [1], type: "graphic", role: "ornament", status: "accepted", source: "modified" }], DEFAULT_LABEL_ANALYSIS_CV_CONFIG);

  assert.equal(contours.length, 1);
  const contour = contours[0]!;
  assert.equal(contour.ringKind, "outer");
  assert.equal(contour.vectorization, "bezier");
  assert.equal(contour.bezier?.segments.length, contour.points.length);
  for (let index = 0; index < contour.rawPoints.length; index += 1) {
    const point = contour.rawPoints[index]!; const next = contour.rawPoints[(index + 1) % contour.rawPoints.length]!;
    const pixelDistance = Math.abs(point[0] - next[0]) * width + Math.abs(point[1] - next[1]) * height;
    assert.ok(Math.abs(pixelDistance - 1) < 0.003, `boundary jump ${pixelDistance} at ${index}`);
  }
});

test("contours preserve holes as separate rings", () => {
  const width = 24; const height = 24; const mask = new Uint8Array(width * height);
  for (let y = 3; y < 21; y += 1) for (let x = 3; x < 21; x += 1) if (x < 8 || x >= 16 || y < 8 || y >= 16) mask[y * width + x] = 1;
  const shape = { ...component(1, 3 / width, 3 / height), bbox: { x: 3 / width, y: 3 / height, width: 18 / width, height: 18 / height } };
  const contours = buildElementContours(mask, width, height, [shape], [{ id: "badge", bbox: shape.bbox, sourceComponentIds: [1], type: "graphic", status: "accepted", source: "modified" }], DEFAULT_LABEL_ANALYSIS_CV_CONFIG);

  assert.deepEqual(contours.map((contour) => contour.ringKind).sort(), ["hole", "outer"]);
});

test("8-connectivity keeps diagonally touching ornament pixels in one reviewed component", () => {
  const width = 12; const height = 12; const mask = new Uint8Array(width * height);
  mask[4 * width + 4] = 1; mask[5 * width + 5] = 1;
  const shape = { ...component(1, 4 / width, 4 / height), bbox: { x: 4 / width, y: 4 / height, width: 2 / width, height: 2 / height } };
  const element = { id: "ornament", bbox: shape.bbox, sourceComponentIds: [1], type: "graphic" as const, role: "ornament" as const, status: "accepted" as const, source: "modified" as const };
  const fourConnected = buildElementContours(mask, width, height, [shape], [element], { ...DEFAULT_LABEL_ANALYSIS_CV_CONFIG, componentConnectivity: 4 });
  const eightConnected = buildElementContours(mask, width, height, [shape], [element], { ...DEFAULT_LABEL_ANALYSIS_CV_CONFIG, componentConnectivity: 8 });

  assert.equal(fourConnected.length, 1);
  assert.equal(eightConnected.length, 2);
  assert.ok(eightConnected.every((contour) => contour.componentId === 1));
});

test("component auto helper compares both connectivity modes and safely recommends diagonal merging", () => {
  const width = 32; const height = 32; const mask = new Uint8Array(width * height);
  for (const [x, y] of [[4, 4], [5, 5], [10, 4], [11, 5], [16, 4], [21, 4], [16, 10], [21, 10]]) mask[y! * width + x!] = 1;
  const result = searchComponentVariants(mask, width, height, DEFAULT_LABEL_ANALYSIS_CV_CONFIG);

  assert.equal(result.generatedCount, 2);
  assert.deepEqual(new Set(result.candidates.map((candidate) => candidate.config.componentConnectivity)), new Set([4, 8]));
  assert.equal(result.selected.config.componentConnectivity, 8);
  assert.ok(result.selected.metrics.diagonalMergeCount > 0);
});

test("morphology auto helper searches a broad deterministic ladder and exposes a bounded diverse shortlist", () => {
  const width = 32; const height = 24; const mask = new Uint8Array(width * height);
  for (let y = 6; y < 18; y += 1) for (let x = 5; x < 12; x += 1) mask[y * width + x] = 1;
  for (let y = 6; y < 18; y += 1) for (let x = 14; x < 21; x += 1) mask[y * width + x] = 1;
  mask[2 * width + 27] = 1;

  const result = searchMorphologyVariants(mask, width, height, DEFAULT_LABEL_ANALYSIS_CV_CONFIG);

  assert.equal(result.generatedCount, 27);
  assert.equal(result.evaluations.length, 27);
  assert.ok(result.evaluations.every((candidate) => !("mask" in candidate)));
  assert.ok(result.shortlist.length >= 2 && result.shortlist.length <= 4);
  assert.equal(new Set(result.shortlist.map((candidate) => candidate.id)).size, result.shortlist.length);
  assert.ok(result.shortlist.some((candidate) => candidate.id === "morph-identity"));
  const identity = result.shortlist.find((candidate) => candidate.id === "morph-identity");
  assert.equal(identity?.config.morphologyEnabled, true);
  assert.deepEqual(identity?.config.morphologyPipeline, []);
  assert.ok(result.shortlist.every((candidate) => candidate.mask.encoding === "rle-u8"));
  assert.ok(result.shortlist.every((candidate) => Number.isFinite(candidate.metrics.connectedComponentCount)));
  assert.ok(result.selected.config.morphologyMode === "manual");
});

test("binary mask auto helper searches polarity, Otsu threshold ladder, and working resolution", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vinedetect-mask-search-")); const imagePath = path.join(directory, "label.png");
  try {
    await sharp({ create: { width: 160, height: 100, channels: 3, background: "#f5f5ef" } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect x="20" y="24" width="120" height="52" rx="4" fill="#172033"/><text x="42" y="60" font-size="26" fill="#fafafa">VIBES</text></svg>') }]).png().toFile(imagePath);
    const result = await searchMaskVariants(imagePath, DEFAULT_LABEL_ANALYSIS_CV_CONFIG);
    assert.equal(result.generatedCount, 30);
    assert.equal(result.evaluations.length, 30);
    assert.equal(result.shortlist.length, 4);
    assert.ok(new Set(result.shortlist.map((candidate) => candidate.family)).size >= 2);
    assert.ok(new Set(result.shortlist.map((candidate) => candidate.config.maskSize)).size >= 2);
    assert.ok(result.shortlist.every((candidate) => candidate.mask.encoding === "rle-u8"));
    assert.ok(result.shortlist.every((candidate) => Number.isFinite(candidate.metrics.textLikeRegionCoverage)));
    assert.equal(result.selected.config.maskMode, "candidate");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
