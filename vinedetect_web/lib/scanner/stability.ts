import type { FrameAnalysis } from "./types";
import { clamp01 } from "./qualityMetrics";

export type StabilityState = {
  lastAnalysis: FrameAnalysis | null;
  stableMs: number;
};

export function createStabilityState(): StabilityState {
  return {
    lastAnalysis: null,
    stableMs: 0,
  };
}

export function updateStability(
  state: StabilityState,
  analysis: FrameAnalysis,
  now: number
) {
  const previous = state.lastAnalysis;

  if (!previous) {
    state.lastAnalysis = analysis;
    state.stableMs = 0;
    return 0;
  }

  const delta =
    Math.abs(previous.sharpness - analysis.sharpness) +
    Math.abs(previous.brightness - analysis.brightness) +
    Math.abs(previous.textDensity - analysis.textDensity);
  const elapsed = Math.max(0, now - previous.timestamp);

  state.stableMs = delta < 0.18 ? state.stableMs + elapsed : 0;
  state.lastAnalysis = analysis;

  return clamp01(state.stableMs / 900);
}
