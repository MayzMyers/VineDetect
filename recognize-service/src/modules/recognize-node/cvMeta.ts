import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import sharp from "sharp";
import { env } from "../../config/env.js";
import type { ColorZone, CvMetaV1, NormalizedRect } from "../../shared/types.js";

const EXTRACTOR_VERSION = "cv-meta-sharp-v3";
const GRID_COLUMNS = 3;
const GRID_ROWS = 4;

type RawRaster = {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
  contentRect?: PixelRect;
};

type Component = {
  id?: number;
  area: number;
  bbox: PixelRect;
  centroid: { x: number; y: number };
};

type PixelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ColorSummary = {
  averageRgb: [number, number, number];
  averageLab: [number, number, number];
  dominantRgb: Array<{ value: [number, number, number]; ratio: number }>;
};

type LabelCandidateSource =
  | "color-component"
  | "color-union"
  | "sliding-window"
  | "projection-profile"
  | "chromatic-plane"
  | "salient-container";

type LabelCandidate = {
  roi: NormalizedRect;
  source: LabelCandidateSource;
  confidence: number;
  score: number;
  edgeDensity: number;
  colorContrast: number;
  positionScore: number;
  areaRatio: number;
  features: Record<string, number>;
  contributions: Record<string, number>;
  penalties: Record<string, number>;
};

type ComponentMap = {
  components: Component[];
  labelMap: Uint16Array;
  maxLabel: number;
};

type ForegroundMaskCandidate = {
  method: string;
  mask: Uint8Array;
};

export type CvPipelineConfigSnapshot = {
  color?: {
    distanceThreshold?: number;
  };
  morphology?: {
    enabled?: boolean;
    operation?: string;
    kernelWidth?: number;
    kernelHeight?: number;
    iterations?: number;
  };
  selection?: {
    minScore?: number;
    maxCandidates?: number;
  };
};

type RuntimeCvConfig = {
  colorDistanceThreshold: number;
  morphologyEnabled: boolean;
  morphologyKernelWidth: number;
  morphologyKernelHeight: number;
  morphologyIterations: number;
  minScore: number;
  maxCandidates: number;
};

const DEFAULT_CV_CONFIG: RuntimeCvConfig = {
  colorDistanceThreshold: 22,
  morphologyEnabled: true,
  morphologyKernelWidth: 3,
  morphologyKernelHeight: 3,
  morphologyIterations: 1,
  minScore: 0.18,
  maxCandidates: 12,
};

function normalizeCvConfig(config: CvPipelineConfigSnapshot | undefined): RuntimeCvConfig {
  return {
    colorDistanceThreshold: clampNumber(config?.color?.distanceThreshold, 8, 140, DEFAULT_CV_CONFIG.colorDistanceThreshold),
    morphologyEnabled: config?.morphology?.enabled ?? DEFAULT_CV_CONFIG.morphologyEnabled,
    morphologyKernelWidth: clampInteger(config?.morphology?.kernelWidth, 1, 21, DEFAULT_CV_CONFIG.morphologyKernelWidth),
    morphologyKernelHeight: clampInteger(config?.morphology?.kernelHeight, 1, 21, DEFAULT_CV_CONFIG.morphologyKernelHeight),
    morphologyIterations: clampInteger(config?.morphology?.iterations, 1, 5, DEFAULT_CV_CONFIG.morphologyIterations),
    minScore: clampNumber(config?.selection?.minScore, 0, 1, DEFAULT_CV_CONFIG.minScore),
    maxCandidates: clampInteger(config?.selection?.maxCandidates, 1, 50, DEFAULT_CV_CONFIG.maxCandidates),
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  return Math.round(clampNumber(value, min, max, fallback));
}

const recognitionGray = new WeakMap<RawRaster, Uint8Array>();

/**
 * V5 front-label ROI only. Same raster, segmentation and bottle/label selectors
 * as extractCvMetaFromFile; deliberately omits hashes, colors, OCR and metadata.
 * Coordinates are normalized to the supplied target-bottle image.
 */
export async function extractRecognitionLabelRoi(image: Buffer, config?: CvPipelineConfigSnapshot) {
  const warnings: string[] = [];
  const analysis = await loadRaster(image, env.CV_ANALYSIS_LONG_SIDE);
  const segmentation = padRasterForSegmentation(analysis);
  recognitionGray.set(segmentation, grayscale(segmentation));
  const background = classifyBackground(segmentation);
  const foreground = buildForegroundMask(segmentation, background.averageRgb);
  const component = selectLargestComponent(foreground, segmentation.width, segmentation.height);
  const bottle = buildBottleDescriptor(component, foreground, segmentation, warnings);
  return buildLabelDescriptor(bottle.roi, segmentation, warnings, normalizeCvConfig(config), false).roi;
}

export async function extractCvMetaFromFile(filePath: string, imageId: string, config?: CvPipelineConfigSnapshot): Promise<CvMetaV1> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const runtimeConfig = normalizeCvConfig(config);
  const file = await stat(filePath);
  if (file.size > env.CV_MAX_FILE_BYTES) {
    throw new Error(`Image exceeds CV_MAX_FILE_BYTES: ${file.size}`);
  }

  const checksum = await checksumFile(filePath);
  const image = sharp(filePath, {
    failOn: "none",
    limitInputPixels: env.CV_MAX_INPUT_PIXELS,
  }).rotate();
  const metadata = await image.metadata();
  const dimensions = autoOrientedDimensions(metadata.width ?? 0, metadata.height ?? 0, metadata.orientation);
  const width = dimensions.width;
  const height = dimensions.height;
  if (!width || !height) warnings.push("SOURCE_DIMENSIONS_MISSING");

  const analysis = await loadRaster(filePath, env.CV_ANALYSIS_LONG_SIDE);
  const segmentation = padRasterForSegmentation(analysis);
  const sourceColors = summarizeColors(analysis);
  const zones = buildColorZones(analysis);
  const quality = inspectQuality(analysis, warnings);
  const background = classifyBackground(segmentation);
  const foregroundMask = buildForegroundMask(segmentation, background.averageRgb);
  const component = selectLargestComponent(foregroundMask, segmentation.width, segmentation.height);
  const bottle = buildBottleDescriptor(component, foregroundMask, segmentation, warnings);
  const label = buildLabelDescriptor(bottle.roi, segmentation, warnings, runtimeConfig);
  const hashes = {
    sourceDHash: await computeDHash(filePath),
    sourcePHash: await computePHash(filePath),
    bottleDHash: bottle.roi ? await computeDHash(filePath, denormalizeRect(bottle.roi, width, height)) : null,
    labelDHash: label.roi ? await computeDHash(filePath, denormalizeRect(label.roi, width, height)) : null,
  };

  const bottleColors = bottle.roi ? summarizeColors(analysis, denormalizeRect(bottle.roi, analysis.width, analysis.height)) : null;
  const labelColors = label.roi ? summarizeColors(analysis, denormalizeRect(label.roi, analysis.width, analysis.height)) : null;
  const sourceScore = calculateSourceScore(quality, bottle.confidence, label.confidence, warnings);

  return {
    schemaVersion: 2,
    extractorVersion: EXTRACTOR_VERSION,
    source: {
      imageId,
      width,
      height,
      aspectRatio: height ? round(width / height, 4) : 0,
    },
    sourceImage: {
      imageId,
      relativePath: imageId,
      checksum,
      format: metadata.format ?? "unknown",
      width,
      height,
      orientation: metadata.orientation ?? null,
      channels: metadata.channels ?? null,
      hasAlpha: Boolean(metadata.hasAlpha),
      fileSize: file.size,
    },
    quality: {
      sourceScore,
      sharpness: quality.sharpness,
      exposure: quality.exposure,
      warnings,
    },
    background: {
      type: background.type,
      confidence: background.confidence,
      averageRgb: background.averageRgb,
      averageLab: rgbToLab(background.averageRgb[0], background.averageRgb[1], background.averageRgb[2]),
      borderVariance: background.borderVariance,
    },
    foreground: {
      found: Boolean(component),
      confidence: bottle.confidence,
      method: "multi-mask-product-image",
      coverage: component ? round(component.area / (segmentation.width * segmentation.height), 4) : 0,
      roi: component ? normalizeRectToContent(component.bbox, segmentation) : null,
      refinedBottleRoi: bottle.roi,
      segmentationRaster: {
        width: segmentation.width,
        height: segmentation.height,
        contentRect: segmentation.contentRect ?? null,
      },
    },
    bottle: {
      detection: {
        found: Boolean(bottle.roi),
        confidence: bottle.confidence,
        origin: bottle.origin,
        warnings: bottle.warnings,
      },
      roi: bottle.roi,
      silhouette: bottle.silhouette,
      colors: bottleColors,
    },
    label: {
      detection: {
        found: Boolean(label.roi),
        confidence: label.confidence,
        origin: label.origin,
        warnings: label.warnings,
      },
      roi: label.roi,
      polygon: label.roi ? rectToPolygon(label.roi) : null,
      layout: label.layout,
      debug: label.debug ?? null,
      colors: labelColors,
    },
    colors: {
      source: sourceColors,
      bottle: bottleColors,
      label: labelColors,
      zones,
    },
    color: {
      averageLab: sourceColors.averageLab,
      dominantLab: sourceColors.dominantRgb.map((color) => ({ value: rgbToLab(...color.value), ratio: color.ratio })),
      zones,
    },
    geometry: {
      bottleRoi: bottle.roi,
      labelRoi: label.roi,
      silhouette: bottle.silhouette,
    },
    hashes: {
      dHash: hashes.sourceDHash,
      ...hashes,
    },
    ocr: {
      enabled: env.CV_OCR_ENABLED,
      status: env.CV_OCR_ENABLED ? "not-implemented" : "disabled",
      observations: [],
      consensusText: "",
      consensusTokens: [],
      variants: label.roi
        ? [
            { id: "label-canonical", roi: label.roi, transform: "none" },
            { id: "label-grayscale", roi: label.roi, transform: "grayscale" },
            { id: "label-threshold", roi: label.roi, transform: "threshold" },
          ]
        : [],
      warnings: env.CV_OCR_ENABLED ? ["OCR_NOT_IMPLEMENTED"] : ["OCR_DISABLED"],
    },
    diagnostics: {
      pipelineVersion: env.CV_PIPELINE_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      runtimeConfig: {
        colorDistanceThreshold: runtimeConfig.colorDistanceThreshold,
        morphologyEnabled: runtimeConfig.morphologyEnabled,
        morphologyKernelWidth: runtimeConfig.morphologyKernelWidth,
        morphologyKernelHeight: runtimeConfig.morphologyKernelHeight,
        morphologyIterations: runtimeConfig.morphologyIterations,
        minScore: runtimeConfig.minScore,
        maxCandidates: runtimeConfig.maxCandidates,
      },
      durationMs: Date.now() - startedAt,
      analysisRaster: {
        width: analysis.width,
        height: analysis.height,
      },
      segmentationRaster: {
        width: segmentation.width,
        height: segmentation.height,
        contentRect: segmentation.contentRect ?? null,
      },
      debugArtifactsEnabled: env.CV_DEBUG_ARTIFACTS,
      debugRoot: env.CV_DEBUG_ARTIFACTS ? env.CV_DEBUG_ROOT : null,
      stages: [
        "source",
        "quality",
        "background",
        "foreground",
        "bottle",
        "label",
        "colors",
        "hashes",
        "ocr-placeholder",
      ],
    },
  };
}

