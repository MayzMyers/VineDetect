import type { RecognitionRoi } from "@/lib/admin/api";

export type CvRegionRole = "custom" | "bottle" | "label";

export type GeneratedCvRegion = {
  id: string;
  role: CvRegionRole;
  rect: RecognitionRoi;
  confidence: number | null;
  origin: string;
};

export type LabelCandidateOverlay = {
  id: string;
  rect: RecognitionRoi;
  rank: number;
  score: number | null;
  confidence: number | null;
  source: string;
};

export function drawLabelCandidateOverlay(
  ctx: CanvasRenderingContext2D,
  candidate: LabelCandidateOverlay,
  image: HTMLImageElement,
  canvas: HTMLCanvasElement
) {
  const rect = naturalToCanvasRect(candidate.rect, image, canvas);
  ctx.strokeStyle = candidate.rank === 1 ? "#ef4444" : "#a855f7";
  ctx.fillStyle = candidate.rank === 1 ? "rgba(239, 68, 68, 0.1)" : "rgba(168, 85, 247, 0.08)";
  ctx.setLineDash(candidate.rank === 1 ? [] : [3, 4]);
  ctx.lineWidth = candidate.rank === 1 ? 3 : 2;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.setLineDash([]);
  ctx.fillStyle = candidate.rank === 1 ? "#ef4444" : "#7e22ce";
  ctx.font = "12px sans-serif";
  ctx.fillText(`#${candidate.rank}`, rect.x + 4, Math.max(12, rect.y + 14));
}

export function drawGeneratedRegionOverlay(
  ctx: CanvasRenderingContext2D,
  region: GeneratedCvRegion,
  image: HTMLImageElement,
  canvas: HTMLCanvasElement
) {
  const rect = naturalToCanvasRect(region.rect, image, canvas);
  ctx.strokeStyle = region.role === "label" ? "#22c55e" : "#f59e0b";
  ctx.fillStyle = region.role === "label" ? "rgba(34, 197, 94, 0.08)" : "rgba(245, 158, 11, 0.08)";
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.setLineDash([]);
}

export function naturalToCanvasRect(rect: RecognitionRoi, image: HTMLImageElement, canvas: HTMLCanvasElement) {
  const scaleX = canvas.width / image.naturalWidth;
  const scaleY = canvas.height / image.naturalHeight;
  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

export function extractGeneratedRegions(cvMeta: unknown): GeneratedCvRegion[] {
  const root = unwrapCvMeta(cvMeta);
  if (!root) return [];
  const regions: GeneratedCvRegion[] = [];
  const bottle = getObject(root, ["bottle"]);
  const bottleRoi = parseNormalizedRect(bottle?.roi);
  if (bottleRoi) {
    regions.push({
      id: "generated:bottle",
      role: "bottle",
      rect: normalizedToNaturalRect(bottleRoi, root),
      confidence: numberValue(getObject(bottle, ["detection"])?.confidence),
      origin: stringValue(getObject(bottle, ["detection"])?.origin) ?? "generated",
    });
  }
  const label = getObject(root, ["label"]);
  const labelRoi = parseNormalizedRect(label?.roi);
  if (labelRoi) {
    regions.push({
      id: "generated:label",
      role: "label",
      rect: normalizedToNaturalRect(labelRoi, root),
      confidence: numberValue(getObject(label, ["detection"])?.confidence),
      origin: stringValue(getObject(label, ["detection"])?.origin) ?? "generated",
    });
  }
  return regions;
}

export function extractLabelTopCandidates(cvMeta: unknown): LabelCandidateOverlay[] {
  const root = unwrapCvMeta(cvMeta);
  if (!root) return [];
  const candidates = getObject(root, ["label", "layout"])?.topCandidates;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((item, index) => {
      const record = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
      const roi = parseNormalizedRect(record?.roi);
      if (!record || !roi) return null;
      const rank = numberValue(record.rank) ?? index + 1;
      return {
        id: `label-candidate:${rank}:${index}`,
        rect: normalizedToNaturalRect(roi, root),
        rank,
        score: numberValue(record.score),
        confidence: numberValue(record.confidence),
        source: stringValue(record.source) ?? "candidate",
      };
    })
    .filter((item): item is LabelCandidateOverlay => Boolean(item));
}

export function unwrapCvMeta(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = record.cvMeta;
  return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : record;
}

export function parseNormalizedRect(value: unknown): RecognitionRoi | null {
  if (!value || typeof value !== "object") return null;
  const rect = value as Record<string, unknown>;
  const x = numberValue(rect.x);
  const y = numberValue(rect.y);
  const width = numberValue(rect.width);
  const height = numberValue(rect.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

export function normalizedToNaturalRect(rect: RecognitionRoi, cvMeta: Record<string, unknown> | null): RecognitionRoi {
  const source = cvMeta ? getObject(cvMeta, ["source"]) : null;
  const width = numberValue(source?.width) ?? 1000;
  const height = numberValue(source?.height) ?? 1000;
  return {
    x: Math.round(rect.x * width),
    y: Math.round(rect.y * height),
    width: Math.round(rect.width * width),
    height: Math.round(rect.height * height),
  };
}

export function getObject(value: unknown, path: string[]): Record<string, unknown> | null {
  let current: unknown = value;
  for (const part of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current && typeof current === "object" ? (current as Record<string, unknown>) : null;
}

export function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}
