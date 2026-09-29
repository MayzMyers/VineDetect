"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

type Position = { x: number; y: number };
type DragState = { pointerId: number; offsetX: number; offsetY: number };

export function MovableViewerDock({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [floating, setFloating] = useState(false);
  const [position, setPosition] = useState<Position>({ x: 16, y: 72 });
  const [width, setWidth] = useState(720);

  useEffect(() => {
    if (!floating) return;
    const keepInViewport = () => {
      setWidth((current) => Math.min(current, Math.max(320, window.innerWidth - 24)));
      setPosition((current) => clampPosition(current, rootRef.current));
    };
    window.addEventListener("resize", keepInViewport);
    return () => window.removeEventListener("resize", keepInViewport);
  }, [floating]);

  function enableFloating() {
    const rect = rootRef.current?.getBoundingClientRect();
    const nextWidth = Math.min(Math.max(360, rect?.width ?? 720), Math.max(360, window.innerWidth - 24));
    setWidth(nextWidth);
    setPosition(clampPosition({ x: rect?.left ?? 16, y: Math.max(12, rect?.top ?? 72) }, rootRef.current, nextWidth));
    setFloating(true);
  }

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!floating || (event.target as HTMLElement).closest("button")) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
  }

  function drag(event: ReactPointerEvent<HTMLDivElement>) {
    const state = dragRef.current;
    if (!floating || !state || state.pointerId !== event.pointerId) return;
    setPosition(clampPosition({ x: event.clientX - state.offsetX, y: event.clientY - state.offsetY }, rootRef.current, width));
  }

  function stopDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div
      ref={rootRef}
      className={`${floating ? "fixed z-50 flex max-h-[calc(100vh-24px)] flex-col overflow-hidden rounded-lg border border-zinc-300 bg-white shadow-2xl" : "relative"} ${className}`}
      style={floating ? { left: position.x, top: position.y, width } : undefined}
    >
      <div
        onPointerDown={startDrag}
        onPointerMove={drag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        className={`mb-2 flex h-9 shrink-0 items-center justify-between rounded border border-zinc-200 bg-zinc-50 px-3 text-xs ${floating ? "cursor-move select-none" : ""}`}
      >
        <span className="font-semibold uppercase tracking-wide text-zinc-500">{title}</span>
        <button
          type="button"
          onClick={() => floating ? setFloating(false) : enableFloating()}
          className="h-7 rounded border border-zinc-300 bg-white px-2 font-medium text-zinc-700 hover:bg-zinc-100"
        >
          {floating ? "Dock viewer" : "Float viewer"}
        </button>
      </div>
      <div className={floating ? "min-h-0 overflow-auto p-2" : ""}>{children}</div>
    </div>
  );
}

function clampPosition(position: Position, element: HTMLDivElement | null, forcedWidth?: number): Position {
  if (typeof window === "undefined") return position;
  const width = forcedWidth ?? element?.offsetWidth ?? 720;
  const height = Math.min(element?.offsetHeight ?? 600, window.innerHeight - 24);
  return {
    x: Math.max(12, Math.min(window.innerWidth - width - 12, position.x)),
    y: Math.max(12, Math.min(window.innerHeight - Math.min(48, height) - 12, position.y)),
  };
}