async function loadRaster(filePath: string | Buffer, longSide: number): Promise<RawRaster> {
  const raw = await sharp(filePath, { failOn: "none", limitInputPixels: env.CV_MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: longSide, height: longSide, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: raw.data, width: raw.info.width, height: raw.info.height, channels: raw.info.channels };
}

function padRasterForSegmentation(raster: RawRaster): RawRaster {
  const padX = Math.max(12, Math.round(raster.width * 0.18));
  const padY = Math.max(12, Math.round(raster.height * 0.06));
  const width = raster.width + padX * 2;
  const height = raster.height + padY * 2;
  const channels = raster.channels;
  const background = estimatePaddingColor(raster);
  const data = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      data[offset] = background[0];
      data[offset + 1] = background[1];
      data[offset + 2] = background[2];
      if (channels >= 4) data[offset + 3] = 255;
    }
  }

  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const sourceOffset = (y * raster.width + x) * channels;
      const targetOffset = ((y + padY) * width + x + padX) * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        data[targetOffset + channel] = raster.data[sourceOffset + channel] ?? (channel === 3 ? 255 : 0);
      }
    }
  }

  return {
    data,
    width,
    height,
    channels,
    contentRect: { x: padX, y: padY, width: raster.width, height: raster.height },
  };
}

function estimatePaddingColor(raster: RawRaster): [number, number, number] {
  const border = collectBorderPixels(raster);
  const average = averageRgb(border);
  const luma = average[0] * 0.299 + average[1] * 0.587 + average[2] * 0.114;
  return luma > 180 ? average : [250, 247, 240];
}

async function checksumFile(filePath: string) {
  const buffer = await sharp(filePath, { failOn: "none" }).metadata().then(() => import("node:fs/promises").then((fs) => fs.readFile(filePath)));
  return createHash("sha256").update(buffer).digest("hex");
}

function inspectQuality(raster: RawRaster, warnings: string[]) {
  const sharpness = estimateSharpness(raster);
  const exposure = estimateExposure(raster);
  if (sharpness < 25) warnings.push("LOW_SHARPNESS");
  if (exposure.underexposedRatio > 0.35) warnings.push("UNDEREXPOSED");
  if (exposure.overexposedRatio > 0.35) warnings.push("OVEREXPOSED");
  if (raster.width < 320 || raster.height < 320) warnings.push("LOW_RESOLUTION");
  return { sharpness, exposure };
}

function estimateSharpness(raster: RawRaster) {
  const gray = grayscale(raster);
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < raster.height - 1; y += 2) {
    for (let x = 1; x < raster.width - 1; x += 2) {
      const center = gray[y * raster.width + x] ?? 0;
      const laplacian =
        (gray[(y - 1) * raster.width + x] ?? 0) +
        (gray[(y + 1) * raster.width + x] ?? 0) +
        (gray[y * raster.width + x - 1] ?? 0) +
        (gray[y * raster.width + x + 1] ?? 0) -
        4 * center;
      sum += laplacian;
      sumSq += laplacian * laplacian;
      count += 1;
    }
  }
  const mean = sum / Math.max(1, count);
  return round(sumSq / Math.max(1, count) - mean * mean, 2);
}

function estimateExposure(raster: RawRaster) {
  const gray = grayscale(raster);
  let dark = 0;
  let bright = 0;
  let sum = 0;
  for (const value of gray) {
    if (value < 24) dark += 1;
    if (value > 235) bright += 1;
    sum += value;
  }
  return {
    meanLuma: round(sum / Math.max(1, gray.length), 2),
    underexposedRatio: round(dark / Math.max(1, gray.length), 4),
    overexposedRatio: round(bright / Math.max(1, gray.length), 4),
  };
}

function classifyBackground(raster: RawRaster) {
  const borderPixels = collectBorderPixels(raster);
  const backgroundAverageRgb = averageRgb(borderPixels);
  const variance = averageColorDistance(borderPixels, backgroundAverageRgb);
  return {
    type: variance < 18 ? "solid" : variance < 38 ? "soft-gradient" : "complex",
    confidence: variance < 18 ? 0.9 : variance < 38 ? 0.65 : 0.35,
    averageRgb: backgroundAverageRgb,
    borderVariance: round(variance, 2),
  };
}

function buildForegroundMask(raster: RawRaster, backgroundRgb: [number, number, number]) {
  const candidates: ForegroundMaskCandidate[] = [];
  for (const candidate of [
    buildAlphaForegroundMask(raster),
    buildWhiteBackgroundForegroundMask(raster),
    buildBorderDistanceForegroundMask(raster, backgroundRgb),
  ]) {
    if (candidate) candidates.push(candidate);
  }

  let best: ForegroundMaskCandidate = candidates[0] ?? { method: "empty", mask: new Uint8Array(raster.width * raster.height) };
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const score = scoreForegroundMask(candidate.mask, raster.width, raster.height);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best.mask;
}

function buildAlphaForegroundMask(raster: RawRaster) {
  if (raster.channels < 4) return null;
  let transparent = 0;
  let opaque = 0;
  const mask = new Uint8Array(raster.width * raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const alpha = raster.data[(y * raster.width + x) * raster.channels + 3] ?? 255;
      if (alpha < 245) transparent += 1;
      if (alpha > 32) {
        opaque += 1;
        mask[y * raster.width + x] = 1;
      }
    }
  }
  const transparentRatio = transparent / Math.max(1, raster.width * raster.height);
  const opaqueRatio = opaque / Math.max(1, raster.width * raster.height);
  if (transparentRatio < 0.01 || opaqueRatio > 0.97) return null;
  clearBorder(mask, raster.width, raster.height);
  return { method: "alpha", mask };
}

function buildWhiteBackgroundForegroundMask(raster: RawRaster) {
  const mask = new Uint8Array(raster.width * raster.height);
  let foreground = 0;
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const offset = (y * raster.width + x) * raster.channels;
      const rgb: [number, number, number] = [
        raster.data[offset] ?? 0,
        raster.data[offset + 1] ?? 0,
        raster.data[offset + 2] ?? 0,
      ];
      const alpha = raster.channels >= 4 ? raster.data[offset + 3] ?? 255 : 255;
      if (alpha < 32) continue;
      if (!isNearWhite(rgb)) {
        mask[y * raster.width + x] = 1;
        foreground += 1;
      }
    }
  }
  const ratio = foreground / Math.max(1, raster.width * raster.height);
  if (ratio < 0.02 || ratio > 0.9) return null;
  closeMask(mask, raster.width, raster.height, { x: 0, y: 0, width: raster.width, height: raster.height });
  clearBorder(mask, raster.width, raster.height);
  return { method: "white-background", mask };
}

function buildBorderDistanceForegroundMask(raster: RawRaster, backgroundRgb: [number, number, number]) {
  const mask = new Uint8Array(raster.width * raster.height);
  const threshold = 32;
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const offset = (y * raster.width + x) * raster.channels;
      const alpha = raster.channels >= 4 ? raster.data[offset + 3] ?? 255 : 255;
      if (alpha < 32) continue;
      const rgb: [number, number, number] = [
        raster.data[offset] ?? 0,
        raster.data[offset + 1] ?? 0,
        raster.data[offset + 2] ?? 0,
      ];
      if (colorDistance(rgb, backgroundRgb) > threshold) {
        mask[y * raster.width + x] = 1;
      }
    }
  }
  clearBorder(mask, raster.width, raster.height);
  return { method: "border-color-distance", mask };
}

function scoreForegroundMask(mask: Uint8Array, width: number, height: number) {
  const component = selectLargestComponent(mask, width, height);
  if (!component) return -1;
  const coverage = component.area / Math.max(1, width * height);
  const bboxCoverage = (component.bbox.width * component.bbox.height) / Math.max(1, width * height);
  const aspect = component.bbox.height / Math.max(1, component.bbox.width);
  const centerOffset = Math.abs((component.centroid.x / width) - 0.5);
  let score = 0;
  score += clamp01((aspect - 1.8) / 4) * 0.35;
  score += clamp01(1 - centerOffset / 0.35) * 0.2;
  score += clamp01((coverage - 0.06) / 0.5) * 0.2;
  score += clamp01(1 - Math.max(0, bboxCoverage - 0.82) / 0.18) * 0.25;
  if (coverage > 0.88) score -= 0.7;
  if (bboxCoverage > 0.9) score -= 0.7;
  if (component.bbox.width >= width * 0.96 && component.bbox.height >= height * 0.96) score -= 0.8;
  return score;
}

function isNearWhite(rgb: [number, number, number]) {
  const max = Math.max(...rgb);
  const min = Math.min(...rgb);
  const luma = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
  return luma > 236 && max - min < 28;
}

