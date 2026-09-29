"use client";

import { useCallback, useMemo, useState } from "react";
import { ImageWorkspace, type WorkspaceCanvasSize, type WorkspacePoint } from "./image-workspace/ImageWorkspace";
import {
  drawLabelCandidateOverlay,
  normalizedToNaturalRect,
  numberValue,
  parseNormalizedRect,
  stringValue,
  unwrapCvMeta,
  type LabelCandidateOverlay,
} from "./image-workspace/cvOverlays";
import type { LabelAnalysisResult, LabelElement, QuadGeometry, RecognitionRoi } from "@/lib/admin/api";

type Props = {
  imageUrl: string | null;
  cvMeta: unknown;
  cropTransformMode?: "source-bbox" | "perspective" | "guided-cylindrical" | "legacy-implicit";
  normalizedContours?: LabelAnalysisResult["visualFeatures"]["contours"];
  normalizedRegions?: Array<{ id: string; bbox: Record<string, unknown>; geometry?: QuadGeometry; rawText: string; normalizedText: string }>;
  ocrRegionSource?: "generated" | "reviewed";
  focusStage?: "mask" | "morphology" | "components" | "elements" | "contours";
  maskOverride?: { width: number; height: number; data: string } | null;
  maskOverrideLabel?: string | null;
  componentDecisions?: Record<string, "accepted" | "rejected">;
  showRejectedComponents?: boolean;
  normalizedComponents?: NonNullable<LabelAnalysisResult["visualFeatures"]["components"]>;
  selectedComponentIds?: number[];
  onComponentClick?: (componentId: number) => void;
  onComponentHover?: (componentId: number | null) => void;
  onComponentDelete?: (componentId: number) => void;
  onComponentAccept?: (componentId: number) => void;
  normalizedElements?: LabelElement[];
  selectedElementId?: string | null;
  onElementHover?: (elementId: string | null) => void;
  onElementClick?: (elementId: string) => void;
  onElementDelete?: (elementId: string) => void;
};

type DebugStageId = "color-mask" | "morphology" | "candidate-generation" | "connected-components" | "candidate-scoring" | "selection";

type DebugComponent = {
  id: number;
  normalizedRect: RecognitionRoi;
  area: number | null;
  selected: boolean;
  accepted: boolean;
  touchesBorder: boolean;
};

type DebugStage = {
  id: DebugStageId;
  label: string;
  components: DebugComponent[];
  candidates: LabelCandidateOverlay[];
  mask: DebugMask | null;
  addedMask: DebugMask | null;
  removedMask: DebugMask | null;
  metrics: Record<string, number>;
  contourPoints: Array<[number, number]>;
  rawContourPoints: Array<[number, number]>;
};

type DebugMask = {
  width: number;
  height: number;
  values: Uint8Array;
};

const STAGE_LABELS: Record<DebugStageId, string> = {
  "color-mask": "Color mask",
  morphology: "Morphology",
  "candidate-generation": "Search ROI",
  "connected-components": "Components",
  "candidate-scoring": "Candidates",
  selection: "Selected",
};

