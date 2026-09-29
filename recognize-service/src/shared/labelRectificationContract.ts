export type LabelRectificationPoint = { x: number; y: number };

export type CylindricalGuides = {
  centerLine: LabelRectificationPoint[];
  horizontalGuides: LabelRectificationPoint[][];
  leftBoundary: LabelRectificationPoint[];
  rightBoundary: LabelRectificationPoint[];
};
export type CylindricalControls = { signedCurvature: number; horizontalScale: number };

export type CylindricalTransform = {
  schemaVersion: 1;
  model: "guided-grid-v1";
  coordinateSpace: "label-perspective-normalized";
  columns: number[];
  rows: Array<{ v: number; points: LabelRectificationPoint[] }>;
  curvature: number;
  surfaceWidth: number;
};

export type LabelRectificationValue =
  | { type: "perspective"; transform: { schemaVersion: 1; model: "quad-homography-v1" } }
  | { type: "guided-cylindrical"; guides: CylindricalGuides; controls?: CylindricalControls; transform: CylindricalTransform };

const COLUMNS = [0, 0.25, 0.5, 0.75, 1];

export function defaultCylindricalGuides(): CylindricalGuides {
  const ys = [0.08, 0.5, 0.92];
  return {
    centerLine: ys.map((y) => ({ x: 0.5, y })),
    leftBoundary: ys.map((y) => ({ x: 0, y })),
    rightBoundary: ys.map((y) => ({ x: 1, y })),
    horizontalGuides: ys.map((y) => COLUMNS.map((x) => ({ x, y }))),
  };
}

export function buildCylindricalTransform(guides: CylindricalGuides): CylindricalTransform {
  const rows = guides.horizontalGuides
    .map((row) => normalizeRow(row))
    .filter((row) => row.length === COLUMNS.length)
    .map((points) => ({ v: clamp(points.reduce((sum, point) => sum + point.y, 0) / points.length), points }))
    .sort((left, right) => left.v - right.v);
  const baseRows = rows.length >= 2 ? rows : defaultCylindricalGuides().horizontalGuides.map((points) => ({ v: points[0]!.y, points }));
  const safeRows = coverFullHeight(baseRows);
  const curvature = safeRows.reduce((sum, row) => sum + Math.abs(row.points[2]!.y - (row.points[0]!.y + row.points[4]!.y) / 2), 0) / safeRows.length;
  const surfaceWidth = safeRows.reduce((sum, row) => sum + Math.hypot(row.points[4]!.x - row.points[0]!.x, row.points[4]!.y - row.points[0]!.y), 0) / safeRows.length;
  return { schemaVersion: 1, model: "guided-grid-v1", coordinateSpace: "label-perspective-normalized", columns: [...COLUMNS], rows: safeRows, curvature, surfaceWidth };
}

export function buildCylindricalControls(guides: CylindricalGuides): CylindricalControls {
  const rows = guides.horizontalGuides.filter((row) => row.length >= 2);
  if (!rows.length) return { signedCurvature: 0, horizontalScale: 1 };
  return {
    signedCurvature: rows.reduce((sum, row) => sum + row[Math.floor(row.length / 2)]!.y - (row[0]!.y + row[row.length - 1]!.y) / 2, 0) / rows.length,
    horizontalScale: rows.reduce((sum, row) => sum + row[row.length - 1]!.x - row[0]!.x, 0) / rows.length,
  };
}

function coverFullHeight(rows: Array<{ v: number; points: LabelRectificationPoint[] }>) {
  const output = rows.map((row) => ({ v: row.v, points: row.points.map((point) => ({ ...point })) }));
  if (output[0]!.v > 0) output.unshift(extrapolateRow(output[0]!, output[1]!, 0));
  if (output[output.length - 1]!.v < 1) output.push(extrapolateRow(output[output.length - 2]!, output[output.length - 1]!, 1));
  return output;
}

function extrapolateRow(left: { v: number; points: LabelRectificationPoint[] }, right: { v: number; points: LabelRectificationPoint[] }, v: number) {
  const mix = (v - left.v) / Math.max(1e-6, right.v - left.v);
  return { v, points: left.points.map((point, index) => ({ x: extendedClamp(point.x + (right.points[index]!.x - point.x) * mix), y: clamp(point.y + (right.points[index]!.y - point.y) * mix) })) };
}

export function normalizeLabelRectification(value: unknown): LabelRectificationValue | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type === "perspective") return { type: "perspective", transform: { schemaVersion: 1, model: "quad-homography-v1" } };
  if (record.type !== "guided-cylindrical") return null;
  const raw = record.guides as Partial<CylindricalGuides> | undefined;
  const fallback = defaultCylindricalGuides();
  const guides: CylindricalGuides = {
    centerLine: normalizePath(raw?.centerLine, fallback.centerLine),
    leftBoundary: normalizePath(raw?.leftBoundary, fallback.leftBoundary),
    rightBoundary: normalizePath(raw?.rightBoundary, fallback.rightBoundary),
    horizontalGuides: Array.isArray(raw?.horizontalGuides)
      ? raw!.horizontalGuides!.map((row) => normalizeRow(row)).filter((row) => row.length === COLUMNS.length)
      : fallback.horizontalGuides,
  };
  if (guides.horizontalGuides.length < 2) guides.horizontalGuides = fallback.horizontalGuides;
  return { type: "guided-cylindrical", guides, controls: buildCylindricalControls(guides), transform: buildCylindricalTransform(guides) };
}

function normalizePath(value: unknown, fallback: LabelRectificationPoint[]) {
  if (!Array.isArray(value) || value.length < 2) return fallback;
  return value.map(normalizePoint).filter((point): point is LabelRectificationPoint => point !== null);
}

function normalizeRow(value: unknown): LabelRectificationPoint[] {
  if (!Array.isArray(value)) return [];
  const points = value.map(normalizePoint).filter((point): point is LabelRectificationPoint => point !== null);
  if (points.length === COLUMNS.length) return points;
  if (points.length < 2) return [];
  return COLUMNS.map((u) => interpolatePath(points, u));
}

function normalizePoint(value: unknown): LabelRectificationPoint | null {
  if (!value || typeof value !== "object") return null;
  const point = value as Record<string, unknown>;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: extendedClamp(Number(point.x)), y: extendedClamp(Number(point.y)) };
}

function interpolatePath(points: LabelRectificationPoint[], t: number) {
  const scaled = t * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const local = scaled - index;
  return { x: points[index]!.x + (points[index + 1]!.x - points[index]!.x) * local, y: points[index]!.y + (points[index + 1]!.y - points[index]!.y) * local };
}

function clamp(value: number) { return Math.max(0, Math.min(1, value)); }
function extendedClamp(value: number) { return Math.max(-0.25, Math.min(1.25, value)); }
