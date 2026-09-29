export type LabelRectificationPoint = { x: number; y: number };
export type CylindricalGuides = { centerLine: LabelRectificationPoint[]; horizontalGuides: LabelRectificationPoint[][]; leftBoundary: LabelRectificationPoint[]; rightBoundary: LabelRectificationPoint[] };
export type CylindricalControls = { signedCurvature: number; horizontalScale: number };
export type CylindricalTransform = { schemaVersion: 1; model: "guided-grid-v1"; coordinateSpace: "label-perspective-normalized"; columns: number[]; rows: Array<{ v: number; points: LabelRectificationPoint[] }>; curvature: number; surfaceWidth: number };
export type LabelRectification =
  | { type: "perspective"; transform: { schemaVersion: 1; model: "quad-homography-v1" } }
  | { type: "guided-cylindrical"; guides: CylindricalGuides; controls: CylindricalControls; transform: CylindricalTransform };

export const perspectiveRectification = (): LabelRectification => ({ type: "perspective", transform: { schemaVersion: 1, model: "quad-homography-v1" } });

export type CylindricalGuideHandle = {
  guide: "centerLine" | "leftBoundary" | "rightBoundary" | "horizontalGuides";
  rowIndex: number;
  pointIndex: number;
};
export function defaultCylindricalGuides(): CylindricalGuides {
  const ys = [.08, .5, .92], xs = [0, .25, .5, .75, 1];
  return { centerLine: ys.map((y) => ({ x: .5, y })), leftBoundary: ys.map((y) => ({ x: 0, y })), rightBoundary: ys.map((y) => ({ x: 1, y })), horizontalGuides: ys.map((y) => xs.map((x) => ({ x, y }))) };
}
export function cylindricalRectification(guides = defaultCylindricalGuides()): LabelRectification {
  const columns = [0, .25, .5, .75, 1];
  const rows = guides.horizontalGuides.map((points) => ({ v: points.reduce((sum, point) => sum + point.y, 0) / points.length, points })).sort((a, b) => a.v - b.v);
  if (rows.length >= 2 && rows[0]!.v > 0) rows.unshift(extrapolateRow(rows[0]!, rows[1]!, 0));
  if (rows.length >= 2 && rows[rows.length - 1]!.v < 1) rows.push(extrapolateRow(rows[rows.length - 2]!, rows[rows.length - 1]!, 1));
  const curvature = rows.reduce((sum, row) => sum + Math.abs(row.points[2]!.y - (row.points[0]!.y + row.points[4]!.y) / 2), 0) / rows.length;
  const surfaceWidth = rows.reduce((sum, row) => sum + Math.hypot(row.points[4]!.x - row.points[0]!.x, row.points[4]!.y - row.points[0]!.y), 0) / rows.length;
  return { type: "guided-cylindrical", guides, controls: cylindricalControls(guides), transform: { schemaVersion: 1, model: "guided-grid-v1", coordinateSpace: "label-perspective-normalized", columns, rows, curvature, surfaceWidth } };
}

export function cylindricalControls(guides: CylindricalGuides): CylindricalControls {
  const rows = guides.horizontalGuides.filter((row) => row.length >= 2);
  if (!rows.length) return { signedCurvature: 0, horizontalScale: 1 };
  const signedCurvature = rows.reduce((sum, row) => {
    const center = row[Math.floor(row.length / 2)]!;
    return sum + center.y - (row[0]!.y + row[row.length - 1]!.y) / 2;
  }, 0) / rows.length;
  const horizontalScale = rows.reduce((sum, row) => sum + row[row.length - 1]!.x - row[0]!.x, 0) / rows.length;
  return { signedCurvature, horizontalScale };
}

export function setCylindricalCurvature(rectification: Extract<LabelRectification, { type: "guided-cylindrical" }>, signedCurvature: number): LabelRectification {
  const guides = structuredClone(rectification.guides);
  for (const row of guides.horizontalGuides) {
    if (row.length < 2) continue;
    const left = row[0]!, right = row[row.length - 1]!;
    row.forEach((point, index) => {
      const t = index / (row.length - 1);
      point.y = extendedClamp(left.y + (right.y - left.y) * t + signedCurvature * 4 * t * (1 - t));
    });
  }
  synchronizeGuidePaths(guides);
  return cylindricalRectification(guides);
}

export function setCylindricalHorizontalScale(rectification: Extract<LabelRectification, { type: "guided-cylindrical" }>, horizontalScale: number): LabelRectification {
  const guides = structuredClone(rectification.guides);
  const current = cylindricalControls(guides).horizontalScale;
  const centerX = guides.centerLine.reduce((sum, point) => sum + point.x, 0) / Math.max(1, guides.centerLine.length);
  const ratio = horizontalScale / Math.max(0.01, current);
  const scalePath = (path: LabelRectificationPoint[]) => path.forEach((point) => { point.x = extendedClamp(centerX + (point.x - centerX) * ratio); });
  guides.horizontalGuides.forEach(scalePath);
  scalePath(guides.leftBoundary); scalePath(guides.centerLine); scalePath(guides.rightBoundary);
  return cylindricalRectification(guides);
}