export function CvStageDebugger({ imageUrl, cvMeta, cropTransformMode = "legacy-implicit", normalizedContours = [], normalizedRegions = [], ocrRegionSource, focusStage, maskOverride, maskOverrideLabel, componentDecisions = {}, showRejectedComponents = false, normalizedComponents = [], selectedComponentIds = [], onComponentClick, onComponentHover, onComponentDelete, onComponentAccept, normalizedElements = [], selectedElementId = null, onElementHover, onElementClick, onElementDelete }: Props) {
  const stages = useMemo(() => extractDebugStages(cvMeta, normalizedContours, normalizedComponents), [cvMeta, normalizedComponents, normalizedContours]);
  const [stageId, setStageId] = useState<DebugStageId>("connected-components");
  const [hoveredCanvasComponentId, setHoveredCanvasComponentId] = useState<number | null>(null);
  const preferredStage = focusStage ? ({ mask: "color-mask", morphology: "morphology", components: "connected-components", elements: "connected-components", contours: "connected-components" } as const)[focusStage] : null;
  const baseStage = (preferredStage ? stages.find((item) => item.id === preferredStage) : null) ?? stages.find((item) => item.id === stageId) ?? stages[0] ?? null;
  const overrideMask = useMemo(() => {
    if (focusStage !== "mask" || !maskOverride) return null;
    try { return extractMask({ ...maskOverride, encoding: "rle-u8" }); }
    catch { return null; }
  }, [focusStage, maskOverride]);
  const stage = useMemo(() => overrideMask ? {
    id: "color-mask" as const,
    label: maskOverrideLabel ? `Selected mask · ${maskOverrideLabel}` : "Selected mask",
    components: [], candidates: [], mask: overrideMask, addedMask: null, removedMask: null,
    metrics: {}, contourPoints: [], rawContourPoints: [],
  } satisfies DebugStage : baseStage, [baseStage, maskOverrideLabel, overrideMask]);
  const [overlays, setOverlays] = useState({
    contours: true,
    rawContours: true,
    simplifiedContours: true,
    components: true,
    groups: focusStage === "elements" || focusStage === "contours",
    candidates: true,
    selected: true,
    ids: false,
    ocr: true,
    rawMask: false,
  });

  const draw = useCallback(
    ({ canvas, image }: { canvas: HTMLCanvasElement; image: HTMLImageElement }) => {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;

      if (!stage) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const semanticView = focusStage === "components" || focusStage === "elements" || focusStage === "contours";
      if (stage.id === "morphology" && stage.mask) {
        drawMorphologyDiff(ctx, stage.mask, stage.addedMask, stage.removedMask, canvas);
      } else if (stage.mask && !semanticView) {
        drawMaskRaster(ctx, stage.mask, canvas);
        if (overlays.contours) drawMaskContours(ctx, stage.mask, canvas);
      } else {
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        if (stage.mask && overlays.rawMask) drawMaskOverlay(ctx, stage.mask, canvas);
      }
      if (focusStage === "contours") {
        if (overlays.rawContours) drawContourCollection(ctx, normalizedContours, canvas, true, selectedElementId);
        if (overlays.simplifiedContours) drawContourCollection(ctx, normalizedContours, canvas, false, selectedElementId);
      } else {
        if (overlays.contours && stage.rawContourPoints.length) drawRawContours(ctx, stage.rawContourPoints, canvas);
        if (overlays.contours && stage.contourPoints.length) drawNormalizedContours(ctx, stage.contourPoints, canvas);
      }

      if (overlays.components) {
        for (const component of stage.components) {
          const decision = componentDecisions[String(component.id)];
          const rendered = { ...component, accepted: decision ? decision === "accepted" : component.accepted, selected: selectedComponentIds.includes(component.id) };
          if (!rendered.accepted && !showRejectedComponents) continue;
          drawComponent(ctx, rendered, canvas, overlays.ids);
          if (focusStage === "components" && rendered.id === hoveredCanvasComponentId) {
            if (rendered.accepted && onComponentDelete) drawComponentReviewControl(ctx, rendered, canvas, "reject");
            if (!rendered.accepted && onComponentAccept) drawComponentReviewControl(ctx, rendered, canvas, "accept");
          }
        }
      }

      if (overlays.candidates) {
        for (const candidate of stage.candidates) {
          if (stage.id === "selection" && !candidate.rank.toString().includes("1") && !overlays.selected) continue;
          drawLabelCandidateOverlay(ctx, candidate, image, canvas);
        }
      }
      if (overlays.ocr) drawOcrRegions(ctx, normalizedRegions, canvas);
      if ((focusStage === "elements" || focusStage === "contours") && overlays.groups) drawElements(ctx, normalizedElements, selectedElementId, canvas, Boolean(onElementDelete), overlays.ids);
    },
    [componentDecisions, focusStage, hoveredCanvasComponentId, normalizedContours, normalizedElements, normalizedRegions, onComponentAccept, onComponentDelete, onElementDelete, overlays, selectedComponentIds, selectedElementId, showRejectedComponents, stage]
  );

  const handlePointerDown = useCallback((point: WorkspacePoint, _event: unknown, context: { canvas: HTMLCanvasElement }) => {
    if ((!onComponentClick && !onComponentDelete && !onComponentAccept && !onElementClick && !onElementDelete) || !stage) return;
    if (focusStage === "elements") {
      const deleteHit = onElementDelete ? [...normalizedElements].reverse().find((element) => elementDeleteHit(point, element, context.canvas)) : null;
      if (deleteHit && onElementDelete) { onElementDelete(deleteHit.id); return; }
      const selectComponent = Boolean((_event as { shiftKey?: boolean }).shiftKey);
      if (onElementClick && !selectComponent) {
        const x = point.x / context.canvas.width; const y = point.y / context.canvas.height;
        const hit = [...normalizedElements].reverse().find((element) => x >= element.bbox.x && x <= element.bbox.x + element.bbox.width && y >= element.bbox.y && y <= element.bbox.y + element.bbox.height);
        if (hit) { onElementClick(hit.id); return; }
      }
    }
    if (focusStage === "components" && hoveredCanvasComponentId !== null) {
      const reviewHit = stage.components.find((component) => component.id === hoveredCanvasComponentId && componentReviewControlHit(point, component, context.canvas));
      if (reviewHit) {
        if (componentAccepted(reviewHit, componentDecisions) && onComponentDelete) onComponentDelete(reviewHit.id);
        else if (!componentAccepted(reviewHit, componentDecisions) && onComponentAccept) onComponentAccept(reviewHit.id);
        return;
      }
    }
    if (!onComponentClick || !overlays.components) return;
    const x = point.x / context.canvas.width; const y = point.y / context.canvas.height;
    const hit = [...stage.components].reverse().find((component) => (componentAccepted(component, componentDecisions) || showRejectedComponents) && x >= component.normalizedRect.x && x <= component.normalizedRect.x + component.normalizedRect.width && y >= component.normalizedRect.y && y <= component.normalizedRect.y + component.normalizedRect.height);
    if (hit) onComponentClick(hit.id);
  }, [componentDecisions, focusStage, hoveredCanvasComponentId, normalizedElements, onComponentAccept, onComponentClick, onComponentDelete, onElementClick, onElementDelete, overlays.components, showRejectedComponents, stage]);

  const handlePointerMove = useCallback((point: WorkspacePoint, _event: unknown, context: { canvas: HTMLCanvasElement }) => {
    const x = point.x / context.canvas.width; const y = point.y / context.canvas.height;
    const componentHit = stage && overlays.components ? [...stage.components].reverse().find((component) => {
      if (!componentAccepted(component, componentDecisions) && !showRejectedComponents) return false;
      const inside = x >= component.normalizedRect.x && x <= component.normalizedRect.x + component.normalizedRect.width && y >= component.normalizedRect.y && y <= component.normalizedRect.y + component.normalizedRect.height;
      return inside || (component.id === hoveredCanvasComponentId && componentReviewControlHit(point, component, context.canvas));
    }) : null;
    setHoveredCanvasComponentId(componentHit?.id ?? null);
    if (onComponentHover) {
      onComponentHover(componentHit?.id ?? null);
    }
    if (onElementHover) {
      const hit = overlays.groups ? [...normalizedElements].reverse().find((element) => x >= element.bbox.x && x <= element.bbox.x + element.bbox.width && y >= element.bbox.y && y <= element.bbox.y + element.bbox.height) : null;
      onElementHover(hit?.id ?? null);
    }
  }, [componentDecisions, hoveredCanvasComponentId, normalizedElements, onComponentHover, onElementHover, overlays.components, overlays.groups, showRejectedComponents, stage]);

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase text-zinc-500">Pipeline stages</h2>
          <div className="mt-1 text-xs text-zinc-500">Stage-specific debug geometry from the preview result.</div>
        </div>
        {focusStage ? <span className="rounded border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm font-medium capitalize text-zinc-700">{focusStage}</span> : <select
          value={stage?.id ?? stageId}
          onChange={(event) => setStageId(event.target.value as DebugStageId)}
          className="h-9 rounded border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-zinc-600"
        >
          {stages.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>}
      </div>

      <div className="mt-3 flex flex-wrap gap-3">
        <span className={`rounded border px-2 py-1 text-xs font-medium ${cropTransformMode === "source-bbox" ? "border-zinc-300 bg-zinc-50 text-zinc-700" : cropTransformMode === "legacy-implicit" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-sky-300 bg-sky-50 text-sky-800"}`}>
          Geometry: {cropTransformLabel(cropTransformMode)}
        </span>
        {!focusStage && <OverlayToggle label="Contours" checked={overlays.contours} onChange={(checked) => setOverlays((current) => ({ ...current, contours: checked }))} />}
        {focusStage === "contours" && <OverlayToggle label="Raw contours" checked={overlays.rawContours} onChange={(checked) => setOverlays((current) => ({ ...current, rawContours: checked }))} />}
        {focusStage === "contours" && <OverlayToggle label="Simplified contours" checked={overlays.simplifiedContours} onChange={(checked) => setOverlays((current) => ({ ...current, simplifiedContours: checked }))} />}
        {(!focusStage || focusStage === "components" || focusStage === "elements" || focusStage === "contours") && <OverlayToggle label="Components" checked={overlays.components} onChange={(checked) => setOverlays((current) => ({ ...current, components: checked }))} />}
        {(focusStage === "elements" || focusStage === "contours") && <OverlayToggle label="Groups" checked={overlays.groups} onChange={(checked) => setOverlays((current) => ({ ...current, groups: checked }))} />}
        {!focusStage && <OverlayToggle label="Candidates" checked={overlays.candidates} onChange={(checked) => setOverlays((current) => ({ ...current, candidates: checked }))} />}
        {(!focusStage || focusStage === "components" || focusStage === "elements" || focusStage === "contours") && <OverlayToggle label="Labels" checked={overlays.ids} onChange={(checked) => setOverlays((current) => ({ ...current, ids: checked }))} />}
        {ocrRegionSource && <OverlayToggle label={`${ocrRegionSource === "reviewed" ? "Reviewed" : "Generated"} OCR boxes (${normalizedRegions.length})`} checked={overlays.ocr} onChange={(checked) => setOverlays((current) => ({ ...current, ocr: checked }))} />}
        {(focusStage === "components" || focusStage === "elements" || focusStage === "contours") && <OverlayToggle label="Raw mask" checked={overlays.rawMask} onChange={(checked) => setOverlays((current) => ({ ...current, rawMask: checked }))} />}
      </div>

      <div className="mt-3">
        {imageUrl && stage ? (
          <ImageWorkspace imageUrl={imageUrl} mode="pipeline-debug" cursor={onComponentClick || onComponentDelete || onComponentAccept || onElementClick || onElementDelete ? "pointer" : undefined} draw={draw} getCanvasSize={getCanvasSize} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerLeave={() => { setHoveredCanvasComponentId(null); onComponentHover?.(null); onElementHover?.(null); }} />
        ) : (
          <div className="rounded border border-zinc-200 p-4 text-sm text-zinc-500">
            No debug stages in this preview yet.
          </div>
        )}
      </div>

      {stage && (
        <div className="mt-3 grid gap-2 text-xs text-zinc-600 sm:grid-cols-3">
          <div>stage: {stage.label}</div>
          <div>components: {stage.components.length}</div>
          <div>candidates: {stage.candidates.length}</div>
          {typeof stage.metrics.coverage === "number" && <div>coverage: {stage.metrics.coverage}</div>}
          {focusStage === "elements" && <div className="sm:col-span-3">Group boxes are envelopes around their member components, not object contours.</div>}
        </div>
      )}
    </section>
  );
}

