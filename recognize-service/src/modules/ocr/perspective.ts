import sharp from "sharp";

export type PerspectivePoint = { x: number; y: number };
export type PerspectiveCorners = { topLeft: PerspectivePoint; topRight: PerspectivePoint; bottomRight: PerspectivePoint; bottomLeft: PerspectivePoint };
export type PerspectiveEstimate = {
  evaluated: boolean;
  applied: boolean;
  confidence: number;
  distortion: number;
  corners: PerspectiveCorners | null;
  method: "directional-edge-quad-v1";
};

type EdgePoint = { position: number; dependent: number; weight: number };
type LineFit = { slope: number; intercept: number; score: number };

export async function estimateLabelPerspective(image: Buffer, options: { previewMaxSide?: number } = {}): Promise<PerspectiveEstimate> {
  const requestedMaxSide = options.previewMaxSide;
  const previewMaxSide = Math.max(160, Math.min(1200, Math.round(requestedMaxSide ?? 480)));
  const resized = requestedMaxSide === undefined
    ? sharp(image).resize({ width: 480, withoutEnlargement: true })
    : sharp(image).resize({ width: previewMaxSide, height: previewMaxSide, fit: "inside", withoutEnlargement: true });
  const prepared = await resized.grayscale().blur(0.6).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = prepared.info;
  if (width < 60 || height < 40) return unresolved();
  const gradients = gradientThresholds(prepared.data, width, height);
  const left = rowEdges(prepared.data, width, height, 0.015, 0.48, gradients.x);
  const right = rowEdges(prepared.data, width, height, 0.52, 0.985, gradients.x);
  const top = columnEdges(prepared.data, width, height, 0.015, 0.48, gradients.y);
  const bottom = columnEdges(prepared.data, width, height, 0.52, 0.985, gradients.y);
  const leftFit = fitLine(left, height, width); const rightFit = fitLine(right, height, width);
  const topFit = fitLine(top, width, height); const bottomFit = fitLine(bottom, width, height);
  if (!leftFit || !rightFit || !topFit || !bottomFit) return unresolved();
  const topLeft = intersection(leftFit, topFit); const topRight = intersection(rightFit, topFit);
  const bottomRight = intersection(rightFit, bottomFit); const bottomLeft = intersection(leftFit, bottomFit);
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return unresolved();
  const corners = normalizeCorners({ topLeft, topRight, bottomRight, bottomLeft }, width, height);
  const area = polygonArea(Object.values(corners));
  const plausible = cornersPlausible(corners) && area >= 0.28 && area <= 1.08;
  if (!plausible) return { ...unresolved(), corners };
  const lineScore = (leftFit.score + rightFit.score + topFit.score + bottomFit.score) / 4;
  const distortion = round01(Math.max(
    Math.abs(corners.topLeft.x - corners.bottomLeft.x), Math.abs(corners.topRight.x - corners.bottomRight.x),
    Math.abs(corners.topLeft.y - corners.topRight.y), Math.abs(corners.bottomLeft.y - corners.bottomRight.y),
  ));
  const confidence = round01(lineScore * Math.min(1, area / 0.5));
  const applied = confidence >= 0.42 && distortion >= 0.018;
  return { evaluated: true, applied, confidence, distortion, corners, method: "directional-edge-quad-v1" };
}

export function warpPerspectiveGrayscale(input: Buffer, width: number, height: number, corners: PerspectiveCorners) {
  return warpPerspectivePixels(input, width, height, 1, width, height, corners);
}

export function warpPerspectivePixels(input: Buffer, inputWidth: number, inputHeight: number, channels: number, outputWidth: number, outputHeight: number, corners: PerspectiveCorners) {
  const output = Buffer.allocUnsafe(outputWidth * outputHeight * channels);
  for (let y = 0; y < outputHeight; y += 1) for (let x = 0; x < outputWidth; x += 1) {
    const source = mapUnitPoint(corners, x / Math.max(1, outputWidth - 1), y / Math.max(1, outputHeight - 1));
    for (let channel = 0; channel < channels; channel += 1) {
      output[(y * outputWidth + x) * channels + channel] = bilinearChannel(input, inputWidth, inputHeight, channels, source.x * (inputWidth - 1), source.y * (inputHeight - 1), channel);
    }
  }
  return output;
}

