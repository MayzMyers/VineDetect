"use client";

import { useEffect, useState } from "react";
import type { FrameAnalysis, ScannerState } from "@/lib/scanner/types";

type Props = { state: ScannerState; analysis: FrameAnalysis | null; jobStage?: string | null; error?: string | null };
type HintMessage = { icon: string; title: string; description: string };

const HINT_DEBOUNCE_MS = 600;

export function ScannerHints({ state, analysis, jobStage, error }: Props) {
  const nextMessage = getHintMessage(state, analysis, jobStage, error);
  const nextIcon = nextMessage.icon;
  const nextTitle = nextMessage.title;
  const nextDescription = nextMessage.description;
  const [message, setMessage] = useState<HintMessage>(() => nextMessage);

  useEffect(() => {
    if (
      nextTitle === message.title &&
      nextDescription === message.description &&
      nextIcon === message.icon
    ) return;

    const timeout = window.setTimeout(
      () => setMessage({ icon: nextIcon, title: nextTitle, description: nextDescription }),
      state === "error" ? 0 : HINT_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [message.description, message.icon, message.title, nextDescription, nextIcon, nextTitle, state]);

  return (
    <div className="scanner-hint-enter flex h-[5.5rem] w-full items-center gap-3 overflow-hidden rounded-[1.4rem] border border-[#eadbcb]/90 bg-[#fbf5eb]/95 px-4 py-3 text-left text-[#281914] shadow-[0_14px_38px_rgba(48,25,17,.24)] backdrop-blur-xl">
      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#9d3036]/10 text-xl text-[#9d3036]" aria-hidden="true">{message.icon}</div>
      <div className="min-w-0 flex-1">
        <div className="font-display truncate text-lg font-medium leading-tight">{message.title}</div>
        <div className="mt-1 line-clamp-2 min-h-10 text-xs leading-5 text-[#705f56]">{message.description}</div>
      </div>
    </div>
  );
}

function getHintMessage(state: ScannerState, analysis: FrameAnalysis | null, jobStage?: string | null, error?: string | null): HintMessage {
  if (state === "error") {
    if (error === "NO_CATALOG_MATCH") return { icon: "↻", title: "Совпадение не найдено", description: "Пересканируйте этикетку целиком." };
    if (error === "SERVER_UNAVAILABLE" || error === "NETWORK_ERROR") return { icon: "!", title: "Не удалось завершить поиск", description: "Проверьте подключение и попробуйте ещё раз." };
    if (error === "RECOGNITION_TIMEOUT") return { icon: "!", title: "Время ожидания истекло", description: "Начните новое сканирование." };
    return {
      icon: "!",
      title: "Сканирование приостановлено",
      description: error === "CAMERA_ERROR" ? "Проверьте доступ к камере." : "Не удалось распознать. Оставьте этикетку в кадре и повторите.",
    };
  }
  if (!analysis) return { icon: "⌖", title: "Наведите камеру на этикетку", description: "Нажмите «Распознать вино» или выберите готовое фото." };
  if (analysis.hints.includes("too_dark")) return { icon: "☼", title: "Нужно больше света", description: "Переместите бутылку в более светлую область." };
  if (analysis.hints.includes("too_bright")) return { icon: "◐", title: "Слишком сильный блик", description: "Немного поверните бутылку или телефон." };
  if (analysis.hints.includes("hold_still")) return { icon: "◎", title: "Кадр размыт", description: "На секунду задержите телефон неподвижно." };
  if (analysis.hints.includes("move_closer")) return { icon: "+", title: "Поднесите ближе", description: "Пусть этикетка занимает большую часть рамки." };
  if (state === "hypothesis") return { icon: "✓", title: "Этикетка найдена", description: "Поиск уже идёт — держите ту же бутылку в кадре." };
  if (state === "stabilizing") return { icon: "✓", title: "Зафиксировано", description: "Выбран лучший кадр этикетки." };
  if (state === "processing") return { icon: "…", title: jobStage === "matching" ? "Ищем совпадение в каталоге" : "Анализируем этикетку", description: "Можно раскрыть карточку и следить за этапами." };
  if (state === "resolved") return { icon: "✓", title: "Распознавание завершено", description: "Результат готов." };
  if (state === "ambiguous") return { icon: "≋", title: "Есть несколько вариантов", description: "Выберите результат в карточке." };
  if (state === "guidance") return { icon: "↻", title: "Нужен другой ракурс", description: "Следуйте подсказке — камера продолжает работать." };
  return { icon: "⌖", title: "Ищем текст этикетки", description: "Покажите этикетку целиком и нажмите «Распознать вино»." };
}