function cropTransformLabel(mode: NonNullable<Props["cropTransformMode"]>) {
  if (mode === "source-bbox") return "original · no correction";
  if (mode === "perspective") return "corrected · perspective";
  if (mode === "guided-cylindrical") return "corrected · perspective + cylindrical";
  return "legacy crop · rerun required";
}

function drawOcrRegions(ctx: CanvasRenderingContext2D, regions: Props["normalizedRegions"], canvas: HTMLCanvasElement) {
  if (!regions) return;
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#0ea5e9";
  ctx.fillStyle = "rgba(14, 165, 233, 0.1)";
  for (const region of regions) {
    if (region.geometry?.type === "quad" && region.geometry.points.length === 4) {
      ctx.beginPath();
      region.geometry.points.forEach((point, index) => {
        const x = point.x * canvas.width; const y = point.y * canvas.height;
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath(); ctx.fill(); ctx.stroke();
      continue;
    }
    const rect = parseNormalizedRect(region.bbox);
    if (!rect) continue;
    const x = rect.x * canvas.width; const y = rect.y * canvas.height;
    const width = rect.width * canvas.width; const height = rect.height * canvas.height;
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
  }
  ctx.restore();
}

function drawElements(ctx: CanvasRenderingContext2D, elements: LabelElement[], selectedElementId: string | null, canvas: HTMLCanvasElement, showDelete: boolean, showLabels: boolean) {
  ctx.save(); ctx.font = "12px sans-serif";
  for (const [index, element] of elements.entries()) {
    const x = element.bbox.x * canvas.width; const y = element.bbox.y * canvas.height; const width = element.bbox.width * canvas.width; const height = element.bbox.height * canvas.height;
    const selected = element.id === selectedElementId;
    ctx.strokeStyle = element.status === "rejected" ? "#ef4444" : element.status === "accepted" ? "#22c55e" : "#f59e0b";
    ctx.fillStyle = selected ? "rgba(139,92,246,.2)" : "rgba(139,92,246,.08)"; ctx.lineWidth = selected ? 4 : 2; ctx.setLineDash(element.status === "unreviewed" ? [5, 4] : []);
    ctx.fillRect(x, y, width, height); ctx.strokeRect(x, y, width, height); ctx.setLineDash([]);
    if (showLabels) { ctx.fillStyle = "#6d28d9"; ctx.fillText(`E${index + 1} · ${element.type}${element.role ? `/${element.role}` : ""}`, x + 3, Math.max(12, y + 13)); }
    if (showDelete) drawElementDeleteControl(ctx, element, canvas);
  }
  ctx.restore();
}

function elementDeleteControlPosition(element: LabelElement, canvas: HTMLCanvasElement) {
  const right = (element.bbox.x + element.bbox.width) * canvas.width;
  const top = element.bbox.y * canvas.height;
  return { x: Math.min(canvas.width - 9, right + 9), y: Math.max(9, top + 9) };
}

function drawElementDeleteControl(ctx: CanvasRenderingContext2D, element: LabelElement, canvas: HTMLCanvasElement) {
  const point = elementDeleteControlPosition(element, canvas);
  ctx.save(); ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(point.x, point.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(point.x - 3, point.y - 3); ctx.lineTo(point.x + 3, point.y + 3); ctx.moveTo(point.x + 3, point.y - 3); ctx.lineTo(point.x - 3, point.y + 3); ctx.stroke(); ctx.restore();
}

function elementDeleteHit(point: WorkspacePoint, element: LabelElement, canvas: HTMLCanvasElement) {
  const control = elementDeleteControlPosition(element, canvas);
  return Math.hypot(point.x - control.x, point.y - control.y) <= 11;
}

function drawMaskContours(ctx: CanvasRenderingContext2D, mask: DebugMask, canvas: HTMLCanvasElement) {
  const scaleX = canvas.width / mask.width;
  const scaleY = canvas.height / mask.height;
  ctx.save();
  ctx.fillStyle = "rgba(6, 182, 212, 0.95)";

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const index = y * mask.width + x;
      if (mask.values[index] === 0) continue;
      const boundary =
        x === 0 || y === 0 || x === mask.width - 1 || y === mask.height - 1 ||
        mask.values[index - 1] === 0 || mask.values[index + 1] === 0 ||
        mask.values[index - mask.width] === 0 || mask.values[index + mask.width] === 0;
      if (boundary) ctx.fillRect(Math.floor(x * scaleX), Math.floor(y * scaleY), Math.max(1, Math.ceil(scaleX)), Math.max(1, Math.ceil(scaleY)));
    }
  }

  ctx.restore();
}

function extractDebugStages(
  cvMeta: unknown,
  normalizedContours: Array<{ points: Array<[number, number]>; rawPoints?: Array<[number, number]> }>,
  normalizedComponents: NonNullable<LabelAnalysisResult["visualFeatures"]["components"]>,
): DebugStage[] {
  const root = unwrapCvMeta(cvMeta);
  const source = root?.source && typeof root.source === "object" ? (root.source as Record<string, unknown>) : null;
  const layers = (((root?.label as Record<string, unknown> | undefined)?.debug as Record<string, unknown> | undefined)?.layers ?? []) as unknown[];
  const byStage = new Map<DebugStageId, DebugStage>();

  for (const id of Object.keys(STAGE_LABELS) as DebugStageId[]) {
    byStage.set(id, { id, label: STAGE_LABELS[id], components: [], candidates: [], mask: null, addedMask: null, removedMask: null, metrics: {}, contourPoints: [], rawContourPoints: [] });
  }

  for (const layerValue of layers) {
    const layer = layerValue && typeof layerValue === "object" ? (layerValue as Record<string, unknown>) : null;
    const rawStage = stringValue(layer?.stage);
    if (layer && rawStage === "morphology-added") { const target = byStage.get("morphology"); if (target) target.addedMask = extractMask(layer); continue; }
    if (layer && rawStage === "morphology-removed") { const target = byStage.get("morphology"); if (target) target.removedMask = extractMask(layer); continue; }
    const stage = rawStage as DebugStageId | null;
    const target = stage ? byStage.get(stage) : null;
    if (!layer || !target) continue;

    if (Array.isArray(layer.components)) {
      target.components.push(...extractComponents(layer.components));
    }

    if (Array.isArray(layer.candidates)) {
      target.candidates.push(...extractCandidates(layer.candidates, source));
    }

    if (layer.kind === "binary-mask") {
      target.mask = extractMask(layer);
      target.metrics = extractMetrics(layer.metrics);
    }
  }

  const componentStage = byStage.get("connected-components");
  if (componentStage && componentStage.components.length === 0) {
    componentStage.components = normalizedComponents.map((component) => ({
      id: component.id,
      normalizedRect: component.bbox,
      area: component.area,
      selected: component.accepted,
      accepted: component.accepted,
      touchesBorder: component.borderTouch.top || component.borderTouch.right || component.borderTouch.bottom || component.borderTouch.left,
    }));
  }
  const morphologyStage = byStage.get("morphology");
  const maskStage = byStage.get("color-mask");
  if (componentStage) componentStage.mask = morphologyStage?.mask ?? maskStage?.mask ?? null;

  const selected = byStage.get("selection");
  const scoring = byStage.get("candidate-scoring");
  if (selected && scoring) {
    selected.candidates = scoring.candidates.filter((candidate) => candidate.rank === 1);
  }

  const points = normalizedContours.flatMap((contour) => contour.points);
  const rawPoints = normalizedContours.flatMap((contour) => contour.rawPoints ?? []);
  const populated = Array.from(byStage.values()).filter((stage) => stage.mask || stage.components.length > 0 || stage.candidates.length > 0);
  if (points.length) {
    if (!populated.length) {
      const fallback = byStage.get("connected-components");
      if (fallback) populated.push(fallback);
    }
    for (const stage of populated) { stage.contourPoints = points; stage.rawContourPoints = rawPoints; }
  }
  return populated;
}

function drawNormalizedContours(ctx: CanvasRenderingContext2D, points: Array<[number, number]>, canvas: HTMLCanvasElement) {
  ctx.save();
  ctx.fillStyle = "rgba(34, 197, 94, 0.95)";
  for (const [x, y] of points) ctx.fillRect(x * canvas.width - 2, y * canvas.height - 2, 4, 4);
  ctx.restore();
}

function drawContourCollection(
  ctx: CanvasRenderingContext2D,
  contours: LabelAnalysisResult["visualFeatures"]["contours"],
  canvas: HTMLCanvasElement,
  raw: boolean,
  highlightedElementId: string | null,
) {
  ctx.save();
  for (const contour of contours) {
    const points = raw ? contour.rawPoints ?? [] : contour.points;
    if (points.length < 2) continue;
    const highlighted = Boolean(highlightedElementId && contour.elementId === highlightedElementId);
    ctx.beginPath();
    const start = !raw && contour.bezier?.start ? contour.bezier.start : points[0]!;
    ctx.moveTo(start[0] * canvas.width, start[1] * canvas.height);
    if (!raw && contour.bezier) {
      for (const segment of contour.bezier.segments) ctx.bezierCurveTo(segment.control1[0] * canvas.width, segment.control1[1] * canvas.height, segment.control2[0] * canvas.width, segment.control2[1] * canvas.height, segment.end[0] * canvas.width, segment.end[1] * canvas.height);
    } else {
      for (const [x, y] of points.slice(1)) ctx.lineTo(x * canvas.width, y * canvas.height);
    }
    ctx.closePath();
    ctx.strokeStyle = raw ? (highlighted ? "#0369a1" : "rgba(6,182,212,.8)") : (highlighted ? "#166534" : "rgba(34,197,94,.9)");
    ctx.lineWidth = highlighted ? 3.5 : raw ? 1 : 2;
    ctx.setLineDash(raw ? [3, 3] : contour.ringKind === "hole" ? [5, 3] : []);
    ctx.stroke();
  }
  ctx.restore();
}

function drawRawContours(ctx: CanvasRenderingContext2D, points: Array<[number, number]>, canvas: HTMLCanvasElement) {
  ctx.save(); ctx.fillStyle = "rgba(6, 182, 212, 0.8)";
  for (const [x, y] of points) ctx.fillRect(x * canvas.width, y * canvas.height, 1.5, 1.5);
  ctx.restore();
}

function extractMask(layer: Record<string, unknown>): DebugMask | null {
  const width = numberValue(layer.width);
  const height = numberValue(layer.height);
  const encoding = stringValue(layer.encoding);
  const data = stringValue(layer.data);
  if (!width || !height || encoding !== "rle-u8" || !data) return null;
  return {
    width,
    height,
    values: decodeBinaryMaskRle(data, width * height),
  };
}

function extractMetrics(value: unknown) {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
  );
}

