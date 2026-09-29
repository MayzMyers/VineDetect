"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CatalogItem,
  type ManualCvAnnotationPayload,
  type RecognitionColor,
  type RecognitionMetadata,
  type RecognitionRoi,
} from "@/lib/admin/api";
import { AdminCvMetaViewer } from "./AdminCvMetaViewer";
import { ImageWorkspace, type WorkspaceCanvasSize, type WorkspacePoint } from "./image-workspace/ImageWorkspace";
import {
  drawGeneratedRegionOverlay,
  drawLabelCandidateOverlay,
  extractGeneratedRegions,
  extractLabelTopCandidates,
  getObject,
  naturalToCanvasRect,
  normalizedToNaturalRect,
  numberValue,
  parseNormalizedRect,
  unwrapCvMeta,
} from "./image-workspace/cvOverlays";

type Props = {
  item: CatalogItem;
  imageUrl: string | null;
  cvMeta?: unknown;
  manualAnnotations?: ManualCvAnnotationPayload | Record<string, never> | null;
  sourceHash?: string | null;
  pipelineVersion?: string;
  onSaveManualAnnotations?: (payload: ManualCvAnnotationPayload) => Promise<void>;
};

type DragState = {
  startX: number;
  startY: number;
};

type PointerPosition = {
  canvasX: number;
  canvasY: number;
  naturalX: number;
  naturalY: number;
  normalizedX: number;
  normalizedY: number;
  componentId: number | null;
};

type RasterZone = {
  x: number;
  y: number;
  averageLab: { l: number; a: number; b: number };
  saturation: number;
  lightness: number;
};

type RasterMeta = {
  width: number;
  height: number;
  averageLab: { l: number; a: number; b: number };
  dominantLab: Array<{ l: number; a: number; b: number }>;
  zones: RasterZone[];
  warnings: string[];
};

type RegionRole = "custom" | "bottle" | "label";

type DebugComponent = {
  id: number;
  rect: RecognitionRoi;
  area: number | null;
  accepted: boolean;
  selected: boolean;
  features: Record<string, unknown>;
};

type DebugLabelMap = {
  width: number;
  height: number;
  labels: Uint16Array;
  maxLabel: number;
};

type DebugBinaryMask = {
  width: number;
  height: number;
  values: Uint8Array;
};

type OverlayVisibility = {
  bottle: boolean;
  label: boolean;
  candidates: boolean;
  components: boolean;
  labelMap: boolean;
  selectedMask: boolean;
  manual: boolean;
};

const EMPTY_METADATA: RecognitionMetadata = {
  tags: [],
  roi: null,
  palette: [],
  excluded_colors: [],
  notes: null,
};