function selectLargestComponent(mask: Uint8Array, width: number, height: number): Component | null {
  const visited = new Uint8Array(mask.length);
  let best: Component | null = null;
  const queue = new Int32Array(mask.length);

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || visited[index]) continue;
    let head = 0;
    let tail = 0;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    queue[tail] = index;
    tail += 1;
    visited[index] = 1;

    while (head < tail) {
      const current = queue[head] ?? 0;
      head += 1;
      const x = current % width;
      const y = Math.floor(current / width);
      area += 1;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      for (const next of [current - 1, current + 1, current - width, current + width]) {
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
        const nx = next % width;
        if (Math.abs(nx - x) > 1) continue;
        visited[next] = 1;
        queue[tail] = next;
        tail += 1;
      }
    }

    const component = {
      area,
      bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      centroid: { x: sumX / Math.max(1, area), y: sumY / Math.max(1, area) },
    };
    if (!best || component.area > best.area) best = component;
  }

  return best && best.area > width * height * 0.02 ? best : null;
}

function buildBottleDescriptor(component: Component | null, mask: Uint8Array, raster: RawRaster, warnings: string[]) {
  const localWarnings: string[] = [];
  if (!component) {
    warnings.push("BOTTLE_FOREGROUND_NOT_FOUND");
    localWarnings.push("BOTTLE_FOREGROUND_NOT_FOUND");
    return { roi: null, confidence: 0, origin: "fallback", warnings: localWarnings, silhouette: null };
  }

  const refined = refineBottleBodyRect(component, mask, raster.width, raster.height);
  const roi = normalizeRectToContent(refined.bbox, raster);
  const aspect = refined.bbox.height / Math.max(1, refined.bbox.width);
  const coverage = component.area / (raster.width * raster.height);
  const confidence = round(clamp01(0.35 + Math.min(0.35, aspect / 8) + Math.min(0.3, coverage * 2)), 3);
  if (confidence < 0.55) localWarnings.push("BOTTLE_LOW_CONFIDENCE");
  if (refined.method !== "component-bbox") localWarnings.push("BOTTLE_ROI_REFINED_BY_ROW_PROFILE");

  return {
    roi,
    confidence,
    origin: refined.method,
    warnings: localWarnings,
    silhouette: {
      widthProfile: buildWidthProfile(mask, raster.width, refined.bbox, 16),
      bboxAspectRatio: round(refined.bbox.width / Math.max(1, refined.bbox.height), 4),
      fillRatio: round(component.area / Math.max(1, refined.bbox.width * refined.bbox.height), 4),
      centerOffsetX: round(component.centroid.x / raster.width - 0.5, 4),
      symmetryScore: estimateSymmetry(mask, raster.width, refined.bbox),
      originalBbox: normalizeRectToContent(component.bbox, raster),
      refinement: refined,
    },
  };
}