function decodeBinaryMaskRle(data: string, expectedLength: number) {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Uint8Array(expectedLength);
  let offset = 0;
  for (let index = 0; index + 7 < bytes.byteLength && offset < expectedLength; index += 8) {
    const value = view.getUint32(index, true) ? 1 : 0;
    const runLength = view.getUint32(index + 4, true);
    values.fill(value, offset, Math.min(expectedLength, offset + runLength));
    offset += runLength;
  }
  return values;
}

function extractComponents(values: unknown[]): DebugComponent[] {
  return values
    .map((value) => {
      const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
      const normalized = parseNormalizedRect(record?.bbox);
      if (!record || !normalized) return null;
      return {
        id: numberValue(record.id) ?? 0,
        normalizedRect: normalized,
        area: numberValue(record.area),
        selected: record.selected === true,
        accepted: record.accepted !== false,
        touchesBorder: record.touchesBorder === true,
      };
    })
    .filter((item): item is DebugComponent => Boolean(item));
}

function extractCandidates(values: unknown[], source: Record<string, unknown> | null): LabelCandidateOverlay[] {
  return values
    .map((value, index) => {
      const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
      const normalized = parseNormalizedRect(record?.bbox);
      if (!record || !normalized) return null;
      const rank = numberValue(record.rank) ?? index + 1;
      return {
        id: stringValue(record.id) ?? `debug-candidate:${rank}`,
        rect: normalizedToNaturalRect(normalized, { source }),
        rank,
        score: numberValue(record.score),
        confidence: numberValue(record.confidence),
        source: stringValue(record.source) ?? "candidate",
      };
    })
    .filter((item): item is LabelCandidateOverlay => Boolean(item));
}

