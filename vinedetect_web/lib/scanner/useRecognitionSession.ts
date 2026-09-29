"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WineCandidate } from "@/lib/catalog/types";
import type { LastScanDebug } from "@/components/scanner/DebugOverlay";
import { requestEnvironmentCamera, stopMediaStream } from "./camera";
import { canvasToBlob, drawVideoFrameToCanvas } from "./crop";
import { predictRecognitionImage, RecognitionApiError } from "./recognitionApi";
import { createRecognitionFlowState } from "./recognitionFlow";
import type { FrameAnalysis, Rect } from "./types";

// The final runtime receives one original photo per explicit user action.
// Camera preview and opening this page never start OCR or recognition requests.
export function useRecognitionSession() {
  const [flow, setFlow] = useState(() => createRecognitionFlowState(crypto.randomUUID()));
  const [cameraStatus, setCameraStatus] = useState<"starting" | "ready" | "error">("starting");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [introVisible, setIntroVisible] = useState(true);
  const [bestFrameUrl, setBestFrameUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const previewRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const cameraRequestRef = useRef(0);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const captureRef = useRef(false);

  const startCamera = useCallback(async () => {
    const requestId = ++cameraRequestRef.current;
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    setCameraStatus("starting");
    setCameraError(null);
    try {
      if (!window.isSecureContext) throw new DOMException("Camera requires a secure context", "SecurityError");
      const stream = await requestEnvironmentCamera();
      if (!mountedRef.current || requestId !== cameraRequestRef.current) {
        stopMediaStream(stream);
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) { video.srcObject = stream; await video.play(); }
      if (!mountedRef.current || requestId !== cameraRequestRef.current) {
        stopMediaStream(stream);
        return;
      }
      setCameraStatus("ready");
      setFlow((current) => current.ocrAccumulationStable ? current : { ...current, uiState: "exploring", error: null });
    } catch (error) {
      if (!mountedRef.current || requestId !== cameraRequestRef.current) return;
      setCameraStatus("error");
      setCameraError(cameraErrorCode(error));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const frame = window.requestAnimationFrame(() => { void startCamera(); });
    return () => {
      window.cancelAnimationFrame(frame);
      mountedRef.current = false;
      cameraRequestRef.current += 1;
      requestRef.current += 1;
      abortRef.current?.abort();
      stopMediaStream(streamRef.current);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, [startCamera]);

  const recognizePhoto = useCallback(async (image: Blob) => {
    if (busyRef.current || image.size === 0) return;
    busyRef.current = true;
    const requestId = ++requestRef.current;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const url = URL.createObjectURL(image);
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setBestFrameUrl(url);
    setIntroVisible(false);
    setFlow((current) => ({ ...createRecognitionFlowState(current.session.id), uiState: "processing", ocrAccumulationStable: true, jobStatus: "processing", jobStage: "recognizing" }));
    try {
      const result = await predictRecognitionImage(image, controller.signal);
      if (!mountedRef.current || controller.signal.aborted || requestId !== requestRef.current) return;
      setFlow((current) => ({ ...current, uiState: "resolved", candidateId: result.slug, jobStatus: "completed", jobStage: "completed", outcome: "match", product: result.product, recognitionConfidence: null, error: null }));
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted || requestId !== requestRef.current) return;
      setFlow((current) => ({ ...current, uiState: "error", jobStatus: "failed", error: error instanceof RecognitionApiError ? error.code : "NETWORK_ERROR" }));
    } finally {
      if (requestId === requestRef.current) busyRef.current = false;
    }
  }, []);

  const capturePhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || busyRef.current || captureRef.current) return;
    captureRef.current = true;
    try {
      // One native-size camera frame, encoded once; no crop, resize, OCR or filtering.
      const image = await canvasToBlob(drawVideoFrameToCanvas(video), "image/jpeg", 0.9);
      if (mountedRef.current) await recognizePhoto(image);
    } catch {
      if (mountedRef.current) setFlow((current) => ({ ...current, uiState: "error", ocrAccumulationStable: true, error: "UPLOAD_ERROR" }));
    } finally { captureRef.current = false; }
  }, [recognizePhoto]);

  const reset = useCallback(() => {
    requestRef.current += 1;
    abortRef.current?.abort();
    busyRef.current = false;
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setBestFrameUrl(null);
    setFlow({ ...createRecognitionFlowState(crypto.randomUUID()), uiState: "exploring" });
  }, []);

  return {
    videoRef, flow,
    analysis: null as FrameAnalysis | null,
    displayRoi: null as Rect | null,
    candidates: [] as WineCandidate[], suggestions: [] as WineCandidate[],
    isLoadingSuggestions: false, bestFrameUrl, ocrAccumulationStartedAt: null,
    lastScan: null as LastScanDebug | null, pollDebug: null,
    confirmCandidate: () => {}, requestMoreSuggestions: () => {}, reset,
    refine: () => { void capturePhoto(); }, selectAlternative: () => {},
    cameraStatus, cameraError, retryCamera: startCamera,
    introVisible, dismissIntro: () => setIntroVisible(false),
    capturePhoto, recognizePhoto,
  };
}

function cameraErrorCode(error: unknown) {
  if (!(error instanceof DOMException)) return "CAMERA_ERROR";
  if (error.name === "NotAllowedError" || error.name === "SecurityError") return "CAMERA_PERMISSION_DENIED";
  if (error.name === "NotFoundError" || error.name === "OverconstrainedError") return "CAMERA_NOT_FOUND";
  if (error.name === "NotReadableError" || error.name === "AbortError") return "CAMERA_IN_USE";
  return "CAMERA_ERROR";
}
