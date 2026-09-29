"use client";

import { useEffect } from "react";

type ActivityEvent = {
  at: string;
  category: "ui" | "request" | "navigation";
  action: string;
  page: string;
  details?: Record<string, unknown>;
};

const ACTIVITY_ENDPOINT = "/api/dev/activity";
const MAX_TEXT = 120;

export function ClientActivityLogger() {
  useEffect(() => {
    const enabled = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ACTIVITY_LOG_ENABLED === "true";
    if (!enabled) return;

    const originalFetch = window.fetch.bind(window);
    const queue: ActivityEvent[] = [];
    let flushTimer: number | null = null;

    function enqueue(category: ActivityEvent["category"], action: string, details?: Record<string, unknown>) {
      queue.push({ at: new Date().toISOString(), category, action, page: `${location.pathname}${location.search}`, details });
      if (queue.length >= 20) void flush();
      else if (flushTimer === null) flushTimer = window.setTimeout(() => void flush(), 250);
    }

    async function flush() {
      if (flushTimer !== null) window.clearTimeout(flushTimer);
      flushTimer = null;
      if (!queue.length) return;
      const events = queue.splice(0, 100);
      try {
        await originalFetch(ACTIVITY_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events }),
          keepalive: true,
        });
      } catch {
        // Activity logging must never break the UI under inspection.
      }
    }

    function describeTarget(target: EventTarget | null) {
      const element = target instanceof Element ? target.closest("button,a,input,select,textarea,canvas,[role]") : null;
      if (!element) return null;
      const input = element instanceof HTMLInputElement ? element : null;
      const value = input?.type === "range" || input?.type === "number"
        ? input.value
        : element instanceof HTMLSelectElement
          ? element.value
          : undefined;
      const textInput = element instanceof HTMLTextAreaElement
        ? element
        : input && !["range", "number", "checkbox", "radio", "button", "submit"].includes(input.type)
          ? input
          : null;
      return {
        tag: element.tagName.toLowerCase(),
        id: element.id || undefined,
        role: element.getAttribute("role") ?? undefined,
        name: element.getAttribute("name") ?? undefined,
        type: element.getAttribute("type") ?? undefined,
        label: activityLabel(element),
        value,
        checked: input?.type === "checkbox" || input?.type === "radio" ? input.checked : undefined,
        textLength: textInput?.value.length,
      };
    }

    function handleClick(event: MouseEvent) {
      const target = describeTarget(event.target);
      if (target) enqueue("ui", "click", { target, button: event.button });
    }

    function handleChange(event: Event) {
      const target = describeTarget(event.target);
      if (target) enqueue("ui", "change", { target });
    }

    function handleSubmit(event: SubmitEvent) {
      enqueue("ui", "submit", { target: describeTarget(event.submitter ?? event.target) });
    }

    function handlePointer(event: PointerEvent) {
      if (!(event.target instanceof HTMLCanvasElement)) return;
      const rect = event.target.getBoundingClientRect();
      enqueue("ui", event.type, {
        target: describeTarget(event.target),
        pointerType: event.pointerType,
        button: event.button,
        x: rect.width ? Number(((event.clientX - rect.left) / rect.width).toFixed(4)) : null,
        y: rect.height ? Number(((event.clientY - rect.top) / rect.height).toFixed(4)) : null,
      });
    }

    function handleKeydown(event: KeyboardEvent) {
      const loggable = event.ctrlKey || event.metaKey || event.altKey || ["Enter", "Escape", "Delete"].includes(event.key);
      if (!loggable) return;
      enqueue("ui", "keydown", { key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey, target: describeTarget(event.target) });
    }

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes(ACTIVITY_ENDPOINT)) return originalFetch(input, init);
      const method = requestMethod(input, init);
      const startedAt = performance.now();
      enqueue("request", "start", { method, url, body: requestBodySummary(init?.body) });
      try {
        const response = await originalFetch(input, init);
        enqueue("request", "finish", { method, url, status: response.status, ok: response.ok, durationMs: Math.round(performance.now() - startedAt) });
        return response;
      } catch (error) {
        enqueue("request", "error", { method, url, durationMs: Math.round(performance.now() - startedAt), error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };

    document.addEventListener("click", handleClick, true);
    document.addEventListener("change", handleChange, true);
    document.addEventListener("submit", handleSubmit, true);
    document.addEventListener("pointerdown", handlePointer, true);
    document.addEventListener("pointerup", handlePointer, true);
    document.addEventListener("keydown", handleKeydown, true);
    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    history.pushState = (...args) => {
      originalPushState(...args);
      enqueue("navigation", "push-state", { url: `${location.pathname}${location.search}` });
    };
    history.replaceState = (...args) => {
      originalReplaceState(...args);
      enqueue("navigation", "replace-state", { url: `${location.pathname}${location.search}` });
    };
    const handlePopState = () => enqueue("navigation", "popstate", { url: `${location.pathname}${location.search}` });
    window.addEventListener("popstate", handlePopState);
    const handleVisibility = () => { if (document.visibilityState === "hidden") void flush(); };
    document.addEventListener("visibilitychange", handleVisibility);
    enqueue("navigation", "page-ready", { url: `${location.pathname}${location.search}` });

    return () => {
      window.fetch = originalFetch;
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("change", handleChange, true);
      document.removeEventListener("submit", handleSubmit, true);
      document.removeEventListener("pointerdown", handlePointer, true);
      document.removeEventListener("pointerup", handlePointer, true);
      document.removeEventListener("keydown", handleKeydown, true);
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
      window.removeEventListener("popstate", handlePopState);
      document.removeEventListener("visibilitychange", handleVisibility);
      void flush();
    };
  }, []);

  return null;
}