function componentAccepted(component: DebugComponent, decisions: Record<string, "accepted" | "rejected">) {
  const decision = decisions[String(component.id)];
  return decision ? decision === "accepted" : component.accepted;
}

function drawComponent(
  ctx: CanvasRenderingContext2D,
  component: DebugComponent,
  canvas: HTMLCanvasElement,
  showId: boolean
) {
  const rect = {
    x: component.normalizedRect.x * canvas.width,
    y: component.normalizedRect.y * canvas.height,
    width: component.normalizedRect.width * canvas.width,
    height: component.normalizedRect.height * canvas.height,
  };
  ctx.strokeStyle = component.selected ? "#22c55e" : component.accepted ? "#06b6d4" : "#ef4444";
  ctx.fillStyle = component.selected ? "rgba(34, 197, 94, 0.12)" : "rgba(6, 182, 212, 0.08)";
  ctx.setLineDash(component.selected ? [] : [4, 4]);
  ctx.lineWidth = component.selected ? 3 : 2;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.setLineDash([]);
  if (showId) {
    ctx.fillStyle = component.selected ? "#15803d" : "#0e7490";
    ctx.font = "12px sans-serif";
    ctx.fillText(`C${component.id}`, rect.x + 4, Math.max(12, rect.y + 14));
  }
}

