import { getAnnotationGraphForTrack } from "../../db/official-draft.repository.js";
import { getSourceItemForTrack } from "../../db/official-draft.repository.js";
import { sourceAssetRef } from "../../shared/officialReference.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getAnnotationGraph } from "../../db/annotation-graph.repository.js";
import { getSourceItem } from "../../db/source.repository.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import type { RegionGeometry } from "../../shared/annotationGraphContract.js";
import type { SourceName } from "../../shared/types.js";
import { resolveGeneratedAssetPath, resolveLocalAssetPath } from "../recognize-node/assets.js";
import type { WizardVisualRenderRequest } from "./wizard.schemas.js";

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

export async function renderWizardVisualContext(source: SourceName, sourceItemId: string, annotationId: string, input: WizardVisualRenderRequest) {
  const [graph, sourceItem] = await Promise.all([getAnnotationGraphForTrack(source, sourceItemId, annotationId), getSourceItemForTrack(source, sourceItemId, annotationId)]);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const packageEntity = graph.packages.find((item) => item.legacyAnnotationTrackId === annotationId);
  if (!packageEntity) throw new NotFoundError("Package for annotation track was not found");
  const sourceRef = sourceAssetRef(sourceItem);
  const sourcePath = sourceRef ? resolveLocalAssetPath(sourceRef) : null;
  if (!sourceRef || !sourcePath) throw new ConflictError("Selected Package has no local source asset");
  const metadata = await sharp(sourcePath, { failOn: "none" }).metadata();
  const sourceSize = orientedSize(metadata.width, metadata.height, metadata.orientation);
  if (!sourceSize.width || !sourceSize.height) throw new ConflictError("Source image dimensions are unavailable");
  const viewportLabelId = input.viewport.type === "label" ? input.viewport.id : null;
  const label = viewportLabelId ? packageEntity.labels.find((item) => item.id === viewportLabelId) : null;
  if (input.viewport.type === "label" && !label) throw new NotFoundError("Viewport Label does not belong to this annotation track");
  if (input.selectedLabelId && !packageEntity.labels.some((item) => item.id === input.selectedLabelId)) throw new NotFoundError("Selected Label does not belong to this annotation track");
  const viewport = clampRect(
    input.viewport.type === "source" ? { x: 0, y: 0, width: sourceSize.width, height: sourceSize.height }
      : input.viewport.type === "package" ? packageEntity.scope.geometry?.bbox ?? { x: 0, y: 0, width: sourceSize.width, height: sourceSize.height }
        : label!.geometry.bbox,
    sourceSize,
  );
  const rendered = await sharp(sourcePath, { failOn: "none" }).rotate().extract(integerRect(viewport, sourceSize))
    .resize({ width: input.maxSide, height: input.maxSide, fit: "inside", withoutEnlargement: false })
    .webp({ quality: 88 }).toBuffer({ resolveWithObject: true });
  const transform = { sourceViewport: viewport, preview: { width: rendered.info.width, height: rendered.info.height }, scaleX: rendered.info.width / viewport.width, scaleY: rendered.info.height / viewport.height };
  const layers = buildOverlayModel(packageEntity, input, transform);
  const svg = overlaySvg(rendered.info.width, rendered.info.height, layers);
  const composite = await sharp(rendered.data).composite([{ input: Buffer.from(svg) }]).webp({ quality: 90 }).toBuffer();
  const renderId = crypto.randomUUID();
  const baseAssetPath = `label-analysis/vision-context/${annotationId}/${renderId}-base.webp`;
  const overlayAssetPath = `label-analysis/vision-context/${annotationId}/${renderId}-overlay.webp`;
  await persistAsset(baseAssetPath, rendered.data);
  await persistAsset(overlayAssetPath, composite);
  return {
    schemaVersion: 1, renderId, annotationId, sourceAssetRef: sourceRef,
    viewport: { request: input.viewport, sourceRect: viewport },
    transform: { type: "source-crop-scale", ...transform },
    assets: {
      base: { assetPath: baseAssetPath, width: rendered.info.width, height: rendered.info.height, mimeType: "image/webp" },
      overlay: { assetPath: overlayAssetPath, width: rendered.info.width, height: rendered.info.height, mimeType: "image/webp" },
    },
    overlayModel: { coordinateSpace: "preview-pixels", layers },
  };
}