function activityLabel(element: Element) {
  const aria = element.getAttribute("aria-label")?.trim();
  if (aria) return aria.slice(0, MAX_TEXT);
  const title = element.getAttribute("title")?.trim();
  if (title) return title.slice(0, MAX_TEXT);
  if (element instanceof HTMLInputElement) return element.labels?.[0]?.textContent?.trim().slice(0, MAX_TEXT);
  return element.textContent?.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) || undefined;
}

function requestUrl(input: RequestInfo | URL) {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    const url = new URL(raw, location.origin);
    return `${url.pathname}${url.search}`;
  } catch {
    return raw.slice(0, 500);
  }
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function requestBodySummary(body: BodyInit | null | undefined): unknown {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") {
    try {
      return redactSensitive(JSON.parse(body) as unknown);
    } catch {
      return { kind: "text", length: body.length, preview: body.slice(0, 500) };
    }
  }
  if (body instanceof URLSearchParams) return redactSensitive(Object.fromEntries(body.entries()));
  if (body instanceof FormData) {
    return {
      kind: "form-data",
      fields: [...body.entries()].map(([key, value]) => ({
        key,
        value: value instanceof File ? { file: value.name, size: value.size, type: value.type } : isSensitiveKey(key) ? "[redacted]" : value.slice(0, 500),
      })),
    };
  }
  if (body instanceof Blob) return { kind: "blob", size: body.size, type: body.type };
  if (body instanceof ArrayBuffer) return { kind: "array-buffer", size: body.byteLength };
  if (ArrayBuffer.isView(body)) return { kind: "typed-array", size: body.byteLength };
  return { kind: body.constructor?.name ?? "body" };
}

function redactSensitive(value: unknown, key = ""): unknown {
  if (isSensitiveKey(key)) return "[redacted]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactSensitive(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([childKey, childValue]) => [childKey, redactSensitive(childValue, childKey)]));
  }
  return typeof value === "string" && value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
}

function isSensitiveKey(key: string) {
  return /password|passwd|token|authorization|secret|cookie/i.test(key);
}