function componentDeleteControlPosition(component: DebugComponent, canvas: HTMLCanvasElement) {
  const right = (component.normalizedRect.x + component.normalizedRect.width) * canvas.width;
  const top = component.normalizedRect.y * canvas.height;
  return { x: Math.min(canvas.width - 9, right + 9), y: Math.max(9, top + 9) };
}

function drawComponentReviewControl(ctx: CanvasRenderingContext2D, component: DebugComponent, canvas: HTMLCanvasElement, action: "accept" | "reject") {
  const point = componentDeleteControlPosition(component, canvas);
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,.95)";
  ctx.strokeStyle = action === "accept" ? "#16a34a" : "#dc2626";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(point.x, point.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath();
  if (action === "accept") {
    ctx.moveTo(point.x - 4, point.y); ctx.lineTo(point.x - 1, point.y + 3); ctx.lineTo(point.x + 5, point.y - 4);
  } else {
    ctx.moveTo(point.x - 3, point.y - 3); ctx.lineTo(point.x + 3, point.y + 3); ctx.moveTo(point.x + 3, point.y - 3); ctx.lineTo(point.x - 3, point.y + 3);
  }
  ctx.stroke();
  ctx.restore();
}

function componentReviewControlHit(point: WorkspacePoint, component: DebugComponent, canvas: HTMLCanvasElement) {
  const control = componentDeleteControlPosition(component, canvas);
  return Math.hypot(point.x - control.x, point.y - control.y) <= 11;
}

