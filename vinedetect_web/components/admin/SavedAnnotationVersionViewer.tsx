"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getDinoDenseOverlay, getGpuMinerEvidence, type AnnotationGraph, type AnnotationRegionGeometry, type DinoDenseOverlay, type GpuMinerEvidenceContext } from "@/lib/admin/api";
import { ImageWorkspace } from "./image-workspace/ImageWorkspace";
import { mapQuadUnitPoint } from "./image-workspace/labelRectification";
import { decodeSavedVersionMask, type SavedVersionMask } from "./savedVersionMask";
import { RawJsonBlock } from "./RawJsonBlock";

type Label = AnnotationGraph["packages"][number]["labels"][number];
type OverlayKey = "scope" | "object" | "label" | "dino" | "ocr" | "mask" | "morphology" | "components" | "elements" | "contours";
const CV_STAGES = ["mask", "morphology", "components", "elements", "contours", "palette"] as const;

export function SavedAnnotationVersionViewer({ graph, imageUrl, source, sourceItemId, token }: { graph: AnnotationGraph; imageUrl: string | null; source: string; sourceItemId: string; token: string | null }) {
  const [visible, setVisible] = useState<Record<OverlayKey, boolean>>({ scope: true, object: true, label: true, dino: false, ocr: true, mask: false, morphology: false, components: false, elements: false, contours: false });
  const [sourceImageError, setSourceImageError] = useState(false);
  const [minerEvidence, setMinerEvidence] = useState<GpuMinerEvidenceContext | null>(null);
  const [minerError, setMinerError] = useState<string | null>(null);
  const [dinoOverlay, setDinoOverlay] = useState<DinoDenseOverlay | null>(null);
  const [dinoOverlayError, setDinoOverlayError] = useState<string | null>(null);
  const [dinoOverlayLoading, setDinoOverlayLoading] = useState(false);
  const labels = useMemo(() => graph.packages.flatMap((packageItem) => packageItem.labels), [graph]);
  const toggle = (key: OverlayKey) => setVisible((current) => ({ ...current, [key]: !current[key] }));
  const drawSource = useCallback(({ canvas, image }: { canvas: HTMLCanvasElement; image: HTMLImageElement }) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (visible.dino && dinoOverlay) drawDinoDenseOverlay(ctx, dinoOverlay, image, canvas);
    for (const [index, packageItem] of graph.packages.entries()) {
      if (visible.scope) drawGeometry(ctx, packageItem.scope.geometry, image, canvas, "#f59e0b", `P${index + 1} scope`);
      if (visible.object) drawGeometry(ctx, packageItem.objectContext.geometry, image, canvas, "#fb7185", `P${index + 1} object`);
      if (visible.label) packageItem.labels.forEach((label, labelIndex) => drawGeometry(ctx, label.geometry, image, canvas, "#22c55e", `L${labelIndex + 1}`));
    }
  }, [dinoOverlay, graph, visible]);

  useEffect(() => {
    let current = true;
    queueMicrotask(() => { if (current) setMinerError(null); });
    void getGpuMinerEvidence(source, sourceItemId, token)
      .then((value) => { if (current) setMinerEvidence(value); })
      .catch((error) => {
        if (!current) return;
        setMinerEvidence(null);
        setMinerError(error instanceof Error ? error.message : "GPU evidence could not be loaded");
      });
    return () => { current = false; };
  }, [source, sourceItemId, token]);

  useEffect(() => {
    if (!visible.dino || dinoOverlay || !minerEvidence?.families.dinov3) return;
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      setDinoOverlayLoading(true);
      setDinoOverlayError(null);
    });
    void getDinoDenseOverlay(source, sourceItemId, token)
      .then((value) => { if (current) setDinoOverlay(value); })
      .catch((error) => { if (current) setDinoOverlayError(error instanceof Error ? error.message : "DINO overlay could not be loaded"); })
      .finally(() => { if (current) setDinoOverlayLoading(false); });
    return () => { current = false; };
  }, [dinoOverlay, minerEvidence?.families.dinov3, source, sourceItemId, token, visible.dino]);

  return <div className="space-y-4">
    <GpuMinerSavedPanel evidence={minerEvidence} error={minerError} dinoOverlay={dinoOverlay} dinoLoading={dinoOverlayLoading} dinoVisible={visible.dino} onToggleDino={() => toggle("dino")} />
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold uppercase text-zinc-700">Version image · source coordinates</h2>
      <p className="mt-1 text-xs text-zinc-500">Package and Label geometry from this version; no generated CV projection is mixed in.</p>
      <div className="mt-3 flex flex-wrap gap-3">{(["scope", "object", "label", "dino"] as const).map((key) => <OverlayCheckbox key={key} label={{ scope: "Package scope", object: "Object context", label: "Label ROI", dino: dinoOverlayLoading ? "DINO boundaries · loading" : dinoOverlay ? `DINO boundaries · ${dinoOverlay.gridWidth}×${dinoOverlay.gridHeight}` : "DINO feature boundaries" }[key]} checked={visible[key]} disabled={key === "dino" && !minerEvidence?.families.dinov3} onChange={() => toggle(key)} />)}</div>
      {dinoOverlayError ? <p className="mt-2 text-xs text-rose-700">DINO overlay unavailable: {dinoOverlayError}</p> : null}
      {visible.dino ? <p className="mt-2 text-xs text-indigo-700">Diagnostic feature-boundary heatmap derived from DINO dense patches; it is not a reviewed ROI or segmentation mask.</p> : null}
      {imageUrl ? <div className="mt-3"><ImageWorkspace imageUrl={imageUrl} mode="viewer" draw={drawSource} onImageLoadError={() => setSourceImageError(true)} />{sourceImageError && <p className="mt-2 text-xs text-red-700">Source image could not be loaded.</p>}</div> : <p className="mt-3 text-xs text-zinc-500">Source image is unavailable.</p>}
    </section>

    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold uppercase text-zinc-700">1 Package · 2 Label ROI · 3 Object context</h2>
      <div className="mt-3 space-y-3">{graph.packages.map((packageItem, index) => <div key={packageItem.id} className="rounded border border-zinc-200 bg-zinc-50 p-3 text-xs">
        <div className="font-semibold">Package #{index + 1} · {packageItem.packageType.value} · {packageItem.status}</div>
        <div className="mt-1 text-zinc-600">Scope: {packageItem.scope.source} · Object context: {packageItem.objectContext.status}</div>
        <div className="mt-2 space-y-2">{packageItem.labels.map((label, labelIndex) => <div key={label.id} className="rounded border border-zinc-200 bg-white p-2">
          <div className="font-semibold">Label #{labelIndex + 1} · {label.visualRegionKind.value} · {label.status}</div>
          <div className="mt-1 text-zinc-600">ROI: {label.geometryReviewStatus} · Rectification: {label.rectification?.type ?? "none"} · Crop: {String(record(label.cv.crop)?.transformMode ?? "unavailable")}</div>
        </div>)}</div>
      </div>)}{graph.packages.length === 0 && <p className="text-xs text-zinc-500">No Packages in this version.</p>}</div>
    </section>

    {labels.map((label, index) => <LabelVersionSection key={label.id} label={label} index={index} sourceImageUrl={imageUrl} visible={visible} toggle={toggle} />)}

    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <h2 className="text-sm font-semibold uppercase text-zinc-700">11 Summary · item metadata</h2>
      <div className="mt-2 grid gap-2 text-xs text-zinc-600 sm:grid-cols-3"><span>Packages: {graph.packages.length}</span><span>Labels: {labels.length}</span><span>Export ready: {graph.validation.readyForCanonicalExport ? "yes" : "no"}</span><span>Identity conflicts: {graph.validation.unresolvedIdentityConflicts}</span><span>Parent suggestions: {graph.validation.suggestedParentRelations}</span><span>Operations: {graph.operations.length}</span></div>
      <div className="mt-3 space-y-1 text-xs">{graph.meta.map((meta) => <div key={meta.id} className="rounded bg-zinc-50 p-2"><strong>{meta.tags.join(", ") || "untagged"}</strong>{meta.note ? ` · ${meta.note}` : ""}</div>)}{graph.meta.length === 0 && <p className="text-zinc-500">No item tags or notes.</p>}</div>
      {graph.operations.length > 0 && <details className="mt-3 rounded border border-zinc-200 p-2 text-xs"><summary className="cursor-pointer font-semibold text-zinc-700">Reviewed operations · {graph.operations.length}</summary><div className="mt-2 max-h-56 space-y-1 overflow-auto">{graph.operations.map((operation) => <div key={operation.id} className="rounded bg-zinc-50 p-2">{operation.operationType} · {operation.helper.id} · {operation.reviewMode} · {operation.status}</div>)}</div></details>}
    </section>
  </div>;
}