export function mapPerspectiveBox(box: { x: number; y: number; width: number; height: number }, corners: PerspectiveCorners) {
  const points = [
    mapUnitPoint(corners, box.x, box.y), mapUnitPoint(corners, box.x + box.width, box.y),
    mapUnitPoint(corners, box.x, box.y + box.height), mapUnitPoint(corners, box.x + box.width, box.y + box.height),
  ];
  const minX = Math.min(...points.map((point) => point.x)); const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y)); const maxY = Math.max(...points.map((point) => point.y));
  return { x: round01(minX), y: round01(minY), width: round01(maxX - minX), height: round01(maxY - minY) };
}

function mapUnitPoint(corners: PerspectiveCorners, u: number, v: number) {
  const { topLeft: p0, topRight: p1, bottomRight: p2, bottomLeft: p3 } = corners;
  const dx1 = p1.x - p2.x; const dx2 = p3.x - p2.x; const sx = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y; const dy2 = p3.y - p2.y; const sy = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(denominator) < 1e-9 ? 0 : (sx * dy2 - dx2 * sy) / denominator;
  const h = Math.abs(denominator) < 1e-9 ? 0 : (dx1 * sy - sx * dy1) / denominator;
  const a = p1.x - p0.x + g * p1.x; const b = p3.x - p0.x + h * p3.x;
  const d = p1.y - p0.y + g * p1.y; const e = p3.y - p0.y + h * p3.y;
  const scale = g * u + h * v + 1;
  return { x: clamp01((a * u + b * v + p0.x) / scale), y: clamp01((d * u + e * v + p0.y) / scale) };
}

function rowEdges(input: Buffer, width: number, height: number, from: number, to: number, threshold: number) {
  const points: EdgePoint[] = []; const start = Math.max(1, Math.floor(width * from)); const end = Math.min(width - 2, Math.ceil(width * to));
  for (let y = 2; y < height - 2; y += 2) {
    let bestX = -1; let best = 0;
    for (let x = start; x <= end; x += 1) { const value = Math.abs((input[y * width + x + 1] ?? 0) - (input[y * width + x - 1] ?? 0)); if (value > best) { best = value; bestX = x; } }
    if (bestX >= 0 && best >= threshold) points.push({ position: y, dependent: bestX, weight: best });
  }
  return points;
}

function columnEdges(input: Buffer, width: number, height: number, from: number, to: number, threshold: number) {
  const points: EdgePoint[] = []; const start = Math.max(1, Math.floor(height * from)); const end = Math.min(height - 2, Math.ceil(height * to));
  for (let x = 2; x < width - 2; x += 2) {
    let bestY = -1; let best = 0;
    for (let y = start; y <= end; y += 1) { const value = Math.abs((input[(y + 1) * width + x] ?? 0) - (input[(y - 1) * width + x] ?? 0)); if (value > best) { best = value; bestY = y; } }
    if (bestY >= 0 && best >= threshold) points.push({ position: x, dependent: bestY, weight: best });
  }
  return points;
}