export async function renderLabelCandidateOverlay(
  visualContext: Awaited<ReturnType<typeof renderWizardVisualContext>>,
  candidates: Array<{ id: string; polygon: Array<[number, number]> }>,
  packageContour: Array<[number, number]> = [],
) {
  const basePath = resolveGeneratedAssetPath(visualContext.assets.base.assetPath);
  if (!basePath) throw new ConflictError("Rendered candidate base asset path is unavailable");
  const layers = candidates.map((candidate, index) => ({
    id: candidate.id,
    rank: index + 1,
    points: candidate.polygon.map(([x, y]) => projectSourcePoint({ x, y }, visualContext.transform)),
  }));
  const projectedPackageContour = packageContour.map(([x, y]) => projectSourcePoint({ x, y }, visualContext.transform));
  const svg = candidateOverlaySvg(visualContext.assets.base.width, visualContext.assets.base.height, layers, projectedPackageContour);
  const buffer = await sharp(basePath, { failOn: "none" }).composite([{ input: Buffer.from(svg) }]).webp({ quality: 90 }).toBuffer();
  const assetPath = `label-analysis/vision-context/${visualContext.annotationId}/${visualContext.renderId}-label-candidates.webp`;
  await persistAsset(assetPath, buffer);
  return {
    renderer: { id: "label-candidate-overlay", version: packageContour.length >= 3 ? "2" : "1" },
    asset: { assetPath, width: visualContext.assets.base.width, height: visualContext.assets.base.height, mimeType: "image/webp" },
    layers: [
      ...(projectedPackageContour.length >= 3 ? [{ id: "accepted-package-contour", rank: 0, previewGeometry: { type: "polygon", points: projectedPackageContour } }] : []),
      ...layers.map(({ id, rank, points }) => ({ id, rank, previewGeometry: { type: "polygon", points } })),
    ],
  };
}

export async function renderStageResultOverlay(
  visualContext: Awaited<ReturnType<typeof renderWizardVisualContext>>,
  input: {
    stage: string;
    sourcePolygons?: Array<{ id: string; points: Point[]; color?: string }>;
    normalizedPolygons?: Array<{ id: string; points: Point[]; color?: string }>;
    mask?: { width: number; height: number; data: string; color?: [number, number, number] } | null;
    palette?: Array<{ rgb: number[]; ratio?: number }>;
  },
) {
  const basePath = resolveGeneratedAssetPath(visualContext.assets.base.assetPath);
  if (!basePath) throw new ConflictError("Rendered stage base asset path is unavailable");
  const width = visualContext.assets.base.width, height = visualContext.assets.base.height;
  const layers = [
    ...(input.sourcePolygons ?? []).map((item) => ({ ...item, points: item.points.map((point) => projectSourcePoint(point, visualContext.transform)) })),
    ...(input.normalizedPolygons ?? []).map((item) => ({ ...item, points: item.points.map((point) => ({ x: round(point.x * width), y: round(point.y * height) })) })),
  ];
  const composites: Array<{ input: Buffer }> = [];
  if (input.mask) {
    const values = decodeBinaryMaskRle(input.mask.data, input.mask.width * input.mask.height);
    const [red, green, blue] = input.mask.color ?? [6, 182, 212];
    const rgba = Buffer.alloc(values.length * 4);
    for (let index = 0; index < values.length; index += 1) {
      const enabled = values[index] === 1; const offset = index * 4;
      rgba[offset] = red; rgba[offset + 1] = green; rgba[offset + 2] = blue; rgba[offset + 3] = enabled ? 120 : 0;
    }
    const resized = await sharp(rgba, { raw: { width: input.mask.width, height: input.mask.height, channels: 4 } })
      .resize(width, height, { fit: "fill", kernel: "nearest" }).png().toBuffer();
    composites.push({ input: resized });
  }
  const svg = stageOverlaySvg(width, height, layers, input.palette ?? []);
  composites.push({ input: Buffer.from(svg) });
  const buffer = await sharp(basePath, { failOn: "none" }).composite(composites).webp({ quality: 90 }).toBuffer();
  const assetPath = `label-analysis/vision-context/${visualContext.annotationId}/${visualContext.renderId}-${safeName(input.stage)}-result.webp`;
  await persistAsset(assetPath, buffer);
  return {
    renderer: { id: `${safeName(input.stage)}-result-overlay`, version: "1" },
    asset: { assetPath, width, height, mimeType: "image/webp" },
    layers: layers.map((item) => ({ id: item.id, previewGeometry: { type: "polygon", points: item.points } })),
  };
}

