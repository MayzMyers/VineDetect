import type { RecognitionUIState } from "./recognitionFlow";

export type ScannerState = RecognitionUIState;

export type ScannerHint =
  | "move_closer"
  | "hold_still"
  | "too_dark"
  | "too_bright"
  | "label_found"
  | "ready";

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FrameAnalysis = {
  timestamp: number;
  sharpness: number;
  brightness: number;
  contrast: number;
  textDensity: number;
  stability: number;
  captureReadiness: number;
  hints: ScannerHint[];
  roi: Rect;
};

export type FrameCandidate = {
  timestamp: number;
  fullFrameBlob: Blob;
  labelCropBlob: Blob;
  analysis: FrameAnalysis;
};