function drawMorphologyDiff(ctx: CanvasRenderingContext2D, result: DebugMask, added: DebugMask | null, removed: DebugMask | null, canvas: HTMLCanvasElement) {
  const imageData = new ImageData(result.width, result.height);
  for (let index = 0; index < result.values.length; index += 1) {
    const offset = index * 4;
    const isAdded = Boolean(added?.values[index]); const isRemoved = Boolean(removed?.values[index]); const unchanged = Boolean(result.values[index]) && !isAdded;
    const color = isAdded ? [34, 197, 94] : isRemoved ? [239, 68, 68] : unchanged ? [255, 255, 255] : [17, 24, 39];
    imageData.data[offset] = color[0]!; imageData.data[offset + 1] = color[1]!; imageData.data[offset + 2] = color[2]!; imageData.data[offset + 3] = 255;
  }
  drawRasterImageData(ctx, imageData, result.width, result.height, canvas);
}

function drawMaskRaster(ctx: CanvasRenderingContext2D, mask: DebugMask, canvas: HTMLCanvasElement) {
  const imageData = new ImageData(mask.width, mask.height);
  for (let index = 0; index < mask.values.length; index += 1) {
    const value = mask.values[index] ? 255 : 0;
    const offset = index * 4;
    imageData.data[offset] = value;
    imageData.data[offset + 1] = value;
    imageData.data[offset + 2] = value;
    imageData.data[offset + 3] = 255;
  }
  drawRasterImageData(ctx, imageData, mask.width, mask.height, canvas);
}

