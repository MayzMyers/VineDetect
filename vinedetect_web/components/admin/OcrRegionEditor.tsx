"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type {
  LabelAnnotationOcrRegionReview,
  LabelAnnotationOcrSnapshot,
  OcrLayout,
  OcrRectification,
  OcrTranscriptionStatus,
  PutLabelAnnotationOcrRegionReview,
  QuadGeometry,
  RecognitionRoi,
} from "@/lib/admin/api";
import { MovableViewerDock } from "./image-workspace/MovableViewerDock";
import { OcrNormalizedPreview } from "./image-workspace/OcrNormalizedPreview";
import { moveQuad, moveQuadCorner, normalizeQuad, pointInQuad, rectangleQuad } from "./image-workspace/quadGeometry";

type DraftRegion = {
  clientId: string;
  sourceRegionIds: string[];
  level: "word" | "line" | "string";
  prediction: { bbox: RecognitionRoi; geometry: QuadGeometry; text: string | null; confidence?: number | null; layout?: OcrLayout; rectification?: OcrRectification | null } | null;
  bbox: RecognitionRoi;
  geometry: QuadGeometry;
  text: string | null;
  transcriptionStatus: OcrTranscriptionStatus;
  layout: OcrLayout;
  rectification: OcrRectification | null;
  sortOrder?: number;
};
type DraftComposition = {
  clientId: string;
  kind: "string";
  memberClientIds: string[];
  text: string | null;
  transcriptionStatus: OcrTranscriptionStatus;
  sortOrder: number;
};
type Interaction =
  | { type: "draw"; start: Point }
  | { type: "move"; start: Point; regionId: string; origin: QuadGeometry }
  | { type: "corner"; regionId: string; cornerIndex: number; origin: QuadGeometry }
  | { type: "baseline"; regionId: string; center: Point };
type Point = { x: number; y: number };
type RegionAction = "move" | "corner" | "delete" | "baseline";
type HitTarget = { region: DraftRegion; action: RegionAction; cornerIndex?: number };