export async function renderMorphologyComparisonBoard(
  visualContext: Awaited<ReturnType<typeof renderWizardVisualContext>>,
  inputMask: { width: number; height: number; data: string },
  candidates: Array<{
    id: string; pipeline: Array<{ operation: string; kernel: [number, number]; iterations: number }>;
    score: number; metrics: { foregroundDelta: number; connectedComponentCount: number; smallComponentCount: number; fragmentation: number };
    mask: { width: number; height: number; data: string };
  }>,
) {
  const columns = 2; const cellWidth = 360; const imageHeight = 260; const headerHeight = 74;
  const rows = Math.max(1, Math.ceil(candidates.length / columns));
  const boardWidth = columns * cellWidth; const boardHeight = rows * (imageHeight + headerHeight);
  const source = decodeBinaryMaskRle(inputMask.data, inputMask.width * inputMask.height);
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  const labels: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const left = (index % columns) * cellWidth; const top = Math.floor(index / columns) * (imageHeight + headerHeight);
    const result = decodeBinaryMaskRle(candidate.mask.data, candidate.mask.width * candidate.mask.height);
    const rgba = morphologyDiffRgba(source, result);
    const rendered = await sharp(rgba, { raw: { width: candidate.mask.width, height: candidate.mask.height, channels: 4 } })
      .resize(cellWidth - 16, imageHeight - 12, { fit: "contain", kernel: "nearest", background: { r: 15, g: 23, b: 42, alpha: 1 } }).png().toBuffer();
    composites.push({ input: rendered, left: left + 8, top: top + headerHeight });
    const pipeline = candidate.pipeline.length ? candidate.pipeline.map((step) => `${step.operation} ${step.kernel[0]}x${step.kernel[1]}x${step.iterations}`).join(" > ") : "identity";
    labels.push(`<g transform="translate(${left + 10},${top + 10})"><text y="16" font-family="sans-serif" font-size="15" font-weight="700" fill="#111827">${escapeSvg(candidate.id)}</text><text y="36" font-family="sans-serif" font-size="12" fill="#334155">${escapeSvg(pipeline)}</text><text y="55" font-family="sans-serif" font-size="11" fill="#475569">score ${candidate.score.toFixed(3)} · CC ${candidate.metrics.connectedComponentCount} · small ${candidate.metrics.smallComponentCount} · ΔFG ${(candidate.metrics.foregroundDelta * 100).toFixed(1)}%</text></g>`);
  }
  const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${boardWidth}" height="${boardHeight}">${labels.join("")}<text x="${boardWidth - 265}" y="${boardHeight - 8}" font-family="sans-serif" font-size="10" fill="#64748b">white unchanged · green added · red removed</text></svg>`;
  composites.push({ input: Buffer.from(labelSvg), left: 0, top: 0 });
  const board = await sharp({ create: { width: boardWidth, height: boardHeight, channels: 4, background: "#f8fafc" } }).composite(composites).webp({ quality: 92 }).toBuffer();
  const inputRgba = morphologyMaskRgba(source);
  const sourceMask = await sharp(inputRgba, { raw: { width: inputMask.width, height: inputMask.height, channels: 4 } })
    .resize({ width: 640, height: 640, fit: "inside", kernel: "nearest" }).webp({ quality: 92 }).toBuffer();
  const boardAssetPath = `label-analysis/vision-context/${visualContext.annotationId}/${visualContext.renderId}-morphology-comparison.webp`;
  const inputAssetPath = `label-analysis/vision-context/${visualContext.annotationId}/${visualContext.renderId}-morphology-input.webp`;
  await Promise.all([persistAsset(boardAssetPath, board), persistAsset(inputAssetPath, sourceMask)]);
  return {
    renderer: { id: "morphology-comparison-board", version: "1" },
    inputAsset: { assetPath: inputAssetPath, mimeType: "image/webp" },
    boardAsset: { assetPath: boardAssetPath, mimeType: "image/webp", width: boardWidth, height: boardHeight },
  };
}