function drawMaskOverlay(ctx: CanvasRenderingContext2D, mask: DebugMask, canvas: HTMLCanvasElement) {
  const imageData = new ImageData(mask.width, mask.height);
  for (let index = 0; index < mask.values.length; index += 1) {
    if (!mask.values[index]) continue;
    const offset = index * 4;
    imageData.data[offset] = 6;
    imageData.data[offset + 1] = 182;
    imageData.data[offset + 2] = 212;
    imageData.data[offset + 3] = 90;
  }
  drawRasterImageData(ctx, imageData, mask.width, mask.height, canvas);
}

function drawRasterImageData(ctx: CanvasRenderingContext2D, imageData: ImageData, width: number, height: number, canvas: HTMLCanvasElement) {
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const offscreenCtx = offscreen.getContext("2d");
  if (!offscreenCtx) return;
  offscreenCtx.putImageData(imageData, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
}

function OverlayToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex h-8 items-center gap-2 text-xs font-medium text-zinc-700">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function getCanvasSize(hostWidth: number, image: HTMLImageElement): WorkspaceCanvasSize {
  const imageAspect = image.naturalWidth / image.naturalHeight;
  const maxWidth = Math.max(1, Math.floor(hostWidth));
  const maxHeight = 720;
  let width = maxWidth;
  let height = Math.round(width / imageAspect);
  if (height > maxHeight) {
    height = maxHeight;
    width = Math.round(height * imageAspect);
  }
  return { width, height };
}