export function OcrRegionEditor({
  imageUrl,
  labelRect,
  snapshot,
  review,
  saving,
  onSave,
  onDirtyChange,
  activeRegionId = null,
  onActiveRegionChange,
}: {
  imageUrl: string | null;
  labelRect: RecognitionRoi | null;
  snapshot: LabelAnnotationOcrSnapshot | null | undefined;
  review: LabelAnnotationOcrRegionReview | null | undefined;
  saving: boolean;
  onSave?: (input: PutLabelAnnotationOcrRegionReview) => Promise<LabelAnnotationOcrRegionReview | null>;
  onDirtyChange?: (dirty: boolean) => void;
  activeRegionId?: string | null;
  onActiveRegionChange?: (id: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [imageRevision, setImageRevision] = useState(0);
  const [regions, setRegions] = useState<DraftRegion[]>(() => initialRegions(snapshot, review));
  const [compositions, setCompositions] = useState<DraftComposition[]>(() => initialCompositions(review));
  const [ocrRunId, setOcrRunId] = useState<string | null>(() => review?.ocrRunId ?? snapshot?.ocr.id ?? null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deletionHistory, setDeletionHistory] = useState<Array<{ region: DraftRegion; index: number; compositions: DraftComposition[] }>>([]);
  const [mode, setMode] = useState<"select" | "draw">("select");
  const [draftBox, setDraftBox] = useState<RecognitionRoi | null>(null);
  const [hoverTarget, setHoverTarget] = useState<{ regionId: string; action: RegionAction } | null>(null);
  const selected = regions.find((region) => selectedIds.length === 1 && region.clientId === selectedIds[0]) ?? null;
  const selectedPreviewGeometry = useMemo(() => selected && labelRect ? normalizedToSourceQuad(selected.geometry, labelRect) : null, [labelRect, selected]);
  const splitTokens = (selected?.text ?? "").trim().split(/\s+/).filter(Boolean);
  const dirty = useMemo(
    () => review === null || review === undefined
      ? Boolean(snapshot) || regions.length > 0
      : JSON.stringify({ regions: regionsForCompare(regions), compositions }) !== JSON.stringify({ regions: regionsForCompare(initialRegions(snapshot, review)), compositions: initialCompositions(review) }),
    [compositions, regions, review, snapshot]
  );

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!imageUrl) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      imageRef.current = image;
      setImageRevision((value) => value + 1);
    };
    image.src = imageUrl;
    return () => {
      imageRef.current = null;
    };
  }, [imageUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !labelRect) return;
    const sourceWidth = Math.max(1, Math.min(image.naturalWidth - labelRect.x, labelRect.width));
    const sourceHeight = Math.max(1, Math.min(image.naturalHeight - labelRect.y, labelRect.height));
    canvas.width = 720;
    canvas.height = Math.max(140, Math.round(canvas.width * sourceHeight / sourceWidth));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, labelRect.x, labelRect.y, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    drawRegions(ctx, canvas, regions, selectedIds, activeRegionId, draftBox);
  }, [activeRegionId, draftBox, imageRevision, labelRect, regions, selectedIds]);

  function resetFromGenerated() {
    setRegions(initialRegions(snapshot, null));
    setCompositions([]);
    setOcrRunId(snapshot?.ocr.id ?? null);
    setSelectedIds([]);
    setHoverTarget(null);
    setDraftBox(null);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const point = pointerPoint(event, canvas);
    if (mode === "draw") {
      canvas.setPointerCapture(event.pointerId);
      interactionRef.current = { type: "draw", start: point };
      setDraftBox({ x: point.x, y: point.y, width: 0.001, height: 0.001 });
      return;
    }
    const hit = hitTestRegions(regions, point, canvas, selectedIds);
    if (!hit) {
      const geometry = rectangleQuad(templateBoxAt(point, regions));
      const region: DraftRegion = {
        clientId: crypto.randomUUID(),
        sourceRegionIds: [],
        level: "word",
        prediction: null,
        bbox: geometry.bbox,
        geometry,
        text: null,
        transcriptionStatus: "unreadable",
        layout: defaultLayout("word"),
        rectification: null,
      };
      setRegions((current) => [...current, region]);
      setSelectedIds([region.clientId]);
      setHoverTarget({ regionId: region.clientId, action: "move" });
      onActiveRegionChange?.(region.clientId);
      return;
    }
    if (hit.action === "delete") {
      deleteRegion(hit.region.clientId);
      return;
    }
    canvas.setPointerCapture(event.pointerId);
    setSelectedIds((current) =>
      event.shiftKey
        ? current.includes(hit.region.clientId)
          ? current.filter((id) => id !== hit.region.clientId)
          : [...current, hit.region.clientId]
        : [hit.region.clientId]
    );
    onActiveRegionChange?.(hit.region.clientId);
    setHoverTarget({ regionId: hit.region.clientId, action: hit.action });
    interactionRef.current = hit.action === "baseline"
      ? { type: "baseline", regionId: hit.region.clientId, center: quadCenter(hit.region.geometry) }
      : hit.action === "corner"
      ? { type: "corner", regionId: hit.region.clientId, cornerIndex: hit.cornerIndex ?? 0, origin: hit.region.geometry }
      : { type: "move", start: point, regionId: hit.region.clientId, origin: hit.region.geometry };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const interaction = interactionRef.current;
    const canvas = event.currentTarget;
    const point = pointerPoint(event, canvas);
    if (!interaction) {
      const hit = mode === "draw" ? null : hitTestRegions(regions, point, canvas, selectedIds);
      setHoverTarget(hit ? { regionId: hit.region.clientId, action: hit.action } : null);
      onActiveRegionChange?.(hit?.region.clientId ?? null);
      return;
    }
    if (interaction.type === "draw") {
      setDraftBox(rectFromPoints(interaction.start, point));
      return;
    }
    setRegions((current) =>
      current.map((region) => {
        if (region.clientId !== interaction.regionId) return region;
        if (interaction.type === "baseline") {
          const angle = normalizeDegrees(Math.atan2(point.y - interaction.center.y, point.x - interaction.center.x) * 180 / Math.PI);
          return { ...region, layout: linearLayout(region.layout, angle), rectification: rotationForAngle(angle) };
        }
        const geometry = interaction.type === "move"
          ? moveQuad(interaction.origin, point.x - interaction.start.x, point.y - interaction.start.y)
          : moveQuadCorner(interaction.origin, interaction.cornerIndex, point);
        return geometry ? { ...region, bbox: geometry.bbox, geometry } : region;
      })
    );
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    const interaction = interactionRef.current;
    interactionRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (interaction?.type === "draw" && draftBox && draftBox.width >= 0.005 && draftBox.height >= 0.005) {
      const geometry = rectangleQuad(draftBox);
      const region: DraftRegion = {
        clientId: crypto.randomUUID(),
        sourceRegionIds: [],
        level: "string",
        prediction: null,
        bbox: geometry.bbox,
        geometry,
        text: null,
        transcriptionStatus: "unreadable",
        layout: defaultLayout("string"),
        rectification: null,
      };
      setRegions((current) => [...current, region]);
      setSelectedIds([region.clientId]);
      setMode("select");
    }
    setDraftBox(null);
    setDeletionHistory([]);
  }

  function clearCanvasHover() {
    if (interactionRef.current) return;
    setHoverTarget(null);
    onActiveRegionChange?.(null);
  }

  function deleteRegion(regionId: string) {
    const index = regions.findIndex((region) => region.clientId === regionId);
    const region = regions[index];
    if (!region) return;
    setDeletionHistory((current) => [...current, { region, index, compositions: compositions.filter((composition) => composition.memberClientIds.includes(regionId)) }]);
    setRegions((current) => current.filter((region) => region.clientId !== regionId));
    setCompositions((current) => current.flatMap((composition) => {
      const memberClientIds = composition.memberClientIds.filter((id) => id !== regionId);
      return memberClientIds.length >= 2 ? [{ ...composition, memberClientIds }] : [];
    }));
    setSelectedIds((current) => current.filter((id) => id !== regionId));
    setHoverTarget((current) => current?.regionId === regionId ? null : current);
    if (activeRegionId === regionId) onActiveRegionChange?.(null);
  }

  function undoDeleteRegion() {
    const deleted = deletionHistory[deletionHistory.length - 1];
    if (!deleted) return;
    setDeletionHistory((current) => current.slice(0, -1));
    setRegions((current) => {
      if (current.some((region) => region.clientId === deleted.region.clientId)) return current;
      const next = [...current];
      next.splice(Math.min(deleted.index, next.length), 0, deleted.region);
      return next;
    });
    setCompositions((current) => [
      ...current,
      ...deleted.compositions.filter((composition) => !current.some((item) => item.clientId === composition.clientId)),
    ].sort((left, right) => left.sortOrder - right.sortOrder));
    setSelectedIds([deleted.region.clientId]);
    onActiveRegionChange?.(deleted.region.clientId);
  }

  useEffect(() => {
    if (deletionHistory.length === 0) return;
    function handleUndo(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z" || event.shiftKey || isEditableTarget(event.target)) return;
      event.preventDefault();
      undoDeleteRegion();
    }
    window.addEventListener("keydown", handleUndo);
    return () => window.removeEventListener("keydown", handleUndo);
  });

  function selectRegion(regionId: string, additive = false) {
    setSelectedIds((current) => additive
      ? current.includes(regionId) ? current.filter((id) => id !== regionId) : [...current, regionId]
      : [regionId]);
    onActiveRegionChange?.(regionId);
  }

  function updateSelected(patch: Partial<DraftRegion>) {
    setRegions((current) =>
      current.map((region) =>
        selectedIds.includes(region.clientId)
          ? { ...region, ...patch }
          : region
      )
    );
  }

  function updateSelectedAngle(angle: number) {
    const normalized = normalizeDegrees(angle);
    setRegions((current) => current.map((region) => selectedIds.includes(region.clientId)
      ? { ...region, layout: linearLayout(region.layout, normalized), rectification: rotationForAngle(normalized) }
      : region));
  }

  function mergeSelectedRegions() {
    const merging = regions.filter((region) => selectedIds.includes(region.clientId));
    if (merging.length < 2) return;
    const sorted = [...merging].sort(readingOrder);
    const mergedText = sorted.map((region) => (region.text ?? "").trim()).filter(Boolean).join(" ");
    const geometry = rectangleQuad(unionRect(sorted.map((region) => region.bbox)));
    const merged: DraftRegion = {
      clientId: crypto.randomUUID(),
      sourceRegionIds: [...new Set(sorted.flatMap((region) => region.sourceRegionIds))],
      level: "string",
      prediction: null,
      bbox: geometry.bbox,
      geometry,
      text: mergedText || null,
      transcriptionStatus: sorted.every((region) => region.transcriptionStatus === "verified")
        ? "verified"
        : mergedText ? "partial" : "unreadable",
      layout: commonJsonValue(sorted.map((region) => region.layout)) ?? { ...defaultLayout("string"), characterOrientation: "mixed" },
      rectification: commonJsonValue(sorted.map((region) => region.rectification)) ?? null,
    };
    setRegions((current) => [...current.filter((region) => !selectedIds.includes(region.clientId)), merged]);
    setCompositions((current) => current.filter((composition) => !composition.memberClientIds.some((id) => selectedIds.includes(id))));
    setSelectedIds([merged.clientId]);
  }

  function splitSelectedRegion() {
    if (!selected || splitTokens.length < 2) return;
    const partWidth = selected.bbox.width / splitTokens.length;
    const parts = splitTokens.map((text, index): DraftRegion => {
      const geometry = rectangleQuad({
        x: selected.bbox.x + partWidth * index,
        y: selected.bbox.y,
        width: partWidth,
        height: selected.bbox.height,
      });
      return {
        clientId: crypto.randomUUID(),
        sourceRegionIds: selected.sourceRegionIds,
        level: "word",
        prediction: null,
        bbox: geometry.bbox,
        geometry,
        text,
        transcriptionStatus: selected.transcriptionStatus,
        layout: { ...selected.layout, type: "word" },
        rectification: selected.rectification,
      };
    });
    setRegions((current) => [...current.filter((region) => region.clientId !== selected.clientId), ...parts]);
    setCompositions((current) => current.filter((composition) => !composition.memberClientIds.includes(selected.clientId)));
    setSelectedIds(parts.map((region) => region.clientId));
  }

  function composeSelectedString() {
    const members = [...regions.filter((region) => selectedIds.includes(region.clientId))].sort(readingOrder);
    if (members.length < 2) return;
    const text = members.map((region) => region.text?.trim()).filter(Boolean).join(" ") || null;
    const composition: DraftComposition = {
      clientId: crypto.randomUUID(), kind: "string", memberClientIds: members.map((region) => region.clientId), text,
      transcriptionStatus: members.every((region) => region.transcriptionStatus === "verified") ? "verified" : text ? "partial" : "unreadable",
      sortOrder: compositions.length,
    };
    setCompositions((current) => [...current, composition]);
  }

  function decomposeString(compositionId: string) {
    setCompositions((current) => current.filter((composition) => composition.clientId !== compositionId));
  }

  async function saveReview() {
    const saved = await onSave?.({
      baseRevision: review?.revision ?? 0,
      ocrRunId,
      status: "reviewed",
      regions: [...regions]
        .sort(readingOrder)
        .map((region, index) => ({
          sourceRegionIds: region.sourceRegionIds,
          clientId: region.clientId,
          level: region.level,
          prediction: region.prediction,
          annotation: { bbox: region.geometry.bbox, geometry: region.geometry, text: region.transcriptionStatus === "unreadable" ? null : region.text, transcriptionStatus: region.transcriptionStatus },
          textDirection: legacyTextDirection(region.layout),
          glyphOrientation: legacyGlyphOrientation(region.layout),
          layout: region.layout,
          rectification: region.rectification,
          sortOrder: index,
        })),
      compositions: compositions.map((composition, index) => ({
        clientId: composition.clientId,
        kind: "string" as const,
        memberClientIds: composition.memberClientIds,
        text: composition.transcriptionStatus === "unreadable" ? null : composition.text,
        transcriptionStatus: composition.transcriptionStatus,
        sortOrder: index,
      })),
    });
    if (saved) { setSelectedIds([]); setDeletionHistory([]); }
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase text-zinc-500">Text annotations</h3>
          <div className="mt-1 text-xs text-zinc-500">
            {review ? `Saved revision ${review.revision}` : "Generated words are an unsaved starting draft"} · {regions.length} regions
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setMode(mode === "draw" ? "select" : "draw")} className="h-9 rounded border border-zinc-300 px-3 text-sm font-medium">
            {mode === "draw" ? "Cancel draw" : "Draw region"}
          </button>
          <button type="button" onClick={resetFromGenerated} disabled={!snapshot} className="h-9 rounded border border-zinc-300 px-3 text-sm font-medium disabled:opacity-40">
            Reset from OCR
          </button>
          <button type="button" onClick={undoDeleteRegion} disabled={!deletionHistory.length} className="h-9 rounded border border-zinc-300 px-3 text-sm font-medium disabled:opacity-40" title="Restore the latest deleted region">
            Undo delete
          </button>
          <button type="button" onClick={() => void saveReview()} disabled={saving || !onSave || !dirty} className="h-9 rounded bg-zinc-950 px-3 text-sm font-semibold text-white disabled:opacity-40">
            Continue
          </button>
        </div>
      </div>

      {review?.ocrRunId && snapshot?.ocr.id && review.ocrRunId !== snapshot.ocr.id && (
        <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Review belongs to an older OCR run. Use Reset from OCR to adopt the latest generated words.
        </div>
      )}

      <div className="mt-3">
        <MovableViewerDock title="OCR regions viewer">
          {imageUrl && labelRect ? (
            <div className="flex max-h-[620px] min-h-40 justify-center overflow-auto rounded border border-zinc-200 bg-zinc-100 p-2">
              <canvas
                ref={canvasRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onPointerLeave={clearCanvasHover}
                className="block h-auto max-h-[600px] max-w-full touch-none rounded bg-zinc-50 object-contain"
                style={{ cursor: canvasCursor(mode, hoverTarget?.action ?? null) }}
              />
            </div>
          ) : (
            <div className="rounded border border-zinc-200 p-3 text-sm text-zinc-500">Label crop is required.</div>
          )}
        </MovableViewerDock>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={composeSelectedString} disabled={selectedIds.length < 2} className="h-8 rounded border border-violet-300 bg-violet-50 px-3 text-xs font-medium text-violet-800 disabled:opacity-40">Compose string</button>
        <button type="button" onClick={mergeSelectedRegions} disabled={selectedIds.length < 2} className="h-8 rounded border border-zinc-300 px-3 text-xs font-medium disabled:opacity-40" title="Replace the selected physical OCR regions with one enclosing region">Merge regions</button>
        <button type="button" onClick={splitSelectedRegion} disabled={!selected || splitTokens.length < 2} className="h-8 rounded border border-zinc-300 px-3 text-xs font-medium disabled:opacity-40" title="Replace one physical OCR region with word regions">Split region by spaces</button>
      </div>

      {compositions.length > 0 && (
        <div className="mt-3 rounded border border-violet-200 bg-violet-50/50 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-violet-800">Semantic strings · word geometry is preserved</div>
          <div className="grid gap-2">
            {compositions.map((composition, index) => (
              <div key={composition.clientId} className="flex items-center gap-2 rounded border border-violet-200 bg-white px-3 py-2 text-xs">
                <span className="text-violet-500">S{index + 1}</span>
                <input value={composition.text ?? ""} disabled={composition.transcriptionStatus === "unreadable"} onChange={(event) => setCompositions((current) => current.map((item) => item.clientId === composition.clientId ? { ...item, text: event.target.value || null } : item))} className="h-8 min-w-0 flex-1 rounded border border-zinc-200 px-2 disabled:bg-zinc-100" />
                <select value={composition.transcriptionStatus} onChange={(event) => setCompositions((current) => current.map((item) => item.clientId === composition.clientId ? { ...item, ...transcriptionPatch(event.target.value as OcrTranscriptionStatus, item.text) } : item))} className="h-8 rounded border border-zinc-200 bg-white px-2">
                  <option value="verified">Verified</option><option value="partial">Partial</option><option value="unreadable">Unreadable</option>
                </select>
                <span className="text-zinc-500">{composition.memberClientIds.length} words</span>
                <button type="button" onClick={() => decomposeString(composition.clientId)} className="h-8 rounded border border-violet-200 px-2 font-medium text-violet-800">Decompose</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <div className="mt-3 grid gap-2 rounded border border-zinc-200 bg-zinc-50 p-3 sm:grid-cols-[120px_1fr]">
          <select value={selected.level} onChange={(event) => updateSelected({ level: event.target.value as DraftRegion["level"] })} className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm">
            <option value="word">Word</option>
            <option value="string">String</option>
          </select>
          <input value={selected.text ?? ""} disabled={selected.transcriptionStatus === "unreadable"} onChange={(event) => updateSelected({ text: event.target.value || null })} placeholder={selected.transcriptionStatus === "unreadable" ? "No reliable transcription" : "Region text"} className="h-9 rounded border border-zinc-300 bg-white px-3 text-sm disabled:bg-zinc-100 disabled:text-zinc-400" />
          <div className="text-xs text-zinc-500 sm:col-span-3">
            bbox x {formatCoordinate(selected.bbox.x)} · y {formatCoordinate(selected.bbox.y)} · w {formatCoordinate(selected.bbox.width)} · h {formatCoordinate(selected.bbox.height)} · {selected.sourceRegionIds.length} source region(s)
          </div>
          <label className="grid gap-1 text-xs font-medium text-zinc-600 sm:col-span-2">Transcription ground truth<select value={selected.transcriptionStatus} onChange={(event) => updateSelected(transcriptionPatch(event.target.value as OcrTranscriptionStatus, selected.text))} className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm"><option value="verified">Verified</option><option value="partial">Partial — exclude from recognition GT</option><option value="unreadable">Unreadable — text ROI only</option></select></label>
          <div className="space-y-2 rounded border border-zinc-200 bg-white p-2 sm:col-span-2">
            <div className="grid grid-cols-2 gap-2"><label className="grid gap-1 text-xs font-medium text-zinc-600">Region unit<select value={selected.layout.type} onChange={(event) => updateSelected({ level: event.target.value as DraftRegion["level"], layout: { ...selected.layout, type: event.target.value as OcrLayout["type"] } })} className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm"><option value="word">Word</option><option value="string">String</option></select></label><label className="grid gap-1 text-xs font-medium text-zinc-600">Character orientation<select value={selected.layout.characterOrientation} onChange={(event) => updateSelected({ layout: { ...selected.layout, characterOrientation: event.target.value as OcrLayout["characterOrientation"] } })} className="h-9 rounded border border-zinc-300 bg-white px-2 text-sm"><option value="upright">Upright in bottle view</option><option value="aligned">Aligned with baseline</option><option value="mixed">Mixed</option></select></label></div>
            <div className="flex flex-wrap gap-1"><button type="button" onClick={() => updateSelectedAngle(0)} className="rounded border px-2 py-1">Horizontal</button><button type="button" onClick={() => updateSelectedAngle(90)} className="rounded border px-2 py-1">Vertical</button><button type="button" onClick={() => updateSelectedAngle(quadTopAngle(selected.geometry))} className="rounded border px-2 py-1">Angled from quad</button><button type="button" disabled title="Curved baseline editing is planned" className="rounded border px-2 py-1 opacity-40">Curved · planned</button></div>
            <label className="grid grid-cols-[1fr_4.5rem] items-center gap-2 text-xs font-medium text-zinc-600">Baseline angle<input type="range" min="-180" max="180" step="1" value={selected.layout.baselineAngleDeg} onChange={(event) => updateSelectedAngle(Number(event.target.value))} /><input type="number" min="-180" max="180" step="1" value={Math.round(selected.layout.baselineAngleDeg * 10) / 10} onChange={(event) => updateSelectedAngle(Number(event.target.value))} className="h-9 rounded border px-2" /></label>
            <p className="text-[10px] text-zinc-500">Drag the blue handle in the viewer to set reading direction. This updates layout and local OCR rectification, never the detection quad.</p>
          </div>
          <div className="sm:col-span-2"><OcrNormalizedPreview imageUrl={imageUrl} geometry={selectedPreviewGeometry} rectification={selected.rectification} /></div>
          {scriptWarningTokens(selected.text ?? "").length > 0 && (
            <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 sm:col-span-3">
              Mixed or visually confusable script: {scriptWarningTokens(selected.text ?? "").join(", ")}. Check homoglyphs such as р/p, о/o, с/c, а/a, Н/H, В/B and ь/b.
            </div>
          )}
        </div>
      )}

      <div className="mt-3 max-h-72 overflow-auto rounded border border-zinc-200">
        {regions.map((region, index) => {
          const scriptWarnings = scriptWarningTokens(region.text ?? "");
          return (
          <div key={region.clientId} onClick={(event) => selectRegion(region.clientId, event.shiftKey)} onMouseEnter={() => onActiveRegionChange?.(region.clientId)} onMouseLeave={() => onActiveRegionChange?.(selectedIds.includes(region.clientId) ? region.clientId : null)} className={`grid cursor-pointer grid-cols-[auto_2rem_minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-zinc-100 px-3 py-2 text-xs last:border-b-0 ${selectedIds.includes(region.clientId) ? "bg-emerald-50" : regionMatchesActive(region, activeRegionId) ? "bg-sky-50" : scriptWarnings.length ? "bg-amber-50/70" : "hover:bg-zinc-50"}`}>
            <input
              type="checkbox"
              checked={selectedIds.includes(region.clientId)}
              onClick={(event) => event.stopPropagation()}
              onChange={() => selectRegion(region.clientId, true)}
            />
            <span className="w-8 text-zinc-400">{index + 1}</span>
            <div className="min-w-0">
              <input value={region.text ?? ""} disabled={region.transcriptionStatus === "unreadable"} onChange={(event) => setRegions((current) => current.map((item) => item.clientId === region.clientId ? { ...item, text: event.target.value || null } : item))} className={`h-8 w-full min-w-0 rounded border bg-white px-2 ${scriptWarnings.length ? "border-amber-400 ring-1 ring-amber-200" : "border-zinc-200"} text-zinc-800 disabled:bg-zinc-100`} placeholder={region.transcriptionStatus === "unreadable" ? "Unreadable text ROI" : "OCR text"} title={scriptWarnings.length ? `Mixed scripts: ${scriptWarnings.join(", ")}` : undefined} />
              {scriptWarnings.length > 0 && <div className="mt-1 text-[10px] font-semibold text-amber-700">Mixed/confusable script: {scriptWarnings.join(", ")}</div>}
            </div>
            <span className="ml-auto flex items-center gap-2 text-zinc-400"><LayoutMark compact layout={region.layout} />{region.level} · {transcriptionLabel(region.transcriptionStatus)}</span>
            <button type="button" onClick={(event) => { event.stopPropagation(); deleteRegion(region.clientId); }} className="h-8 rounded border border-red-200 bg-white px-2 text-[11px] font-semibold text-red-700 hover:border-red-400 hover:bg-red-50" aria-label={`Delete OCR region ${index + 1}`} title="Delete region">Del</button>
          </div>
          );
        })}
      </div>
    </section>
  );
}

function initialRegions(snapshot: LabelAnnotationOcrSnapshot | null | undefined, review: LabelAnnotationOcrRegionReview | null | undefined): DraftRegion[] {
  if (review) {
    return review.regions.flatMap((region) => {
      const geometry = normalizeQuad(region.annotation.geometry, region.annotation.bbox);
      const predictionGeometry = region.prediction ? normalizeQuad(region.prediction.geometry, region.prediction.bbox) : null;
      return geometry ? [{
      clientId: region.id,
      sourceRegionIds: region.sourceRegionIds,
      level: region.level === "line" ? "string" : region.level,
      prediction: region.prediction && predictionGeometry ? { ...region.prediction, bbox: predictionGeometry.bbox, geometry: predictionGeometry } : null,
      bbox: geometry.bbox,
      geometry,
      text: region.annotation.text,
      transcriptionStatus: region.annotation.transcriptionStatus,
      layout: region.layout ?? legacyLayout(region.level, region.textDirection ?? inferTextDirection(region.bbox), region.glyphOrientation ?? "upright"),
      rectification: region.rectification ?? null,
      sortOrder: region.sortOrder,
      }] : [];
    });
  }

  return (snapshot?.regions ?? [])
    .filter((region) => region.level === "word")
    .flatMap((region, index) => {
      const bbox = parseBbox(region.bbox);
      const geometry = bbox ? normalizeQuad(region.geometry, bbox) : null;
      const generatedLayout = legacyLayout(compoundToken(region.rawText || region.normalizedText) ? "string" : "word", region.textDirection ?? inferTextDirection(geometry?.bbox ?? { x: 0, y: 0, width: 1, height: 1 }), region.glyphOrientation ?? "upright");
      const generatedRectification = rotationForAngle(generatedLayout.baselineAngleDeg);
      return geometry
        ? [{
            clientId: `generated:${region.id}`,
            sourceRegionIds: [region.id],
            level: compoundToken(region.rawText || region.normalizedText) ? "string" as const : "word" as const,
            prediction: { bbox: geometry.bbox, geometry, text: region.rawText || region.normalizedText || null, confidence: region.confidence, layout: generatedLayout, rectification: generatedRectification },
            bbox: geometry.bbox,
            geometry,
            text: region.rawText || region.normalizedText || null,
            transcriptionStatus: (region.rawText || region.normalizedText ? "verified" : "unreadable") as OcrTranscriptionStatus,
            layout: generatedLayout,
            rectification: generatedRectification,
            sortOrder: index,
          }]
        : [];
    });
}

function initialCompositions(review: LabelAnnotationOcrRegionReview | null | undefined): DraftComposition[] {
  return (review?.compositions ?? []).map((composition) => ({
    clientId: composition.id,
    kind: "string",
    memberClientIds: composition.memberIds,
    text: composition.text,
    transcriptionStatus: composition.transcriptionStatus,
    sortOrder: composition.sortOrder,
  }));
}

function isEditableTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  const tagName = element?.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || Boolean(element?.isContentEditable);
}

function drawRegions(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, regions: DraftRegion[], selectedIds: string[], activeRegionId: string | null, draftBox: RecognitionRoi | null) {
  ctx.save();
  ctx.font = "12px sans-serif";
  for (const [index, region] of regions.entries()) {
    const selected = selectedIds.includes(region.clientId);
    const active = regionMatchesActive(region, activeRegionId);
    const mixedScript = scriptWarningTokens(region.text ?? "").length > 0;
    const x = region.bbox.x * canvas.width;
    const y = region.bbox.y * canvas.height;
    ctx.strokeStyle = active ? "#e11d48" : selected ? "#22c55e" : mixedScript ? "#f59e0b" : "#0ea5e9";
    ctx.fillStyle = active ? "rgba(225,29,72,.16)" : selected ? "rgba(34,197,94,.14)" : mixedScript ? "rgba(245,158,11,.2)" : "rgba(14,165,233,.08)";
    ctx.lineWidth = selected || active || mixedScript ? 3 : 1.5;
    drawQuadPath(ctx, canvas, region.geometry);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#111827";
    ctx.fillText(String(index + 1), x + 3, Math.max(11, y + 12));
    if (active || selected || mixedScript) drawRegionLabel(ctx, canvas, `${mixedScript ? "⚠ " : ""}${region.text?.trim() || (region.transcriptionStatus === "unreadable" ? `(unreadable ${index + 1})` : `(empty ${index + 1})`)}`, x, y, active, selected, mixedScript);
    drawRegionControls(ctx, canvas, region.geometry, active || selected);
    if (selected) drawLocalBaselineHandle(ctx, canvas, region.geometry, region.layout.baselineAngleDeg);
  }
  if (draftBox) {
    ctx.strokeStyle = "#a855f7";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(draftBox.x * canvas.width, draftBox.y * canvas.height, draftBox.width * canvas.width, draftBox.height * canvas.height);
  }
  ctx.restore();
}

function LayoutMark({ layout, compact = false }: { layout: OcrLayout; compact?: boolean }) {
  return <span title={`${layout.flow} baseline ${Math.round(layout.baselineAngleDeg * 10) / 10}°; glyphs ${layout.characterOrientation}`} className={`inline-flex shrink-0 items-center justify-center gap-1 rounded border border-violet-200 bg-violet-50 font-semibold text-violet-800 ${compact ? "h-7 min-w-12 px-1 text-xs" : "h-12 min-w-16 text-base"}`}><span style={{ transform: `rotate(${layout.baselineAngleDeg}deg)` }}>→</span><span>A</span></span>;
}

function compoundToken(text: string) {
  return /^[\p{L}\p{N}]+(?:[-‐‑‒–—][\p{L}\p{N}]+)+$/u.test(text.trim());
}

function inferTextDirection(bbox: RecognitionRoi): "right" | "down" {
  return bbox.height > bbox.width * 1.35 ? "down" : "right";
}

function formatCoordinate(value: number) {
  return Number(value.toFixed(4));
}

function drawRegionControls(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, geometry: QuadGeometry, emphasized: boolean) {
  if (!emphasized) return;
  const topLeft = geometry.points[0];
  const topRight = geometry.points[1];
  const deleteX = (topLeft.x + topRight.x) / 2 * canvas.width;
  const deleteY = Math.max(8, Math.min(topLeft.y, topRight.y) * canvas.height - 12);
  const deleteRadius = emphasized ? 8 : 7;
  ctx.beginPath();
  ctx.fillStyle = "rgba(220,38,38,.94)";
  ctx.arc(deleteX, deleteY, deleteRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(deleteX - 3, deleteY - 3);
  ctx.lineTo(deleteX + 3, deleteY + 3);
  ctx.moveTo(deleteX + 3, deleteY - 3);
  ctx.lineTo(deleteX - 3, deleteY + 3);
  ctx.stroke();

  const cornerRadius = emphasized ? 5 : 4;
  for (const point of geometry.points) {
    ctx.beginPath();
    ctx.fillStyle = emphasized ? "#16a34a" : "#0284c7";
    ctx.arc(point.x * canvas.width, point.y * canvas.height, cornerRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawQuadPath(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, geometry: QuadGeometry) {
  ctx.beginPath();
  geometry.points.forEach((point, index) => {
    const x = point.x * canvas.width;
    const y = point.y * canvas.height;
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

function drawRegionLabel(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, text: string, x: number, y: number, active: boolean, selected: boolean, warning = false) {
  const padding = 4;
  const height = 17;
  const width = Math.min(Math.max(24, canvas.width - x), ctx.measureText(text).width + padding * 2);
  const top = y >= height + 2 ? y - height - 2 : y;
  ctx.fillStyle = active ? "rgba(225,29,72,.94)" : selected ? "rgba(22,163,74,.94)" : warning ? "rgba(217,119,6,.96)" : "rgba(24,24,27,.88)";
  ctx.fillRect(x, top, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x + padding, top + 12, Math.max(1, width - padding * 2));
}

function regionMatchesActive(region: DraftRegion, activeRegionId: string | null) {
  return Boolean(activeRegionId && (region.clientId === activeRegionId || region.sourceRegionIds.includes(activeRegionId)));
}

function scriptWarningTokens(text: string) {
  return [...new Set(text.trim().split(/\s+/u).filter((token) => {
    const letters = token.match(/[\p{Letter}]/gu)?.join("") ?? "";
    if (!letters) return false;
    const hasCyrillic = /\p{Script=Cyrillic}/u.test(letters);
    const hasLatin = /\p{Script=Latin}/u.test(letters);
    if (hasCyrillic && hasLatin) return true;
    return letters.length >= 4 && hasLatin && !hasCyrillic && /^[ABCEHIKMOPTXYabcehikmoptxy]+$/.test(letters);
  }))];
}

function hitTestRegions(regions: DraftRegion[], point: Point, canvas: HTMLCanvasElement, selectedIds: string[]): HitTarget | null {
  const bounds = canvas.getBoundingClientRect();
  const radiusX = 12 / Math.max(1, bounds.width);
  const radiusY = 12 / Math.max(1, bounds.height);
  for (const region of [...regions].reverse()) {
    if (selectedIds.includes(region.clientId)) {
      const handle = localBaselineHandlePoint(region.geometry, region.layout.baselineAngleDeg);
      if (Math.abs(point.x - handle.x) <= radiusX && Math.abs(point.y - handle.y) <= radiusY) return { region, action: "baseline" };
    }
    const deletePoint = { x: (region.geometry.points[0].x + region.geometry.points[1].x) / 2, y: Math.max(0, Math.min(region.geometry.points[0].y, region.geometry.points[1].y) - radiusY) };
    if (Math.abs(point.x - deletePoint.x) <= radiusX && Math.abs(point.y - deletePoint.y) <= radiusY) {
      return { region, action: "delete" };
    }
    const cornerIndex = region.geometry.points.findIndex((corner) => Math.abs(point.x - corner.x) <= radiusX && Math.abs(point.y - corner.y) <= radiusY);
    if (cornerIndex >= 0) {
      return { region, action: "corner", cornerIndex };
    }
    if (pointInQuad(point, region.geometry)) return { region, action: "move" };
  }
  return null;
}

function templateBoxAt(point: Point, regions: DraftRegion[]): RecognitionRoi {
  const widths = regions.map((region) => region.bbox.width).filter((value) => value > 0.005).sort((left, right) => left - right);
  const heights = regions.map((region) => region.bbox.height).filter((value) => value > 0.005).sort((left, right) => left - right);
  const width = clampRange(median(widths) ?? 0.18, 0.06, 0.45);
  const height = clampRange(median(heights) ?? 0.07, 0.025, 0.25);
  return {
    x: clampRange(point.x - width / 2, 0, 1 - width),
    y: clampRange(point.y - height / 2, 0, 1 - height),
    width,
    height,
  };
}

function median(values: number[]) {
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2 : values[middle] ?? null;
}

function clampRange(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function canvasCursor(mode: "select" | "draw", action: RegionAction | null) {
  if (mode === "draw") return "crosshair";
  if (action === "delete") return "pointer";
  if (action === "corner") return "crosshair";
  if (action === "baseline") return "grab";
  if (action === "move") return "move";
  return "cell";
}

function pointerPoint(event: ReactPointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement): Point {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: clamp01((event.clientX - bounds.left) / Math.max(1, bounds.width)),
    y: clamp01((event.clientY - bounds.top) / Math.max(1, bounds.height)),
  };
}

function rectFromPoints(left: Point, right: Point): RecognitionRoi {
  return {
    x: Math.min(left.x, right.x),
    y: Math.min(left.y, right.y),
    width: Math.abs(right.x - left.x),
    height: Math.abs(right.y - left.y),
  };
}

function unionRect(rects: RecognitionRoi[]): RecognitionRoi {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function clampRect(rect: RecognitionRoi) {
  const x = clamp(rect.x, 0, 0.999);
  const y = clamp(rect.y, 0, 0.999);
  return { x, y, width: clamp(rect.width, 0.001, 1 - x), height: clamp(rect.height, 0.001, 1 - y) };
}

function transcriptionPatch(status: OcrTranscriptionStatus, currentText: string | null): Partial<DraftRegion> {
  return { transcriptionStatus: status, text: status === "unreadable" ? null : currentText };
}

function transcriptionLabel(status: OcrTranscriptionStatus) {
  return ({
    verified: "verified text",
    partial: "partial text",
    unreadable: "unreadable text ROI",
  } satisfies Record<OcrTranscriptionStatus, string>)[status];
}

function parseBbox(value: Record<string, unknown>): RecognitionRoi | null {
  const x = finite(value.x);
  const y = finite(value.y);
  const width = finite(value.width);
  const height = finite(value.height);
  return x === null || y === null || width === null || height === null ? null : clampRect({ x, y, width, height });
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readingOrder(left: DraftRegion, right: DraftRegion) {
  const lineTolerance = Math.max(left.bbox.height, right.bbox.height) * 0.6;
  return Math.abs(left.bbox.y - right.bbox.y) <= lineTolerance ? left.bbox.x - right.bbox.x : left.bbox.y - right.bbox.y;
}

function regionsForCompare(regions: DraftRegion[]) {
  return regions.map((region) => ({
    sourceRegionIds: region.sourceRegionIds,
    level: region.level,
    prediction: region.prediction,
    bbox: region.bbox,
    geometry: region.geometry,
    text: region.text,
    transcriptionStatus: region.transcriptionStatus,
    layout: region.layout,
    rectification: region.rectification,
  }));
}

function defaultLayout(type: OcrLayout["type"]): OcrLayout {
  return { type, flow: "linear", baselineAngleDeg: 0, baseline: null, characterOrientation: "upright" };
}

function legacyLayout(type: OcrLayout["type"] | "line", direction: string, orientation: string): OcrLayout {
  return {
    type: type === "word" ? "word" : "string",
    flow: "linear",
    baselineAngleDeg: direction === "down" ? 90 : direction === "left" ? 180 : direction === "up" ? -90 : 0,
    baseline: null,
    characterOrientation: orientation === "mixed" ? "mixed" : orientation === "upright" ? "upright" : "aligned",
  };
}

function linearLayout(layout: OcrLayout, angle: number): OcrLayout {
  return { ...layout, flow: "linear", baselineAngleDeg: normalizeDegrees(angle), baseline: null, characterOrientation: layout.characterOrientation === "tangent-aligned" ? "aligned" : layout.characterOrientation };
}

function rotationForAngle(angle: number): OcrRectification | null {
  const normalized = normalizeDegrees(angle);
  return Math.abs(normalized) < 0.05 ? null : { type: "rotation", angleDeg: -normalized };
}

function normalizeDegrees(angle: number) {
  if (!Number.isFinite(angle)) return 0;
  const normalized = ((angle + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
}

function quadCenter(geometry: QuadGeometry): Point {
  return { x: geometry.points.reduce((sum, point) => sum + point.x, 0) / 4, y: geometry.points.reduce((sum, point) => sum + point.y, 0) / 4 };
}

function localBaselineHandlePoint(geometry: QuadGeometry, angleDeg: number): Point {
  const center = quadCenter(geometry);
  const length = Math.max(0.04, Math.max(geometry.bbox.width, geometry.bbox.height) * 0.65);
  const angle = angleDeg * Math.PI / 180;
  return { x: center.x + Math.cos(angle) * length, y: center.y + Math.sin(angle) * length };
}

function drawLocalBaselineHandle(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, geometry: QuadGeometry, angleDeg: number) {
  const center = quadCenter(geometry), handle = localBaselineHandlePoint(geometry, angleDeg);
  ctx.save(); ctx.strokeStyle = "#2563eb"; ctx.fillStyle = "#2563eb"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(center.x * canvas.width, center.y * canvas.height); ctx.lineTo(handle.x * canvas.width, handle.y * canvas.height); ctx.stroke();
  ctx.beginPath(); ctx.arc(handle.x * canvas.width, handle.y * canvas.height, 7, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}

function quadTopAngle(geometry: QuadGeometry) {
  const [left, right] = geometry.points;
  return normalizeDegrees(Math.atan2(right.y - left.y, right.x - left.x) * 180 / Math.PI);
}

function normalizedToSourceQuad(geometry: QuadGeometry, labelRect: RecognitionRoi): QuadGeometry {
  const points = geometry.points.map((point) => ({ x: labelRect.x + point.x * labelRect.width, y: labelRect.y + point.y * labelRect.height })) as QuadGeometry["points"];
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  return { type: "quad", points, bbox: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } };
}

function legacyTextDirection(layout: OcrLayout): "right" | "left" | "down" | "up" | "mixed" {
  const angle = normalizeDegrees(layout.baselineAngleDeg);
  return Math.abs(angle) <= 45 ? "right" : angle > 45 && angle < 135 ? "down" : angle <= -45 && angle > -135 ? "up" : "left";
}

function legacyGlyphOrientation(layout: OcrLayout): "upright" | "clockwise" | "counterclockwise" | "upside-down" | "mixed" {
  if (layout.characterOrientation === "mixed") return "mixed";
  if (layout.characterOrientation === "upright") return "upright";
  const angle = normalizeDegrees(layout.baselineAngleDeg);
  return Math.abs(angle) > 135 ? "upside-down" : angle > 45 ? "clockwise" : angle < -45 ? "counterclockwise" : "upright";
}

function commonJsonValue<T>(values: T[]): T | null {
  return values.length > 0 && values.every((value) => JSON.stringify(value) === JSON.stringify(values[0])) ? values[0]! : null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}
