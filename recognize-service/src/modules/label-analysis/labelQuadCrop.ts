import sharp from "sharp";
import { isValidConvexQuad, type QuadGeometry } from "../../shared/quadGeometry.js";
import { normalizeLabelRectification, type LabelRectificationValue } from "../../shared/labelRectificationContract.js";
import { warpPerspectivePixels, type PerspectiveCorners } from "../ocr/perspective.js";

export type SourceCropRect = { x: number; y: number; width: number; height: number };
export type LabelCropTransformMode = "source-bbox" | "perspective" | "guided-cylindrical";

export async function createRectifiedLabelCrop(sourcePath: string, cropPath: string, rect: SourceCropRect, geometry: QuadGeometry, rectification?: LabelRectificationValue | null) {
  const result = await createRectifiedLabelCropBuffer(sourcePath, rect, geometry, rectification);
  await sharp(result.buffer).toFile(cropPath);
  return { width: result.width, height: result.height, transformMode: result.transformMode };
}

export async function createRectifiedLabelCropBuffer(sourcePath: string, rect: SourceCropRect, geometry: QuadGeometry, rectification?: LabelRectificationValue | null) {
  const extracted = await sharp(sourcePath)
    .extract({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  const relative = geometry.points.map((point) => ({ x: (point.x - rect.x) / rect.width, y: (point.y - rect.y) / rect.height }));
  const corners: PerspectiveCorners = { topLeft: relative[0]!, topRight: relative[1]!, bottomRight: relative[2]!, bottomLeft: relative[3]! };
  const normalizedRectification = normalizeLabelRectification(rectification);
  if (!normalizedRectification) {
    const buffer = await sharp(extracted.data, { raw: extracted.info }).webp({ quality: 95 }).toBuffer();
    return { buffer, width: extracted.info.width, height: extracted.info.height, transformMode: "source-bbox" as const };
  }
  const width = Math.max(1, Math.min(4096, Math.round((distance(geometry.points[0], geometry.points[1]) + distance(geometry.points[3], geometry.points[2])) / 2)));
  const height = Math.max(1, Math.min(4096, Math.round((distance(geometry.points[0], geometry.points[3]) + distance(geometry.points[1], geometry.points[2])) / 2)));
  const perspectivePixels = warpPerspectivePixels(extracted.data, extracted.info.width, extracted.info.height, extracted.info.channels, width, height, corners);
  const pixels = normalizedRectification?.type === "guided-cylindrical"
    ? warpGuidedGrid(perspectivePixels, width, height, extracted.info.channels, normalizedRectification)
    : perspectivePixels;
  const buffer = await sharp(pixels, { raw: { width, height, channels: extracted.info.channels } }).webp({ quality: 95 }).toBuffer();
  return { buffer, width, height, transformMode: normalizedRectification.type };
}

export async function createRectifiedNormalizedQuadCropBuffer(source: Buffer, sourceWidth: number, sourceHeight: number, geometry: QuadGeometry) {
  if (!isValidConvexQuad(geometry.points, { min: 0, max: 1 })) throw new Error("Normalized region crop requires a convex quad inside the Label bounds");
  const extracted = await sharp(source, { failOn: "none" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (extracted.info.width !== sourceWidth || extracted.info.height !== sourceHeight) throw new Error("Label crop dimensions do not match the supplied coordinate space");
  const corners: PerspectiveCorners = {
    topLeft: geometry.points[0], topRight: geometry.points[1], bottomRight: geometry.points[2], bottomLeft: geometry.points[3],
  };
  const pixelPoint = (point: { x: number; y: number }) => ({ x: point.x * sourceWidth, y: point.y * sourceHeight });
  const width = Math.max(1, Math.min(4096, Math.round((distance(pixelPoint(geometry.points[0]), pixelPoint(geometry.points[1])) + distance(pixelPoint(geometry.points[3]), pixelPoint(geometry.points[2]))) / 2)));
  const height = Math.max(1, Math.min(4096, Math.round((distance(pixelPoint(geometry.points[0]), pixelPoint(geometry.points[3])) + distance(pixelPoint(geometry.points[1]), pixelPoint(geometry.points[2]))) / 2)));
  const pixels = warpPerspectivePixels(extracted.data, sourceWidth, sourceHeight, extracted.info.channels, width, height, corners);
  const buffer = await sharp(pixels, { raw: { width, height, channels: extracted.info.channels } }).webp({ quality: 95 }).toBuffer();
  return { buffer, width, height };
}

function warpGuidedGrid(source: Buffer, width: number, height: number, channels: number, rectification: Extract<LabelRectificationValue, { type: "guided-cylindrical" }>) {
  const output = Buffer.alloc(width * height * channels);
  const rows = rectification.transform.rows;
  const columns = rectification.transform.columns;
  for (let y = 0; y < height; y += 1) {
    const v = height <= 1 ? 0 : y / (height - 1);
    const [top, bottom, rowMix] = rowInterval(rows, v);
    for (let x = 0; x < width; x += 1) {
      const u = width <= 1 ? 0 : x / (width - 1);
      const topPoint = pathPoint(top.points, columns, u);
      const bottomPoint = pathPoint(bottom.points, columns, u);
      const sourceX = Math.max(0, Math.min(width - 1, (topPoint.x + (bottomPoint.x - topPoint.x) * rowMix) * (width - 1)));
      const sourceY = Math.max(0, Math.min(height - 1, (topPoint.y + (bottomPoint.y - topPoint.y) * rowMix) * (height - 1)));
      sampleBilinear(source, width, height, channels, sourceX, sourceY, output, (y * width + x) * channels);
    }
  }
  return output;
}

function rowInterval(rows: Array<{ v: number; points: Array<{ x: number; y: number }> }>, v: number) {
  if (v <= rows[0]!.v) return [rows[0]!, rows[0]!, 0] as const;
  if (v >= rows[rows.length - 1]!.v) return [rows[rows.length - 1]!, rows[rows.length - 1]!, 0] as const;
  const index = Math.max(0, rows.findIndex((row) => row.v >= v) - 1);
  const top = rows[index]!;
  const bottom = rows[index + 1]!;
  return [top, bottom, (v - top.v) / Math.max(1e-6, bottom.v - top.v)] as const;
}

function pathPoint(points: Array<{ x: number; y: number }>, columns: number[], u: number) {
  const nextIndex = columns.findIndex((column) => column >= u);
  if (nextIndex <= 0) return points[0]!;
  const index = Math.min(points.length - 2, nextIndex - 1);
  const mix = (u - columns[index]!) / Math.max(1e-6, columns[index + 1]! - columns[index]!);
  return { x: points[index]!.x + (points[index + 1]!.x - points[index]!.x) * mix, y: points[index]!.y + (points[index + 1]!.y - points[index]!.y) * mix };
}

function sampleBilinear(source: Buffer, width: number, height: number, channels: number, x: number, y: number, output: Buffer, offset: number) {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  for (let channel = 0; channel < channels; channel += 1) {
    const a = source[(y0 * width + x0) * channels + channel]! * (1 - fx) + source[(y0 * width + x1) * channels + channel]! * fx;
    const b = source[(y1 * width + x0) * channels + channel]! * (1 - fx) + source[(y1 * width + x1) * channels + channel]! * fx;
    output[offset + channel] = Math.round(a * (1 - fy) + b * fy);
  }
}

function distance(left: { x: number; y: number }, right: { x: number; y: number }) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}