export function AdminRecognitionEditor({
  item,
  imageUrl,
  cvMeta,
  manualAnnotations,
  sourceHash,
  pipelineVersion = "cv-meta-v2",
  onSaveManualAnnotations,
}: Props) {
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const storageKey = `vinedetect-recognition-editor:${item.recognitionKey}`;
  const [metadata, setMetadata] = useState<RecognitionMetadata>(EMPTY_METADATA);
  const [activeRole, setActiveRole] = useState<RegionRole>("custom");
  const [tagInput, setTagInput] = useState("");
  const [status, setStatus] = useState("Loaded from localStorage");
  const [drag, setDrag] = useState<DragState | null>(null);
  const [mode, setMode] = useState<"roi" | "pipette-add" | "pipette-exclude">("roi");
  const [rasterMeta, setRasterMeta] = useState<RasterMeta | null>(null);
  const [pointerPosition, setPointerPosition] = useState<PointerPosition | null>(null);
  const [overlays, setOverlays] = useState<OverlayVisibility>({
    bottle: true,
    label: true,
    candidates: true,
    components: true,
    labelMap: false,
    selectedMask: true,
    manual: true,
  });

  const generatedRegions = useMemo(() => extractGeneratedRegions(cvMeta), [cvMeta]);
  const debugCandidates = useMemo(() => extractLabelTopCandidates(cvMeta), [cvMeta]);
  const debugComponents = useMemo(() => extractDebugComponents(cvMeta), [cvMeta]);
  const debugLabelMap = useMemo(() => extractDebugLabelMap(cvMeta), [cvMeta]);
  const selectedLabelMask = useMemo(() => extractSelectedLabelMask(cvMeta), [cvMeta]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const fromManual = manualAnnotationsToMetadata(manualAnnotations);
      if (fromManual) {
        setMetadata(fromManual.metadata);
        setActiveRole(fromManual.activeRole);
        setStatus("Loaded manual annotations");
        return;
      }
      setMetadata(loadStoredMetadata(storageKey));
      setStatus(onSaveManualAnnotations ? "No manual annotations saved" : "Loaded from localStorage");
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [manualAnnotations, onSaveManualAnnotations, storageKey]);

  const drawCanvas = useCallback(({ canvas, image }: { canvas: HTMLCanvasElement; image: HTMLImageElement }) => {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    if (overlays.labelMap && debugLabelMap) {
      const overlay = labelMapToCanvas(debugLabelMap);
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    if (overlays.selectedMask && selectedLabelMask) {
      const overlay = binaryMaskToCanvas(selectedLabelMask, [239, 68, 68, 180]);
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    if (overlays.components) {
      for (const component of debugComponents) {
        const rect = naturalToCanvasRect(component.rect, image, canvas);
        ctx.strokeStyle = component.selected ? "#dc2626" : "#06b6d4";
        ctx.setLineDash(component.selected ? [] : [2, 3]);
        ctx.lineWidth = component.selected ? 3 : 1.5;
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
        ctx.setLineDash([]);
        ctx.fillStyle = component.selected ? "#dc2626" : "#0891b2";
        ctx.font = "11px sans-serif";
        ctx.fillText(`C${component.id}`, rect.x + 3, Math.max(11, rect.y + 12));
      }
    }

    if (overlays.candidates) {
      for (const candidate of debugCandidates) {
        drawLabelCandidateOverlay(ctx, candidate, image, canvas);
      }
    }

    for (const region of generatedRegions) {
      if (region.role === "bottle" && !overlays.bottle) continue;
      if (region.role === "label" && !overlays.label) continue;
      drawGeneratedRegionOverlay(ctx, region, image, canvas);
    }

    if (metadata.roi && overlays.manual) {
      const rect = naturalToCanvasRect(metadata.roi, image, canvas);
      ctx.fillStyle = "rgba(14, 165, 233, 0.14)";
      ctx.strokeStyle = "#0ea5e9";
      ctx.lineWidth = 3;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    }
  }, [debugCandidates, debugComponents, debugLabelMap, generatedRegions, metadata.roi, overlays, selectedLabelMask]);

  const refreshRasterMeta = useCallback(() => {
    const canvas = sourceCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    setRasterMeta(extractRasterMeta(ctx, canvas.width, canvas.height));
  }, []);

  const handleWorkspaceReady = useCallback(
    ({ image, size }: { image: HTMLImageElement; size: { width: number; height: number } }) => {
      imageRef.current = image;
      sourceCanvasRef.current = createSourceCanvas(image, size);
      refreshRasterMeta();
    },
    [refreshRasterMeta]
  );

  const includedColors = useMemo(
    () => metadata.palette.filter((color) => !metadata.excluded_colors.some((excluded) => excluded.hex === color.hex)),
    [metadata.excluded_colors, metadata.palette]
  );

  function handlePointerDown(point: WorkspacePoint) {
    if (mode.startsWith("pipette")) {
      pickColor(point.x, point.y, mode === "pipette-exclude");
      return;
    }

    setDrag({ startX: point.x, startY: point.y });
  }

  function handlePointerMove(point: WorkspacePoint, _event: React.PointerEvent<HTMLCanvasElement>, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    const { canvas, image } = context;
    setPointerPosition(toPointerPosition(point, image, canvas, debugLabelMap));

    if (!drag || mode !== "roi") return;

    const canvasRect = normalizeRect({
      x: drag.startX,
      y: drag.startY,
      width: point.x - drag.startX,
      height: point.y - drag.startY,
    });

    setMetadata((current) => ({
      ...current,
      roi: canvasToNaturalRect(canvasRect, image, canvas),
    }));
  }

  function handlePointerUp(point: WorkspacePoint | null, _event: React.PointerEvent<HTMLCanvasElement>, context: { canvas: HTMLCanvasElement; image: HTMLImageElement }) {
    if (drag) {
      const { canvas, image } = context;
      if (point) {
        const canvasRect = normalizeRect({
          x: drag.startX,
          y: drag.startY,
          width: point.x - drag.startX,
          height: point.y - drag.startY,
        });
        const nextRoi = canvasToNaturalRect(canvasRect, image, canvas);
        setMetadata((current) => ({
          ...current,
          roi: nextRoi,
        }));
        refreshPalette(nextRoi);
      }
    }
    setDrag(null);
  }

  function handlePointerLeave() {
    setDrag(null);
    setPointerPosition(null);
  }

  function refreshPalette(nextRoi: RecognitionRoi | null = metadata.roi) {
    const canvas = sourceCanvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !nextRoi) return;

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const rect = naturalToCanvasRect(nextRoi, image, canvas);
    const palette = extractPalette(ctx, rect, 8);
    setMetadata((current) => ({ ...current, palette }));
  }

  function pickColor(x: number, y: number, exclude: boolean) {
    const sourceCanvas = sourceCanvasRef.current;
    if (!sourceCanvas) return;
    const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    const [r, g, b] = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    const color = { hex: rgbToHex(r, g, b), source: "pipette" as const };
    setMetadata((current) => addPickedColor(current, color, exclude));
  }

  function addTag() {
    const value = tagInput.trim();
    if (!value) return;
    setMetadata((current) => ({
      ...current,
      tags: Array.from(new Set([...current.tags, value])),
    }));
    setTagInput("");
  }

  function removeTag(tag: string) {
    setMetadata((current) => ({
      ...current,
      tags: current.tags.filter((value) => value !== tag),
    }));
  }

  async function save() {
    try {
      if (onSaveManualAnnotations) {
        const image = imageRef.current;
        await onSaveManualAnnotations(
          buildManualPayload(metadata, activeRole, sourceHash, pipelineVersion, image?.naturalWidth ?? 1000, image?.naturalHeight ?? 1000)
        );
        setStatus("Saved manual annotations");
        return;
      }
      window.localStorage.setItem(storageKey, JSON.stringify(metadata));
      setStatus("Saved to localStorage");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save localStorage metadata");
    }
  }

  function applyGeneratedRegion(region: ReturnType<typeof extractGeneratedRegions>[number]) {
    setActiveRole(region.role);
    setMetadata((current) => ({
      ...current,
      roi: region.rect,
      palette: generatedPaletteForRole(cvMeta, region.role),
    }));
    setStatus(`Copied generated ${region.role} ROI to manual draft`);
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-3 border-b border-zinc-200 pb-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase text-zinc-500">Recognition Metadata</h2>
          <div className="mt-1 text-xs text-zinc-500">{status}</div>
        </div>
        <button
          type="button"
          onClick={save}
          className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium"
        >
          Save manual
        </button>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div>
          <div className="mb-3 flex flex-wrap gap-2">
            <select
              value={activeRole}
              onChange={(event) => setActiveRole(event.target.value as RegionRole)}
              className="h-9 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
            >
              <option value="custom">Custom region</option>
              <option value="bottle">Bottle</option>
              <option value="label">Label</option>
            </select>
            <ModeButton active={mode === "roi"} onClick={() => setMode("roi")} label="ROI" />
            <ModeButton active={mode === "pipette-add"} onClick={() => setMode("pipette-add")} label="Pipette add" />
            <ModeButton active={mode === "pipette-exclude"} onClick={() => setMode("pipette-exclude")} label="Pipette exclude" />
            <button type="button" onClick={() => refreshPalette()} className="h-9 rounded border border-zinc-300 px-3 text-sm">
              Rebuild palette
            </button>
            <button type="button" onClick={refreshRasterMeta} className="h-9 rounded border border-zinc-300 px-3 text-sm">
              Rebuild raster data
            </button>
          </div>
          {generatedRegions.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {generatedRegions.map((region) => (
                <button
                  key={region.id}
                  type="button"
                  onClick={() => applyGeneratedRegion(region)}
                  className="h-8 rounded border border-zinc-300 px-3 text-xs font-medium hover:bg-zinc-50"
                >
                  Use generated {region.role} {region.confidence === null ? "" : `(${region.confidence})`}
                </button>
              ))}
            </div>
          )}
          <div className="mb-3 grid gap-3 rounded border border-zinc-200 bg-zinc-50 p-3 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div className="flex flex-wrap gap-3">
              <OverlayToggle
                label="Bottle ROI"
                checked={overlays.bottle}
                onChange={(checked) => setOverlays((current) => ({ ...current, bottle: checked }))}
              />
              <OverlayToggle
                label="Label ROI"
                checked={overlays.label}
                onChange={(checked) => setOverlays((current) => ({ ...current, label: checked }))}
              />
              <OverlayToggle
                label={`Top candidates (${debugCandidates.length})`}
                checked={overlays.candidates}
                onChange={(checked) => setOverlays((current) => ({ ...current, candidates: checked }))}
              />
              <OverlayToggle
                label={`Components (${debugComponents.length})`}
                checked={overlays.components}
                onChange={(checked) => setOverlays((current) => ({ ...current, components: checked }))}
              />
              <OverlayToggle
                label="Label map"
                checked={overlays.labelMap}
                onChange={(checked) => setOverlays((current) => ({ ...current, labelMap: checked }))}
              />
              <OverlayToggle
                label="Selected mask"
                checked={overlays.selectedMask}
                onChange={(checked) => setOverlays((current) => ({ ...current, selectedMask: checked }))}
              />
              <OverlayToggle
                label="Manual ROI"
                checked={overlays.manual}
                onChange={(checked) => setOverlays((current) => ({ ...current, manual: checked }))}
              />
            </div>
            <PointerReadout position={pointerPosition} />
          </div>
          <ImageWorkspace
            imageUrl={imageUrl}
            mode={mode === "roi" ? "roi-editor" : "color-picker"}
            draw={drawCanvas}
            getCanvasSize={getCanvasSize}
            onReady={handleWorkspaceReady}
            onImageLoadError={() => setStatus("Failed to load source image for canvas")}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
          />
        </div>

        <div className="space-y-4">
          <AdminCvMetaViewer title="Generated CV metadata" cvMeta={cvMeta} />
          <CanvasRasterSummary rasterMeta={rasterMeta} />

          <div>
            <div className="text-xs font-semibold uppercase text-zinc-500">Generated reference</div>
            <div className="mt-2 grid gap-2 text-xs text-zinc-600">
              {generatedRegions.length === 0 && <div>No generated ROI</div>}
              {generatedRegions.map((region) => (
                <div key={region.id} className="rounded border border-zinc-200 p-2">
                  {region.role} / {region.origin} / confidence {region.confidence ?? "-"}
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold uppercase text-zinc-500">Label candidates</div>
            <div className="mt-2 grid gap-2 text-xs text-zinc-600">
              {debugCandidates.length === 0 && <div>No label candidates</div>}
              {debugCandidates.slice(0, 5).map((candidate) => (
                <div key={candidate.id} className="rounded border border-zinc-200 p-2">
                  #{candidate.rank} / {candidate.source} / score {candidate.score ?? "-"} / confidence {candidate.confidence ?? "-"}
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold uppercase text-zinc-500">Components</div>
            <div className="mt-2 max-h-48 overflow-auto rounded border border-zinc-200">
              {debugComponents.length === 0 && <div className="p-2 text-xs text-zinc-500">No component metadata</div>}
              {debugComponents.slice(0, 24).map((component) => (
                <div key={component.id} className="border-b border-zinc-100 p-2 text-xs text-zinc-600 last:border-b-0">
                  C{component.id} / area {component.area ?? "-"} / {component.selected ? "selected" : component.accepted ? "accepted" : "rejected"}
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold uppercase text-zinc-500">Tag cloud</div>
            <div className="mt-2 flex gap-2">
              <input
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addTag();
                  }
                }}
                className="h-10 min-w-0 flex-1 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
                placeholder="label, vintage, producer"
              />
              <button type="button" onClick={addTag} className="h-10 rounded border border-zinc-300 px-3 text-sm">
                Add
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {metadata.tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="rounded bg-zinc-100 px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-200"
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          <ColorSection
            title="Selected tones"
            colors={includedColors}
            onToggle={(color) =>
              setMetadata((current) => ({
                ...current,
                excluded_colors: uniqueColors([...current.excluded_colors, { hex: color.hex, source: "palette" }]),
              }))
            }
          />
          <ColorSection
            title="Excluded tones"
            colors={metadata.excluded_colors}
            onToggle={(color) =>
              setMetadata((current) => ({
                ...current,
                excluded_colors: current.excluded_colors.filter((itemColor) => itemColor.hex !== color.hex),
              }))
            }
          />

          <div>
            <div className="text-xs font-semibold uppercase text-zinc-500">Notes</div>
            <textarea
              value={metadata.notes ?? ""}
              onChange={(event) => setMetadata((current) => ({ ...current, notes: event.target.value }))}
              className="mt-2 min-h-24 w-full rounded border border-zinc-300 p-3 text-sm outline-none focus:border-zinc-600"
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function ModeButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-9 rounded border px-3 text-sm ${active ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-300"}`}
    >
      {label}
    </button>
  );
}

function OverlayToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex h-8 items-center gap-2 text-xs font-medium text-zinc-700">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

function PointerReadout({ position }: { position: PointerPosition | null }) {
  return (
    <div className="grid min-w-52 gap-1 font-mono text-xs text-zinc-600">
      <div>
        canvas: {position ? `${formatCoord(position.canvasX)}, ${formatCoord(position.canvasY)}` : "-"}
      </div>
      <div>
        image: {position ? `${formatCoord(position.naturalX)}, ${formatCoord(position.naturalY)}` : "-"}
      </div>
      <div>
        norm: {position ? `${position.normalizedX.toFixed(4)}, ${position.normalizedY.toFixed(4)}` : "-"}
      </div>
      <div>component: {position?.componentId ? `C${position.componentId}` : "-"}</div>
    </div>
  );
}

function CanvasRasterSummary({ rasterMeta }: { rasterMeta: RasterMeta | null }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold uppercase text-zinc-500">Canvas raster sample</h2>
      {!rasterMeta ? (
        <div className="mt-3 rounded border border-zinc-200 p-3 text-sm text-zinc-500">Raster sample is not ready.</div>
      ) : (
        <div className="mt-3 grid gap-2 text-xs text-zinc-600">
          <div className="rounded border border-zinc-200 p-2">
            {rasterMeta.width} x {rasterMeta.height}
          </div>
          <div className="rounded border border-zinc-200 p-2">
            average Lab {rasterMeta.averageLab.l}, {rasterMeta.averageLab.a}, {rasterMeta.averageLab.b}
          </div>
          {rasterMeta.warnings.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-800">{rasterMeta.warnings.join("; ")}</div>
          )}
        </div>
      )}
    </section>
  );
}

function ColorSection({
  title,
  colors,
  onToggle,
}: {
  title: string;
  colors: RecognitionColor[];
  onToggle: (color: RecognitionColor) => void;
}) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase text-zinc-500">{title}</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {colors.length === 0 && <div className="text-sm text-zinc-500">No colors</div>}
        {colors.map((color) => (
          <button
            key={color.hex}
            type="button"
            onClick={() => onToggle(color)}
            className="h-9 w-9 rounded border border-zinc-300"
            style={{ backgroundColor: color.hex }}
            title={color.hex}
          />
        ))}
      </div>
    </div>
  );
}

function formatCoord(value: number) {
  return Math.round(value).toLocaleString("ru-RU");
}

function getCanvasSize(hostWidth: number, image: HTMLImageElement): WorkspaceCanvasSize {
  const imageAspect = image.naturalWidth / image.naturalHeight;
  const maxWidth = Math.max(1, Math.floor(hostWidth));
  const maxHeight = 620;
  const widthByHeight = Math.floor(maxHeight * imageAspect);
  const width = Math.max(1, Math.min(maxWidth, widthByHeight));
  const height = Math.max(1, Math.round(width / imageAspect));
  return { width, height };
}

function createSourceCanvas(image: HTMLImageElement, size: WorkspaceCanvasSize) {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) {
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

function canvasToNaturalRect(rect: RecognitionRoi, image: HTMLImageElement, canvas: HTMLCanvasElement) {
  const scaleX = image.naturalWidth / canvas.width;
  const scaleY = image.naturalHeight / canvas.height;
  return clampRect(
    {
      x: Math.round(rect.x * scaleX),
      y: Math.round(rect.y * scaleY),
      width: Math.round(rect.width * scaleX),
      height: Math.round(rect.height * scaleY),
    },
    image.naturalWidth,
    image.naturalHeight
  );
}

function toPointerPosition(
  point: { x: number; y: number },
  image: HTMLImageElement,
  canvas: HTMLCanvasElement,
  labelMap: DebugLabelMap | null
): PointerPosition {
  const scaleX = image.naturalWidth / canvas.width;
  const scaleY = image.naturalHeight / canvas.height;
  const naturalX = point.x * scaleX;
  const naturalY = point.y * scaleY;
  const componentId = labelMap ? lookupLabelMap(labelMap, naturalX / image.naturalWidth, naturalY / image.naturalHeight) : null;
  return {
    canvasX: point.x,
    canvasY: point.y,
    naturalX,
    naturalY,
    normalizedX: image.naturalWidth ? naturalX / image.naturalWidth : 0,
    normalizedY: image.naturalHeight ? naturalY / image.naturalHeight : 0,
    componentId,
  };
}

function normalizeRect(rect: RecognitionRoi) {
  const x = rect.width < 0 ? rect.x + rect.width : rect.x;
  const y = rect.height < 0 ? rect.y + rect.height : rect.y;
  return {
    x,
    y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

function clampRect(rect: RecognitionRoi, maxWidth: number, maxHeight: number) {
  const x = Math.max(0, Math.min(maxWidth, rect.x));
  const y = Math.max(0, Math.min(maxHeight, rect.y));
  return {
    x,
    y,
    width: Math.max(1, Math.min(maxWidth - x, rect.width)),
    height: Math.max(1, Math.min(maxHeight - y, rect.height)),
  };
}

function extractPalette(ctx: CanvasRenderingContext2D, rect: RecognitionRoi, limit: number) {
  const safeRect = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
  const data = ctx.getImageData(safeRect.x, safeRect.y, safeRect.width, safeRect.height).data;
  const buckets = new Map<string, number>();
  const step = Math.max(4, Math.floor(data.length / 9000) * 4);

  for (let index = 0; index < data.length; index += step) {
    const alpha = data[index + 3];
    if (alpha < 64) continue;
    const r = Math.round(data[index] / 32) * 32;
    const g = Math.round(data[index + 1] / 32) * 32;
    const b = Math.round(data[index + 2] / 32) * 32;
    const hex = rgbToHex(Math.min(255, r), Math.min(255, g), Math.min(255, b));
    buckets.set(hex, (buckets.get(hex) ?? 0) + 1);
  }

  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([hex, count]) => ({ hex, count, source: "palette" as const }));
}

function extractRasterMeta(ctx: CanvasRenderingContext2D, width: number, height: number): RasterMeta {
  const columns = 3;
  const rows = 4;
  const zones: RasterZone[] = [];
  const warnings: string[] = [];

  if (width < 24 || height < 24) {
    warnings.push("Image is too small for stable raster features");
  }

  const averageLab = averageLabForRect(ctx, { x: 0, y: 0, width, height });

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const rect = {
        x: Math.floor((x / columns) * width),
        y: Math.floor((y / rows) * height),
        width: Math.max(1, Math.floor(width / columns)),
        height: Math.max(1, Math.floor(height / rows)),
      };
      const zoneLab = averageLabForRect(ctx, rect);
      zones.push({
        x,
        y,
        averageLab: zoneLab,
        saturation: Math.sqrt(zoneLab.a * zoneLab.a + zoneLab.b * zoneLab.b),
        lightness: zoneLab.l,
      });
    }
  }

  return {
    width,
    height,
    averageLab,
    dominantLab: [...zones].sort((a, b) => b.saturation - a.saturation).slice(0, 5).map((zone) => zone.averageLab),
    zones,
    warnings,
  };
}

function averageLabForRect(ctx: CanvasRenderingContext2D, rect: RecognitionRoi) {
  const safeRect = {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
  const data = ctx.getImageData(safeRect.x, safeRect.y, safeRect.width, safeRect.height).data;
  let l = 0;
  let a = 0;
  let b = 0;
  let count = 0;
  const step = Math.max(4, Math.floor(data.length / 12000) * 4);

  for (let index = 0; index < data.length; index += step) {
    const alpha = data[index + 3];
    if (alpha < 64) continue;
    const lab = rgbToLab(data[index], data[index + 1], data[index + 2]);
    l += lab.l;
    a += lab.a;
    b += lab.b;
    count += 1;
  }

  if (count === 0) return { l: 0, a: 0, b: 0 };
  return {
    l: l / count,
    a: a / count,
    b: b / count,
  };
}

function rgbToLab(r: number, g: number, b: number) {
  const red = pivotRgb(r / 255);
  const green = pivotRgb(g / 255);
  const blue = pivotRgb(b / 255);

  const x = (red * 0.4124 + green * 0.3576 + blue * 0.1805) / 0.95047;
  const y = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 1.0;
  const z = (red * 0.0193 + green * 0.1192 + blue * 0.9505) / 1.08883;

  const fx = pivotXyz(x);
  const fy = pivotXyz(y);
  const fz = pivotXyz(z);

  return {
    l: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

function pivotRgb(value: number) {
  return value > 0.04045 ? ((value + 0.055) / 1.055) ** 2.4 : value / 12.92;
}

function pivotXyz(value: number) {
  return value > 0.008856 ? value ** (1 / 3) : 7.787 * value + 16 / 116;
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function addPickedColor(metadata: RecognitionMetadata, color: RecognitionColor, exclude: boolean) {
  if (exclude) {
    return {
      ...metadata,
      excluded_colors: uniqueColors([...metadata.excluded_colors, color]),
    };
  }

  return {
    ...metadata,
    palette: uniqueColors([color, ...metadata.palette]),
    excluded_colors: metadata.excluded_colors.filter((excluded) => excluded.hex !== color.hex),
  };
}

function uniqueColors(colors: RecognitionColor[]) {
  const seen = new Set<string>();
  return colors.filter((color) => {
    if (seen.has(color.hex)) return false;
    seen.add(color.hex);
    return true;
  });
}

function extractDebugComponents(cvMeta: unknown): DebugComponent[] {
  const root = unwrapCvMeta(cvMeta);
  const layers = getDebugLayers(root);
  const layer = layers.find((item) => getString(item, "id") === "components");
  const components = getArray(layer, "components");
  return components
    .map((item) => {
      const record = asRecord(item);
      const bbox = parseNormalizedRect(record?.bbox);
      const id = numberValue(record?.id);
      if (!record || !bbox || id === null) return null;
      return {
        id,
        rect: normalizedToNaturalRect(bbox, root),
        area: numberValue(record.area),
        accepted: record.accepted === true,
        selected: record.selected === true,
        features: asRecord(record.features) ?? {},
      };
    })
    .filter((item): item is DebugComponent => Boolean(item));
}

function extractDebugLabelMap(cvMeta: unknown): DebugLabelMap | null {
  const root = unwrapCvMeta(cvMeta);
  const layers = getDebugLayers(root);
  const layer = layers.find((item) => getString(item, "id") === "component-label-map");
  if (!layer) return null;
  const width = numberValue(layer.width);
  const height = numberValue(layer.height);
  const maxLabel = numberValue(layer.maxLabel) ?? 0;
  const data = getString(layer, "data");
  if (!width || !height || !data) return null;
  return {
    width,
    height,
    maxLabel,
    labels: decodeUint16RleBase64(data, width * height),
  };
}

function extractSelectedLabelMask(cvMeta: unknown): DebugBinaryMask | null {
  const root = unwrapCvMeta(cvMeta);
  const layers = getDebugLayers(root);
  const layer = layers.find((item) => getString(item, "id") === "selected-label-mask");
  if (!layer) return null;
  const width = numberValue(layer.width);
  const height = numberValue(layer.height);
  const data = getString(layer, "data");
  if (!width || !height || !data) return null;
  return {
    width,
    height,
    values: decodeBinaryRleBase64(data, width * height),
  };
}

function getDebugLayers(root: Record<string, unknown> | null) {
  const layers = getObject(root, ["label", "debug"])?.layers;
  return Array.isArray(layers) ? layers.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function manualAnnotationsToMetadata(value: ManualCvAnnotationPayload | Record<string, never> | null | undefined) {
  if (!value || !("schemaVersion" in value)) return null;
  const region = value.regions.find((item) => item.role === "label" || item.role === "bottle" || item.role === "custom");
  const rect = parseNormalizedRect(region?.rect);
  const role: RegionRole = region?.role === "label" || region?.role === "bottle" ? region.role : "custom";
  const palette = value.palettes[0];
  return {
    activeRole: role,
    metadata: normalizeMetadata({
      tags: [],
      roi: rect ? normalizedToNaturalRect(rect, null) : null,
      palette: annotationColorsToRecognitionColors(palette?.colors),
      excluded_colors: [],
      notes: null,
    }),
  };
}

function buildManualPayload(
  metadata: RecognitionMetadata,
  activeRole: RegionRole,
  sourceHash: string | null | undefined,
  pipelineVersion: string,
  naturalWidth: number,
  naturalHeight: number
): ManualCvAnnotationPayload {
  const normalizedRect = metadata.roi ? naturalToNormalizedRect(metadata.roi, naturalWidth, naturalHeight) : null;
  return {
    schemaVersion: 1,
    sourceHash: sourceHash ?? "",
    basedOnPipelineVersion: pipelineVersion,
    regions: normalizedRect
      ? [
          {
            role: activeRole,
            rect: normalizedRect,
            origin: "manual-override",
          },
        ]
      : [],
    palettes: [
      {
        role: activeRole,
        origin: "manual-override",
        colors: metadata.palette.map((color) => ({
          rgb: hexToRgb(color.hex),
          origin: color.source === "pipette" ? "pipette" : "manual",
        })),
      },
    ],
    colorSamples: [],
    decisions: normalizedRect
      ? [
          {
            featureRole: `${activeRole}-roi`,
            action: "override-generated",
          },
        ]
      : [],
  };
}

function generatedPaletteForRole(cvMeta: unknown, role: RegionRole): RecognitionColor[] {
  const root = unwrapCvMeta(cvMeta);
  if (!root) return [];
  const colors = getObject(root, ["colors", role])?.dominantRgb;
  if (!Array.isArray(colors)) return [];
  return colors.flatMap((item) => {
      const value = getObject(item, ["value"]);
      if (!Array.isArray(value) || value.length < 3) return [];
      return {
        hex: rgbToHex(Number(value[0]), Number(value[1]), Number(value[2])),
        source: "palette" as const,
      };
    });
}

function labelMapToCanvas(labelMap: DebugLabelMap) {
  const canvas = document.createElement("canvas");
  canvas.width = labelMap.width;
  canvas.height = labelMap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const imageData = ctx.createImageData(labelMap.width, labelMap.height);
  for (let index = 0; index < labelMap.labels.length; index += 1) {
    const label = labelMap.labels[index] ?? 0;
    if (!label) continue;
    const color = componentColor(label);
    const offset = index * 4;
    imageData.data[offset] = color[0];
    imageData.data[offset + 1] = color[1];
    imageData.data[offset + 2] = color[2];
    imageData.data[offset + 3] = 180;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function binaryMaskToCanvas(mask: DebugBinaryMask, color: [number, number, number, number]) {
  const canvas = document.createElement("canvas");
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const imageData = ctx.createImageData(mask.width, mask.height);
  for (let index = 0; index < mask.values.length; index += 1) {
    if (!mask.values[index]) continue;
    const offset = index * 4;
    imageData.data[offset] = color[0];
    imageData.data[offset + 1] = color[1];
    imageData.data[offset + 2] = color[2];
    imageData.data[offset + 3] = color[3];
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function lookupLabelMap(labelMap: DebugLabelMap, normalizedX: number, normalizedY: number) {
  const x = Math.max(0, Math.min(labelMap.width - 1, Math.floor(normalizedX * labelMap.width)));
  const y = Math.max(0, Math.min(labelMap.height - 1, Math.floor(normalizedY * labelMap.height)));
  const value = labelMap.labels[y * labelMap.width + x] ?? 0;
  return value > 0 ? value : null;
}

function decodeBinaryRleBase64(data: string, expectedLength: number) {
  const bytes = Uint8Array.from(window.atob(data), (char) => char.charCodeAt(0));
  const encoded = new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  const output = new Uint8Array(expectedLength);
  let outputIndex = 0;
  for (let index = 0; index < encoded.length; index += 2) {
    const value = encoded[index] ? 1 : 0;
    const runLength = encoded[index + 1] ?? 0;
    const end = Math.min(expectedLength, outputIndex + runLength);
    output.fill(value, outputIndex, end);
    outputIndex = end;
  }
  return output;
}

function decodeUint16RleBase64(data: string, expectedLength: number) {
  const bytes = Uint8Array.from(window.atob(data), (char) => char.charCodeAt(0));
  const encoded = new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  const output = new Uint16Array(expectedLength);
  let outputIndex = 0;
  for (let index = 0; index < encoded.length; index += 2) {
    const value = encoded[index] ?? 0;
    const runLength = encoded[index + 1] ?? 0;
    const end = Math.min(expectedLength, outputIndex + runLength);
    output.fill(value, outputIndex, end);
    outputIndex = end;
  }
  return output;
}

function componentColor(id: number): [number, number, number] {
  const hue = (id * 47) % 360;
  return hslToRgb(hue / 360, 0.75, 0.55);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue2rgb = (p: number, q: number, t: number) => {
    let next = t;
    if (next < 0) next += 1;
    if (next > 1) next -= 1;
    if (next < 1 / 6) return p + (q - p) * 6 * next;
    if (next < 1 / 2) return q;
    if (next < 2 / 3) return p + (q - p) * (2 / 3 - next) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

function annotationColorsToRecognitionColors(value: unknown): RecognitionColor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
      const rgb = getObject(item, ["rgb"]);
      if (!Array.isArray(rgb) || rgb.length < 3) return [];
      return {
        hex: rgbToHex(Number(rgb[0]), Number(rgb[1]), Number(rgb[2])),
        source: "manual" as const,
      };
    });
}

function naturalToNormalizedRect(rect: RecognitionRoi, naturalWidth: number, naturalHeight: number): RecognitionRoi {
  const width = Math.max(1, naturalWidth);
  const height = Math.max(1, naturalHeight);
  return {
    x: roundUnit(rect.x / width),
    y: roundUnit(rect.y / height),
    width: roundUnit(rect.width / width),
    height: roundUnit(rect.height / height),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getString(value: Record<string, unknown> | null | undefined, key: string) {
  const next = value?.[key];
  return typeof next === "string" ? next : null;
}

function getArray(value: Record<string, unknown> | null | undefined, key: string) {
  const next = value?.[key];
  return Array.isArray(next) ? next : [];
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16) || 0,
    Number.parseInt(normalized.slice(2, 4), 16) || 0,
    Number.parseInt(normalized.slice(4, 6), 16) || 0,
  ];
}

function roundUnit(value: number) {
  return Math.round(value * 10000) / 10000;
}

function normalizeMetadata(metadata: Partial<RecognitionMetadata> | null | undefined): RecognitionMetadata {
  return {
    tags: Array.isArray(metadata?.tags) ? metadata.tags : [],
    roi: metadata?.roi ?? null,
    palette: Array.isArray(metadata?.palette) ? metadata.palette : [],
    excluded_colors: Array.isArray(metadata?.excluded_colors) ? metadata.excluded_colors : [],
    notes: metadata?.notes ?? null,
  };
}

function loadStoredMetadata(storageKey: string): RecognitionMetadata {
  if (typeof window === "undefined") return EMPTY_METADATA;

  try {
    const rawValue = window.localStorage.getItem(storageKey);
    return rawValue ? normalizeMetadata(JSON.parse(rawValue)) : EMPTY_METADATA;
  } catch {
    return EMPTY_METADATA;
  }
}