function GpuMinerSavedPanel({ evidence, error, dinoOverlay, dinoLoading, dinoVisible, onToggleDino }: { evidence: GpuMinerEvidenceContext | null; error: string | null; dinoOverlay: DinoDenseOverlay | null; dinoLoading: boolean; dinoVisible: boolean; onToggleDino: () => void }) {
  const dino = evidence?.families.dinov3;
  const siglip = evidence?.families.siglip2;
  const available = [dino, siglip].filter(Boolean).length;
  return <section className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="text-sm font-semibold uppercase text-indigo-950">External GPU evidence</h2><p className="mt-1 text-xs text-indigo-800">Item-level DINOv3 / SigLIP2 evidence used as advisory context; embeddings remain outside PostgreSQL.</p></div>
      <span className="rounded bg-indigo-100 px-2 py-1 text-xs font-semibold text-indigo-900">{available}/2 imported</span>
    </div>
    {error ? <p className="mt-3 rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">{error}</p> : null}
    {!error && !evidence ? <p className="mt-3 text-xs text-indigo-700">Loading GPU evidence…</p> : null}
    {evidence ? <>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {dino ? <SavedMinerCard title="DINOv3" value={dino} detail={savedDenseSummary(dino.features)} visual={<DinoBoundaryPreview overlay={dinoOverlay} loading={dinoLoading} visible={dinoVisible} onToggle={onToggleDino} />} /> : <SavedMinerMissing title="DINOv3" />}
        {siglip ? <SavedMinerCard title="SigLIP2" value={siglip} detail={savedSimilaritySummary(siglip.features, siglip.metrics)} visual={<SiglipSimilarityGauge value={similarityValue(siglip.features, siglip.metrics)} />} /> : <SavedMinerMissing title="SigLIP2" />}
      </div>
      <details className="mt-3 rounded border border-indigo-200 bg-white p-2 text-xs"><summary className="cursor-pointer font-semibold text-indigo-900">Raw imported evidence</summary><RawJsonBlock value={evidence} containerClassName="mt-2" className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[10px] leading-4 text-zinc-100" /></details>
    </> : null}
  </section>;
}

