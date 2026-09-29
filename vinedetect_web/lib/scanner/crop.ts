import type { Rect } from "./types";

export function getGuideRoi(videoWidth: number, videoHeight: number): Rect {
  const width = videoWidth * 0.68;
  const height = videoHeight * 0.34;

  return {
    x: (videoWidth - width) / 2,
    y: videoHeight * 0.34,
    width,
    height,
  };
}

export function projectRectToObjectCover(
  rect: Rect,
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number
): Rect {
  const scale = Math.max(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const offsetX = (viewportWidth - renderedWidth) / 2;
  const offsetY = (viewportHeight - renderedHeight) / 2;

  return {
    x: rect.x * scale + offsetX,
    y: rect.y * scale + offsetY,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

export function drawVideoFrameToCanvas(video: HTMLVideoElement) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is not available");

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function cropCanvas(source: HTMLCanvasElement, roi: Rect) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(roi.width);
  canvas.height = Math.round(roi.height);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context is not available");

  ctx.drawImage(source, roi.x, roi.y, roi.width, roi.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/jpeg",
  quality = 0.9
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Failed to convert canvas to blob"));
          return;
        }
        resolve(blob);
      },
      type,
      quality
    );
  });
}
