"use client";

import { useEffect, useRef, useState } from "react";
import type { OcrRectification, QuadGeometry } from "@/lib/admin/api";

export function OcrNormalizedPreview({ imageUrl, geometry, rectification, maxWidth = 360 }: {
  imageUrl: string | null;
  geometry: QuadGeometry | null;
  rectification: OcrRectification | null;
  maxWidth?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageUrl || !geometry) return;
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) return;
      try {
        const bbox = geometry.bbox;
        const sourceX = Math.max(0, Math.min(image.naturalWidth - 1, bbox.x));
        const sourceY = Math.max(0, Math.min(image.naturalHeight - 1, bbox.y));
        const sourceWidth = Math.max(1, Math.min(image.naturalWidth - sourceX, bbox.width));
        const sourceHeight = Math.max(1, Math.min(image.naturalHeight - sourceY, bbox.height));
        const angle = rectification?.type === "rotation" ? rectification.angleDeg * Math.PI / 180 : 0;
        const rotatedWidth = Math.abs(sourceWidth * Math.cos(angle)) + Math.abs(sourceHeight * Math.sin(angle));
        const rotatedHeight = Math.abs(sourceWidth * Math.sin(angle)) + Math.abs(sourceHeight * Math.cos(angle));
        const scale = Math.min(1, maxWidth / Math.max(1, rotatedWidth));
        canvas.width = Math.max(1, Math.round(rotatedWidth * scale));
        canvas.height = Math.max(1, Math.round(rotatedHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.save();
        context.translate(canvas.width / 2, canvas.height / 2);
        context.rotate(angle);
        context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, -sourceWidth * scale / 2, -sourceHeight * scale / 2, sourceWidth * scale, sourceHeight * scale);
        context.restore();
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Preview failed");
      }
    };
    image.onerror = () => { if (!cancelled) setError("Preview image could not be loaded"); };
    image.src = imageUrl;
    return () => { cancelled = true; };
  }, [geometry, imageUrl, maxWidth, rectification]);

  if (!imageUrl || !geometry) return null;
  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 p-2">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase text-zinc-500">
        <span>Normalized OCR preview</span>
        <span>{rectification?.type ?? "crop only"}</span>
      </div>
      {error ? <p className="text-xs text-red-700">{error}</p> : <canvas ref={canvasRef} className="mx-auto block max-h-32 max-w-full rounded bg-white" />}
      {rectification && rectification.type !== "rotation" && <p className="mt-1 text-[10px] text-amber-700">{rectification.type} runtime preview is planned; the persisted contract is already supported.</p>}
    </div>
  );
}
