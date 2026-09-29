"use client";

import { useEffect, useRef, useState } from "react";
import type { WineCandidate } from "@/lib/catalog/types";
import { OCR_ACCUMULATION_WINDOW_MS, type RecognitionFlowState, type RecognitionProduct, type RecognitionUIState } from "@/lib/scanner/recognitionFlow";

type SheetSnapPoint = "peek" | "half" | "expanded";
type Props = {
  state: RecognitionUIState;
  flow: RecognitionFlowState;
  candidates: WineCandidate[];
  suggestions: WineCandidate[];
  bestFrameUrl: string | null;
  ocrAccumulationStartedAt: number | null;
  isLoadingSuggestions: boolean;
  onConfirmCandidate: () => void;
  onRequestSuggestions: () => void;
  onReset: () => void;
  onRefine: () => void;
  onSelectAlternative: (source: string, sourceItemId: string) => void;
};

const STAGES = [
  ["extracting", "Проверяем винтаж"],
  ["retrieving", "Сверяем производителя"],
  ["matching", "Ищем совпадения в базе"],
  ["ranking", "Уточняем вариант"],
] as const;

export function RecognitionSheet(props: Props) {
  const { state, flow, candidates, suggestions, bestFrameUrl, ocrAccumulationStartedAt, isLoadingSuggestions, onConfirmCandidate, onRequestSuggestions, onReset, onRefine, onSelectAlternative } = props;
  const [snapPoint, setSnapPoint] = useState<SheetSnapPoint>(() => defaultSnapPoint(state));
  const dragStart = useRef<number | null>(null);
  const isFinalState = state === "resolved" || state === "ambiguous";

  // Opening the camera does not select a result; show the sheet for an explicit request.
  if (state === "initializing" || state === "exploring") return null;

  const peekHeight = state === "reading" ? "14rem" : "12.5rem";
  const effectiveSnapPoint = state === "reading"
    ? "peek"
    : (state === "stabilizing" || state === "processing") && snapPoint === "peek"
    ? "half"
    : (state === "resolved" || state === "ambiguous") && snapPoint !== "expanded"
      ? "expanded"
      : snapPoint;
  const height = effectiveSnapPoint === "peek" ? peekHeight : effectiveSnapPoint === "half" ? "min(55dvh, 31rem)" : "min(88dvh, 54rem)";
  const provisional = candidates[0];
  const title = state === "reading"
    ? "Считываем этикетку…"
    : state === "stabilizing" || state === "processing"
      ? "Ожидаем результат…"
      : flow.product?.title ?? (state === "hypothesis" ? provisional?.title : null) ?? "Распознаём этикетку";
  const producer = flow.product?.producer ?? (state === "hypothesis" ? provisional?.producer : null);
  const image = state === "stabilizing" || state === "processing"
    ? bestFrameUrl
    : state === "reading" ? null : flow.product?.image ?? (state === "hypothesis" ? provisional?.imageUrl : null) ?? bestFrameUrl;

  function finishDrag(clientY: number) {
    if (dragStart.current === null) return;
    const delta = clientY - dragStart.current;
    dragStart.current = null;
    if (isFinalState && delta > 55) {
      onReset();
      return;
    }
    if (delta < -55) setSnapPoint((current) => current === "peek" ? "half" : "expanded");
    if (delta > 55) setSnapPoint((current) => current === "expanded" ? "half" : "peek");
  }

  return (
    <section className="recognition-sheet-enter absolute inset-x-0 bottom-0 z-20 overflow-hidden rounded-t-[2rem] border-t border-[#dfd2c2] bg-[#fbf5eb]/[.98] text-[#281914] shadow-[0_-22px_70px_rgba(39,19,10,.28)] backdrop-blur-xl transition-[height] duration-500 ease-out" style={{ height }} aria-live="polite">
      <div className="relative touch-none px-5 pb-3 pt-3" onPointerDown={(event) => { dragStart.current = event.clientY; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerUp={(event) => finishDrag(event.clientY)} onPointerCancel={() => { dragStart.current = null; }}>
        <button type="button" aria-label="Изменить размер карточки" className="mx-auto block h-1.5 w-12 rounded-full bg-[#d9cdbf]" onClick={() => setSnapPoint((current) => current === "peek" ? "half" : current === "half" ? "expanded" : "peek")} />
        {isFinalState && (
          <button
            type="button"
            onClick={onReset}
            className="absolute right-4 top-1.5 flex items-center gap-1.5 rounded-full bg-[#efe6da] px-3 py-1.5 text-xs font-semibold text-[#8f3035] shadow-sm transition active:scale-[.97]"
            aria-label="Сканировать следующую бутылку"
          >
            <span className="text-base leading-none" aria-hidden="true">↻</span>
            Следующая
          </button>
        )}
      </div>

      <div className="h-[calc(100%-2rem)] overflow-y-auto px-5 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <header className="flex items-center gap-4">
          <ProductImage src={image} />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-[#9d3036]">{eyebrow(state)}</p>
            <h1 className="font-display mt-1 line-clamp-2 text-[1.65rem] leading-[1.05]">{title}</h1>
            {producer && <p className="mt-2 text-sm text-[#705f56]">{producer}</p>}
          </div>
          {state === "reading" && <AccumulationTimer startedAt={ocrAccumulationStartedAt} />}
          {(state === "hypothesis" || state === "stabilizing" || state === "processing") && <Spinner />}
        </header>

        {state === "reading" && <ReadingBody signals={flow.catalogSignals} />}
        {state === "hypothesis" && <HypothesisBody candidates={candidates} onConfirm={onConfirmCandidate} />}
        {(state === "stabilizing" || state === "processing") && <ProcessingBody stage={flow.jobStage} />}
        {state === "resolved" && <ResultBody product={flow.product} suggestions={suggestions} confidence={flow.recognitionConfidence} noMatch={flow.outcome === "no_match"} onMore={onRequestSuggestions} loading={isLoadingSuggestions} onReset={onReset} />}
        {state === "ambiguous" && (
          <div className="mt-6">
            <h2 className="font-display text-2xl">Мы нашли несколько<br />похожих вариантов</h2>
            <div className="mt-4 space-y-2">{flow.alternatives.map((alternative) => <ProductOption key={`${alternative.source}:${alternative.sourceItemId}`} product={alternative.product} confidence={alternative.confidence} onSelect={() => onSelectAlternative(alternative.source, alternative.sourceItemId)} />)}</div>
            <button type="button" onClick={onReset} className="mt-4 w-full rounded-2xl border border-[#d9cdbf] px-4 py-3 text-sm font-medium">Сканировать заново</button>
          </div>
        )}
        {state === "guidance" && (
          <div className="mt-6 rounded-[1.5rem] bg-[#f2e8da] p-5 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-[#b23a3f]/20 text-3xl text-[#9d3036]">⌖</div>
            <h2 className="font-display mt-4 text-2xl">Нужно больше деталей</h2>
            <p className="mt-2 text-sm leading-6 text-[#705f56]">{flow.guidance?.message ?? guidanceCopy(flow.guidance?.type)}</p>
            <button type="button" onClick={onRefine} className="mt-5 w-full rounded-2xl bg-[#9d3036] px-4 py-3.5 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(157,48,54,.22)]">Проверить новый кадр</button>
          </div>
        )}
        {state === "error" && (
          <RecognitionError error={flow.error} onReset={onReset} />
        )}
      </div>
    </section>
  );
}

function RecognitionError({ error, onReset }: { error: string | null; onReset: () => void }) {
  const copy = error === "NO_CATALOG_MATCH"
    ? ["Не нашли совпадение", "Слова с этикетки считаны, но ни одна карточка каталога не подтвердилась. Наведите камеру на этикетку ещё раз."]
    : error === "SERVER_UNAVAILABLE" || error === "NETWORK_ERROR"
      ? ["Не удалось завершить поиск", "Проверьте подключение и попробуйте пересканировать бутылку ещё раз."]
      : error === "SERVICE_BUSY"
        ? ["Распознавание занято", "Дождитесь завершения текущего запроса и попробуйте снова."]
    : error === "RECOGNITION_TIMEOUT"
        ? ["Ответ не получен", "Распознавание заняло слишком много времени. Начните новое сканирование."]
        : ["Не удалось распознать", "Измените ракурс и покажите этикетку целиком."];
  return (
    <div className="mt-6 rounded-[1.5rem] bg-[#f2e8da] p-5 text-center">
      <div className="mx-auto grid h-14 w-14 place-items-center rounded-full border border-[#b23a3f]/20 text-2xl text-[#9d3036]" aria-hidden="true">↻</div>
      <h2 className="font-display mt-4 text-2xl">{copy[0]}</h2>
      <p className="mt-2 text-sm leading-6 text-[#705f56]">{copy[1]}</p>
      <button type="button" onClick={onReset} className="mt-5 w-full rounded-2xl bg-[#9d3036] px-4 py-3.5 text-sm font-semibold text-white">Пересканировать</button>
    </div>
  );
}

function HypothesisBody({ candidates, onConfirm }: { candidates: WineCandidate[]; onConfirm: () => void }) {
  const tags = candidates[0]?.matchedTags ?? [];
  return <div className="mt-5"><p className="text-sm text-[#705f56]">Ищем точное совпадение…</p>{tags?.length ? <div className="mt-3 flex flex-wrap gap-2">{tags.map((tag) => <span key={tag} className="rounded-full bg-[#efe6da] px-3 py-1.5 text-[11px] font-semibold uppercase">{tag}</span>)}</div> : null}<button type="button" onClick={onConfirm} className="mt-4 w-full rounded-2xl bg-[#9d3036] px-4 py-3 text-sm font-semibold text-white">Открыть карточку</button></div>;
}

function ReadingBody({ signals }: { signals: string[] }) {
  return <div className="mt-4"><p className="text-sm text-[#705f56]">Накапливаем слова с этикетки. Держите камеру ровно…</p><div className="mt-3 flex flex-wrap gap-2">{signals.map((signal, index) => <span key={signal} className="recognition-token-pop rounded-full bg-[#efe6da] px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ animationDelay: `${index * 55}ms` }}>{signal}</span>)}</div></div>;
}

function ProcessingBody({ stage }: { stage: string | null }) {
  const activeIndex = STAGES.findIndex(([id]) => id === stage);
  return <div className="mt-6"><p className="text-sm font-medium">Проверяем этикетку и ищем точное совпадение…</p><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#e1d5c7]"><div className="h-full w-[58%] animate-pulse rounded-full bg-[#9d3036]" /></div>{activeIndex >= 0 && <div className="mt-6 space-y-5">{STAGES.map(([id, label], index) => <div key={id} className={`flex items-center gap-3 text-sm ${index <= activeIndex ? "text-[#7f282d]" : "text-[#a99b90]"}`}><span className={`grid h-6 w-6 place-items-center rounded-full border ${index < activeIndex ? "border-[#9d3036] bg-[#9d3036] text-white" : index === activeIndex ? "border-[#9d3036]" : "border-[#d7cbbd]"}`}>{index < activeIndex ? "✓" : ""}</span>{label}</div>)}</div>}<div className="mt-6 rounded-2xl bg-[#f2e8da] p-4 text-sm leading-6 text-[#705f56]">Снимок готов — бутылку уже можно убрать из кадра.</div></div>;
}

function ResultBody({ product, suggestions, confidence, noMatch, onMore, loading, onReset }: { product: RecognitionProduct | null; suggestions: WineCandidate[]; confidence: number | null; noMatch: boolean; onMore: () => void; loading: boolean; onReset: () => void }) {
  return (
    <div className="mt-6">
      {product && <>
        <div className="flex flex-wrap gap-2">{[product.region, product.category, product.vintage?.toString()].filter(Boolean).map((value) => <span key={value} className="rounded-full bg-[#efe6da] px-3 py-1.5 text-sm">{value}</span>)}</div>
        {product.description && <p className="mt-5 text-[15px] leading-7 text-[#55463f]">{product.description}</p>}
        {product.dishes && product.dishes.length > 0 && <DishPairings dishes={product.dishes} />}
      </>}
      {noMatch && <p className="rounded-2xl bg-[#f2e8da] p-4 text-sm text-[#705f56]">Точного совпадения пока нет. Посмотрите похожие варианты или попробуйте ещё раз.</p>}
      <button type="button" className="mt-5 w-full rounded-2xl bg-[#9d3036] px-4 py-4 text-sm font-semibold text-white">Подробнее о вине&nbsp;&nbsp; →</button>
      <div className="mt-4 grid grid-cols-3 gap-2"><Action icon="♧" label="Сохранить" /><Action icon="☆" label="Оценить" /><Action icon="↗" label="Поделиться" /></div>
      {suggestions.length > 0 && <div className="mt-7 border-t border-[#e5dbcf] pt-5"><div className="flex items-center justify-between"><h2 className="font-display text-2xl">Похожее вино</h2><button type="button" onClick={onMore} disabled={loading} className="text-sm text-[#9d3036]">{loading ? "Ищем…" : "Смотреть все"}</button></div><div className="mt-3 space-y-2">{suggestions.slice(0, 3).map((item) => <CandidateOption key={item.wineId} candidate={item} />)}</div></div>}
      {confidence !== null && <div className="mt-6 rounded-2xl bg-[#f2e8da] p-4 text-sm"><div className="flex justify-between"><span className="text-[#705f56]">Уверенность</span><strong>{Math.round(confidence * 100)}%</strong></div></div>}
      <button type="button" onClick={onReset} className="mt-4 w-full py-3 text-sm font-medium text-[#9d3036]">Сканировать следующую бутылку</button>
    </div>
  );
}

function DishPairings({ dishes }: { dishes: NonNullable<RecognitionProduct["dishes"]> }) {
  return (
    <section className="mt-6 border-t border-[#e5dbcf] pt-5">
      <h2 className="font-display text-2xl">Подойдёт к блюдам</h2>
      <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
        {dishes.map((dish) => (
          <div key={dish.name} className="flex min-w-[8.5rem] items-center gap-2.5 rounded-2xl bg-[#f4ebdf] p-2.5">
            <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-xl bg-[#eadfce] text-xl text-[#9d3036]">
              {dish.image ? <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={dish.image} alt={dish.alt ?? dish.name} className="h-full w-full object-cover" />
              </> : <span aria-hidden="true">♧</span>}
            </div>
            <span className="text-xs font-medium leading-tight text-[#55463f]">{dish.name}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProductImage({ src }: { src?: string | null }) {
  return <div className="relative grid h-20 w-16 shrink-0 place-items-center overflow-hidden rounded-xl bg-[#efe6da] p-1">{src ? <>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={src} alt="" className="block h-full w-full" style={{ objectFit: "contain", objectPosition: "center" }} />
  </> : <WineBottleIcon />}</div>;
}
function WineBottleIcon() { return <svg viewBox="0 0 32 64" className="h-14 w-7 text-[#8f3035]" aria-hidden="true"><path d="M12 3h8v12c0 3 1 5 4 8 3 4 5 8 5 14v21c0 2-2 3-4 3H7c-2 0-4-1-4-3V37c0-6 2-10 5-14 3-3 4-5 4-8V3Z" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M8 33h16v20H8z" fill="currentColor" opacity=".13"/><path d="M12 8h8" stroke="currentColor" strokeWidth="1.8"/></svg>; }
function Spinner() {
  return (
    <span className="relative h-10 w-10 shrink-0" role="status" aria-label="Ожидаем ответ">
      <span className="absolute inset-0 rounded-full border-2 border-[#ddcfc0]" />
      <span className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-r-[#b94a4f] border-t-[#8f292f] motion-reduce:animate-none" />
      <span className="absolute inset-[7px] animate-pulse rounded-full bg-[#9d3036]/10 motion-reduce:animate-none" />
    </span>
  );
}
function AccumulationTimer({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (startedAt === null) return;
    const interval = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  const currentTime = startedAt === null || now < startedAt ? startedAt : now;
  const remainingMs = startedAt === null || currentTime === null
    ? OCR_ACCUMULATION_WINDOW_MS
    : Math.max(0, OCR_ACCUMULATION_WINDOW_MS - (currentTime - startedAt));
  const seconds = (remainingMs / 1000).toFixed(1);
  const progress = startedAt === null ? 0 : 1 - remainingMs / OCR_ACCUMULATION_WINDOW_MS;

  return (
    <div className="relative grid h-12 w-12 shrink-0 place-items-center" aria-label={startedAt === null ? "Собираем детали этикетки" : `Собираем детали: осталось ${seconds} секунды`}>
      <svg viewBox="0 0 40 40" className="absolute inset-0 h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="20" cy="20" r="17" pathLength="100" fill="none" stroke="#ddcfc0" strokeWidth="2.5" />
        <circle
          cx="20"
          cy="20"
          r="17"
          pathLength="100"
          fill="none"
          stroke="#9d3036"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="100"
          strokeDashoffset={100 - progress * 100}
          className="transition-[stroke-dashoffset] duration-100 ease-linear motion-reduce:transition-none"
        />
      </svg>
      <span className="text-[10px] font-semibold tabular-nums text-[#7f282d]">{startedAt === null ? "…" : seconds}</span>
    </div>
  );
}
function Action({ icon, label }: { icon: string; label: string }) { return <button type="button" className="rounded-2xl bg-[#f4ebdf] px-2 py-3 text-center text-[#8e3034]"><span className="block text-xl">{icon}</span><span className="mt-1 block text-[11px]">{label}</span></button>; }
function ProductOption({ product, confidence, onSelect }: { product: RecognitionProduct; confidence: number; onSelect: () => void }) { return <button type="button" onClick={onSelect} className="flex w-full items-center gap-3 rounded-2xl bg-[#f4ebdf] p-3 text-left">{product.image && <ProductImage src={product.image} />}<span className="min-w-0 flex-1"><strong className="font-display block text-lg leading-tight">{product.title}</strong><span className="mt-1 block text-xs text-[#8a786e]">{[product.region, product.vintage].filter(Boolean).join(" · ")}</span></span><span className="rounded-full border border-[#9d3036] px-2 py-1 text-xs font-semibold">{Math.round(confidence * 100)}%</span></button>; }
function CandidateOption({ candidate }: { candidate: WineCandidate }) { return <div className="flex items-center gap-3 rounded-2xl bg-[#f4ebdf] p-3">{candidate.imageUrl && <ProductImage src={candidate.imageUrl} />}<span className="min-w-0 flex-1"><strong className="font-display block truncate text-lg">{candidate.title}</strong><span className="text-xs text-[#8a786e]">{candidate.producer}</span></span><span className="text-2xl text-[#9d3036]">＋</span></div>; }
function eyebrow(state: RecognitionUIState) { if (state === "reading") return "Распознано на этикетке"; if (state === "stabilizing" || state === "processing") return "Кадр зафиксирован"; if (state === "resolved") return "Результат распознавания"; if (state === "ambiguous") return "Несколько совпадений"; if (state === "guidance") return "Нужен другой ракурс"; return "Предварительный результат"; }
function guidanceCopy(type?: string) { return ({ label_top: "Покажите верхнюю часть этикетки", label_bottom: "Покажите нижнюю часть этикетки", label_left: "Поверните бутылку немного вправо", label_right: "Поверните бутылку немного влево", closer: "Поднесите этикетку ближе", steadier: "Задержите камеру неподвижно" } as Record<string, string>)[type ?? ""] ?? "Покажите этикетку целиком"; }

function defaultSnapPoint(state: RecognitionUIState): SheetSnapPoint {
  if (state === "processing" || state === "stabilizing" || state === "guidance") return "half";
  if (state === "resolved" || state === "ambiguous") return "expanded";
  return "peek";
}
