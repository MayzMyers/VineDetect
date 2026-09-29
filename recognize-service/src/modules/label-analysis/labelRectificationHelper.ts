import { officialTargetForTrack,verifyOfficialBytes } from "../../db/official-draft.repository.js";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { pool } from "../../db/pool.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { bboxFromGeometry, isValidConvexQuad, type QuadGeometry } from "../../shared/quadGeometry.js";
import { buildCylindricalControls, buildCylindricalTransform, defaultCylindricalGuides, type CylindricalGuides, type LabelRectificationValue } from "../../shared/labelRectificationContract.js";
import type { SourceName } from "../../shared/types.js";
import { resolveLocalAssetPath } from "../recognize-node/assets.js";
import { estimateLabelPerspective, type PerspectiveCorners } from "../ocr/perspective.js";
import { createRectifiedLabelCropBuffer } from "./labelQuadCrop.js";

export type LabelRectificationHelperConfig = {
  schemaVersion: 1;
  previewMaxSide: number;
  minConfidence: number;
  minRetainedArea: number;
  maxCornerDisplacement: number;
  minCylindricalConfidence: number;
  minCylindricalCurvature: number;
  maxCylindricalCurvature: number;
  detectPerspective: boolean;
  detectCylindrical: boolean;
};

export type LabelRectificationCandidate = {
  id: string;
  score: number;
  payload: {
    mode: "none" | "perspective" | "guided-cylindrical";
    geometry: QuadGeometry;
    rectification: LabelRectificationValue | null;
    diagnostics: {
      method: "original-reviewed-label" | "directional-edge-quad-v1" | "horizontal-curve-consensus-v1";
      confidence: number;
      distortion: number;
      retainedArea: number;
      cornerDisplacement: number;
      recommended: boolean;
      warnings: string[];
      evidenceRows?: number;
      signedCurvature?: number;
      controlParameters?: { signedCurvature: number; horizontalScale: number };
    };
  };
};

const DEFAULT_CONFIG: LabelRectificationHelperConfig = {
  schemaVersion: 1,
  previewMaxSide: 640,
  minConfidence: 0.42,
  minRetainedArea: 0.55,
  maxCornerDisplacement: 0.35,
  minCylindricalConfidence: 0.48,
  minCylindricalCurvature: 0.006,
  maxCylindricalCurvature: 0.12,
  detectPerspective: true,
  detectCylindrical: true,
};