function refineBottleBodyRect(component: Component, mask: Uint8Array, width: number, height: number) {
  const rows: Array<{ y: number; left: number; right: number; rowWidth: number }> = [];
  for (let y = component.bbox.y; y < component.bbox.y + component.bbox.height; y += 1) {
    let left = width;
    let right = -1;
    for (let x = component.bbox.x; x < component.bbox.x + component.bbox.width; x += 1) {
      if (!mask[y * width + x]) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
    if (right < left) continue;
    rows.push({ y, left, right, rowWidth: right - left + 1 });
  }

  if (rows.length < Math.max(20, component.bbox.height * 0.25)) {
    return { method: "component-bbox", bbox: component.bbox, rowCount: rows.length };
  }

  const componentWidth = Math.max(1, component.bbox.width);
  const usableRows = rows.filter((row) => row.rowWidth / componentWidth >= 0.08 && row.rowWidth / width <= 0.94);
  const sourceRows = usableRows.length >= rows.length * 0.35 ? usableRows : rows;
  const top = quantile(sourceRows.map((row) => row.y), 0.02);
  const bottom = quantile(sourceRows.map((row) => row.y), 0.98);
  const verticalRows = sourceRows.filter((row) => row.y >= top && row.y <= bottom);
  const left = quantile(verticalRows.map((row) => row.left), 0.08);
  const right = quantile(verticalRows.map((row) => row.right), 0.92);
  const bbox = clampPixelRect(
    {
      x: Math.floor(left),
      y: Math.floor(top),
      width: Math.max(1, Math.ceil(right - left + 1)),
      height: Math.max(1, Math.ceil(bottom - top + 1)),
    },
    width,
    height
  );

  const originalCoverage = (component.bbox.width * component.bbox.height) / Math.max(1, width * height);
  const refinedCoverage = (bbox.width * bbox.height) / Math.max(1, width * height);
  if (originalCoverage < 0.86 && bbox.width > component.bbox.width * 0.88) {
    return { method: "component-bbox", bbox: component.bbox, rowCount: rows.length, usableRowCount: usableRows.length };
  }

  return {
    method: "row-profile",
    bbox,
    rowCount: rows.length,
    usableRowCount: usableRows.length,
    originalCoverage: round(originalCoverage, 4),
    refinedCoverage: round(refinedCoverage, 4),
  };
}

function buildLabelDescriptor(bottleRoi: NormalizedRect | null, raster: RawRaster, warnings: string[], config: RuntimeCvConfig, includeDebug = true) {
  const localWarnings: string[] = [];
  if (!bottleRoi) {
    warnings.push("LABEL_SKIPPED_NO_BOTTLE_ROI");
    return { roi: null, confidence: 0, origin: "skipped", warnings: ["LABEL_SKIPPED_NO_BOTTLE_ROI"], layout: null };
  }
  const candidate = detectLabelCandidate(bottleRoi, raster, config, includeDebug);
  if (candidate) {
    if (candidate.confidence < 0.45) localWarnings.push("LABEL_CANDIDATE_LOW_CONFIDENCE");
    return {
      roi: candidate.roi,
      confidence: candidate.confidence,
      origin: "candidate-color-edge",
      warnings: localWarnings,
      layout: {
        edgeDensity: candidate.edgeDensity,
        aspectRatio: round(candidate.roi.width / Math.max(0.0001, candidate.roi.height), 4),
        textLineCandidates: Math.max(0, Math.round(candidate.edgeDensity * 10)),
        colorContrast: candidate.colorContrast,
        positionScore: candidate.positionScore,
        areaRatio: candidate.areaRatio,
        candidateCount: candidate.candidateCount,
        features: candidate.features,
        contributions: candidate.contributions,
        penalties: candidate.penalties,
        topCandidates: candidate.topCandidates,
      },
      debug: candidate.debug,
    };
  }

  const labelRoi = buildFallbackLabelRoi(bottleRoi);
  const pixel = denormalizeContentRect(labelRoi, raster);
  const edgeDensity = estimateEdgeDensity(raster, pixel);
  const confidence = round(clamp01(0.25 + edgeDensity * 2.2), 3);
  localWarnings.push("LABEL_HEURISTIC_FALLBACK");
  if (confidence < 0.45) localWarnings.push("LABEL_HEURISTIC_LOW_CONFIDENCE");
  return {
    roi: labelRoi,
    confidence,
    origin: "heuristic-fallback",
    warnings: localWarnings,
    layout: {
      edgeDensity,
      aspectRatio: round(labelRoi.width / Math.max(0.0001, labelRoi.height), 4),
      textLineCandidates: Math.max(0, Math.round(edgeDensity * 10)),
    },
  };
}

function buildFallbackLabelRoi(bottleRoi: NormalizedRect): NormalizedRect {
  return {
    x: round(bottleRoi.x + bottleRoi.width * 0.12, 4),
    y: round(bottleRoi.y + bottleRoi.height * 0.36, 4),
    width: round(bottleRoi.width * 0.76, 4),
    height: round(bottleRoi.height * 0.26, 4),
  };
}

function detectLabelCandidate(bottleRoi: NormalizedRect, raster: RawRaster, config: RuntimeCvConfig, includeDebug = true) {
  const bottleRect = denormalizeContentRect(bottleRoi, raster);
  const searchRect = insetRect(
    {
      x: bottleRect.x,
      y: bottleRect.y + Math.floor(bottleRect.height * 0.16),
      width: bottleRect.width,
      height: Math.floor(bottleRect.height * 0.7),
    },
    Math.max(1, Math.floor(bottleRect.width * 0.08)),
    Math.max(1, Math.floor(bottleRect.height * 0.02)),
    raster.width,
    raster.height
  );
  if (searchRect.width < 12 || searchRect.height < 12) return null;

  const glassRgb = sampleBottleBodyColor(raster, bottleRect);
  const gray = grayscale(raster);
  const mask = new Uint8Array(raster.width * raster.height);

  for (let y = searchRect.y; y < searchRect.y + searchRect.height; y += 1) {
    for (let x = searchRect.x; x < searchRect.x + searchRect.width; x += 1) {
      const rgb = getPixelRgb(raster, x, y);
      const contrast = colorDistance(rgb, glassRgb);
      const localEdge = localGradient(gray, raster.width, x, y);
      const threshold = config.colorDistanceThreshold;
      if (contrast > threshold || (contrast > threshold * 0.64 && localEdge > 34)) {
        mask[y * raster.width + x] = 1;
      }
    }
  }

  const colorMask = new Uint8Array(mask);
  if (config.morphologyEnabled) {
    for (let iteration = 0; iteration < config.morphologyIterations; iteration += 1) {
      closeMask(mask, raster.width, raster.height, searchRect, config);
    }
  }
  const morphologyMask = new Uint8Array(mask);
  const componentMap = selectComponentsWithLabelMap(mask, searchRect, raster.width, raster.height);
  const components = componentMap.components;
  const candidates: LabelCandidate[] = [];
  for (const component of components) {
    const scored = scoreLabelComponent(component, bottleRect, raster, glassRgb, "color-component");
    if (!scored) continue;
    candidates.push(scored);
  }
  const unionComponent = selectMaskUnionComponent(mask, searchRect, raster.width);
  const unionScored = unionComponent ? scoreLabelComponent(unionComponent, bottleRect, raster, glassRgb, "color-union") : null;
  if (unionScored) candidates.push(unionScored);
  candidates.push(...detectChromaticPlaneCandidates(bottleRect, searchRect, raster, glassRgb, config));
  candidates.push(...detectProjectionProfileCandidates(bottleRect, searchRect, raster, glassRgb));
  candidates.push(...detectLabelWindowCandidates(bottleRect, searchRect, raster, glassRgb));
  candidates.push(...detectSalientContainerCandidates(candidates, bottleRect, searchRect, raster, glassRgb));
  const ranked = rankMainLabelCandidates(candidates);
  const best = ranked[0] ?? null;
  if (!best || best.score < config.minScore) return null;
  return {
    ...best,
    candidateCount: ranked.length,
    debug: includeDebug ? buildMinimalLabelDebugBundle(raster, searchRect, colorMask, morphologyMask, componentMap, ranked) : undefined,
    topCandidates: ranked.slice(0, config.maxCandidates).map((candidate, index) => ({
      rank: index + 1,
      source: candidate.source,
      score: candidate.score,
      confidence: candidate.confidence,
      roi: candidate.roi,
      features: candidate.features,
      contributions: candidate.contributions,
      penalties: candidate.penalties,
    })),
  };
}

function detectSalientContainerCandidates(
  candidates: LabelCandidate[],
  bottleRect: PixelRect,
  searchRect: PixelRect,
  raster: RawRaster,
  glassRgb: [number, number, number]
) {
  const result: LabelCandidate[] = [];
  const normalizedBottle = normalizeRectToContent(bottleRect, raster);
  const seeds = rankLabelCandidates(candidates)
    .filter((candidate) => {
      const relativeCenterY =
        (candidate.roi.y + candidate.roi.height / 2 - normalizedBottle.y) / Math.max(0.0001, normalizedBottle.height);
      return candidate.areaRatio >= 0.018 && candidate.areaRatio <= 0.18 && relativeCenterY >= 0.36;
    })
    .slice(0, 10);

  for (const seed of seeds) {
    const seedRect = denormalizeContentRect(seed.roi, raster);
    for (const [widthFraction, heightFraction] of [[0.64, 0.18], [0.78, 0.24], [0.9, 0.3]] as const) {
      const width = Math.max(seedRect.width * 1.2, bottleRect.width * widthFraction);
      const height = Math.max(seedRect.height * 1.2, bottleRect.height * heightFraction);
      const centered = clampRectToBounds(
        {
          x: Math.round(seedRect.x + seedRect.width / 2 - width / 2),
          y: Math.round(seedRect.y + seedRect.height / 2 - height / 2),
          width: Math.round(width),
          height: Math.round(height),
        },
        searchRect
      );
      const scored = scoreLabelRect(centered, bottleRect, raster, glassRgb, "salient-container");
      if (scored) result.push(scored);
    }
  }
  return rankLabelCandidates(result).slice(0, 12);
}

function detectLabelWindowCandidates(bottleRect: PixelRect, searchRect: PixelRect, raster: RawRaster, glassRgb: [number, number, number]) {
  const candidates: LabelCandidate[] = [];
  const widthFractions = [0.44, 0.52, 0.64, 0.76, 0.88];
  const heightFractions = [0.1, 0.14, 0.18, 0.22, 0.28];
  for (const widthFraction of widthFractions) {
    for (const heightFraction of heightFractions) {
      const width = Math.max(8, Math.floor(bottleRect.width * widthFraction));
      const height = Math.max(8, Math.floor(bottleRect.height * heightFraction));
      const stepX = Math.max(3, Math.floor(width / 5));
      const stepY = Math.max(3, Math.floor(height / 5));
      for (let y = searchRect.y; y <= searchRect.y + searchRect.height - height; y += stepY) {
        for (let x = searchRect.x; x <= searchRect.x + searchRect.width - width; x += stepX) {
          const scored = scoreLabelRect({ x, y, width, height }, bottleRect, raster, glassRgb, "sliding-window");
          if (!scored) continue;
          if (scored.score >= 0.22) candidates.push(scored);
        }
      }
    }
  }
  return rankLabelCandidates(candidates).slice(0, 12);
}

function detectChromaticPlaneCandidates(bottleRect: PixelRect, searchRect: PixelRect, raster: RawRaster, glassRgb: [number, number, number], config: RuntimeCvConfig) {
  const mask = new Uint8Array(raster.width * raster.height);
  for (let y = searchRect.y; y < searchRect.y + searchRect.height; y += 1) {
    for (let x = searchRect.x; x < searchRect.x + searchRect.width; x += 1) {
      const rgb = getPixelRgb(raster, x, y);
      const luma = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
      const chroma = rgbChroma(rgb);
      const contrast = colorDistance(rgb, glassRgb);
      if (contrast > Math.max(36, config.colorDistanceThreshold * 1.6) && luma > 34 && chroma > 22) {
        mask[y * raster.width + x] = 1;
      }
    }
  }

  if (config.morphologyEnabled) {
    for (let iteration = 0; iteration < config.morphologyIterations; iteration += 1) {
      closeMask(mask, raster.width, raster.height, searchRect, config);
    }
  }
  const components = selectComponentsWithLabelMap(mask, searchRect, raster.width, raster.height).components;
  const candidates: LabelCandidate[] = [];
  for (const component of components) {
    const widthRatio = component.bbox.width / Math.max(1, bottleRect.width);
    const heightRatio = component.bbox.height / Math.max(1, bottleRect.height);
    if (widthRatio < 0.34 || heightRatio < 0.12) continue;
    const rect = expandChromaticPlaneRect(component.bbox, searchRect, raster, glassRgb);
    const scored = scoreLabelRect(rect, bottleRect, raster, glassRgb, "chromatic-plane");
    if (scored) candidates.push(scored);
  }

  return rankLabelCandidates(candidates).slice(0, 8);
}

function expandChromaticPlaneRect(seedRect: PixelRect, searchRect: PixelRect, raster: RawRaster, glassRgb: [number, number, number]) {
  const xs: number[] = [];
  const ys: number[] = [];
  const yPad = Math.max(2, Math.floor(seedRect.height * 0.08));
  const minY = Math.max(searchRect.y, seedRect.y - yPad);
  const maxY = Math.min(searchRect.y + searchRect.height - 1, seedRect.y + seedRect.height + yPad);
  for (let y = minY; y <= maxY; y += 1) {
    let rowHits = 0;
    const rowXs: number[] = [];
    for (let x = searchRect.x; x < searchRect.x + searchRect.width; x += 1) {
      const rgb = getPixelRgb(raster, x, y);
      const luma = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
      const isPlane = colorDistance(rgb, glassRgb) > 40 && luma > 30 && rgbChroma(rgb) > 16;
      if (!isPlane) continue;
      rowHits += 1;
      rowXs.push(x);
    }
    if (rowHits < Math.max(4, searchRect.width * 0.18)) continue;
    xs.push(...rowXs);
    ys.push(y);
  }

  if (xs.length < Math.max(30, seedRect.width * seedRect.height * 0.08) || ys.length < Math.max(8, seedRect.height * 0.35)) {
    return expandRect(seedRect, Math.max(2, Math.floor(searchRect.width * 0.015)), raster.width, raster.height);
  }

  const left = quantile(xs, 0.02);
  const right = quantile(xs, 0.98);
  const top = quantile(ys, 0.02);
  const bottom = quantile(ys, 0.98);
  return clampPixelRect(
    {
      x: Math.floor(left),
      y: Math.floor(top),
      width: Math.max(1, Math.ceil(right - left + 1)),
      height: Math.max(1, Math.ceil(bottom - top + 1)),
    },
    raster.width,
    raster.height
  );
}

function detectProjectionProfileCandidates(bottleRect: PixelRect, searchRect: PixelRect, raster: RawRaster, glassRgb: [number, number, number]) {
  const rows: Array<{ y: number; score: number }> = [];
  const minY = Math.max(searchRect.y, bottleRect.y + Math.floor(bottleRect.height * 0.42));
  const maxY = Math.min(searchRect.y + searchRect.height, bottleRect.y + Math.floor(bottleRect.height * 0.86));
  for (let y = minY; y < maxY; y += 1) {
    let bright = 0;
    let contrast = 0;
    let total = 0;
    for (let x = searchRect.x; x < searchRect.x + searchRect.width; x += 2) {
      const rgb = getPixelRgb(raster, x, y);
      const luma = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
      if (luma > 150) bright += 1;
      contrast += colorDistance(rgb, glassRgb) / 140;
      total += 1;
    }
    const brightRatio = bright / Math.max(1, total);
    const contrastRatio = contrast / Math.max(1, total);
    rows.push({ y, score: brightRatio * 0.65 + contrastRatio * 0.35 });
  }
  if (rows.length < 12) return [];

  const threshold = Math.max(0.34, quantile(rows.map((row) => row.score), 0.68));
  const segments: Array<{ start: number; end: number; score: number }> = [];
  let current: { start: number; end: number; score: number; count: number } | null = null;
  for (const row of rows) {
    if (row.score >= threshold) {
      if (!current) current = { start: row.y, end: row.y, score: 0, count: 0 };
      current.end = row.y;
      current.score += row.score;
      current.count += 1;
      continue;
    }
    if (current) {
      segments.push({ start: current.start, end: current.end, score: current.score / Math.max(1, current.count) });
      current = null;
    }
  }
  if (current) segments.push({ start: current.start, end: current.end, score: current.score / Math.max(1, current.count) });

  return segments
    .filter((segment) => {
      const h = segment.end - segment.start + 1;
      return h >= bottleRect.height * 0.08 && h <= bottleRect.height * 0.34;
    })
    .flatMap((segment) => {
      const rect = buildProjectionRect(segment, searchRect, raster, glassRgb);
      if (!rect) return [];
      const scored = scoreLabelRect(rect, bottleRect, raster, glassRgb, "projection-profile");
      return scored ? [scored] : [];
    });
}

function buildProjectionRect(
  segment: { start: number; end: number; score: number },
  searchRect: PixelRect,
  raster: RawRaster,
  glassRgb: [number, number, number]
) {
  const xs: number[] = [];
  for (let y = segment.start; y <= segment.end; y += 2) {
    for (let x = searchRect.x; x < searchRect.x + searchRect.width; x += 1) {
      const rgb = getPixelRgb(raster, x, y);
      const luma = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
      if (luma > 138 || colorDistance(rgb, glassRgb) > 48) xs.push(x);
    }
  }
  if (xs.length < Math.max(20, searchRect.width * 0.2)) return null;
  const left = quantile(xs, 0.04);
  const right = quantile(xs, 0.96);
  return clampPixelRect(
    {
      x: Math.floor(left),
      y: Math.floor(segment.start),
      width: Math.max(1, Math.ceil(right - left + 1)),
      height: Math.max(1, Math.ceil(segment.end - segment.start + 1)),
    },
    raster.width,
    raster.height
  );
}

function estimateChromaticFill(raster: RawRaster, rect: PixelRect, glassRgb: [number, number, number]) {
  const stepY = Math.max(1, Math.floor(rect.height / 70));
  const stepX = Math.max(1, Math.floor(rect.width / 70));
  let hits = 0;
  let total = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += stepY) {
    for (let x = rect.x; x < rect.x + rect.width; x += stepX) {
      const rgb = getPixelRgb(raster, x, y);
      const luma = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
      if (luma > 34 && colorDistance(rgb, glassRgb) > 42 && rgbChroma(rgb) > 18) hits += 1;
      total += 1;
    }
  }
  return round(hits / Math.max(1, total), 4);
}

