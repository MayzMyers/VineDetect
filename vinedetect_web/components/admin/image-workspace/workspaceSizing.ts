import type { WorkspaceCanvasSize } from "./ImageWorkspace";

export function containedCanvasSize(
  hostWidth: number,
  naturalWidth: number,
  naturalHeight: number,
  viewportHeight: number,
): WorkspaceCanvasSize {
  const maxWidth = Math.max(1, Math.floor(hostWidth));
  const maxHeight = Math.max(420, Math.min(820, Math.floor(viewportHeight) - 220));
  const scale = Math.min(
    maxWidth / Math.max(1, naturalWidth),
    maxHeight / Math.max(1, naturalHeight),
  );
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  };
}
