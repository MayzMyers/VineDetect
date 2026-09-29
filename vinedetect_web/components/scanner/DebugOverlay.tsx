"use client";
import type { WineCandidate } from "@/lib/catalog/types";
import type { OcrResult } from "@/lib/ocr/tesseract";
import type { FrameAnalysis, ScannerState } from "@/lib/scanner/types";

export type LastScanDebug = {
  startedAt: string;
  durationMs: number;
  lookupStatus: "pending" | "ok" | "error" | "skipped" | "deduplicated";
  lookupError?: string;
  bootstrapVersion?: string;
  localCandidateCount?: number;
  catalogSignals?: string[];
  accumulatedTokenMatches: string[];
  query: string;
  keywords: string[];
  ocrFrameSize: number;
  ocrFramePreviewUrl: string;
  ocr: OcrResult;
  candidates: WineCandidate[];
  quality: FrameAnalysis;
};

type Props = {
  enabled: boolean;
  state: ScannerState;
  analysis: FrameAnalysis | null;
  lastScan: LastScanDebug | null;
  error?: string | null;
  session: {
    id: string;
    candidateId: string | null;
    jobId: string | null;
    jobStatus: string | null;
    jobStage: string | null;
    accumulationStable: boolean;
  };
  poll: {
    attempts: number;
    consecutiveFailures: number;
    lastAttemptAt: string | null;
    lastError: string | null;
    status: string;
  } | null;
};

export function DebugOverlay({ enabled, state, analysis, lastScan, error, session, poll }: Props) {
  if (!enabled) return null;

  return (
    <aside className="fixed left-3 top-3 z-[60] max-h-[72dvh] w-[min(92vw,420px)] overflow-auto rounded-xl bg-black/80 p-4 font-mono text-xs text-white shadow-2xl backdrop-blur lg:static lg:h-[min(94dvh,58rem)] lg:max-h-none lg:w-[min(42rem,46vw)] lg:shrink-0 lg:rounded-[2rem]">
      <section>
        <div className="mb-1 font-sans text-xs font-semibold uppercase text-white/60">Live frame</div>
        <div>state: {state}</div>
        {error && <div className="text-red-300">flowError: {error}</div>}
        {analysis && (
          <>
            <div>sharpness: {analysis.sharpness.toFixed(2)}</div>
            <div>brightness: {analysis.brightness.toFixed(2)}</div>
            <div>contrast: {analysis.contrast.toFixed(2)}</div>
            <div>textDensity: {analysis.textDensity.toFixed(2)}</div>
            <div>stability: {analysis.stability.toFixed(2)}</div>
            <div>readiness: {analysis.captureReadiness.toFixed(2)}</div>
          </>
        )}
      </section>

      <section className="mt-3 border-t border-white/20 pt-3">
        <div className="mb-1 font-sans text-xs font-semibold uppercase text-white/60">Recognition session</div>
        <div className="break-all">session: {session.id}</div>
        <div className="break-all">candidate: {session.candidateId ?? "(none)"}</div>
        <div className="break-all">job: {session.jobId ?? "(none)"}</div>
        <div>jobStatus: {session.jobStatus ?? "(none)"}</div>
        <div>jobStage: {session.jobStage ?? "(none)"}</div>
        <div>accumulationStable: {String(session.accumulationStable)}</div>
        {poll && <>
          <div>poll: {poll.status} · attempts {poll.attempts} · failures {poll.consecutiveFailures}</div>
          <div>pollAt: {poll.lastAttemptAt ?? "(none)"}</div>
          {poll.lastError && <div className="text-amber-300">pollError: {poll.lastError}</div>}
        </>}
      </section>

      {lastScan && (
        <section className="mt-3 border-t border-white/20 pt-3">
          <div className="mb-1 font-sans text-xs font-semibold uppercase text-white/60">Last live scan</div>
          <div>startedAt: {lastScan.startedAt}</div>
          <div>durationMs: {Math.round(lastScan.durationMs)}</div>
          <div>lookup: {lastScan.lookupStatus}</div>
          {lastScan.lookupError && <div>lookupError: {lastScan.lookupError}</div>}
          {lastScan.bootstrapVersion && <div>bootstrap: {lastScan.bootstrapVersion}</div>}
          {lastScan.localCandidateCount !== undefined && (
            <div>localCandidates: {lastScan.localCandidateCount}</div>
          )}
          <div>ocrFrame: {formatBytes(lastScan.ocrFrameSize)} · full camera frame</div>
          <div>ocrConfidence: {Math.round(lastScan.ocr.confidence)}%</div>
          <div className="break-words">keywords: {lastScan.keywords.join(", ") || "(empty)"}</div>
          <div className="break-words text-emerald-300">catalogSignals: {lastScan.catalogSignals?.join(", ") || "(empty)"}</div>
          <div className="break-words text-amber-300">tokenMatchesAccumulated: {lastScan.accumulatedTokenMatches.join(", ") || "(empty)"}</div>
          <div className="mt-1 whitespace-pre-wrap break-words">
            raw: {lastScan.ocr.rawText || "(empty)"}
          </div>
          <div className="mt-1 whitespace-pre-wrap break-words">
            normalized: {lastScan.ocr.normalizedText || "(empty)"}
          </div>
          <div className="mt-1">selectedQuality:</div>
          <div>  sharpness: {lastScan.quality.sharpness.toFixed(2)}</div>
          <div>  textDensity: {lastScan.quality.textDensity.toFixed(2)}</div>
          <div>  readiness: {lastScan.quality.captureReadiness.toFixed(2)}</div>
          <div className="mt-1">candidates: {lastScan.candidates.length}</div>
          {lastScan.candidates.slice(0, 5).map((candidate, index) => (
            <div key={candidate.wineId} className="mt-1 break-words">
              {index + 1}. {Math.round(candidate.score * 100)}% {candidate.title}
            </div>
          ))}
          {lastScan.ocrFramePreviewUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={lastScan.ocrFramePreviewUrl}
              alt="Last full camera frame sent to OCR"
              className="mt-2 max-h-48 w-full rounded border border-white/20 bg-white/5 object-contain"
            />
          )}
        </section>
      )}
    </aside>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