function fitLine(points: EdgePoint[], independentExtent: number, dependentExtent: number): LineFit | null {
  if (points.length < Math.max(8, independentExtent * 0.12)) return null;
  const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);
  const meanX = points.reduce((sum, point) => sum + point.position * point.weight, 0) / totalWeight;
  const meanY = points.reduce((sum, point) => sum + point.dependent * point.weight, 0) / totalWeight;
  const variance = points.reduce((sum, point) => sum + point.weight * (point.position - meanX) ** 2, 0);
  if (variance <= 0) return null;
  const slope = points.reduce((sum, point) => sum + point.weight * (point.position - meanX) * (point.dependent - meanY), 0) / variance;
  const intercept = meanY - slope * meanX;
  const residual = Math.sqrt(points.reduce((sum, point) => sum + point.weight * (point.dependent - (slope * point.position + intercept)) ** 2, 0) / totalWeight);
  const coverage = Math.min(1, points.length / Math.max(1, independentExtent / 2));
  const residualScore = Math.max(0, 1 - residual / Math.max(3, dependentExtent * 0.06));
  return { slope, intercept, score: coverage * residualScore };
}

function intersection(vertical: LineFit, horizontal: LineFit) {
  const denominator = 1 - vertical.slope * horizontal.slope;
  if (Math.abs(denominator) < 1e-6) return null;
  const x = (vertical.slope * horizontal.intercept + vertical.intercept) / denominator;
  return { x, y: horizontal.slope * x + horizontal.intercept };
}

function gradientThresholds(input: Buffer, width: number, height: number) {
  const xValues: number[] = []; const yValues: number[] = [];
  for (let y = 2; y < height - 2; y += 4) for (let x = 2; x < width - 2; x += 4) {
    xValues.push(Math.abs((input[y * width + x + 1] ?? 0) - (input[y * width + x - 1] ?? 0)));
    yValues.push(Math.abs((input[(y + 1) * width + x] ?? 0) - (input[(y - 1) * width + x] ?? 0)));
  }
  return { x: robustThreshold(xValues), y: robustThreshold(yValues) };
}

function robustThreshold(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return Math.max(12, sorted[Math.floor(sorted.length * 0.88)] ?? 12);
}

function normalizeCorners(corners: PerspectiveCorners, width: number, height: number): PerspectiveCorners {
  const point = ({ x, y }: PerspectivePoint) => ({ x: round01(x / width), y: round01(y / height) });
  return { topLeft: point(corners.topLeft), topRight: point(corners.topRight), bottomRight: point(corners.bottomRight), bottomLeft: point(corners.bottomLeft) };
}

function cornersPlausible(corners: PerspectiveCorners) {
  const { topLeft, topRight, bottomRight, bottomLeft } = corners;
  return topLeft.x < topRight.x && bottomLeft.x < bottomRight.x && topLeft.y < bottomLeft.y && topRight.y < bottomRight.y
    && Object.values(corners).every((point) => point.x >= -0.08 && point.x <= 1.08 && point.y >= -0.08 && point.y <= 1.08);
}

function polygonArea(points: PerspectivePoint[]) {
  return Math.abs(points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y; }, 0)) / 2;
}

function bilinear(input: Buffer, width: number, height: number, x: number, y: number) {
  return bilinearChannel(input, width, height, 1, x, y, 0);
}

function bilinearChannel(input: Buffer, width: number, height: number, channels: number, x: number, y: number, channel: number) {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(x))); const y0 = Math.max(0, Math.min(height - 1, Math.floor(y)));
  const x1 = Math.min(width - 1, x0 + 1); const y1 = Math.min(height - 1, y0 + 1); const fx = x - x0; const fy = y - y0;
  const value = (px: number, py: number) => input[(py * width + px) * channels + channel] ?? 255;
  const top = value(x0, y0) * (1 - fx) + value(x1, y0) * fx;
  const bottom = value(x0, y1) * (1 - fx) + value(x1, y1) * fx;
  return Math.round(top * (1 - fy) + bottom * fy);
}

function unresolved(): PerspectiveEstimate {
  return { evaluated: true, applied: false, confidence: 0, distortion: 0, corners: null, method: "directional-edge-quad-v1" };
}

function clamp01(value: number) { return Math.max(0, Math.min(1, value)); }
function round01(value: number) { return Math.round(clamp01(value) * 10000) / 10000; }