export async function renderMaskComparisonBoard(
  visualContext: Awaited<ReturnType<typeof renderWizardVisualContext>>,
  candidates: Array<{
    id: string; config: { threshold?: number; maskSize?: number; invert?: boolean }; score: number;
    metrics: { connectedComponentCount?: number; smallNoiseCount?: number; foregroundRatio?: number; textLikeRegionCoverage?: number };
    mask: { width: number; height: number; data: string };
  }>,
) {
  const columns = 2; const cellWidth = 360; const imageHeight = 260; const headerHeight = 74;
  const rows = Math.max(1, Math.ceil(candidates.length / columns));
  const boardWidth = columns * cellWidth; const boardHeight = rows * (imageHeight + headerHeight);
  const composites: Array<{ input: Buffer; left: number; top: number }> = []; const labels: string[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const left = (index % columns) * cellWidth; const top = Math.floor(index / columns) * (imageHeight + headerHeight);
    const values = decodeBinaryMaskRle(candidate.mask.data, candidate.mask.width * candidate.mask.height);
    const rendered = await sharp(morphologyMaskRgba(values), { raw: { width: candidate.mask.width, height: candidate.mask.height, channels: 4 } })
      .resize(cellWidth - 16, imageHeight - 12, { fit: "contain", kernel: "nearest", background: { r: 15, g: 23, b: 42, alpha: 1 } }).png().toBuffer();
    composites.push({ input: rendered, left: left + 8, top: top + headerHeight });
    const polarity = candidate.config.invert ? "light foreground" : "dark foreground";
    labels.push(`<g transform="translate(${left + 10},${top + 10})"><text y="16" font-family="sans-serif" font-size="15" font-weight="700" fill="#111827">${escapeSvg(candidate.id)}</text><text y="36" font-family="sans-serif" font-size="12" fill="#334155">${polarity} | threshold ${candidate.config.threshold ?? "?"} | size ${candidate.config.maskSize ?? "?"}</text><text y="55" font-family="sans-serif" font-size="11" fill="#475569">score ${candidate.score.toFixed(3)} | CC ${candidate.metrics.connectedComponentCount ?? "?"} | noise ${candidate.metrics.smallNoiseCount ?? "?"} | FG ${((candidate.metrics.foregroundRatio ?? 0) * 100).toFixed(1)}%</text></g>`);
  }
  composites.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${boardWidth}" height="${boardHeight}">${labels.join("")}</svg>`), left: 0, top: 0 });
  const board = await sharp({ create: { width: boardWidth, height: boardHeight, channels: 4, background: "#f8fafc" } }).composite(composites).webp({ quality: 92 }).toBuffer();
  const assetPath = `label-analysis/vision-context/${visualContext.annotationId}/${visualContext.renderId}-mask-comparison.webp`;
  await persistAsset(assetPath, board);
  return { renderer: { id: "mask-comparison-board", version: "1" }, asset: { assetPath, mimeType: "image/webp", width: boardWidth, height: boardHeight } };
}

function morphologyMaskRgba(mask: Uint8Array) {
  const rgba = Buffer.alloc(mask.length * 4);
  for (let index = 0; index < mask.length; index += 1) {
    const foreground = mask[index] === 1; const offset = index * 4;
    rgba[offset] = foreground ? 248 : 15; rgba[offset + 1] = foreground ? 250 : 23; rgba[offset + 2] = foreground ? 252 : 42; rgba[offset + 3] = 255;
  }
  return rgba;
}

function morphologyDiffRgba(source: Uint8Array, result: Uint8Array) {
  const rgba = Buffer.alloc(result.length * 4);
  for (let index = 0; index < result.length; index += 1) {
    const before = source[index] === 1; const after = result[index] === 1; const offset = index * 4;
    const color = before && after ? [248, 250, 252] : !before && after ? [34, 197, 94] : before && !after ? [239, 68, 68] : [15, 23, 42];
    rgba[offset] = color[0]!; rgba[offset + 1] = color[1]!; rgba[offset + 2] = color[2]!; rgba[offset + 3] = 255;
  }
  return rgba;
}

