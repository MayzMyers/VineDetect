import type { WineCandidate } from "../catalog/types.ts";
import type { OcrResult } from "../ocr/tesseract.ts";
import type { FrameAnalysis } from "./types.ts";

export type RecognitionUIState =
  | "initializing"
  | "exploring"
  | "reading"
  | "hypothesis"
  | "stabilizing"
  | "processing"
  | "resolved"
  | "ambiguous"
  | "guidance"
  | "error";

export type RecognitionGuidance = {
  type: "label_top" | "label_bottom" | "label_left" | "label_right" | "closer" | "steadier";
  message?: string;
};

export type RecognitionAlternative = {
  source: string;
  sourceItemId: string;
  product: RecognitionProduct;
  confidence: number;
};

export const CAMERA_CONFIG = {
  frameAnalysisIntervalMs: 260,
  ocrSampleIntervalMs: 900,
  candidateScoreThreshold: 0.5,
  stabilityWindowMs: 2_600,
  minimumStableObservations: 3,
  minimumTokenSimilarity: 0.72,
  pollIntervalMs: 500,
  jobStartGraceMs: 4_000,
  jobCreateTimeoutMs: 8_000,
  jobTimeoutMs: 30_000,
  // The BFF may spend up to 8-10 seconds enriching a completed job with
  // catalog details. Keep the client request deadline above that boundary.
  pollRequestTimeoutMs: 12_000,
} as const;

export const OCR_ACCUMULATION_WINDOW_MS = 2_000;

export type CameraSession = {
  id: string;
  startedAt: number;
  activeCandidateId?: string;
  activeJobId?: string;
};

export type FrameObservation = {
  id: string;
  timestamp: number;
  image: Blob;
  ocr: OcrResult;
  normalizedTokens: string[];
  tagMatches: WineCandidate[];
  quality: Pick<FrameAnalysis, "sharpness" | "brightness" | "contrast" | "captureReadiness">;
  semanticScore: number;
};

export type RecognitionProduct = {
  id: number | string;
  catalogKey: string;
  slug: string;
  title: string;
  producer: string | null;
  image: string | null;
  category: string | null;
  region: string | null;
  vintage: number | null;
  description: string | null;
  dishes?: RecognitionDish[];
};

export type RecognitionDish = {
  name: string;
  image: string | null;
  alt: string | null;
};

export type RecognitionJobSnapshot = {
  jobId: string;
  sessionId: string;
  status: "queued" | "processing" | "completed" | "failed";
  stage: string;
  outcome?: "match" | "no_match" | "ambiguous" | "need_more_data" | null;
  recognition?: { confidence: number; alternatives?: RecognitionAlternative[] };
  product?: RecognitionProduct | null;
  similar?: WineCandidate[];
  alternatives?: RecognitionAlternative[];
  guidance?: RecognitionGuidance | null;
  error?: string | null;
};

export type RecognitionFlowState = {
  session: CameraSession;
  uiState: RecognitionUIState;
  candidateId: string | null;
  normalizedTokens: string[];
  catalogSignals: string[];
  ocrAccumulationStable: boolean;
  jobId: string | null;
  jobStatus: RecognitionJobSnapshot["status"] | null;
  jobStage: string | null;
  recognitionConfidence: number | null;
  outcome: "match" | "no_match" | "ambiguous" | "need_more_data" | null;
  product: RecognitionProduct | null;
  alternatives: RecognitionAlternative[];
  guidance: RecognitionGuidance | null;
  error: string | null;
};

export type RecognitionFlowAction =
  | { type: "CAMERA_STARTING" }
  | { type: "CAMERA_READY" }
  | { type: "CATALOG_SIGNALS_UPDATED"; signals: string[] }
  | { type: "CANDIDATE_FOUND"; candidateId: string; tokens: string[] }
  | { type: "JOB_STARTED"; candidateId: string; jobId: string }
  | { type: "ACCUMULATION_COMPLETED" }
  | { type: "CANDIDATE_STABLE"; candidateId: string }
  | { type: "USER_CONFIRMED"; candidateId: string }
  | { type: "JOB_UPDATED"; candidateId: string; job: RecognitionJobSnapshot }
  | { type: "RESET_FLOW" }
  | { type: "FAILED"; error: string; sessionId?: string; jobId?: string }
  | { type: "RESET"; sessionId: string; startedAt: number };

export function createRecognitionFlowState(sessionId: string, startedAt = Date.now()): RecognitionFlowState {
  return {
    session: { id: sessionId, startedAt },
    uiState: "initializing",
    candidateId: null,
    normalizedTokens: [],
    catalogSignals: [],
    ocrAccumulationStable: false,
    jobId: null,
    jobStatus: null,
    jobStage: null,
    recognitionConfidence: null,
    outcome: null,
    product: null,
    alternatives: [],
    guidance: null,
    error: null,
  };
}

