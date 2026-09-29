"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  value: unknown;
  className?: string;
  containerClassName?: string;
  copyLabel?: string;
};

export function RawJsonBlock({
  value,
  className = "max-h-72 overflow-auto rounded bg-zinc-950 p-3 pr-20 text-xs leading-5 text-zinc-100",
  containerClassName = "mt-3",
  copyLabel = "Copy",
}: Props) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | null>(null);
  const json = serializeJson(value);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  async function copyJson() {
    try {
      await writeClipboard(json);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1800);
  }

  return (
    <div className={`relative ${containerClassName}`}>
      <button
        type="button"
        onClick={() => void copyJson()}
        className="absolute right-2 top-2 z-10 rounded border border-zinc-600 bg-zinc-800 px-2 py-1 text-[10px] font-semibold text-zinc-100 shadow-sm hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-violet-400"
        aria-label={`${copyLabel} JSON to clipboard`}
      >
        {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : copyLabel}
      </button>
      <pre className={className}>{json}</pre>
      <span className="sr-only" role="status" aria-live="polite">
        {copyState === "copied" ? "JSON copied to clipboard" : copyState === "error" ? "Could not copy JSON" : ""}
      </span>
    </div>
  );
}

function serializeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back for browsers that expose Clipboard API but deny it in the
      // current context (for example, a non-secure development origin).
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.select();
    copied = document.execCommand("copy");
  } finally {
    textarea.remove();
  }
  if (!copied) throw new Error("Clipboard API is unavailable");
}
