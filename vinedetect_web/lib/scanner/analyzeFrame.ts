import { cropCanvas, drawVideoFrameToCanvas, getGuideRoi } from "./crop";
import {
  clamp01,
  estimateBrightness,
  estimateContrast,
  estimateSharpness,
  estimateTextDensity,
} from "./qualityMetrics";
import type { FrameAnalysis, ScannerHint } from "./types";

export function analyzeVideoFrame(video: HTMLVideoElement): FrameAnalysis {
  const fullCanvas = drawVideoFrameToCanvas(video);
  const roi = getGuideRoi(fullCanvas.width, fullCanvas.height);
  const crop = cropCanvas(fullCanvas, roi);
  const ctx = crop.getContext("2d");

  if (!ctx) throw new Error("Canvas 2D context is not available");

  const imageData = ctx.getImageData(0, 0, crop.width, crop.height);
  const sharpness = estimateSharpness(imageData);
  const brightness = estimateBrightness(imageData);
  const contrast = estimateContrast(imageData);
  const textDensity = estimateTextDensity(imageData);
  const hints: ScannerHint[] = [];

  if (brightness < 0.2) hints.push("too_dark");
  if (brightness > 0.94) hints.push("too_bright");
  if (sharpness < 0.36) hints.push("hold_still");
  if (textDensity < 0.24) hints.push("move_closer");
  if (textDensity >= 0.24 && contrast >= 0.18) hints.push("label_found");

  const captureReadiness = clamp01(
    sharpness * 0.32 +
      contrast * 0.2 +
      textDensity * 0.24 +
      scoreBrightness(brightness) * 0.24
  );

  if (captureReadiness > 0.72) hints.push("ready");

  return {
    timestamp: performance.now(),
    sharpness,
    brightness,
    contrast,
    textDensity,
    stability: 0,
    captureReadiness,
    hints,
    roi,
  };
}

function scoreBrightness(value: number) {
  if (value < 0.2 || value > 0.94) return 0;
  if (value < 0.38) return value / 0.38;
  if (value > 0.82) return (0.94 - value) / 0.12;
  return 1;
}