function refineLabelPaperRect(rect: PixelRect, raster: RawRaster, glassRgb: [number, number, number]) {
  const xs: number[] = [];
  const stepY = Math.max(1, Math.floor(rect.height / 80));
  const stepX = Math.max(1, Math.floor(rect.width / 80));
  for (let y = rect.y; y < rect.y + rect.height; y += stepY) {
    for (let x = rect.x; x < rect.x + rect.width; x += stepX) {
      const rgb = getPixelRgb(raster, x, y);
      const luma = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
      const paperLike = luma > 145 && colorDistance(rgb, glassRgb) > 34;
      if (!paperLike) continue;
      xs.push(x);
    }
  }
  if (xs.length < Math.max(24, (rect.width * rect.height) / 900)) return rect;
  const left = quantile(xs, 0.03);
  const right = quantile(xs, 0.97);
  const next = clampPixelRect(
    {
      x: Math.floor(left),
      y: rect.y,
      width: Math.max(1, Math.ceil(right - left + 1)),
      height: rect.height,
    },
    raster.width,
    raster.height
  );
  if (next.width < rect.width * 0.35 || next.height < rect.height * 0.45) return rect;
  if (next.width > rect.width * 1.02 || next.height > rect.height * 1.02) return rect;
  return next;
}

function scoreLabelComponent(
  component: Component,
  bottleRect: PixelRect,
  raster: RawRaster,
  glassRgb: [number, number, number],
  source: LabelCandidateSource
) {
  const rect = expandRect(component.bbox, 4, raster.width, raster.height);
  return scoreLabelRect(rect, bottleRect, raster, glassRgb, source);
}

function scoreLabelRect(rect: PixelRect, bottleRect: PixelRect, raster: RawRaster, glassRgb: [number, number, number], source: LabelCandidateSource): LabelCandidate | null {
  const refinedRect = source === "sliding-window" || source === "projection-profile" || source === "salient-container"
    ? refineLabelPaperRect(rect, raster, glassRgb)
    : rect;
  rect = refinedRect;
  const widthRatio = rect.width / Math.max(1, bottleRect.width);
  const heightRatio = rect.height / Math.max(1, bottleRect.height);
  const areaRatio = (rect.width * rect.height) / Math.max(1, bottleRect.width * bottleRect.height);
  const aspectRatio = rect.width / Math.max(1, rect.height);
  if (widthRatio < 0.16 || widthRatio > 1.12) return null;
  if (heightRatio < 0.045 || heightRatio > 0.62) return null;
  if (areaRatio < 0.012 || areaRatio > 0.52) return null;
  if (aspectRatio < 0.38 || aspectRatio > 7.2) return null;

  const centerY = rect.y + rect.height / 2;
  const relativeCenterY = (centerY - bottleRect.y) / Math.max(1, bottleRect.height);
  const positionTarget = source === "projection-profile" ? 0.68 : 0.62;
  const positionScore = round(clamp01(1 - Math.abs(relativeCenterY - positionTarget) / 0.36), 4);
  const edgeDensity = estimateEdgeDensity(raster, rect);
  const outerEdgeDensity = estimateOuterRingEdgeDensity(raster, rect);
  const innerEdgeLift = round(clamp01((edgeDensity - outerEdgeDensity + 0.08) / 0.28), 4);
  const average = averageRegionRgb(raster, rect);
  const colorContrast = round(clamp01(colorDistance(average, glassRgb) / 110), 4);
  const localContrast = estimateLocalContrast(raster, rect);
  const entropy = estimateLocalEntropy(raster, rect);
  const sizeScore = round(clamp01((widthRatio - 0.18) / 0.52) * clamp01((heightRatio - 0.06) / 0.24), 4);
  const chromaticFill = estimateChromaticFill(raster, rect, glassRgb);
  const rectangularBoundary = round(clamp01(edgeDensity * 1.6 + innerEdgeLift * 0.35), 4);
  const fullLabelShape = clamp01((widthRatio - 0.48) / 0.3) * clamp01((heightRatio - 0.1) / 0.14) * clamp01((0.46 - heightRatio) / 0.16);
  const labelEvidence = clamp01(Math.max(edgeDensity, entropy, localContrast, colorContrast));
  const contributions = {
    colorDifference: round(colorContrast * 0.24, 4),
    edgeBoundary: round(rectangularBoundary * 0.14, 4),
    innerTexture: round(Math.max(edgeDensity, entropy) * 0.16, 4),
    localContrast: round(localContrast * 0.1, 4),
    positionPrior: round(positionScore * 0.12, 4),
    sizePrior: round(sizeScore * 0.16, 4),
    chromaticFill: round(chromaticFill * (source === "chromatic-plane" ? 0.22 : 0.12), 4),
    chromaticPlane: source === "chromatic-plane" ? 0.08 : 0,
    projectionProfile: source === "projection-profile" ? 0.08 : 0,
    fullLabelSupport: round(fullLabelShape * labelEvidence * 0.12, 4),
    salientContainer: source === "salient-container" ? round(fullLabelShape * 0.04, 4) : 0,
  };
  const touchesBottleBoundary =
    rect.x <= bottleRect.x + 2 ||
    rect.y <= bottleRect.y + 2 ||
    rect.x + rect.width >= bottleRect.x + bottleRect.width - 2 ||
    rect.y + rect.height >= bottleRect.y + bottleRect.height - 2;
  const penalties = {
    outerRingTexture: outerEdgeDensity > edgeDensity ? round(-Math.min(0.08, (outerEdgeDensity - edgeDensity) * 0.4), 4) : 0,
    touchesBottleBoundary: touchesBottleBoundary ? -0.04 : 0,
    tinyRect: widthRatio < 0.34 || heightRatio < 0.1 ? -0.12 : 0,
    neckOrShoulder: relativeCenterY < 0.42
      ? round(-Math.min(0.2, (0.42 - relativeCenterY) * 0.75 + (widthRatio < 0.58 ? 0.05 : 0)), 4)
      : 0,
    emptyBottleBody: labelEvidence < 0.18
      ? round(-Math.min(0.16, (0.18 - labelEvidence) * 0.9), 4)
      : 0,
    isolatedFragment: widthRatio < 0.5 && heightRatio < 0.2 ? -0.05 : 0,
  };
  const score = round(
    clamp01(
      Object.values(contributions).reduce((sum, value) => sum + value, 0) +
        Object.values(penalties).reduce((sum, value) => sum + value, 0)
    ),
    4
  );
  return {
    roi: normalizeRectToContent(rect, raster),
    source,
    confidence: round(clamp01(0.18 + score * 0.82), 3),
    score,
    edgeDensity,
    colorContrast,
    positionScore,
    areaRatio: round(areaRatio, 4),
    features: {
      colorDifference: colorContrast,
      edgeDensity,
      outerRingEdgeDensity: outerEdgeDensity,
      innerEdgeLift,
      entropy,
      localContrast,
      chromaticFill,
      rectangularBoundary,
      positionPrior: positionScore,
      sizePrior: sizeScore,
      aspectRatioPrior: round(clamp01(1 - Math.abs(aspectRatio - 1.6) / 4.8), 4),
    },
    contributions,
    penalties,
  };
}

function rankLabelCandidates(candidates: LabelCandidate[]) {
  return dedupeLabelCandidates(candidates).sort((a, b) => b.score - a.score);
}

function rankMainLabelCandidates(candidates: LabelCandidate[]) {
  const deduped = dedupeLabelCandidates(candidates).map((candidate) => ({
    ...candidate,
    contributions: { ...candidate.contributions },
    penalties: { ...candidate.penalties },
  }));

  for (const inner of deduped) {
    const containers = deduped.filter((outer) => isPlausibleLabelContainer(outer, inner));
    if (!containers.length) continue;
    const bestContainer = containers.sort((a, b) => b.score - a.score)[0];
    const areaLift = clamp01((bestContainer.areaRatio / Math.max(0.0001, inner.areaRatio) - 1.25) / 2.5);
    const outerBonus = round(0.05 + areaLift * 0.07, 4);
    bestContainer.contributions.containsSalientFragment = Math.max(
      bestContainer.contributions.containsSalientFragment ?? 0,
      outerBonus
    );
    inner.penalties.containedFragment = Math.min(
      inner.penalties.containedFragment ?? 0,
      -round(0.04 + areaLift * 0.05, 4)
    );
  }

  for (const candidate of deduped) {
    candidate.score = round(
      clamp01(
        Object.values(candidate.contributions).reduce((sum, value) => sum + value, 0) +
          Object.values(candidate.penalties).reduce((sum, value) => sum + value, 0)
      ),
      4
    );
    candidate.confidence = round(clamp01(0.18 + candidate.score * 0.82), 3);
  }
  return deduped.sort((a, b) => b.score - a.score);
}