function buildOverlayModel(
  packageEntity: Awaited<ReturnType<typeof getAnnotationGraph>>["packages"][number],
  input: WizardVisualRenderRequest,
  transform: { sourceViewport: Rect; preview: { width: number; height: number }; scaleX: number; scaleY: number },
) {
  const layers: Array<Record<string, unknown>> = [];
  const add = (kind: string, id: string, geometry: RegionGeometry | null, color: string, status: string, sourcePoints?: Point[]) => {
    if (!geometry && !sourcePoints) return;
    const points = sourcePoints ?? geometryPoints(geometry!);
    layers.push({ kind, id, status, color, sourceGeometry: { type: "polygon", points }, previewGeometry: { type: "polygon", points: points.map((point) => projectSourcePoint(point, transform)) } });
  };
  if (input.overlays.includes("package-scope")) add("package-scope", packageEntity.id, packageEntity.scope.geometry, "#2563eb", "reviewed");
  if (input.overlays.includes("object-context") && (input.includeRejected || packageEntity.objectContext.status !== "rejected")) add("object-context", packageEntity.id, packageEntity.objectContext.geometry, "#ef4444", packageEntity.objectContext.status);
  if (input.overlays.includes("labels")) for (const label of packageEntity.labels) {
    if (!input.includeRejected && label.geometryReviewStatus === "rejected") continue;
    add("label", label.id, label.geometry, label.id === input.selectedLabelId ? "#22c55e" : "#84cc16", label.geometryReviewStatus);
  }
  if (input.overlays.includes("ocr")) for (const label of packageEntity.labels) for (const ocr of label.ocr) {
    if (!input.includeRejected && ocr.regionStatus === "rejected") continue;
    const labelQuad = label.geometry.type === "quad" ? label.geometry.points : null;
    const sourcePoints = ocr.coordinateSpace.type === "label-rectified" && labelQuad
      ? ocr.geometry.points.map((point) => projectLabelPoint(point, labelQuad)) : [];
    if (sourcePoints.length) add("ocr", ocr.id, null, label.id === input.selectedLabelId ? "#a855f7" : "#f59e0b", ocr.regionStatus, sourcePoints);
  }
  return layers;
}

export function projectSourcePoint(point: Point, transform: { sourceViewport: Rect; scaleX: number; scaleY: number }): Point {
  return { x: round((point.x - transform.sourceViewport.x) * transform.scaleX), y: round((point.y - transform.sourceViewport.y) * transform.scaleY) };
}