function SavedMinerCard({ title, value, detail, visual }: { title: string; value: NonNullable<GpuMinerEvidenceContext["families"]["dinov3"]>; detail: string; visual?: ReactNode }) {
  return <div className={`rounded border p-3 text-xs ${value.status === "completed" ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}>
    <div className="flex items-center justify-between gap-2"><strong>{title}</strong><span className="font-semibold uppercase">{value.status}</span></div>
    {visual}
    <div className="mt-2">{detail}</div>
    <div className="mt-1 break-all text-zinc-600">{value.model.id ?? "unknown model"}@{value.model.revision ?? "unknown revision"}</div>
    <div className="mt-1 text-zinc-500">run {value.runId} · {value.artifactsAvailable ? "artifacts linked" : "metadata only"}</div>
    <div className="mt-1 break-all text-zinc-500">image {value.imageHash ?? "hash unavailable"}</div>
    {value.error ? <div className="mt-2 text-rose-700">{String(value.error.message ?? "Miner extraction failed")}</div> : null}
  </div>;
}
function SavedMinerMissing({ title }: { title: string }) { return <div className="rounded border border-dashed border-zinc-300 bg-white p-3 text-xs text-zinc-500"><strong className="block text-zinc-700">{title}</strong>Not imported for this item.</div>; }
function savedDenseSummary(features: Record<string, unknown>) { const shape = Array.isArray(features.denseShape) ? features.denseShape.join("×") : "none"; return `dense ${shape} · embedding ${String(features.embeddingDim ?? "—")} · grid ${String(features.gridWidth ?? "—")}×${String(features.gridHeight ?? "—")}`; }
function savedSimilaritySummary(features: Record<string, unknown>, metrics: Record<string, unknown>) { const raw = similarityValue(features, metrics); return raw !== null ? `image ↔ catalog similarity ${raw.toFixed(4)}` : "image ↔ catalog similarity unavailable"; }
function similarityValue(features: Record<string, unknown>, metrics: Record<string, unknown>) { const raw = Number(features.imageTextSimilarity ?? metrics.imageTextSimilarity); return Number.isFinite(raw) ? raw : null; }

function DinoBoundaryPreview({ overlay, loading, visible, onToggle }: { overlay: DinoDenseOverlay | null; loading: boolean; visible: boolean; onToggle: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !overlay) return;
    canvas.width = overlay.gridWidth;
    canvas.height = overlay.gridHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const pixels = ctx.createImageData(canvas.width, canvas.height);
    overlay.values.forEach((value, index) => { const [red, green, blue, alpha] = dinoHeatColor(value, false); const offset = index * 4; pixels.data[offset] = red; pixels.data[offset + 1] = green; pixels.data[offset + 2] = blue; pixels.data[offset + 3] = alpha; });
    ctx.putImageData(pixels, 0, 0);
  }, [overlay]);
  return <div className="mt-3 rounded border border-indigo-200 bg-white p-2">
    {overlay ? <canvas ref={canvasRef} className="h-28 w-full rounded bg-zinc-950 [image-rendering:pixelated]" aria-label="DINO feature-boundary heatmap" /> : <div className="flex h-28 items-center justify-center rounded border border-dashed border-indigo-200 bg-indigo-50 text-[11px] text-indigo-800">{loading ? "Building DINO heatmap…" : "Dense heatmap is loaded on demand"}</div>}
    <div className="mt-2 h-2 rounded bg-gradient-to-r from-amber-100 via-orange-400 to-red-600" />
    <div className="mt-1 flex justify-between text-[9px] uppercase text-zinc-500"><span>similar patches</span><span>feature boundary</span></div>
    <button type="button" disabled={loading} onClick={onToggle} className="mt-2 h-8 w-full rounded border border-indigo-300 bg-indigo-50 text-[11px] font-semibold text-indigo-900 disabled:opacity-50">{loading ? "Loading…" : visible ? "Hide on source image" : overlay ? "Show on source image" : "Load and show heatmap"}</button>
  </div>;
}

function SiglipSimilarityGauge({ value }: { value: number | null }) {
  const bounded = value === null ? 0 : Math.max(-1, Math.min(1, value));
  const position = 50 + bounded * 50;
  return <div className="mt-3 rounded border border-violet-200 bg-white p-3">
    <div className="flex items-end justify-between gap-3"><span className="text-[10px] font-semibold uppercase text-violet-900">Image ↔ catalog</span><strong className="font-mono text-lg text-violet-950">{value === null ? "—" : value.toFixed(4)}</strong></div>
    <div className="relative mt-3 h-3 rounded-full bg-gradient-to-r from-rose-400 via-zinc-200 to-emerald-500">
      <span className="absolute -top-1 h-5 w-px bg-zinc-600" style={{ left: "50%" }} />
      {value !== null ? <span className="absolute -top-1.5 h-6 w-2 -translate-x-1/2 rounded bg-violet-700 ring-2 ring-white" style={{ left: `${position}%` }} /> : null}
    </div>
    <div className="mt-1 flex justify-between text-[9px] text-zinc-500"><span>-1</span><span>0</span><span>+1</span></div>
    <p className="mt-2 text-[10px] leading-4 text-zinc-600">Raw embedding similarity, not probability. Compare values only within the same model and run.</p>
  </div>;
}

function LabelVersionSection({ label, index, sourceImageUrl, visible, toggle }: { label: Label; index: number; sourceImageUrl: string | null; visible: Record<OverlayKey, boolean>; toggle: (key: OverlayKey) => void }) {
  const [cropImageError, setCropImageError] = useState(false);
  const [coordinateMode, setCoordinateMode] = useState<"run-space" | "source-crop">("run-space");
  const crop = record(label.cv.crop);
  const cropPath = typeof crop?.assetPath === "string" ? crop.assetPath : null;
  const cropUrl = cropPath ? assetUrl(cropPath) : null;
  const job = record(label.cv.job);
  const preview = record(job?.preview);
  const artifactPath = typeof record(job?.debugArtifact)?.assetPath === "string" ? String(record(job?.debugArtifact)?.assetPath) : null;
  const [artifactState, setArtifactState] = useState<{ path: string; layers: unknown[]; error: string | null } | null>(null);
  useEffect(() => {
    if (!artifactPath) return;
    let cancelled = false;
    void fetch(assetUrl(artifactPath)).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const artifact = await response.json() as { layers?: unknown[] };
      if (!cancelled) setArtifactState({ path: artifactPath, layers: list(artifact.layers), error: null });
    }).catch((error) => { if (!cancelled) setArtifactState({ path: artifactPath, layers: [], error: error instanceof Error ? error.message : "Failed to load mask artifact" }); });
    return () => { cancelled = true; };
  }, [artifactPath]);
  const components = list(preview?.components);
  const elements = list(preview?.elements);
  const contours = list(preview?.contours);
  const palette = list(job?.palette).length ? list(job?.palette) : list(preview?.palette);
  const workflow = record(job?.workflow);
  const checkpoints = record(workflow?.checkpoints);
  const inlineDebugLayers = list(record(record(record(preview?.cvDebug)?.label)?.debug)?.layers);
  const debugLayers = inlineDebugLayers.length ? inlineDebugLayers : artifactState?.path === artifactPath ? artifactState.layers : [];
  const rawMask = decodeSavedVersionMask(debugLayers.find((layer) => record(layer)?.id === "raw-mask"));
  const morphologyMask = decodeSavedVersionMask(debugLayers.find((layer) => record(layer)?.id === "morphology-mask"));
  const sourceCropSize = useCallback((hostWidth: number) => {
    const width = Math.max(1, Math.min(hostWidth, label.geometry.bbox.width));
    return { width: Math.round(width), height: Math.max(1, Math.round(width * label.geometry.bbox.height / Math.max(1, label.geometry.bbox.width))) };
  }, [label.geometry.bbox.height, label.geometry.bbox.width]);
  const drawCrop = ({ canvas, image }: { canvas: HTMLCanvasElement; image: HTMLImageElement }) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (coordinateMode === "source-crop") {
      const bbox = label.geometry.bbox;
      ctx.drawImage(image, bbox.x, bbox.y, bbox.width, bbox.height, 0, 0, canvas.width, canvas.height);
    } else {
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (visible.mask && rawMask) drawMaskOverlay(ctx, rawMask, canvas, [6, 182, 212]);
      if (visible.morphology && morphologyMask) drawMaskOverlay(ctx, morphologyMask, canvas, [37, 99, 235]);
    }
    const project = coordinateMode === "source-crop" ? (point: { x: number; y: number }) => projectRectifiedPointToSourceCrop(label, point) : undefined;
    if (visible.ocr) label.ocr.filter((region) => region.coordinateSpace.type === "label-rectified").forEach((region, regionIndex) => drawNormalizedGeometry(ctx, region.geometry, canvas, region.regionStatus === "rejected" ? "#ef4444" : "#0ea5e9", `T${regionIndex + 1}`, project));
    if (visible.components) components.forEach((component, componentIndex) => drawNormalizedBox(ctx, record(component)?.bbox, canvas, "#10b981", `C${componentIndex + 1}`, project));
    if (visible.elements) elements.forEach((element, elementIndex) => drawNormalizedBox(ctx, record(element)?.bbox, canvas, "#a855f7", `E${elementIndex + 1}`, project));
    if (visible.contours) contours.forEach((contour) => drawNormalizedContour(ctx, record(contour)?.points, canvas, project));
  };
  const runRectification = label.rectification?.type ?? "none";
  const runTransformMode = String(crop?.transformMode ?? "unknown");
  const viewerImageUrl = coordinateMode === "source-crop" ? sourceImageUrl : cropUrl;
  const ocrCoordinateSpace = label.ocr.map((region) => region.coordinateSpace).find((space) => space.type === "label-rectified");
  const ocrCropRevision = ocrCoordinateSpace?.type === "label-rectified" ? ocrCoordinateSpace.cropRevision : null;
  const inconsistentRunSpace = label.rectification !== null && runTransformMode === "source-bbox";
  const selectCoordinateMode = (mode: "run-space" | "source-crop") => { setCropImageError(false); setCoordinateMode(mode); };
  return <section className="rounded-lg border border-sky-200 bg-white p-4">
    <h2 className="text-sm font-semibold uppercase text-sky-900">Label #{index + 1} · 4–10 OCR and CV</h2>
    <p className="mt-1 text-xs text-zinc-500">OCR ROI space: <strong>label-rectified</strong> · crop revision {ocrCropRevision ?? "?"} · run correction {runRectification} · saved crop {runTransformMode}.</p>
    <div className="mt-3 inline-flex rounded border border-sky-200 bg-sky-50 p-1 text-xs" aria-label="OCR coordinate-space preview">
      <button type="button" onClick={() => selectCoordinateMode("run-space")} className={`rounded px-3 py-1.5 font-medium ${coordinateMode === "run-space" ? "bg-sky-700 text-white" : "text-sky-900"}`}>Run space · {runRectification === "none" ? "no correction" : "correction applied"}</button>
      <button type="button" disabled={!sourceImageUrl} onClick={() => selectCoordinateMode("source-crop")} className={`rounded px-3 py-1.5 font-medium disabled:opacity-40 ${coordinateMode === "source-crop" ? "bg-sky-700 text-white" : "text-sky-900"}`}>Original crop · projected boxes</button>
    </div>
    <p className="mt-2 text-xs text-sky-800">{coordinateMode === "run-space" ? "Persisted input coordinate system used by the OCR/CV run." : "OCR and vector CV geometry is projected back to the uncorrected source bbox. Binary Mask and Morphology remain available only in Run space."}</p>
    {inconsistentRunSpace && <p className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">Saved crop is marked source-bbox while the Label has {runRectification} correction. Treat this version as stale or inconsistent before reviewing OCR geometry.</p>}
    {artifactPath && artifactState?.path !== artifactPath && <p className="mt-2 text-xs text-sky-700">Loading saved Mask and Morphology raster layers...</p>}
    {artifactState?.path === artifactPath && artifactState.error && <p className="mt-2 text-xs text-amber-700">Mask artifact unavailable: {artifactState.error}</p>}
    <div className="mt-3 flex flex-wrap gap-3">{(["ocr", "mask", "morphology", "components", "elements", "contours"] as const).map((key) => <OverlayCheckbox key={key} label={{ ocr: `OCR (${label.ocr.length})`, mask: `Binary Mask${rawMask ? "" : artifactPath && artifactState?.path !== artifactPath ? " · loading" : " · unavailable"}`, morphology: `Morphology${morphologyMask ? "" : artifactPath && artifactState?.path !== artifactPath ? " · loading" : " · unavailable"}`, components: `Components (${components.length})`, elements: `Elements (${elements.length})`, contours: `Contours (${contours.length})` }[key]} checked={visible[key]} disabled={key === "mask" && (!rawMask || coordinateMode === "source-crop") || key === "morphology" && (!morphologyMask || coordinateMode === "source-crop")} onChange={() => toggle(key)} />)}</div>
    {viewerImageUrl ? <div className="mt-3"><ImageWorkspace imageUrl={viewerImageUrl} mode="viewer" draw={drawCrop} getCanvasSize={coordinateMode === "source-crop" ? sourceCropSize : undefined} onImageLoadError={() => setCropImageError(true)} />{cropImageError && <p className="mt-2 text-xs text-red-700">{coordinateMode === "source-crop" ? "Source image" : "Saved crop"} could not be loaded.</p>}</div> : <p className="mt-3 rounded border border-dashed p-3 text-xs text-zinc-500">{coordinateMode === "source-crop" ? "Source image" : "Saved label crop"} is unavailable; overlays remain listed below.</p>}
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div><h3 className="text-xs font-semibold uppercase text-zinc-600">OCR regions · {label.ocr.length}</h3><div className="mt-2 max-h-64 space-y-1 overflow-auto">{label.ocr.map((region) => <div key={region.id} className="rounded border border-zinc-200 p-2 text-xs"><strong>{region.transcription.text || "—"}</strong><span className="ml-2 text-zinc-500">{region.regionStatus} / {region.transcription.status} · {region.layout.type}/{region.layout.flow} · {region.coordinateSpace.type}</span></div>)}{label.ocr.length === 0 && <p className="text-xs text-zinc-500">No OCR regions.</p>}</div>{label.ocrCompositions?.length ? <div className="mt-2 text-xs text-zinc-600">Compositions: {label.ocrCompositions.map((composition) => composition.text || "—").join(" · ")}</div> : null}</div>
      <div><h3 className="text-xs font-semibold uppercase text-zinc-600">Palette · {palette.length} colors</h3><div className="mt-2 flex flex-wrap gap-2">{palette.map((value, colorIndex) => { const rgb = record(value)?.rgb; return Array.isArray(rgb) && rgb.length === 3 && rgb.every((channel) => typeof channel === "number") ? <span key={colorIndex} title={`rgb(${rgb.join(", ")})`} className="h-8 w-8 rounded border border-zinc-300" style={{ backgroundColor: `rgb(${rgb.join(",")})` }} /> : null; })}{palette.length === 0 && <p className="text-xs text-zinc-500">No saved palette.</p>}</div>
        <div className="mt-3 text-xs text-zinc-600">{components.length} Components · {elements.length} Elements · {contours.length} Contours</div>
      </div>
    </div>
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div><h3 className="text-xs font-semibold uppercase text-zinc-600">Components · {components.length}</h3><div className="mt-2 max-h-40 space-y-1 overflow-auto">{components.map((value, componentIndex) => { const component = record(value); return <div key={String(component?.id ?? componentIndex)} className="rounded border border-zinc-200 p-2 text-xs">C{String(component?.id ?? componentIndex + 1)} · {String(component?.reviewStatus ?? (component?.accepted ? "accepted" : "unreviewed"))} · area {String(component?.areaRatio ?? "—")}</div>; })}{components.length === 0 && <p className="text-xs text-zinc-500">No saved Components.</p>}</div></div>
      <div><h3 className="text-xs font-semibold uppercase text-zinc-600">Elements · {elements.length}</h3><div className="mt-2 max-h-40 space-y-1 overflow-auto">{elements.map((value, elementIndex) => { const element = record(value); return <div key={String(element?.id ?? elementIndex)} className="rounded border border-zinc-200 p-2 text-xs">{String(element?.type ?? "unknown")} · {String(element?.role ?? "untyped")} · {String(element?.status ?? "unreviewed")}{typeof element?.text === "string" ? ` · ${element.text}` : ""}</div>; })}{elements.length === 0 && <p className="text-xs text-zinc-500">No saved Elements.</p>}</div></div>
    </div>
    <div className="mt-3 text-xs text-zinc-600">Contours: {contours.length} traced rings; {contours.filter((value) => record(value)?.vectorization === "bezier").length} Bezier.</div>
    <div className="mt-4"><h3 className="text-xs font-semibold uppercase text-zinc-600">Wizard CV checkpoints</h3><div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{CV_STAGES.map((stage) => { const checkpoint = record(checkpoints?.[stage]); const execution = record(checkpoint?.execution); return <div key={stage} className="rounded border border-zinc-200 bg-zinc-50 p-2 text-xs"><div className="flex justify-between gap-2 font-semibold"><span className="capitalize">{stage}</span><span className={checkpoint?.status === "valid" ? "text-emerald-700" : checkpoint?.status === "stale" ? "text-amber-700" : "text-zinc-400"}>{String(checkpoint?.status ?? "not saved")}</span></div>{execution && <details className="mt-2"><summary className="cursor-pointer text-zinc-600">Reviewed parameters / output</summary><RawJsonBlock value={{ params: execution.finalParams, output: execution.reviewedOutput }} containerClassName="mt-1" className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[10px] leading-4 text-zinc-100" /></details>}</div>; })}</div></div>
    {label.meta.length > 0 && <div className="mt-4 text-xs text-zinc-600">Label metadata: {label.meta.map((meta) => meta.tags.join(", ") || meta.note).join(" · ")}</div>}
  </section>;
}

function OverlayCheckbox({ label, checked, disabled = false, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: () => void }) { return <label className={`flex items-center gap-1.5 text-xs ${disabled ? "text-zinc-400" : "text-zinc-700"}`}><input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />{label}</label>; }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function assetUrl(path: string) { return `/api/admin/assets/${path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`; }
function drawGeometry(ctx: CanvasRenderingContext2D, geometry: AnnotationRegionGeometry | null, image: HTMLImageElement, canvas: HTMLCanvasElement, color: string, label: string) { if (!geometry) return; drawPath(ctx, geometry.points.map((point) => ({ x: point.x * canvas.width / image.naturalWidth, y: point.y * canvas.height / image.naturalHeight })), color, label); }
function drawNormalizedGeometry(ctx: CanvasRenderingContext2D, geometry: AnnotationRegionGeometry, canvas: HTMLCanvasElement, color: string, label: string, project?: PointProjection) { drawPath(ctx, geometry.points.map((point) => { const value = project?.(point) ?? point; return { x: value.x * canvas.width, y: value.y * canvas.height }; }), color, label); }
function drawNormalizedBox(ctx: CanvasRenderingContext2D, value: unknown, canvas: HTMLCanvasElement, color: string, label: string, project?: PointProjection) { const box = record(value); if (!box || ![box.x, box.y, box.width, box.height].every((number) => typeof number === "number" && Number.isFinite(number))) return; const points = [{ x: Number(box.x), y: Number(box.y) }, { x: Number(box.x) + Number(box.width), y: Number(box.y) }, { x: Number(box.x) + Number(box.width), y: Number(box.y) + Number(box.height) }, { x: Number(box.x), y: Number(box.y) + Number(box.height) }].map((point) => project?.(point) ?? point); drawPath(ctx, points.map((point) => ({ x: point.x * canvas.width, y: point.y * canvas.height })), color, label); }
function drawNormalizedContour(ctx: CanvasRenderingContext2D, value: unknown, canvas: HTMLCanvasElement, project?: PointProjection) { if (!Array.isArray(value)) return; const points = value.filter((item): item is [number, number] => Array.isArray(item) && item.length === 2 && item.every((number) => typeof number === "number" && Number.isFinite(number))).map(([x, y]) => project?.({ x, y }) ?? { x, y }).map(({ x, y }) => ({ x: x * canvas.width, y: y * canvas.height })); drawPath(ctx, points, "#f97316", ""); }
type PointProjection = (point: { x: number; y: number }) => { x: number; y: number };
function projectRectifiedPointToSourceCrop(label: Label, point: { x: number; y: number }) {
  const bbox = label.geometry.bbox;
  const corners = label.geometry.points.map((corner) => ({ x: (corner.x - bbox.x) / Math.max(1, bbox.width), y: (corner.y - bbox.y) / Math.max(1, bbox.height) }));
  const corrected = mapSavedRectificationPoint(label, point.x, point.y);
  return mapQuadUnitPoint(corners, corrected.x, corrected.y);
}
function mapSavedRectificationPoint(label: Label, u: number, v: number) {
  if (label.rectification?.type !== "guided-cylindrical") return { x: u, y: v };
  const rows = label.rectification.transform.rows;
  const columns = label.rectification.transform.columns;
  if (!rows.length || !columns.length) return { x: u, y: v };
  let top = rows[0]!, bottom = rows[rows.length - 1]!;
  for (let index = 0; index < rows.length - 1; index += 1) {
    if (v >= rows[index]!.v && v <= rows[index + 1]!.v) { top = rows[index]!; bottom = rows[index + 1]!; break; }
  }
  const mix = top === bottom ? 0 : (v - top.v) / Math.max(1e-6, bottom.v - top.v);
  const a = savedGuidePoint(top.points, columns, u), b = savedGuidePoint(bottom.points, columns, u);
  return { x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix };
}
function savedGuidePoint(points: Array<{ x: number; y: number }>, columns: number[], u: number) {
  const found = columns.findIndex((column) => column >= u);
  if (found <= 0) return points[0] ?? { x: u, y: 0 };
  const index = Math.min(points.length - 2, found - 1);
  const left = points[index], right = points[index + 1];
  if (!left || !right) return points.at(-1) ?? { x: u, y: 0 };
  const mix = (u - columns[index]!) / Math.max(1e-6, columns[index + 1]! - columns[index]!);
  return { x: left.x + (right.x - left.x) * mix, y: left.y + (right.y - left.y) * mix };
}
function drawPath(ctx: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>, color: string, label: string) { if (points.length < 2) return; ctx.save(); ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2; ctx.setLineDash([5, 3]); ctx.beginPath(); ctx.moveTo(points[0]!.x, points[0]!.y); points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y)); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]); if (label) { ctx.font = "bold 12px sans-serif"; ctx.fillText(label, points[0]!.x + 3, Math.max(12, points[0]!.y - 3)); } ctx.restore(); }
function drawMaskOverlay(ctx: CanvasRenderingContext2D, mask: SavedVersionMask, canvas: HTMLCanvasElement, color: [number, number, number]) {
  const layer = document.createElement("canvas");
  layer.width = mask.width; layer.height = mask.height;
  const layerCtx = layer.getContext("2d");
  if (!layerCtx) return;
  const pixels = layerCtx.createImageData(mask.width, mask.height);
  mask.values.forEach((value, index) => { if (!value) return; const offset = index * 4; pixels.data[offset] = color[0]; pixels.data[offset + 1] = color[1]; pixels.data[offset + 2] = color[2]; pixels.data[offset + 3] = 96; });
  layerCtx.putImageData(pixels, 0, 0);
  ctx.drawImage(layer, 0, 0, canvas.width, canvas.height);
}

function drawDinoDenseOverlay(ctx: CanvasRenderingContext2D, overlay: DinoDenseOverlay, image: HTMLImageElement, canvas: HTMLCanvasElement) {
  if (overlay.values.length !== overlay.gridWidth * overlay.gridHeight) return;
  const layer = document.createElement("canvas");
  layer.width = overlay.gridWidth;
  layer.height = overlay.gridHeight;
  const layerCtx = layer.getContext("2d");
  if (!layerCtx) return;
  const pixels = layerCtx.createImageData(layer.width, layer.height);
  overlay.values.forEach((raw, index) => {
    const [red, green, blue, alpha] = dinoHeatColor(raw, true);
    const offset = index * 4;
    pixels.data[offset] = red;
    pixels.data[offset + 1] = green;
    pixels.data[offset + 2] = blue;
    pixels.data[offset + 3] = alpha;
  });
  layerCtx.putImageData(pixels, 0, 0);

  const transform = record(overlay.sourceToInputTransform);
  const scaleX = positiveNumber(transform?.scaleX) ?? (overlay.inputWidth ? overlay.inputWidth / image.naturalWidth : 1);
  const scaleY = positiveNumber(transform?.scaleY) ?? (overlay.inputHeight ? overlay.inputHeight / image.naturalHeight : 1);
  const offsetX = finiteNumber(transform?.offsetX) ?? 0;
  const offsetY = finiteNumber(transform?.offsetY) ?? 0;
  const sourceX = -offsetX / scaleX;
  const sourceY = -offsetY / scaleY;
  const sourceWidth = (overlay.inputWidth ?? image.naturalWidth * scaleX) / scaleX;
  const sourceHeight = (overlay.inputHeight ?? image.naturalHeight * scaleY) / scaleY;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(layer, sourceX * canvas.width / image.naturalWidth, sourceY * canvas.height / image.naturalHeight, sourceWidth * canvas.width / image.naturalWidth, sourceHeight * canvas.height / image.naturalHeight);
  ctx.restore();
}

function dinoHeatColor(raw: number, transparentLow: boolean): [number, number, number, number] {
  const value = Math.max(0, Math.min(255, raw));
  const ratio = value / 255;
  return [
    Math.round(255 - ratio * 35),
    Math.round(230 - ratio * 210),
    Math.round(120 - ratio * 100),
    transparentLow ? value < 20 ? 0 : Math.round(Math.min(155, value * 0.65)) : 255,
  ];
}

function finiteNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function positiveNumber(value: unknown) { const result = finiteNumber(value); return result !== null && result > 0 ? result : null; }
