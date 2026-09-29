export type GeometryPoint = { x: number; y: number };
export type GeometryBbox = { x: number; y: number; width: number; height: number };
export type QuadGeometry = {
  type: "quad";
  points: [GeometryPoint, GeometryPoint, GeometryPoint, GeometryPoint];
  bbox: GeometryBbox;
};

export function rectangleGeometry(bbox: GeometryBbox): QuadGeometry {
  const normalized = normalizeBbox(bbox);
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

export function normalizeQuadGeometry(value: unknown, fallbackBbox?: unknown): QuadGeometry | null {
  const record = objectValue(value);
  const rawPoints = Array.isArray(record?.points) ? record.points.map(pointValue) : [];
  const points = rawPoints.every((point): point is GeometryPoint => point !== null) && rawPoints.length === 4
    ? canonicalPoints(rawPoints as GeometryPoint[])
    : null;
  if (points && isValidConvexQuad(points)) return { type: "quad", points, bbox: bboxFromPoints(points) };
  const bbox = bboxValue(fallbackBbox ?? record?.bbox);
  return bbox ? rectangleGeometry(bbox) : null;
}

export function bboxFromGeometry(geometry: QuadGeometry): GeometryBbox {
  return bboxFromPoints(geometry.points);
}

export function isValidConvexQuad(points: readonly GeometryPoint[], bounds?: { min: number; max: number }) {
  if (points.length !== 4 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
  if (bounds && points.some((point) => point.x < bounds.min || point.x > bounds.max || point.y < bounds.min || point.y > bounds.max)) return false;
  const crosses = points.map((point, index) => cross(point, points[(index + 1) % 4]!, points[(index + 2) % 4]!));
  const epsilon = 1e-8;
  return crosses.every((value) => value > epsilon) || crosses.every((value) => value < -epsilon);
}

export function sameQuad(left: QuadGeometry | null | undefined, right: QuadGeometry | null | undefined, epsilon = 1e-6) {
  if (!left || !right) return left === right;
  return left.points.every((point, index) => {
    const candidate = right.points[index]!;
    return Math.abs(point.x - candidate.x) <= epsilon && Math.abs(point.y - candidate.y) <= epsilon;
  });
}

function canonicalPoints(points: GeometryPoint[]): [GeometryPoint, GeometryPoint, GeometryPoint, GeometryPoint] {
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const ordered = [...points].sort((left, right) => Math.atan2(left.y - center.y, left.x - center.x) - Math.atan2(right.y - center.y, right.x - center.x));
  if (signedArea(ordered) < 0) ordered.reverse();
  const start = ordered.reduce((best, point, index) => point.x + point.y < ordered[best]!.x + ordered[best]!.y ? index : best, 0);
  const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];
  return [rotated[0]!, rotated[1]!, rotated[2]!, rotated[3]!];
}

function bboxFromPoints(points: readonly GeometryPoint[]): GeometryBbox {
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const right = Math.max(...points.map((point) => point.x));
  const bottom = Math.max(...points.map((point) => point.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function signedArea(points: readonly GeometryPoint[]) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function cross(a: GeometryPoint, b: GeometryPoint, c: GeometryPoint) {
  return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

function bboxValue(value: unknown): GeometryBbox | null {
  const record = objectValue(value);
  const x = finite(record?.x); const y = finite(record?.y);
  const width = finite(record?.width); const height = finite(record?.height);
  return x === null || y === null || width === null || height === null || width <= 0 || height <= 0 ? null : normalizeBbox({ x, y, width, height });
}

function pointValue(value: unknown): GeometryPoint | null {
  const record = objectValue(value);
  const x = finite(record?.x); const y = finite(record?.y);
  return x === null || y === null ? null : { x, y };
}

function normalizeBbox(bbox: GeometryBbox): GeometryBbox {
  return { x: bbox.x, y: bbox.y, width: Math.max(0, bbox.width), height: Math.max(0, bbox.height) };
}

function finite(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function objectValue(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