function isPlausibleLabelContainer(outer: LabelCandidate, inner: LabelCandidate) {
  if (outer === inner || outer.areaRatio <= inner.areaRatio * 1.25 || outer.areaRatio > inner.areaRatio * 6) return false;
  if (outer.score < inner.score - 0.18) return false;
  if ((outer.features.rectangularBoundary ?? 0) < 0.18 && (outer.features.localContrast ?? 0) < 0.18) return false;
  const intersection = rectIntersectionArea(outer.roi, inner.roi);
  const innerArea = inner.roi.width * inner.roi.height;
  return intersection / Math.max(0.000001, innerArea) >= 0.9;
}

function rectIntersectionArea(a: NormalizedRect, b: NormalizedRect) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function clampRectToBounds(rect: PixelRect, bounds: PixelRect): PixelRect {
  const left = Math.max(bounds.x, rect.x);
  const top = Math.max(bounds.y, rect.y);
  const right = Math.min(bounds.x + bounds.width, rect.x + rect.width);
  const bottom = Math.min(bounds.y + bounds.height, rect.y + rect.height);
  return {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function dedupeLabelCandidates(candidates: LabelCandidate[]) {
  const result: LabelCandidate[] = [];
  for (const candidate of candidates) {
    const duplicateIndex = result.findIndex((item) => rectIou(item.roi, candidate.roi) > 0.82);
    if (duplicateIndex === -1) {
      result.push(candidate);
      continue;
    }
    if (candidate.score > result[duplicateIndex].score) result[duplicateIndex] = candidate;
  }
  return result;
}

function buildMinimalLabelDebugBundle(
  raster: RawRaster,
  searchRect: PixelRect,
  colorMask: Uint8Array,
  morphologyMask: Uint8Array,
  componentMap: ComponentMap,
  ranked: LabelCandidate[]
) {
  return {
    schemaVersion: 1,
    coordinateSpaces: [
      {
        id: "analysis-image",
        width: raster.width,
        height: raster.height,
        originX: 0,
        originY: 0,
        scaleX: 1,
        scaleY: 1,
      },
    ],
    layers: [
      {
        id: "color-mask",
        name: "Color mask",
        kind: "binary-mask",
        stage: "color-mask",
        coordinateSpaceId: "analysis-image",
        schemaVersion: 1,
        visibleByDefault: true,
        opacity: 1,
        width: raster.width,
        height: raster.height,
        encoding: "rle-u8",
        data: encodeUint32Base64(encodeBinaryMaskRle(colorMask)),
        foregroundValue: 1,
        metrics: summarizeMask(colorMask, searchRect, raster.width),
      },
      {
        id: "morphology-mask",
        name: "Morphology result",
        kind: "binary-mask",
        stage: "morphology",
        coordinateSpaceId: "analysis-image",
        schemaVersion: 1,
        visibleByDefault: true,
        opacity: 1,
        width: raster.width,
        height: raster.height,
        encoding: "rle-u8",
        data: encodeUint32Base64(encodeBinaryMaskRle(morphologyMask)),
        foregroundValue: 1,
        metrics: summarizeMask(morphologyMask, searchRect, raster.width),
      },
      {
        id: "component-label-map",
        name: "Component label map",
        kind: "label-map",
        stage: "connected-components",
        coordinateSpaceId: "analysis-image",
        schemaVersion: 1,
        visibleByDefault: false,
        opacity: 0.35,
        width: raster.width,
        height: raster.height,
        valueType: "uint16",
        encoding: "rle",
        data: encodeUint32Base64(encodeUint16LabelMapRle(componentMap.labelMap)),
        backgroundLabel: 0,
        maxLabel: componentMap.maxLabel,
      },
      {
        id: "components",
        name: "Connected components",
        kind: "components",
        stage: "connected-components",
        coordinateSpaceId: "analysis-image",
        schemaVersion: 1,
        visibleByDefault: true,
        labelMapLayerId: "component-label-map",
        components: componentMap.components.map((component) => ({
          id: component.id ?? 0,
          bbox: normalizeRectToContent(component.bbox, raster),
          centroid: {
            x: round(component.centroid.x / raster.width, 4),
            y: round(component.centroid.y / raster.height, 4),
          },
          area: component.area,
          accepted: true,
          selected: ranked.some((candidate) => rectIou(candidate.roi, normalizeRectToContent(component.bbox, raster)) > 0.7),
          features: {
            area: component.area,
            aspectRatio: round(component.bbox.width / Math.max(1, component.bbox.height), 4),
            rectangularity: round(component.area / Math.max(1, component.bbox.width * component.bbox.height), 4),
          },
        })),
      },
      {
        id: "candidates",
        name: "Label candidates",
        kind: "candidates",
        stage: "candidate-scoring",
        coordinateSpaceId: "analysis-image",
        schemaVersion: 1,
        visibleByDefault: true,
        candidates: ranked.slice(0, 8).map((candidate, index) => ({
          id: `candidate-${index + 1}`,
          rank: index + 1,
          source: candidate.source,
          bbox: candidate.roi,
          selected: index === 0,
          score: candidate.score,
          confidence: candidate.confidence,
          features: candidate.features,
          contributions: candidate.contributions,
          penalties: candidate.penalties,
        })),
      },
      {
        id: "selected-label-mask",
        name: "Selected label mask",
        kind: "binary-mask",
        stage: "selection",
        coordinateSpaceId: "analysis-image",
        schemaVersion: 1,
        visibleByDefault: true,
        opacity: 0.28,
        width: raster.width,
        height: raster.height,
        encoding: "rle-u8",
        data: encodeUint32Base64(encodeBinaryMaskRle(buildRectMask(ranked[0]?.roi ?? null, raster))),
        foregroundValue: 1,
      },
      {
        id: "search-rect",
        name: "Label search region",
        kind: "components",
        stage: "candidate-generation",
        coordinateSpaceId: "analysis-image",
        schemaVersion: 1,
        visibleByDefault: false,
        components: [
          {
            id: 0,
            bbox: normalizeRectToContent(searchRect, raster),
            centroid: {
              x: round((searchRect.x + searchRect.width / 2) / raster.width, 4),
              y: round((searchRect.y + searchRect.height / 2) / raster.height, 4),
            },
            area: searchRect.width * searchRect.height,
            accepted: true,
            selected: false,
            features: {},
          },
        ],
      },
    ],
  };
}

function buildRectMask(rect: NormalizedRect | null, raster: RawRaster) {
  const width = raster.width;
  const height = raster.height;
  const mask = new Uint8Array(width * height);
  if (!rect) return mask;
  const pixel = denormalizeContentRect(rect, raster);
  for (let y = pixel.y; y < pixel.y + pixel.height; y += 1) {
    for (let x = pixel.x; x < pixel.x + pixel.width; x += 1) {
      mask[y * width + x] = 1;
    }
  }
  return mask;
}

function summarizeMask(mask: Uint8Array, rect: PixelRect, width: number) {
  let active = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      if (mask[y * width + x]) active += 1;
    }
  }
  const total = Math.max(1, rect.width * rect.height);
  return {
    activePixels: active,
    coverage: round(active / total, 4),
  };
}

function encodeBinaryMaskRle(values: Uint8Array) {
  if (values.length === 0) return new Uint32Array();
  const encoded: number[] = [];
  let currentValue = values[0] ? 1 : 0;
  let runLength = 1;
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index] ? 1 : 0;
    if (value === currentValue) {
      runLength += 1;
      continue;
    }
    encoded.push(currentValue, runLength);
    currentValue = value;
    runLength = 1;
  }
  encoded.push(currentValue, runLength);
  return Uint32Array.from(encoded);
}

function encodeUint16LabelMapRle(values: Uint16Array) {
  if (values.length === 0) return new Uint32Array();
  const encoded: number[] = [];
  let currentValue = values[0] ?? 0;
  let runLength = 1;
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    if (value === currentValue) {
      runLength += 1;
      continue;
    }
    encoded.push(currentValue, runLength);
    currentValue = value;
    runLength = 1;
  }
  encoded.push(currentValue, runLength);
  return Uint32Array.from(encoded);
}

function encodeUint32Base64(values: Uint32Array) {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString("base64");
}

async function computeDHash(filePath: string, rect?: PixelRect) {
  let image = sharp(filePath, { failOn: "none" }).rotate();
  if (rect) {
    const metadata = await sharp(filePath, { failOn: "none" }).metadata();
    const dimensions = autoOrientedDimensions(metadata.width ?? 0, metadata.height ?? 0, metadata.orientation);
    image = image.extract(normalizeExtractRect(rect, dimensions.width, dimensions.height));
  }
  const raw = await image.resize(9, 8, { fit: "fill" }).greyscale().raw().toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = raw[y * 9 + x] ?? 0;
      const right = raw[y * 9 + x + 1] ?? 0;
      bits += left > right ? "1" : "0";
    }
  }
  return BigInt(`0b${bits}`).toString(16).padStart(16, "0");
}

async function computePHash(filePath: string) {
  const size = 16;
  const raw = await sharp(filePath, { failOn: "none" }).rotate().resize(size, size, { fit: "fill" }).greyscale().raw().toBuffer();
  const average = raw.reduce((sum, value) => sum + value, 0) / Math.max(1, raw.length);
  let bits = "";
  for (const value of raw) bits += value > average ? "1" : "0";
  return BigInt(`0b${bits}`).toString(16).padStart(64, "0");
}

function buildColorZones(raster: RawRaster): ColorZone[] {
  const zones: ColorZone[] = [];
  const zoneWidth = Math.floor(raster.width / GRID_COLUMNS);
  const zoneHeight = Math.floor(raster.height / GRID_ROWS);
  for (let y = 0; y < GRID_ROWS; y += 1) {
    for (let x = 0; x < GRID_COLUMNS; x += 1) {
      const left = x * zoneWidth;
      const top = y * zoneHeight;
      const width = x === GRID_COLUMNS - 1 ? raster.width - left : zoneWidth;
      const height = y === GRID_ROWS - 1 ? raster.height - top : zoneHeight;
      const color = summarizeColors(raster, { x: left, y: top, width, height });
      zones.push({
        x: round(x / GRID_COLUMNS, 4),
        y: round(y / GRID_ROWS, 4),
        width: round(1 / GRID_COLUMNS, 4),
        height: round(1 / GRID_ROWS, 4),
        averageLab: color.averageLab,
        saturation: round(saturation(...color.averageRgb), 4),
        lightness: color.averageLab[0],
      });
    }
  }
  return zones;
}

