"use client";

import { useRef, useState } from "react";
import { useRecognitionSession } from "@/lib/scanner/useRecognitionSession";
import { DebugOverlay } from "./DebugOverlay";
import { RecognitionSheet } from "./RecognitionSheet";
import { ScannerHints } from "./ScannerHints";
import { ScannerOverlay } from "./ScannerOverlay";

export function ScannerPage({ debug = false }: { debug?: boolean }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const {
    videoRef, flow, analysis, displayRoi, candidates, suggestions,
    isLoadingSuggestions, bestFrameUrl, ocrAccumulationStartedAt, lastScan,
    pollDebug,
    confirmCandidate, requestMoreSuggestions, reset, refine, selectAlternative,
    cameraStatus, cameraError, retryCamera,
    introVisible, dismissIntro, capturePhoto, recognizePhoto,
  } = useRecognitionSession();
  const cameraUnavailable = cameraStatus === "error" && !flow.ocrAccumulationStable;
  const choosePhoto = () => fileInputRef.current?.click();
  const showHint = ["exploring", "guidance", "error"].includes(flow.uiState);
  const viewportLocked = flow.ocrAccumulationStable && ["stabilizing", "processing"].includes(flow.uiState);

  return (
    <main className="grid min-h-dvh place-items-center bg-[#eee5d8] text-[#251813]">
      <input ref={fileInputRef} type="file" accept="image/*" aria-label="Выбрать фотографию вина" className="sr-only" onChange={(event) => {
        const photo = event.target.files?.[0];
        event.target.value = "";
        if (photo) void recognizePhoto(photo);
      }} />
      <div className="flex w-full items-center justify-center gap-5 lg:max-w-[78rem] lg:px-5">
      <section className="relative h-dvh w-full max-w-[32rem] overflow-hidden bg-[#241713] text-white shadow-[0_30px_90px_rgba(56,30,18,.28)] sm:h-[min(94dvh,58rem)] sm:rounded-[2.25rem]">
        <video
          ref={videoRef}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 ${cameraUnavailable ? "invisible opacity-0" : "opacity-100"}`}
          playsInline
          muted
          autoPlay
        />

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/40" />

        {introVisible && (
          <IntroCurtain onDismiss={dismissIntro} onUpload={choosePhoto} />
        )}

        {cameraUnavailable && (
          <CameraUnavailable error={cameraError} onRetry={() => void retryCamera()} onUpload={choosePhoto} />
        )}

        {!cameraUnavailable && <ScannerOverlay state={flow.uiState} analysis={analysis} displayRoi={displayRoi} />}

        {!cameraUnavailable && viewportLocked && (
          <div className="absolute inset-x-0 top-0 z-[19] bg-black/20 backdrop-blur-md" style={{ bottom: "min(55dvh, 31rem)" }}>
            <button type="button" onClick={reset} className="absolute bottom-4 right-4 flex items-center gap-2 rounded-full border border-white/20 bg-[#36231d]/80 px-4 py-3 text-sm font-semibold text-white shadow-xl backdrop-blur-xl transition active:scale-[.98]">
              <span className="text-xl leading-none" aria-hidden="true">↻</span>
              Начать заново
            </button>
          </div>
        )}

        {!cameraUnavailable && showHint && flow.uiState !== "initializing" && (
          <div className="absolute inset-x-5 bottom-28 z-20">
            <ScannerHints state={flow.uiState} analysis={analysis} jobStage={flow.jobStage} error={flow.error} />
          </div>
        )}

        {!cameraUnavailable && !introVisible && !flow.ocrAccumulationStable && (
          <div className="absolute inset-x-5 bottom-6 z-30 flex gap-3">
            <button type="button" onClick={() => void capturePhoto()} disabled={cameraStatus !== "ready"} className="flex-1 rounded-2xl bg-[#9d3036] px-5 py-4 text-sm font-semibold text-white shadow-lg disabled:opacity-50">Распознать вино</button>
            <button type="button" onClick={choosePhoto} className="rounded-2xl border border-white/30 bg-[#36231d]/80 px-5 py-4 text-sm font-semibold text-white backdrop-blur-xl">Выбрать фото</button>
          </div>
        )}

        {!cameraUnavailable && <RecognitionSheet
          state={flow.uiState}
          flow={flow}
          candidates={candidates}
          suggestions={suggestions}
          bestFrameUrl={bestFrameUrl}
          ocrAccumulationStartedAt={ocrAccumulationStartedAt}
          isLoadingSuggestions={isLoadingSuggestions}
          onConfirmCandidate={confirmCandidate}
          onRequestSuggestions={requestMoreSuggestions}
          onReset={reset}
          onRefine={refine}
          onSelectAlternative={selectAlternative}
        />}

      </section>
      <DebugOverlay
        enabled={debug}
        analysis={analysis}
        lastScan={lastScan}
        state={flow.uiState}
        error={flow.error}
        session={{
          id: flow.session.id,
          candidateId: flow.candidateId,
          jobId: flow.jobId,
          jobStatus: flow.jobStatus,
          jobStage: flow.jobStage,
          accumulationStable: flow.ocrAccumulationStable,
        }}
        poll={pollDebug}
      />
      </div>
    </main>
  );
}

function CameraUnavailable({ error, onRetry, onUpload }: { error: string | null; onRetry: () => void; onUpload: () => void }) {
  const copy = error === "CAMERA_PERMISSION_DENIED"
    ? ["Нет доступа к камере", "Разрешите доступ к камере в настройках браузера и попробуйте снова."]
    : error === "CAMERA_NOT_FOUND"
      ? ["Камера не найдена", "Подключите камеру или откройте сканер на телефоне."]
      : error === "CAMERA_IN_USE"
        ? ["Камера занята", "Закройте другое приложение, использующее камеру, и повторите попытку."]
        : ["Камера недоступна", "Проверьте подключение и разрешение на использование камеры."];

  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-[#f5ede2] px-8 text-center text-[#251813]">
      <div className="max-w-[22rem]">
        <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-[#eee1d3] text-4xl text-[#8f2f34]" aria-hidden="true">◎</div>
        <h1 className="font-display mt-7 text-3xl leading-tight">{copy[0]}</h1>
        <p className="mt-3 text-base leading-6 text-[#6f625b]">{copy[1]}</p>
        <button type="button" onClick={onRetry} className="mt-8 w-full rounded-2xl bg-[#9d3036] px-6 py-4 font-medium text-white shadow-lg transition hover:bg-[#86272c] active:scale-[.99]">
          Попробовать снова
        </button>
        <button type="button" onClick={onUpload} className="mt-3 w-full rounded-2xl border border-[#d9cdbf] px-6 py-4 font-medium text-[#8f2f34]">Выбрать фото</button>
      </div>
    </div>
  );
}

function IntroCurtain({ onDismiss, onUpload }: { onDismiss: () => void; onUpload: () => void }) {
  const pointerStart = useRef<number | null>(null);
  const [leaving, setLeaving] = useState(false);

  function dismiss() {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(onDismiss, 420);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Открыть камеру"
      className={`absolute inset-0 z-40 grid cursor-pointer place-items-center overflow-hidden bg-[#2b1b15]/55 backdrop-blur-2xl ${leaving ? "scanner-intro-leave" : "scanner-intro-enter"}`}
      onClick={dismiss}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") dismiss(); }}
      onPointerDown={(event) => { pointerStart.current = event.clientY; }}
      onPointerUp={(event) => {
        if (pointerStart.current !== null && pointerStart.current - event.clientY > 34) dismiss();
        pointerStart.current = null;
      }}
      onPointerCancel={() => { pointerStart.current = null; }}
    >
      <div className="max-w-[19rem] px-6 text-center">
        <div className="mx-auto grid h-20 w-20 place-items-center rounded-full border border-white/20 bg-white/10">
          <CameraIcon />
        </div>
        <h1 className="font-display mt-7 text-3xl leading-tight">Наведите камеру<br />на этикетку вина</h1>
        <div className="mt-10 space-y-4 text-left text-sm text-white/80">
          <p>◎ &nbsp;Нажмите «Распознать вино»</p>
          <p>◇ &nbsp;Или выберите готовое фото</p>
          <p>ϟ &nbsp;Результат появится в карточке</p>
          <button type="button" className="mt-4 w-full rounded-2xl border border-white/30 px-4 py-3 text-center font-semibold" onClick={(event) => { event.stopPropagation(); onUpload(); }}>Выбрать фото</button>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] text-center">
        <span className="mx-auto block h-1.5 w-20 rounded-full bg-white/90 shadow" />
        <span className="mt-3 block text-xs text-white/65">Коснитесь экрана или смахните вверх</span>
      </div>
    </div>
  );
}

function CameraIcon() {
  return <svg viewBox="0 0 32 32" className="h-10 w-10 text-white" aria-hidden="true"><path d="M10.5 9.5 12 6.8h8l1.5 2.7H25a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-10a3 3 0 0 1 3-3h3.5Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><circle cx="16" cy="17" r="5" fill="none" stroke="currentColor" strokeWidth="1.6"/></svg>;
}
