"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { containedCanvasSize } from "./workspaceSizing";

export type WorkspaceCanvasSize = {
  width: number;
  height: number;
};

export type WorkspacePoint = {
  x: number;
  y: number;
};

type WorkspaceContext = {
  canvas: HTMLCanvasElement;
  image: HTMLImageElement;
  size: WorkspaceCanvasSize;
};

type Props = {
  imageUrl: string | null;
  mode?: "viewer" | "annotation" | "roi-editor" | "color-picker" | "pipeline-debug";
  className?: string;
  cursor?: CSSProperties["cursor"];
  allowPointerOverflow?: boolean;
  draw: (context: WorkspaceContext) => void;
  getCanvasSize?: (hostWidth: number, image: HTMLImageElement) => WorkspaceCanvasSize;
  onReady?: (context: WorkspaceContext) => void;
  onImageLoadError?: () => void;
  onPointerDown?: (point: WorkspacePoint, event: PointerEvent<HTMLCanvasElement>, context: WorkspaceContext) => void;
  onPointerMove?: (point: WorkspacePoint, event: PointerEvent<HTMLCanvasElement>, context: WorkspaceContext) => void;
  onPointerUp?: (point: WorkspacePoint | null, event: PointerEvent<HTMLCanvasElement>, context: WorkspaceContext) => void;
  onPointerLeave?: (event: PointerEvent<HTMLCanvasElement>, context: WorkspaceContext) => void;
  onContextMenu?: (point: WorkspacePoint | null, event: MouseEvent<HTMLCanvasElement>, context: WorkspaceContext) => void;
};

const DEFAULT_SIZE: WorkspaceCanvasSize = { width: 1, height: 1 };

export function ImageWorkspace({
  imageUrl,
  className,
  cursor,
  allowPointerOverflow = false,
  draw,
  getCanvasSize = defaultCanvasSize,
  onReady,
  onImageLoadError,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerLeave,
  onContextMenu,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [size, setSize] = useState<WorkspaceCanvasSize>(DEFAULT_SIZE);

  const buildContext = useCallback((): WorkspaceContext | null => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image) return null;
    return { canvas, image, size: { width: canvas.width, height: canvas.height } };
  }, []);

  const syncSizeAndDraw = useCallback(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!host || !canvas || !image) return;

    const nextSize = getCanvasSize(host.clientWidth, image);
    canvas.width = nextSize.width;
    canvas.height = nextSize.height;
    setSize(nextSize);

    const context = { canvas, image, size: nextSize };
    draw(context);
    onReady?.(context);
  }, [draw, getCanvasSize, onReady]);

  useEffect(() => {
    if (!imageUrl || !canvasRef.current) return;

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      imageRef.current = image;
      syncSizeAndDraw();
    };
    image.onerror = () => onImageLoadError?.();
    image.src = imageUrl;
  }, [imageUrl, onImageLoadError, syncSizeAndDraw]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const observer = new ResizeObserver(syncSizeAndDraw);
    observer.observe(host);
    return () => observer.disconnect();
  }, [syncSizeAndDraw]);

  useEffect(() => {
    const context = buildContext();
    if (context) draw(context);
  }, [buildContext, draw, size]);

  function readPoint(event: PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: allowPointerOverflow ? event.clientX - rect.left : Math.max(0, Math.min(canvas.width, event.clientX - rect.left)),
      y: allowPointerOverflow ? event.clientY - rect.top : Math.max(0, Math.min(canvas.height, event.clientY - rect.top)),
    };
  }

  function handlePointerDown(event: PointerEvent<HTMLCanvasElement>) {
    const context = buildContext();
    const point = readPoint(event);
    if (!context || !point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    onPointerDown?.(point, event, context);
  }

  function handlePointerMove(event: PointerEvent<HTMLCanvasElement>) {
    const context = buildContext();
    const point = readPoint(event);
    if (!context || !point) return;
    onPointerMove?.(point, event, context);
  }

  function handlePointerUp(event: PointerEvent<HTMLCanvasElement>) {
    const context = buildContext();
    if (!context) return;
    onPointerUp?.(readPoint(event), event, context);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handlePointerLeave(event: PointerEvent<HTMLCanvasElement>) {
    const context = buildContext();
    if (!context) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) return;
    onPointerLeave?.(event, context);
  }

  function handleContextMenu(event: MouseEvent<HTMLCanvasElement>) {
    const context = buildContext();
    if (!context) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const point = {
      x: Math.max(0, Math.min(canvas.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(canvas.height, event.clientY - rect.top)),
    };
    onContextMenu?.(point, event, context);
  }

  return (
    <div ref={hostRef} className="flex w-full justify-center overflow-hidden">
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onContextMenu={handleContextMenu}
        className={className ?? "rounded border border-zinc-200 bg-zinc-50 touch-none"}
        style={{
          width: `${size.width}px`,
          height: `${size.height}px`,
          maxWidth: "100%",
          cursor,
        }}
      />
    </div>
  );
}

function defaultCanvasSize(hostWidth: number, image: HTMLImageElement) {
  return containedCanvasSize(
    hostWidth,
    image.naturalWidth,
    image.naturalHeight,
    typeof window === "undefined" ? 900 : window.innerHeight,
  );
}