export function recognitionFlowReducer(
  state: RecognitionFlowState,
  action: RecognitionFlowAction,
): RecognitionFlowState {
  switch (action.type) {
    case "CAMERA_STARTING":
      return { ...state, uiState: "initializing", error: null };
    case "CAMERA_READY":
      if (state.ocrAccumulationStable) return { ...state, error: null };
      return {
        ...state,
        uiState: state.candidateId
          ? state.uiState
          : state.catalogSignals.length > 0 ? "reading" : "exploring",
        error: null,
      };
    case "CATALOG_SIGNALS_UPDATED": {
      const catalogSignals = action.signals;
      if (state.candidateId || state.ocrAccumulationStable) return { ...state, catalogSignals };
      return {
        ...state,
        catalogSignals,
        uiState: catalogSignals.length > 0 ? "reading" : "exploring",
      };
    }
    case "CANDIDATE_FOUND": {
      if (state.candidateId === action.candidateId) return state;
      const accumulationLocked = state.ocrAccumulationStable;
      return {
        ...state,
        uiState: accumulationLocked ? "stabilizing" : "reading",
        candidateId: action.candidateId,
        normalizedTokens: action.tokens,
        catalogSignals: state.catalogSignals,
        ocrAccumulationStable: accumulationLocked,
        jobId: null,
        jobStatus: null,
        jobStage: null,
        recognitionConfidence: null,
        outcome: null,
        product: null,
        alternatives: [],
        guidance: null,
        error: null,
        session: { ...state.session, activeCandidateId: action.candidateId, activeJobId: undefined },
      };
    }
    case "JOB_STARTED":
      if (action.candidateId !== state.candidateId) return state;
      return {
        ...state,
        uiState: state.ocrAccumulationStable ? "stabilizing" : state.uiState,
        jobId: action.jobId,
        jobStatus: "queued",
        jobStage: "queued",
        session: { ...state.session, activeJobId: action.jobId },
      };
    case "ACCUMULATION_COMPLETED":
      return {
        ...state,
        ocrAccumulationStable: true,
        uiState: state.jobStatus === "completed"
          ? completedViewState(state.outcome)
          : "stabilizing",
      };
    case "CANDIDATE_STABLE":
    case "USER_CONFIRMED":
      if (action.candidateId !== state.candidateId) return state;
      return {
        ...state,
        ocrAccumulationStable: true,
        uiState: state.jobStatus === "completed"
          ? completedViewState(state.outcome)
          : state.jobId ? "stabilizing" : "reading",
      };
    case "JOB_UPDATED":
      if (
        action.candidateId !== state.candidateId ||
        action.job.jobId !== state.jobId ||
        action.job.sessionId !== state.session.id
      ) return state;
      const outcome = action.job.outcome ?? state.outcome;
      const alternatives = action.job.alternatives ?? action.job.recognition?.alternatives ?? state.alternatives;
      const guidance = action.job.guidance ?? state.guidance;
      const noCatalogMatch = action.job.status === "completed" && outcome === "no_match";
      return {
        ...state,
        jobStatus: action.job.status,
        jobStage: action.job.stage,
        recognitionConfidence: action.job.recognition?.confidence ?? state.recognitionConfidence,
        outcome,
        product: action.job.product ?? state.product,
        alternatives,
        guidance,
        error: action.job.status === "failed" ? "RECOGNITION_FAILED" : noCatalogMatch ? "NO_CATALOG_MATCH" : null,
        uiState: action.job.status === "failed"
          ? "error"
          : noCatalogMatch
            ? "error"
          : action.job.status === "completed" && ["stabilizing", "processing", "ambiguous", "guidance"].includes(state.uiState)
            ? completedViewState(outcome)
            : action.job.status === "processing" && state.uiState === "stabilizing"
              ? "processing"
              : state.uiState,
      };
    case "RESET_FLOW": {
      const next = createRecognitionFlowState(state.session.id, state.session.startedAt);
      return { ...next, uiState: "exploring" };
    }
    case "FAILED":
      if (action.sessionId && action.sessionId !== state.session.id) return state;
      if (action.jobId && action.jobId !== state.jobId) return state;
      return { ...state, uiState: "error", error: action.error };
    case "RESET":
      return createRecognitionFlowState(action.sessionId, action.startedAt);
  }
}

function completedViewState(outcome: RecognitionFlowState["outcome"]): RecognitionUIState {
  if (outcome === "no_match") return "error";
  if (outcome === "ambiguous") return "ambiguous";
  if (outcome === "need_more_data") return "guidance";
  return "resolved";
}

export function evaluateObservation(observation: FrameObservation) {
  const ocrConfidence = clamp(observation.ocr.confidence / 100, 0, 1);
  const tagMatchScore = observation.tagMatches[0]?.score ?? 0;
  const tokenScore = clamp(observation.normalizedTokens.length / 4, 0, 1);
  const sharpness = clamp(observation.quality.sharpness, 0, 1);
  return clamp(
    ocrConfidence * 0.32 + tagMatchScore * 0.34 + tokenScore * 0.18 + sharpness * 0.16,
    0,
    1,
  );
}

export function candidateIdForTokens(tokens: string[]) {
  return tokens.slice(0, 6).join("|");
}

export function observationWindowIsStable(
  observations: FrameObservation[],
  now: number,
  config = CAMERA_CONFIG,
) {
  const window = observations.filter((item) => now - item.timestamp <= config.stabilityWindowMs);
  if (window.length < config.minimumStableObservations) return false;
  const anchor = window[window.length - 1]?.normalizedTokens ?? [];
  const similarity = window.reduce(
    (sum, item) => sum + tokenSetSimilarity(anchor, item.normalizedTokens),
    0,
  ) / window.length;
  return similarity >= config.minimumTokenSimilarity;
}

export function tokenSetSimilarity(left: string[], right: string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of leftSet) if (rightSet.has(token)) intersection += 1;
  return intersection / union.size;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