export function mapQuadUnitPoint(points: Array<{ x: number; y: number }>, u: number, v: number) {
  const [p0, p1, p2, p3] = points;
  if (!p0 || !p1 || !p2 || !p3) return { x: 0, y: 0 };
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, sx = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, sy = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g = Math.abs(denominator) < 1e-9 ? 0 : (sx * dy2 - dx2 * sy) / denominator;
  const h = Math.abs(denominator) < 1e-9 ? 0 : (dx1 * sy - sx * dy1) / denominator;
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y;
  const scale = g * u + h * v + 1;
  return { x: (a * u + b * v + p0.x) / scale, y: (d * u + e * v + p0.y) / scale };
}

export function inverseQuadUnitPoint(points: Array<{ x: number; y: number }>, target: { x: number; y: number }) {
  let u = .5, v = .5;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const current = mapQuadUnitPoint(points, u, v), du = mapQuadUnitPoint(points, u + .001, v), dv = mapQuadUnitPoint(points, u, v + .001);
    const ax = (du.x - current.x) / .001, ay = (du.y - current.y) / .001, bx = (dv.x - current.x) / .001, by = (dv.y - current.y) / .001;
    const determinant = ax * by - ay * bx;
    if (Math.abs(determinant) < 1e-8) break;
    const ex = target.x - current.x, ey = target.y - current.y;
    u += (ex * by - ey * bx) / determinant;
    v += (ax * ey - ay * ex) / determinant;
    u = extendedClamp(u); v = extendedClamp(v);
  }
  return { x: u, y: v };
}

export function updateCylindricalGuide(rectification: Extract<LabelRectification, { type: "guided-cylindrical" }>, handle: CylindricalGuideHandle, point: { x: number; y: number }): LabelRectification {
  const guides = structuredClone(rectification.guides);
  if (handle.guide === "horizontalGuides") guides.horizontalGuides[handle.rowIndex]![handle.pointIndex] = { x: extendedClamp(point.x), y: extendedClamp(point.y) };
  else guides[handle.guide][handle.pointIndex] = { x: extendedClamp(point.x), y: extendedClamp(point.y) };
  return cylindricalRectification(guides);
}

export function addHorizontalGuide(rectification: Extract<LabelRectification, { type: "guided-cylindrical" }>): LabelRectification {
  const guides = structuredClone(rectification.guides), rows = [...guides.horizontalGuides].sort((a, b) => a[2]!.y - b[2]!.y);
  let index = 0, gap = -1;
  for (let i = 0; i < rows.length - 1; i += 1) {
    const value = rows[i + 1]![2]!.y - rows[i]![2]!.y;
    if (value > gap) { gap = value; index = i; }
  }
  const a = rows[index]!, b = rows[index + 1]!;
  rows.splice(index + 1, 0, a.map((point, pointIndex) => ({ x: (point.x + b[pointIndex]!.x) / 2, y: (point.y + b[pointIndex]!.y) / 2 })));
  guides.horizontalGuides = rows;
  return cylindricalRectification(guides);
}

export function removeHorizontalGuide(rectification: Extract<LabelRectification, { type: "guided-cylindrical" }>): LabelRectification {
  const guides = structuredClone(rectification.guides);
  if (guides.horizontalGuides.length > 2) guides.horizontalGuides.splice(Math.floor(guides.horizontalGuides.length / 2), 1);
  return cylindricalRectification(guides);
}

function extrapolateRow(left: { v: number; points: LabelRectificationPoint[] }, right: { v: number; points: LabelRectificationPoint[] }, v: number) {
  const mix = (v - left.v) / Math.max(1e-6, right.v - left.v);
  return { v, points: left.points.map((point, index) => ({ x: extendedClamp(point.x + (right.points[index]!.x - point.x) * mix), y: clamp(point.y + (right.points[index]!.y - point.y) * mix) })) };
}
function synchronizeGuidePaths(guides: CylindricalGuides) {
  const rows = [...guides.horizontalGuides].sort((a, b) => a[Math.floor(a.length / 2)]!.y - b[Math.floor(b.length / 2)]!.y);
  guides.centerLine = rows.map((row) => ({ ...row[Math.floor(row.length / 2)]! }));
  guides.leftBoundary = rows.map((row) => ({ ...row[0]! }));
  guides.rightBoundary = rows.map((row) => ({ ...row[row.length - 1]! }));
}
function clamp(value: number) { return Math.max(0, Math.min(1, value)); }
function extendedClamp(value: number) { return Math.max(-0.25, Math.min(1.25, value)); }