function summarizeColors(raster: RawRaster, rect: PixelRect = { x: 0, y: 0, width: raster.width, height: raster.height }): ColorSummary {
  const buckets = new Map<string, number>();
  const samples: Array<[number, number, number]> = [];
  const step = Math.max(1, Math.floor((rect.width * rect.height) / 12000));
  let index = 0;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      index += 1;
      if (index % step !== 0) continue;
      const offset = (y * raster.width + x) * raster.channels;
      const rgb: [number, number, number] = [raster.data[offset] ?? 0, raster.data[offset + 1] ?? 0, raster.data[offset + 2] ?? 0];
      samples.push(rgb);
      const key = rgb.map((value) => Math.min(255, Math.round(value / 32) * 32)).join(",");
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
  }
  const avg = averageRgb(samples);
  return {
    averageRgb: avg,
    averageLab: rgbToLab(...avg),
    dominantRgb: [...buckets.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([key, count]) => ({
        value: key.split(",").map(Number) as [number, number, number],
        ratio: round(count / Math.max(1, samples.length), 4),
      })),
  };
}

function collectBorderPixels(raster: RawRaster): Array<[number, number, number]> {
  const pixels: Array<[number, number, number]> = [];
  const border = Math.max(2, Math.floor(Math.min(raster.width, raster.height) * 0.04));
  for (let y = 0; y < raster.height; y += Math.max(1, Math.floor(raster.height / 180))) {
    for (let x = 0; x < raster.width; x += Math.max(1, Math.floor(raster.width / 180))) {
      if (x >= border && x < raster.width - border && y >= border && y < raster.height - border) continue;
      const offset = (y * raster.width + x) * raster.channels;
      pixels.push([raster.data[offset] ?? 0, raster.data[offset + 1] ?? 0, raster.data[offset + 2] ?? 0]);
    }
  }
  return pixels;
}

function averageRgb(pixels: Array<[number, number, number]>): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const pixel of pixels) {
    r += pixel[0];
    g += pixel[1];
    b += pixel[2];
  }
  const count = Math.max(1, pixels.length);
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

function grayscale(raster: RawRaster) {
  const cached = recognitionGray.get(raster);
  if (cached) return cached;
  const gray = new Uint8Array(raster.width * raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const offset = (y * raster.width + x) * raster.channels;
      gray[y * raster.width + x] = Math.round((raster.data[offset] ?? 0) * 0.299 + (raster.data[offset + 1] ?? 0) * 0.587 + (raster.data[offset + 2] ?? 0) * 0.114);
    }
  }
  return gray;
}

function buildWidthProfile(mask: Uint8Array, imageWidth: number, bbox: PixelRect, bins: number) {
  const profile: number[] = [];
  for (let bin = 0; bin < bins; bin += 1) {
    const y0 = bbox.y + Math.floor((bbox.height * bin) / bins);
    const y1 = bbox.y + Math.floor((bbox.height * (bin + 1)) / bins);
    let minX = bbox.x + bbox.width;
    let maxX = bbox.x;
    for (let y = y0; y < y1; y += 1) {
      for (let x = bbox.x; x < bbox.x + bbox.width; x += 1) {
        if (!mask[y * imageWidth + x]) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    }
    profile.push(round(Math.max(0, maxX - minX + 1) / Math.max(1, bbox.width), 4));
  }
  return profile;
}

function estimateSymmetry(mask: Uint8Array, imageWidth: number, bbox: PixelRect) {
  let matched = 0;
  let total = 0;
  for (let y = bbox.y; y < bbox.y + bbox.height; y += 3) {
    for (let dx = 0; dx < bbox.width / 2; dx += 2) {
      const left = bbox.x + dx;
      const right = bbox.x + bbox.width - dx - 1;
      matched += mask[y * imageWidth + left] === mask[y * imageWidth + right] ? 1 : 0;
      total += 1;
    }
  }
  return round(matched / Math.max(1, total), 4);
}

function estimateEdgeDensity(raster: RawRaster, rect: PixelRect) {
  const gray = grayscale(raster);
  let edges = 0;
  let total = 0;
  for (let y = rect.y + 1; y < rect.y + rect.height - 1; y += 2) {
    for (let x = rect.x + 1; x < rect.x + rect.width - 1; x += 2) {
      const gx = Math.abs((gray[y * raster.width + x + 1] ?? 0) - (gray[y * raster.width + x - 1] ?? 0));
      const gy = Math.abs((gray[(y + 1) * raster.width + x] ?? 0) - (gray[(y - 1) * raster.width + x] ?? 0));
      if (gx + gy > 42) edges += 1;
      total += 1;
    }
  }
  return round(edges / Math.max(1, total), 4);
}

function estimateOuterRingEdgeDensity(raster: RawRaster, rect: PixelRect) {
  const outer = expandRect(rect, Math.max(4, Math.floor(Math.min(rect.width, rect.height) * 0.12)), raster.width, raster.height);
  const gray = grayscale(raster);
  let edges = 0;
  let total = 0;
  for (let y = outer.y + 1; y < outer.y + outer.height - 1; y += 2) {
    for (let x = outer.x + 1; x < outer.x + outer.width - 1; x += 2) {
      if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) continue;
      const gx = Math.abs((gray[y * raster.width + x + 1] ?? 0) - (gray[y * raster.width + x - 1] ?? 0));
      const gy = Math.abs((gray[(y + 1) * raster.width + x] ?? 0) - (gray[(y - 1) * raster.width + x] ?? 0));
      if (gx + gy > 42) edges += 1;
      total += 1;
    }
  }
  return round(edges / Math.max(1, total), 4);
}

function estimateLocalContrast(raster: RawRaster, rect: PixelRect) {
  const gray = grayscale(raster);
  const values: number[] = [];
  const clamped = clampPixelRect(rect, raster.width, raster.height);
  const step = Math.max(1, Math.floor(Math.min(clamped.width, clamped.height) / 40));
  for (let y = clamped.y; y < clamped.y + clamped.height; y += step) {
    for (let x = clamped.x; x < clamped.x + clamped.width; x += step) {
      values.push(gray[y * raster.width + x] ?? 0);
    }
  }
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return round(clamp01(Math.sqrt(variance) / 80), 4);
}

function estimateLocalEntropy(raster: RawRaster, rect: PixelRect) {
  const gray = grayscale(raster);
  const bins = new Array<number>(16).fill(0);
  let total = 0;
  const clamped = clampPixelRect(rect, raster.width, raster.height);
  const step = Math.max(1, Math.floor(Math.min(clamped.width, clamped.height) / 48));
  for (let y = clamped.y; y < clamped.y + clamped.height; y += step) {
    for (let x = clamped.x; x < clamped.x + clamped.width; x += step) {
      bins[Math.min(15, Math.floor((gray[y * raster.width + x] ?? 0) / 16))] += 1;
      total += 1;
    }
  }
  const entropy = bins.reduce((sum, count) => {
    if (!count) return sum;
    const p = count / Math.max(1, total);
    return sum - p * Math.log2(p);
  }, 0);
  return round(clamp01(entropy / 4), 4);
}

function localGradient(gray: ArrayLike<number>, width: number, x: number, y: number) {
  const center = y * width + x;
  const gx = Math.abs((gray[center + 1] ?? 0) - (gray[center - 1] ?? 0));
  const gy = Math.abs((gray[center + width] ?? 0) - (gray[center - width] ?? 0));
  return gx + gy;
}

function getPixelRgb(raster: RawRaster, x: number, y: number): [number, number, number] {
  const offset = (y * raster.width + x) * raster.channels;
  return [raster.data[offset] ?? 0, raster.data[offset + 1] ?? 0, raster.data[offset + 2] ?? 0];
}

function sampleBottleBodyColor(raster: RawRaster, bottleRect: PixelRect): [number, number, number] {
  const fallback = averageRegionRgb(raster, bottleRect);
  const samples: Array<[number, number, number]> = [];
  const bands = [
    {
      x: bottleRect.x + Math.floor(bottleRect.width * 0.08),
      y: bottleRect.y + Math.floor(bottleRect.height * 0.2),
      width: Math.floor(bottleRect.width * 0.16),
      height: Math.floor(bottleRect.height * 0.6),
    },
    {
      x: bottleRect.x + Math.floor(bottleRect.width * 0.76),
      y: bottleRect.y + Math.floor(bottleRect.height * 0.2),
      width: Math.floor(bottleRect.width * 0.16),
      height: Math.floor(bottleRect.height * 0.6),
    },
  ];
  for (const band of bands) {
    const rect = clampPixelRect(band, raster.width, raster.height);
    for (let y = rect.y; y < rect.y + rect.height; y += 3) {
      for (let x = rect.x; x < rect.x + rect.width; x += 3) {
        samples.push(getPixelRgb(raster, x, y));
      }
    }
  }
  return samples.length > 8 ? averageRgb(samples) : fallback;
}

function averageRegionRgb(raster: RawRaster, rect: PixelRect): [number, number, number] {
  const pixels: Array<[number, number, number]> = [];
  const clamped = clampPixelRect(rect, raster.width, raster.height);
  const step = Math.max(1, Math.floor(Math.min(clamped.width, clamped.height) / 48));
  for (let y = clamped.y; y < clamped.y + clamped.height; y += step) {
    for (let x = clamped.x; x < clamped.x + clamped.width; x += step) {
      pixels.push(getPixelRgb(raster, x, y));
    }
  }
  return averageRgb(pixels);
}