export async function runLabelRectificationHelper(source: SourceName, sourceItemId: string, input: { scope: { type: "label"; id: string }; config?: Record<string, unknown> }) {
  const config = normalizeConfig(input.config);
  const context = await loadLabel(source, sourceItemId, input.scope.id);
  const geometry = context.geometry;
  const operationId = randomUUID();
  const candidates: LabelRectificationCandidate[] = [{
    id: "rectification-original",
    score: 0.5,
    payload: {
      mode: "none", geometry, rectification: null,
      diagnostics: { method: "original-reviewed-label", confidence: 1, distortion: 0, retainedArea: 1, cornerDisplacement: 0, recommended: false, warnings: [] },
    },
  }];

  const sourcePath = context.sourceAssetRef ? resolveLocalAssetPath(context.sourceAssetRef) : null;
  if ((config.detectPerspective || config.detectCylindrical) && !sourcePath) throw new ConflictError("Label Package has no local source asset");
  const metadata = sourcePath ? await sharp(sourcePath).metadata() : null;
  if (sourcePath && (!metadata?.width || !metadata.height)) throw new ConflictError("Source image dimensions are unavailable");
  let cylindricalBasis = geometry;
  let cylindricalBasisRectification = perspectiveRectification();

  if (config.detectPerspective) {
    const crop = integerRect(geometry.bbox, metadata!.width!, metadata!.height!);
    const buffer = await sharp(sourcePath!).extract(crop).toBuffer();
    const estimate = await estimateLabelPerspective(buffer, { previewMaxSide: config.previewMaxSide });
    if (estimate.corners) {
      const suggested = geometryFromCorners(estimate.corners, crop);
      const retainedArea = round(area(suggested.points) / Math.max(1, area(geometry.points)));
      const cornerDisplacement = round(meanCornerDistance(geometry, suggested) / Math.max(1, Math.hypot(geometry.bbox.width, geometry.bbox.height)));
      const warnings = [
        ...(estimate.confidence < config.minConfidence ? ["low-confidence"] : []),
        ...(retainedArea < config.minRetainedArea ? ["content-loss-risk"] : []),
        ...(cornerDisplacement > config.maxCornerDisplacement ? ["large-corner-displacement"] : []),
      ];
      const recommended = estimate.applied && warnings.length === 0;
      if (recommended) {
        cylindricalBasis = suggested;
        cylindricalBasisRectification = perspectiveRectification();
      }
      candidates.push({
        id: "rectification-perspective-1",
        score: round(Math.max(0, estimate.confidence * Math.min(1, retainedArea) * (1 - Math.min(0.8, cornerDisplacement)))),
        payload: {
          mode: "perspective", geometry: suggested, rectification: perspectiveRectification(),
          diagnostics: { method: estimate.method, confidence: estimate.confidence, distortion: estimate.distortion, retainedArea, cornerDisplacement, recommended, warnings },
        },
      });
    }
  }

  if (config.detectCylindrical && sourcePath) {
    const rect = integerRect(cylindricalBasis.bbox, metadata!.width!, metadata!.height!);
    const normalized = await createRectifiedLabelCropBuffer(sourcePath, { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, cylindricalBasis, cylindricalBasisRectification);
    const estimate = await estimateLabelCylindricalGuides(normalized.buffer, config);
    if (estimate && estimate.confidence >= config.minCylindricalConfidence) {
      candidates.push({
        id: "rectification-cylindrical-1",
        score: round(estimate.confidence),
        payload: {
          mode: "guided-cylindrical",
          geometry: cylindricalBasis,
          rectification: { type: "guided-cylindrical", guides: estimate.guides, controls: buildCylindricalControls(estimate.guides), transform: buildCylindricalTransform(estimate.guides) },
          diagnostics: {
            method: "horizontal-curve-consensus-v1",
            confidence: round(estimate.confidence),
            distortion: round(Math.abs(estimate.signedCurvature)),
            retainedArea: 1,
            cornerDisplacement: 0,
            recommended: true,
            warnings: [],
            evidenceRows: estimate.evidenceRows,
            signedCurvature: round(estimate.signedCurvature),
            controlParameters: buildCylindricalControls(estimate.guides),
          },
        },
      });
    }
  }

  const recommendation = [...candidates].filter((candidate) => candidate.payload.diagnostics.recommended).sort((left, right) => right.score - left.score)[0] ?? candidates[0]!;
  for (const candidate of candidates) candidate.payload.diagnostics.recommended = candidate.id === recommendation.id;

  await persistRun(operationId, source, sourceItemId, input.scope.id, Number(context.revision), config, candidates);
  return {
    operationId,
    helper: { id: "label-rectification", version: "cv-label-rectification-v1" },
    scope: input.scope,
    labelRevision: Number(context.revision),
    config,
    candidates,
    status: "draft" as const,
  };
}

function normalizeConfig(value: Record<string, unknown> | undefined): LabelRectificationHelperConfig {
  const number = (key: keyof LabelRectificationHelperConfig, fallback: number, min: number, max: number) => {
    const candidate = value?.[key]; return typeof candidate === "number" && Number.isFinite(candidate) ? Math.max(min, Math.min(max, candidate)) : fallback;
  };
  return {
    schemaVersion: 1,
    previewMaxSide: Math.round(number("previewMaxSide", DEFAULT_CONFIG.previewMaxSide, 160, 1200)),
    minConfidence: number("minConfidence", DEFAULT_CONFIG.minConfidence, 0, 1),
    minRetainedArea: number("minRetainedArea", DEFAULT_CONFIG.minRetainedArea, 0.2, 1.2),
    maxCornerDisplacement: number("maxCornerDisplacement", DEFAULT_CONFIG.maxCornerDisplacement, 0.02, 1),
    minCylindricalConfidence: number("minCylindricalConfidence", DEFAULT_CONFIG.minCylindricalConfidence, 0, 1),
    minCylindricalCurvature: number("minCylindricalCurvature", DEFAULT_CONFIG.minCylindricalCurvature, 0.001, 0.2),
    maxCylindricalCurvature: number("maxCylindricalCurvature", DEFAULT_CONFIG.maxCylindricalCurvature, 0.01, 0.35),
    detectPerspective: typeof value?.detectPerspective === "boolean" ? value.detectPerspective : DEFAULT_CONFIG.detectPerspective,
    detectCylindrical: typeof value?.detectCylindrical === "boolean" ? value.detectCylindrical : DEFAULT_CONFIG.detectCylindrical,
  };
}

export async function estimateLabelCylindricalGuides(buffer: Buffer, options: Pick<LabelRectificationHelperConfig, "previewMaxSide" | "minCylindricalConfidence" | "minCylindricalCurvature" | "maxCylindricalCurvature">) {
  const image = await sharp(buffer, { failOn: "none" }).resize({ width: options.previewMaxSide, height: options.previewMaxSide, fit: "inside", withoutEnlargement: true }).grayscale().blur(0.45).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = image.info;
  if (width < 80 || height < 80) return null;
  const xs = [0.08, 0.29, 0.5, 0.71, 0.92].map((ratio) => Math.max(1, Math.min(width - 2, Math.round((width - 1) * ratio))));
  const gradient = (x: number, y: number) => Math.abs(image.data[(y + 1) * width + x]! - image.data[(y - 1) * width + x]!);
  const centerX = xs[2]!;
  const peaks: Array<{ y: number; strength: number }> = [];
  for (let y = Math.round(height * 0.05); y < Math.round(height * 0.95); y += 1) {
    const strength = gradient(centerX, y);
    if (strength >= 18 && strength >= gradient(centerX, y - 1) && strength > gradient(centerX, y + 1)) peaks.push({ y, strength });
  }
  const minimumGap = Math.max(3, Math.round(height * 0.025));
  const seeds: typeof peaks = [];
  for (const peak of peaks.sort((left, right) => right.strength - left.strength)) {
    if (seeds.every((seed) => Math.abs(seed.y - peak.y) >= minimumGap)) seeds.push(peak);
    if (seeds.length >= 16) break;
  }
  const window = Math.max(4, Math.round(height * 0.04));
  const shape = xs.map((_, index) => 4 * (index / (xs.length - 1)) * (1 - index / (xs.length - 1)));
  const observations: Array<{ curvature: number; weight: number; fit: number; y: number }> = [];
  for (const seed of seeds) {
    const ys = xs.map((x, index) => {
      if (index === 2) return seed.y;
      let bestY = seed.y; let bestScore = -Infinity;
      for (let y = Math.max(1, seed.y - window); y <= Math.min(height - 2, seed.y + window); y += 1) {
        const score = gradient(x, y) - Math.abs(y - seed.y) * 0.55;
        if (score > bestScore) { bestScore = score; bestY = y; }
      }
      return bestY;
    });
    const baselineAt = (index: number) => ys[0]! + (ys[4]! - ys[0]!) * index / (xs.length - 1);
    const samples = [1, 2, 3].map((index) => (ys[index]! - baselineAt(index)) / shape[index]!);
    const curvePixels = median(samples);
    const fit = [1, 2, 3].reduce((sum, index) => sum + Math.abs((ys[index]! - baselineAt(index)) - curvePixels * shape[index]!), 0) / (3 * window);
    const curvature = curvePixels / height;
    const strength = xs.reduce((sum, x, index) => sum + gradient(x, ys[index]!), 0) / (xs.length * 255);
    if (Math.abs(curvature) >= options.minCylindricalCurvature * 0.55 && Math.abs(curvature) <= options.maxCylindricalCurvature * 1.25 && fit <= 0.55 && strength >= 0.08) {
      observations.push({ curvature, weight: Math.max(0.01, strength * (1 - fit)), fit, y: ((ys[0]! + ys[4]!) / 2) / height });
    }
  }
  if (observations.length < 2) return null;
  const signedCurvature = weightedMedian(observations.map((item) => ({ value: item.curvature, weight: item.weight })));
  const agreeing = observations.filter((item) => Math.sign(item.curvature) === Math.sign(signedCurvature) && Math.abs(item.curvature - signedCurvature) <= Math.max(0.012, Math.abs(signedCurvature) * 0.8));
  if (agreeing.length < 2 || Math.abs(signedCurvature) < options.minCylindricalCurvature || Math.abs(signedCurvature) > options.maxCylindricalCurvature) return null;
  const signAgreement = agreeing.length / observations.length;
  const meanStrength = agreeing.reduce((sum, item) => sum + Math.min(1, item.weight * 3), 0) / agreeing.length;
  const meanFit = agreeing.reduce((sum, item) => sum + item.fit, 0) / agreeing.length;
  const confidence = Math.max(0, Math.min(1, 0.2 + Math.min(0.3, agreeing.length * 0.06) + meanStrength * 0.25 + signAgreement * 0.2 + (1 - meanFit) * 0.05));
  const guides = guidesFromCurvature(signedCurvature, agreeing.map((item) => item.y));
  return { guides, confidence, signedCurvature, evidenceRows: agreeing.length };
}

function guidesFromCurvature(curvature: number, evidenceYs: number[]): CylindricalGuides {
  const base = defaultCylindricalGuides();
  const rowYs = evidenceYs.length >= 3
    ? [quantile(evidenceYs, 0.15), quantile(evidenceYs, 0.5), quantile(evidenceYs, 0.85)]
    : [0.08, 0.5, 0.92];
  const horizontalGuides = rowYs.map((y) => base.horizontalGuides[0]!.map((point) => ({ x: point.x, y: clamp(y + curvature * 4 * point.x * (1 - point.x), 0.005, 0.995) })));
  return {
    centerLine: rowYs.map((y) => ({ x: 0.5, y: clamp(y + curvature, 0.005, 0.995) })),
    leftBoundary: rowYs.map((y) => ({ x: 0, y })),
    rightBoundary: rowYs.map((y) => ({ x: 1, y })),
    horizontalGuides,
  };
}

function median(values: number[]) { return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!; }
function weightedMedian(values: Array<{ value: number; weight: number }>) {
  const sorted = [...values].sort((left, right) => left.value - right.value);
  const half = sorted.reduce((sum, item) => sum + item.weight, 0) / 2;
  let sum = 0;
  for (const item of sorted) { sum += item.weight; if (sum >= half) return item.value; }
  return sorted.at(-1)!.value;
}
function quantile(values: number[], fraction: number) { const sorted = [...values].sort((left, right) => left - right); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))]!; }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }

async function loadLabel(source: SourceName, sourceItemId: string, labelId: string) {
  const row = (await pool.query(`SELECT label.geometry,label.rectification,label.revision,package.source_asset_ref,package.legacy_annotation_track_id
    FROM meta.annotation_labels label JOIN meta.annotation_packages package ON package.id=label.package_id
    WHERE label.id=$1 AND package.source=$2 AND package.source_item_id=$3 AND label.deleted_at IS NULL AND package.deleted_at IS NULL`,
  [labelId, source, sourceItemId])).rows[0];
  if (!row) throw new NotFoundError("Label rectification scope not found");
  if(row.legacy_annotation_track_id) {
    const official=await officialTargetForTrack(source,sourceItemId,String(row.legacy_annotation_track_id));
    if(official)await verifyOfficialBytes(official);
  }
  const geometry = row.geometry as QuadGeometry;
  if (geometry?.type !== "quad" || !isValidConvexQuad(geometry.points)) throw new ConflictError("Reviewed convex Label quad is required");
  return { geometry: { ...geometry, bbox: bboxFromGeometry(geometry) }, rectification: row.rectification, revision: row.revision, sourceAssetRef: row.source_asset_ref ? String(row.source_asset_ref) : null };
}

async function persistRun(operationId: string, source: SourceName, sourceItemId: string, labelId: string, labelRevision: number, config: LabelRectificationHelperConfig, candidates: LabelRectificationCandidate[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO meta.annotation_operations
      (id,source,source_item_id,operation_type,scope_type,scope_id,helper_output,operation_status,helper_id,helper_version,initial_config,final_config,review_status)
      VALUES($1,$2,$3,'run_label_rectification','label',$4,$5::jsonb,'draft','label-rectification','cv-label-rectification-v1',$6::jsonb,$6::jsonb,'manual')`,
      [operationId, source, sourceItemId, labelId, JSON.stringify({ labelRevision }), JSON.stringify(config)]);
    for (const [index, candidate] of candidates.entries()) await client.query(`INSERT INTO meta.annotation_candidates
      (id,operation_id,candidate_key,payload,score,sort_order) VALUES($1,$2,$3,$4::jsonb,$5,$6)`,
      [randomUUID(), operationId, candidate.id, JSON.stringify(candidate.payload), candidate.score, index]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

function geometryFromCorners(corners: PerspectiveCorners, crop: { left: number; top: number; width: number; height: number }): QuadGeometry {
  const point = ({ x, y }: { x: number; y: number }) => ({ x: crop.left + x * crop.width, y: crop.top + y * crop.height });
  const points: QuadGeometry["points"] = [point(corners.topLeft), point(corners.topRight), point(corners.bottomRight), point(corners.bottomLeft)];
  return { type: "quad", points, bbox: bboxFromGeometry({ type: "quad", points, bbox: { x: 0, y: 0, width: 1, height: 1 } }) };
}

function integerRect(bbox: QuadGeometry["bbox"], width: number, height: number) {
  const left = Math.max(0, Math.floor(bbox.x)); const top = Math.max(0, Math.floor(bbox.y));
  const right = Math.min(width, Math.ceil(bbox.x + bbox.width)); const bottom = Math.min(height, Math.ceil(bbox.y + bbox.height));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
function perspectiveRectification(): LabelRectificationValue { return { type: "perspective", transform: { schemaVersion: 1, model: "quad-homography-v1" } }; }
function area(points: QuadGeometry["points"]) { return Math.abs(points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]!; return sum + point.x * next.y - next.x * point.y; }, 0)) / 2; }
function meanCornerDistance(left: QuadGeometry, right: QuadGeometry) { return left.points.reduce((sum, point, index) => sum + Math.hypot(point.x - right.points[index]!.x, point.y - right.points[index]!.y), 0) / 4; }
function round(value: number) { return Math.round(value * 10000) / 10000; }
