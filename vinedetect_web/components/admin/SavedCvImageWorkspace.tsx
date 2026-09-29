"use client";

import { useCallback, useMemo, useState } from "react";
import { ImageWorkspace, type WorkspaceCanvasSize } from "./image-workspace/ImageWorkspace";
import {
  drawGeneratedRegionOverlay,
  drawLabelCandidateOverlay,
  extractGeneratedRegions,
  extractLabelTopCandidates,
} from "./image-workspace/cvOverlays";

type Props = {
  imageUrl: string | null;
  cvMeta: unknown;
};

type OverlayVisibility = {
  bottle: boolean;
  label: boolean;
  candidates: boolean;
};

export function SavedCvImageWorkspace({ imageUrl, cvMeta }: Props) {
  const regions = useMemo(() => extractGeneratedRegions(cvMeta), [cvMeta]);
  const candidates = useMemo(() => extractLabelTopCandidates(cvMeta), [cvMeta]);
  const [overlays, setOverlays] = useState<OverlayVisibility>({
    bottle: true,
    label: true,
    candidates: true,
  });

  const draw = useCallback(
    ({ canvas, image }: { canvas: HTMLCanvasElement; image: HTMLImageElement }) => {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

      if (overlays.candidates) {
        for (const candidate of candidates) {
          drawLabelCandidateOverlay(ctx, candidate, image, canvas);
        }
      }

      for (const region of regions) {
        if (region.role === "bottle" && !overlays.bottle) continue;
        if (region.role === "label" && !overlays.label) continue;
        drawGeneratedRegionOverlay(ctx, region, image, canvas);
      }
    },
    [candidates, overlays, regions]
  );

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase text-zinc-500">Saved CV overlays</h2>
        <div className="flex flex-wrap gap-3">
          <OverlayToggle label="Bottle ROI" checked={overlays.bottle} onChange={(checked) => setOverlays((current) => ({ ...current, bottle: checked }))} />
          <OverlayToggle label="Label ROI" checked={overlays.label} onChange={(checked) => setOverlays((current) => ({ ...current, label: checked }))} />
          <OverlayToggle
            label={`Candidates (${candidates.length})`}
            checked={overlays.candidates}
            onChange={(checked) => setOverlays((current) => ({ ...current, candidates: checked }))}
          />
        </div>
      </div>

      <div className="mt-3">
        {imageUrl ? (
          <ImageWorkspace imageUrl={imageUrl} mode="viewer" draw={draw} getCanvasSize={getCanvasSize} />
        ) : (
          <div className="rounded border border-zinc-200 p-4 text-sm text-zinc-500">No image URL</div>
        )}
      </div>
    </section>
  );
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