function closeMask(mask: Uint8Array, width: number, height: number, rect: PixelRect, config: RuntimeCvConfig = DEFAULT_CV_CONFIG) {
  const grown = new Uint8Array(mask);
  const radiusX = Math.max(1, Math.floor(config.morphologyKernelWidth / 2));
  const radiusY = Math.max(1, Math.floor(config.morphologyKernelHeight / 2));
  const minNeighbors = Math.max(2, Math.floor((radiusX * 2 + radiusY * 2) * 0.35));
  for (let y = rect.y + radiusY; y < rect.y + rect.height - radiusY; y += 1) {
    for (let x = rect.x + radiusX; x < rect.x + rect.width - radiusX; x += 1) {
      const index = y * width + x;
      if (mask[index]) continue;
      let neighbors = 0;
      for (let dy = -radiusY; dy <= radiusY; dy += 1) {
        for (let dx = -radiusX; dx <= radiusX; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          if (Math.abs(dx) + Math.abs(dy) > radiusX + radiusY) continue;
          neighbors += mask[(y + dy) * width + x + dx] ? 1 : 0;
        }
      }
      if (neighbors >= minNeighbors) grown[index] = 1;
    }
  }
  for (let y = rect.y; y < rect.y + rect.height && y < height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width && x < width; x += 1) {
      mask[y * width + x] = grown[y * width + x] ?? 0;
    }
  }
}

function selectComponentsWithLabelMap(mask: Uint8Array, rect: PixelRect, width: number, height: number): ComponentMap {
  const visited = new Uint8Array(mask.length);
  const labelMap = new Uint16Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: Component[] = [];
  const minArea = Math.max(16, Math.floor(rect.width * rect.height * 0.008));
  let nextLabel = 1;

  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const index = y * width + x;
      if (!mask[index] || visited[index]) continue;
      let head = 0;
      let tail = 0;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      queue[tail] = index;
      tail += 1;
      visited[index] = 1;

      while (head < tail) {
        const current = queue[head] ?? 0;
        head += 1;
        const cx = current % width;
        const cy = Math.floor(current / width);
        area += 1;
        sumX += cx;
        sumY += cy;
        labelMap[current] = nextLabel;
        minX = Math.min(minX, cx);
        minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx);
        maxY = Math.max(maxY, cy);
        for (const next of [current - 1, current + 1, current - width, current + width]) {
          if (next < 0 || next >= mask.length || visited[next] || !mask[next]) continue;
          const nx = next % width;
          if (Math.abs(nx - cx) > 1) continue;
          visited[next] = 1;
          queue[tail] = next;
          tail += 1;
        }
      }

      if (area >= minArea) {
        components.push({
          id: nextLabel,
          area,
          bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
          centroid: { x: sumX / Math.max(1, area), y: sumY / Math.max(1, area) },
        });
        nextLabel += 1;
      } else {
        for (let index = 0; index < labelMap.length; index += 1) {
          if (labelMap[index] === nextLabel) labelMap[index] = 0;
        }
      }
    }
  }

  return {
    components,
    labelMap,
    maxLabel: Math.max(0, nextLabel - 1),
  };
}

function selectMaskUnionComponent(mask: Uint8Array, rect: PixelRect, width: number): Component | null {
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = rect.x + rect.width;
  let minY = rect.y + rect.height;
  let maxX = rect.x;
  let maxY = rect.y;
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      if (!mask[y * width + x]) continue;
      area += 1;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (area < Math.max(20, rect.width * rect.height * 0.01)) return null;
  return {
    area,
    bbox: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    centroid: { x: sumX / Math.max(1, area), y: sumY / Math.max(1, area) },
  };
}

function clearBorder(mask: Uint8Array, width: number, height: number) {
  for (let x = 0; x < width; x += 1) {
    mask[x] = 0;
    mask[(height - 1) * width + x] = 0;
  }
  for (let y = 0; y < height; y += 1) {
    mask[y * width] = 0;
    mask[y * width + width - 1] = 0;
  }
}

function averageColorDistance(pixels: Array<[number, number, number]>, rgb: [number, number, number]) {
  return pixels.reduce((sum, pixel) => sum + colorDistance(pixel, rgb), 0) / Math.max(1, pixels.length);
}

function colorDistance(a: [number, number, number], b: [number, number, number]) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function rgbChroma(rgb: [number, number, number]) {
  return Math.max(...rgb) - Math.min(...rgb);
}

function saturation(r: number, g: number, b: number) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  return max === 0 ? 0 : (max - min) / max;
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const [x, y, z] = rgbToXyz(r, g, b);
  const fx = labPivot(x / 95.047);
  const fy = labPivot(y / 100);
  const fz = labPivot(z / 108.883);
  return [round(116 * fy - 16, 2), round(500 * (fx - fy), 2), round(200 * (fy - fz), 2)];
}

function rgbToXyz(r: number, g: number, b: number) {
  const [rr, gg, bb] = [r, g, b].map((value) => {
    const channel = value / 255;
    return (channel > 0.04045 ? ((channel + 0.055) / 1.055) ** 2.4 : channel / 12.92) * 100;
  });
  return [
    rr * 0.4124 + gg * 0.3576 + bb * 0.1805,
    rr * 0.2126 + gg * 0.7152 + bb * 0.0722,
    rr * 0.0193 + gg * 0.1192 + bb * 0.9505,
  ];
}

function labPivot(value: number) {
  return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
}

function normalizeRect(rect: PixelRect, width: number, height: number): NormalizedRect {
  return {
    x: round(rect.x / width, 4),
    y: round(rect.y / height, 4),
    width: round(rect.width / width, 4),
    height: round(rect.height / height, 4),
  };
}

function normalizeRectToContent(rect: PixelRect, raster: RawRaster): NormalizedRect {
  const content = raster.contentRect;
  if (!content) return normalizeRect(rect, raster.width, raster.height);
  return {
    x: round((rect.x - content.x) / content.width, 4),
    y: round((rect.y - content.y) / content.height, 4),
    width: round(rect.width / content.width, 4),
    height: round(rect.height / content.height, 4),
  };
}

function denormalizeRect(rect: NormalizedRect, width: number, height: number): PixelRect {
  return {
    x: Math.max(0, Math.floor(rect.x * width)),
    y: Math.max(0, Math.floor(rect.y * height)),
    width: Math.max(1, Math.min(width, Math.floor(rect.width * width))),
    height: Math.max(1, Math.min(height, Math.floor(rect.height * height))),
  };
}

function denormalizeContentRect(rect: NormalizedRect, raster: RawRaster): PixelRect {
  const content = raster.contentRect;
  if (!content) return denormalizeRect(rect, raster.width, raster.height);
  return clampPixelRect(
    {
      x: content.x + Math.floor(rect.x * content.width),
      y: content.y + Math.floor(rect.y * content.height),
      width: Math.max(1, Math.floor(rect.width * content.width)),
      height: Math.max(1, Math.floor(rect.height * content.height)),
    },
    raster.width,
    raster.height
  );
}

function insetRect(rect: PixelRect, insetX: number, insetY: number, width: number, height: number): PixelRect {
  return clampPixelRect(
    {
      x: rect.x + insetX,
      y: rect.y + insetY,
      width: rect.width - insetX * 2,
      height: rect.height - insetY * 2,
    },
    width,
    height
  );
}

function expandRect(rect: PixelRect, padding: number, width: number, height: number): PixelRect {
  return clampPixelRect(
    {
      x: rect.x - padding,
      y: rect.y - padding,
      width: rect.width + padding * 2,
      height: rect.height + padding * 2,
    },
    width,
    height
  );
}

function clampPixelRect(rect: PixelRect, width: number, height: number): PixelRect {
  const x = Math.max(0, Math.min(width - 1, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(rect.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.floor(rect.width))),
    height: Math.max(1, Math.min(height - y, Math.floor(rect.height))),
  };
}

export function normalizeExtractRect(rect: PixelRect, imageWidth: number, imageHeight: number) {
  if (![rect.x, rect.y, rect.width, rect.height, imageWidth, imageHeight].every(Number.isFinite)) {
    throw new Error("Invalid extract area: crop and image dimensions must be finite");
  }
  if (imageWidth <= 0 || imageHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    throw new Error("Invalid extract area: crop and image dimensions must be positive");
  }
  const requestedLeft = Math.floor(rect.x);
  const requestedTop = Math.floor(rect.y);
  const requestedRight = Math.ceil(rect.x + rect.width);
  const requestedBottom = Math.ceil(rect.y + rect.height);
  if (requestedRight <= 0 || requestedBottom <= 0 || requestedLeft >= imageWidth || requestedTop >= imageHeight) {
    throw new Error("Invalid extract area: crop does not intersect the image");
  }
  const left = Math.max(0, requestedLeft);
  const top = Math.max(0, requestedTop);
  const right = Math.min(imageWidth, requestedRight);
  const bottom = Math.min(imageHeight, requestedBottom);
  if (right <= left || bottom <= top) throw new Error("Invalid extract area: clipped crop is empty");
  return { left, top, width: right - left, height: bottom - top };
}

export function autoOrientedDimensions(width: number, height: number, orientation?: number) {
  return orientation && orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

function rectToPolygon(rect: NormalizedRect) {
  return [
    { x: rect.x, y: rect.y },
    { x: round(rect.x + rect.width, 4), y: rect.y },
    { x: round(rect.x + rect.width, 4), y: round(rect.y + rect.height, 4) },
    { x: rect.x, y: round(rect.y + rect.height, 4) },
  ];
}

function rectIou(a: NormalizedRect, b: NormalizedRect) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  return intersection / Math.max(0.000001, areaA + areaB - intersection);
}

function calculateSourceScore(
  quality: ReturnType<typeof inspectQuality>,
  bottleConfidence: number,
  labelConfidence: number,
  warnings: string[],
) {
  let score = 1;
  score -= Math.min(0.3, warnings.length * 0.05);
  score -= quality.sharpness < 25 ? 0.2 : 0;
  score -= quality.exposure.underexposedRatio > 0.35 || quality.exposure.overexposedRatio > 0.35 ? 0.15 : 0;
  score += bottleConfidence * 0.15;
  score += labelConfidence * 0.05;
  return round(clamp01(score), 3);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function quantile(values: number[], q: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
  return sorted[index] ?? 0;
}
