import type { QuadGeometry, RecognitionPoint, RecognitionRoi } from "@/lib/admin/api";

export function rectangleQuad(bbox: RecognitionRoi): QuadGeometry {
  const normalized = normalizeRect(bbox);
  return {
    type: "quad",
    points: [
      { x: normalized.x, y: normalized.y },
      { x: normalized.x + normalized.width, y: normalized.y },
      { x: normalized.x + normalized.width, y: normalized.y + normalized.height },
      { x: normalized.x, y: normalized.y + normalized.height },
    ],
    bbox: normalized,
  };
}

export function normalizeQuad(geometry: QuadGeometry | null | undefined, fallback?: RecognitionRoi | null): QuadGeometry | null {
  if (geometry?.type === "quad" && geometry.points.length === 4) {
    const points = canonicalPoints(geometry.points);
    if (isConvexQuad(points)) return { type: "quad", points, bbox: quadBbox(points) };
  }
  return fallback && fallback.width > 0 && fallback.height > 0 ? rectangleQuad(fallback) : null;
}

export function quadBbox(points: readonly RecognitionPoint[]): RecognitionRoi {
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function moveQuad(geometry: QuadGeometry, dx: number, dy: number, bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }): QuadGeometry {
  const bbox = geometry.bbox;
  const clampedX = Math.max(bounds.minX - bbox.x, Math.min(dx, bounds.maxX - bbox.x - bbox.width));
  const clampedY = Math.max(bounds.minY - bbox.y, Math.min(dy, bounds.maxY - bbox.y - bbox.height));
  return fromPoints(geometry.points.map((point) => ({ x: point.x + clampedX, y: point.y + clampedY })));
}

export function moveQuadCorner(geometry: QuadGeometry, index: number, point: RecognitionPoint, bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }): QuadGeometry | null {
  const points = geometry.points.map((candidate, candidateIndex) => candidateIndex === index ? {
    x: clamp(point.x, bounds.minX, bounds.maxX),
    y: clamp(point.y, bounds.minY, bounds.maxY),
  } : candidate);
  if (!isConvexQuad(points)) return null;
  return fromPoints(points);
}

export function pointInQuad(point: RecognitionPoint, geometry: QuadGeometry) {
  const crosses = geometry.points.map((corner, index) => cross(corner, geometry.points[(index + 1) % 4]!, point));
  return crosses.every((value) => value >= -1e-8) || crosses.every((value) => value <= 1e-8);
}

export function isConvexQuad(points: readonly RecognitionPoint[]) {
  if (points.length !== 4 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
  const crosses = points.map((point, index) => cross(point, points[(index + 1) % 4]!, points[(index + 2) % 4]!));
  return crosses.every((value) => value > 1e-8) || crosses.every((value) => value < -1e-8);
}

export function sameQuad(left: QuadGeometry | null | undefined, right: QuadGeometry | null | undefined, epsilon = 1e-6) {
  const normalizedLeft = normalizeQuad(left);
  const normalizedRight = normalizeQuad(right);
  if (!normalizedLeft || !normalizedRight) return normalizedLeft === normalizedRight;
  return normalizedLeft.points.every((point, index) => {
    const candidate = normalizedRight.points[index]!;
    return Math.abs(point.x - candidate.x) <= epsilon && Math.abs(point.y - candidate.y) <= epsilon;
  });
}

/** Lightweight duplicate warning, not an automatic identity decision. */
export function visualRegionOverlapRatio(left: QuadGeometry, right: QuadGeometry) {
  const leftArea = Math.max(0, left.bbox.width) * Math.max(0, left.bbox.height);
  const rightArea = Math.max(0, right.bbox.width) * Math.max(0, right.bbox.height);
  const smallerArea = Math.min(leftArea, rightArea);
  if (smallerArea <= 0) return 0;
  const width = Math.max(0, Math.min(left.bbox.x + left.bbox.width, right.bbox.x + right.bbox.width) - Math.max(left.bbox.x, right.bbox.x));
  const height = Math.max(0, Math.min(left.bbox.y + left.bbox.height, right.bbox.y + right.bbox.height) - Math.max(left.bbox.y, right.bbox.y));
  return (width * height) / smallerArea;
}

function fromPoints(points: RecognitionPoint[]): QuadGeometry {
  const tuple: QuadGeometry["points"] = [points[0]!, points[1]!, points[2]!, points[3]!];
  return { type: "quad", points: tuple, bbox: quadBbox(tuple) };
}

function canonicalPoints(points: readonly RecognitionPoint[]): QuadGeometry["points"] {
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const ordered = [...points].sort((left, right) => Math.atan2(left.y - center.y, left.x - center.x) - Math.atan2(right.y - center.y, right.x - center.x));
  if (signedArea(ordered) < 0) ordered.reverse();
  const start = ordered.reduce((best, point, index) => point.x + point.y < ordered[best]!.x + ordered[best]!.y ? index : best, 0);
  const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];
  return [rotated[0]!, rotated[1]!, rotated[2]!, rotated[3]!];
}

function normalizeRect(rect: RecognitionRoi) {
  const x = rect.width >= 0 ? rect.x : rect.x + rect.width;
  const y = rect.height >= 0 ? rect.y : rect.y + rect.height;
  return { x, y, width: Math.abs(rect.width), height: Math.abs(rect.height) };
}

function signedArea(points: readonly RecognitionPoint[]) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function cross(a: RecognitionPoint, b: RecognitionPoint, c: RecognitionPoint) {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
