"use client";

import type { BottleDetectionConfig, LabelSourceAnalysisRun } from "@/lib/admin/api";

export type BottleOverlayState = { verifiedLabel: boolean; background: boolean; foreground: boolean; foregroundClosed: boolean; edges: boolean; rejectedContours: boolean; rawContour: boolean; simplifiedContour: boolean };
export const DEFAULT_BOTTLE_OVERLAYS: BottleOverlayState = { verifiedLabel: true, background: false, foreground: false, foregroundClosed: false, edges: false, rejectedContours: false, rawContour: true, simplifiedContour: true };

type Props = {
  state: LabelSourceAnalysisRun | null | undefined; config: BottleDetectionConfig; overlays: BottleOverlayState; selectedCandidateId: string | null; saving: boolean; eyedropperActive: boolean;
  onConfigChange: (config: BottleDetectionConfig) => void; onOverlayChange: (overlays: BottleOverlayState) => void; onSelectCandidate: (candidateId: string) => void; onRun: () => void | Promise<unknown>;
  onRemoveColor: (index: number) => void; onUndoColor: () => void; canUndoColor: boolean; onToggleEyedropper: () => void; onAccept: () => void | Promise<void>; onSkip: () => void | Promise<void>; onBack: () => void;
};

export function BottleContextStage({ state, config, overlays, selectedCandidateId, saving, eyedropperActive, onConfigChange, onOverlayChange, onSelectCandidate, onRun, onRemoveColor, onUndoColor, canUndoColor, onToggleEyedropper, onAccept, onSkip, onBack }: Props) {
  const detection = state?.bottleDetection;
  const selected = detection?.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? null;
  const palette = detection?.palette ?? [];
  const reviewed = detection?.annotation?.status === "verified";
  const selectedMode = detection?.annotation?.candidateId === selectedCandidateId
    ? detection.annotation.source === "auto-edited" ? "changed" : detection.annotation.source === "manual" ? "manual" : "unchanged"
    : selected ? "unchanged" : null;
  return <div className="space-y-4">
    <section className="rounded-lg border border-violet-200 bg-violet-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div><h3 className="text-sm font-semibold uppercase text-violet-900">Object Context · smart lasso</h3><p className="mt-1 text-xs leading-5 text-violet-800">Flood the border-connected background inside the current Package scope, invert it, then take the largest physical-package component. The reviewed contour is segmentation GT; the Package crop is only helper scope.</p></div>
        <span className="shrink-0 rounded border border-violet-200 bg-white px-2 py-1 text-xs text-violet-800">{reviewed ? "Saved reviewed contour" : selected ? `${Math.round(selected.score * 100)}% preview` : "No candidate"}</span>
      </div>
      <div className="mt-4 grid gap-3">
        <BottleSlider label="Neutral padding" value={config.paddingPercent} min={2} max={20} displayValue={`${config.paddingPercent}%`} onChange={(paddingPercent) => onConfigChange({ ...config, paddingPercent })} disabled={saving} />
        <BottleSlider label="Preview max side" value={config.previewMaxSize} min={256} max={960} step={64} displayValue={`${config.previewMaxSize}px`} onChange={(previewMaxSize) => onConfigChange({ ...config, previewMaxSize })} disabled={saving} />
        <div>
          <BottleSlider label="Background fuzziness (Lab tolerance)" value={config.silhouetteThreshold} min={2} max={80} onChange={(silhouetteThreshold) => onConfigChange({ ...config, silhouetteThreshold })} disabled={saving} />
          <p className="mt-1 text-[11px] leading-4 text-violet-700">Higher values absorb more gray shadows and background gradients. Label selection does not change this Package-level extraction.</p>
        </div>
        <label className="grid gap-1 text-xs font-medium text-violet-900"><span>Connectivity</span><select value={config.connectivity} onChange={(event) => onConfigChange({ ...config, connectivity: Number(event.target.value) as 4 | 8 })} disabled={saving} className="h-9 rounded border border-violet-300 bg-white px-2"><option value={4}>4-neighbour</option><option value={8}>8-neighbour</option></select></label>
        <BottleSlider label="Smooth / simplify" value={config.simplifyTolerance} min={0.5} max={8} step={0.5} displayValue={`${config.simplifyTolerance.toFixed(1)}px`} onChange={(simplifyTolerance) => onConfigChange({ ...config, simplifyTolerance })} disabled={saving} />
      </div>
      <button type="button" onClick={() => void onRun()} disabled={saving} className="mt-4 h-10 w-full rounded bg-violet-900 px-4 text-sm font-semibold text-white disabled:opacity-50">{saving ? "Running..." : "Recalculate outline"}</button>
      {detection?.debug ? <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-violet-800"><span>Padding {detection.debug.padding?.percent ?? config.paddingPercent}%</span><span>{detection.debug.contourCount} external contours</span><span>{detection.debug.processing ? `${detection.debug.processing.mode} ${detection.debug.processing.rasterWidth}×${detection.debug.processing.rasterHeight}` : "preview"}</span><span>{detection.debug.processing ? `${detection.debug.processing.elapsedMs}ms` : ""}</span>{detection.debug.processing?.effectiveSimplifyTolerance ? <span className="col-span-2">Effective full-resolution smoothing: {detection.debug.processing.effectiveSimplifyTolerance}px</span> : null}</div> : null}
    </section>

    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between"><h3 className="text-sm font-semibold uppercase text-zinc-500">Bottle candidates</h3><span className="text-xs text-zinc-500">{detection?.candidates.length ?? 0}</span></div>
      {!detection?.candidates.length ? <p className="mt-3 text-sm text-zinc-500">No reliable contour. Tune the controls or skip this optional stage.</p> : <div className="mt-3 space-y-2">{detection.candidates.map((candidate, index) => <button key={candidate.id} type="button" onClick={() => onSelectCandidate(candidate.id)} className={`w-full rounded border p-3 text-left text-xs ${candidate.id === selectedCandidateId ? "border-violet-700 bg-violet-50" : "border-zinc-200 bg-white hover:bg-zinc-50"}`}>
        <div className="flex items-center justify-between gap-3"><span className="font-semibold">{candidate.id === selectedCandidateId ? "Selected" : "Candidate"} #{index + 1}{candidate.recommended ? " · Recommended" : ""}</span><span className="flex items-center gap-2">{candidate.id === selectedCandidateId ? <span className={`rounded px-2 py-1 text-[10px] font-bold uppercase ${selectedMode === "changed" ? "bg-amber-100 text-amber-800" : selectedMode === "manual" ? "bg-sky-100 text-sky-800" : "bg-emerald-100 text-emerald-800"}`}>{selectedMode}</span> : null}<span className="font-semibold">{Math.round(candidate.score * 100)}%</span></span></div>
        <div className="mt-1 font-mono text-[11px] text-violet-700">{candidate.origin}</div>
        <div className="mt-1 text-zinc-500">label {Math.round(candidate.metrics.labelContainment * 100)}% · edge {Math.round((candidate.metrics.edgeSupport ?? candidate.metrics.foregroundSupport) * 100)}% · area {Math.round(candidate.metrics.areaRatio * 100)}% · {candidate.metrics.contourStatus}</div>
      </button>)}</div>}
    </section>

    <section className="rounded-lg border border-sky-200 bg-sky-50 p-4"><h3 className="text-sm font-semibold uppercase text-sky-900">Overlays</h3><div className="mt-3 grid grid-cols-2 gap-2">{(Object.keys(overlays) as Array<keyof BottleOverlayState>).map((key) => <label key={key} className="flex items-center gap-2 text-xs text-sky-900"><input type="checkbox" checked={overlays[key]} onChange={(event) => onOverlayChange({ ...overlays, [key]: event.target.checked })} />{overlayLabel(key)}</label>)}</div></section>

    {detection ? <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
      <div className="flex items-center justify-between"><h3 className="text-sm font-semibold uppercase text-emerald-900">Bottle palette</h3><span className="text-xs text-emerald-800">{palette.length}</span></div>
      <div className="mt-3 grid gap-2">{palette.map((color, index) => <div key={`${color.rgb.join("-")}:${index}`} className="flex items-center gap-2 rounded border border-emerald-200 bg-white p-2"><span className="h-8 w-8 rounded border" style={{ backgroundColor: `rgb(${color.rgb.join(",")})` }} /><span className="min-w-0 flex-1 font-mono text-[11px]">rgb({color.rgb.join(", ")}) · {color.ratio ? `${Math.round(color.ratio * 100)}%` : "picked"}</span><button type="button" onClick={() => onRemoveColor(index)} className="h-8 w-8 rounded border" title="Remove color">x</button></div>)}</div>
      <div className="mt-3 grid grid-cols-2 gap-2"><button type="button" onClick={onToggleEyedropper} className={`h-9 rounded border text-xs font-semibold ${eyedropperActive ? "border-emerald-900 bg-emerald-900 text-white" : "border-emerald-300 bg-white text-emerald-900"}`}>{eyedropperActive ? "Click the bottle surface" : "Add with eyedropper"}</button><button type="button" onClick={onUndoColor} disabled={!canUndoColor} className="h-9 rounded border border-emerald-300 bg-white text-xs font-semibold text-emerald-900 disabled:opacity-40">Undo delete (Ctrl+Z)</button></div>
    </section> : null}

    <section className="rounded-lg border border-zinc-200 bg-white p-4"><div className="grid grid-cols-2 gap-2"><button type="button" onClick={onBack} className="h-10 rounded border border-zinc-300 text-sm font-medium">Back</button><button type="button" onClick={() => void onSkip()} disabled={saving} className="h-10 rounded border border-amber-300 text-sm font-medium text-amber-800 disabled:opacity-50">Skip</button><button type="button" onClick={() => void onAccept()} disabled={saving || !selected} className="col-span-2 h-10 rounded bg-zinc-950 text-sm font-semibold text-white disabled:opacity-50">Accept displayed contour and continue</button></div><p className="mt-3 text-xs leading-5 text-zinc-500">Stores exactly the displayed Raw contour, Smoothed contour and curated palette. Candidate points are already projected into source-image coordinates; no second flood-fill or color sampling is performed. Bézier fitting is not part of this stage.</p></section>
  </div>;
}

function BottleSlider({ label, value, min, max, step = 1, disabled, displayValue, onChange }: { label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; displayValue?: string; onChange: (value: number) => void }) {
  return <label className="grid gap-1 text-xs font-medium text-violet-900"><span className="flex justify-between gap-3"><span>{label}</span><span>{displayValue ?? value}</span></span><input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function overlayLabel(key: keyof BottleOverlayState) {
  return ({ verifiedLabel: "Selected Label reference", background: "Flooded background", foreground: "Foreground mask", foregroundClosed: "Closed foreground", edges: "Canny fallback", rejectedContours: "Rejected components", rawContour: "Raw contour", simplifiedContour: "Smoothed contour" } satisfies Record<keyof BottleOverlayState, string>)[key];
}