export function projectLabelPoint(point: Point, labelQuad: [Point, Point, Point, Point]): Point {
  const [tl, tr, br, bl] = labelQuad;
  const u = point.x; const v = point.y;
  return {
    x: round((1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x + u * v * br.x + (1 - u) * v * bl.x),
    y: round((1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y + u * v * br.y + (1 - u) * v * bl.y),
  };
}

function geometryPoints(geometry: RegionGeometry) { return geometry.points; }
function overlaySvg(width: number, height: number, layers: Array<Record<string, unknown>>) {
  const paths = layers.map((layer) => {
    const points = ((layer.previewGeometry as { points: Point[] }).points).map((point) => `${point.x},${point.y}`).join(" ");
    return `<polygon points="${points}" fill="none" stroke="${layer.color}" stroke-width="2" stroke-dasharray="7 4" vector-effect="non-scaling-stroke"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths}</svg>`;
}
function candidateOverlaySvg(width: number, height: number, layers: Array<{ id: string; rank: number; points: Point[] }>, packageContour: Point[] = []) {
  const packageMarkup = packageContour.length >= 3
    ? `<g><polygon points="${packageContour.map((point) => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="#16a34a" stroke-width="3" stroke-dasharray="12 5" vector-effect="non-scaling-stroke"/><text x="${(packageContour[0]?.x ?? 0) + 4}" y="${Math.max(15, (packageContour[0]?.y ?? 0) + 16)}" fill="#166534" font-family="sans-serif" font-size="13">PACKAGE</text></g>`
    : "";
  const markup = layers.map((layer) => {
    const points = layer.points.map((point) => `${point.x},${point.y}`).join(" ");
    const anchor = layer.points[0] ?? { x: 0, y: 0 };
    const label = escapeSvg(`${layer.rank}: ${layer.id}`);
    return `<g><polygon points="${points}" fill="rgba(168,85,247,0.08)" stroke="#a855f7" stroke-width="3" stroke-dasharray="8 4" vector-effect="non-scaling-stroke"/><rect x="${anchor.x}" y="${Math.max(0, anchor.y - 22)}" width="${Math.max(54, label.length * 7)}" height="22" fill="#581c87" opacity="0.92"/><text x="${anchor.x + 5}" y="${Math.max(15, anchor.y - 6)}" fill="white" font-family="sans-serif" font-size="13">${label}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${packageMarkup}${markup}</svg>`;
}
function stageOverlaySvg(width: number, height: number, layers: Array<{ id: string; points: Point[]; color?: string }>, palette: Array<{ rgb: number[]; ratio?: number }>) {
  const polygons = layers.map((layer) => {
    const points = layer.points.map((point) => `${point.x},${point.y}`).join(" "); const anchor = layer.points[0] ?? { x: 0, y: 0 };
    return `<g><polygon points="${points}" fill="none" stroke="${layer.color ?? "#f97316"}" stroke-width="3" stroke-dasharray="7 4"/><text x="${anchor.x + 3}" y="${Math.max(14, anchor.y - 4)}" fill="#7c2d12" font-family="sans-serif" font-size="12">${escapeSvg(layer.id)}</text></g>`;
  }).join("");
  const swatches = palette.slice(0, 12).map((item, index) => {
    const rgb = item.rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))));
    return `<g><rect x="${10 + index * 34}" y="${height - 42}" width="28" height="28" fill="rgb(${rgb.join(",")})" stroke="white" stroke-width="2"/><text x="${10 + index * 34}" y="${height - 46}" fill="#111827" font-family="sans-serif" font-size="9">${Math.round((item.ratio ?? 0) * 100)}%</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${polygons}${swatches}</svg>`;
}
function decodeBinaryMaskRle(data: string, expectedLength: number) {
  const bytes = Buffer.from(data, "base64"); const values = new Uint8Array(expectedLength); let offset = 0;
  for (let index = 0; index + 7 < bytes.length && offset < expectedLength; index += 8) {
    const value = bytes.readUInt32LE(index) ? 1 : 0; const runLength = bytes.readUInt32LE(index + 4);
    values.fill(value, offset, Math.min(expectedLength, offset + runLength)); offset += runLength;
  }
  return values;
}
function safeName(value: string) { return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "stage"; }
function escapeSvg(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" }[char]!)); }
async function persistAsset(assetPath: string, buffer: Buffer) {
  const local = resolveGeneratedAssetPath(assetPath); if (!local) throw new ConflictError("Visual Context asset path is invalid");
  await mkdir(path.dirname(local), { recursive: true }); await writeFile(local, buffer);
}
function orientedSize(width = 0, height = 0, orientation?: number) { return orientation && orientation >= 5 ? { width: height, height: width } : { width, height }; }
function clampRect(rect: Rect, size: { width: number; height: number }): Rect {
  const x = Math.max(0, Math.min(size.width - 1, rect.x)); const y = Math.max(0, Math.min(size.height - 1, rect.y));
  return { x, y, width: Math.max(1, Math.min(size.width - x, rect.width)), height: Math.max(1, Math.min(size.height - y, rect.height)) };
}
function integerRect(rect: Rect, size: { width: number; height: number }) {
  const left = Math.max(0, Math.floor(rect.x)); const top = Math.max(0, Math.floor(rect.y));
  return { left, top, width: Math.max(1, Math.min(size.width - left, Math.ceil(rect.x + rect.width) - left)), height: Math.max(1, Math.min(size.height - top, Math.ceil(rect.y + rect.height) - top)) };
}
function round(value: number) { return Math.round(value * 1000) / 1000; }
