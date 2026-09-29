"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createLlmWizardBatchJob,
  createRecognitionBatchTargetJob,
  createRecognitionJob,
  deleteRecognitionMetadata,
  estimateRecognitionBatchJob,
  listPipelinePresets,
  listRecognitionInventory,
  type PipelinePresetRecord,
  type RecognitionInventoryItem,
  type SiglipLabelMode,
  type DinoLabelMode,
} from "@/lib/admin/api";
import { getStoredToken } from "@/lib/admin/auth";
import { AdminAuthPanel } from "./AdminAuthPanel";
import { AdminNavLinks } from "./AdminNavLinks";
import {
  parseRecognitionListRouteState,
  recognitionItemHref,
  recognitionListHref,
  recognitionListScrollKey,
  type RecognitionListAnnotationStatus,
  type RecognitionListAutomationMode,
  type RecognitionListExecutionActor,
  type RecognitionListCvMeta,
  type RecognitionListRouteState,
  type RecognitionListSource,
} from "./recognitionListRouteState";
import { formatRecognitionTag, RECOGNITION_LIST_TAGS } from "./recognitionTags";

type PresetScope = "selection" | "source" | "global";

const PAGE_SIZE = 50;

export function AdminRecognitionListPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchParamsKey = searchParams.toString();
  const initialRouteState = parseRecognitionListRouteState(searchParams);
  const [token, setToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [items, setItems] = useState<RecognitionInventoryItem[]>([]);
  const [source, setSource] = useState<RecognitionListSource>(initialRouteState.source);
  const [status, setStatus] = useState(initialRouteState.status);
  const [cvMeta, setCvMeta] = useState<RecognitionListCvMeta>(initialRouteState.cvMeta);
  const [annotationStatus, setAnnotationStatus] = useState<RecognitionListAnnotationStatus>(initialRouteState.annotationStatus);
  const [executionActor, setExecutionActor] = useState<RecognitionListExecutionActor>(initialRouteState.executionActor);
  const [automationMode, setAutomationMode] = useState<RecognitionListAutomationMode>(initialRouteState.automationMode);
  const [recognitionTag, setRecognitionTag] = useState(initialRouteState.recognitionTag);
  const [firstPerInitial, setFirstPerInitial] = useState(initialRouteState.firstPerInitial);
  const [perInitialLimit, setPerInitialLimit] = useState(initialRouteState.perInitialLimit);
  const [query, setQuery] = useState(initialRouteState.query);
  const [offset, setOffset] = useState((initialRouteState.page - 1) * PAGE_SIZE);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [llmExecutionMode, setLlmExecutionMode] = useState<"session-chain" | "one-shot-chain">("session-chain");
  const [llmSiglipLabelMode, setLlmSiglipLabelMode] = useState<SiglipLabelMode>("off");
  const [llmDinoLabelMode, setLlmDinoLabelMode] = useState<DinoLabelMode>("off");
  const [llmStopAfterStage, setLlmStopAfterStage] = useState<"" | "ocr">("");
  const [presets, setPresets] = useState<PipelinePresetRecord[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetScope, setPresetScope] = useState<PresetScope>("selection");
  const [presetPlanned, setPresetPlanned] = useState<number | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [loadedListHref, setLoadedListHref] = useState<string | null>(null);
  const restoredScrollHref = useRef<string | null>(null);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const listRouteState: RecognitionListRouteState = { page, query, source, status, cvMeta, annotationStatus, executionActor, automationMode, recognitionTag, firstPerInitial, perInitialLimit };
  const currentListHref = recognitionListHref(listRouteState);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const next = parseRecognitionListRouteState(new URLSearchParams(searchParamsKey));
      setSource(next.source);
      setStatus(next.status);
      setCvMeta(next.cvMeta);
      setAnnotationStatus(next.annotationStatus);
      setExecutionActor(next.executionActor);
      setAutomationMode(next.automationMode);
      setRecognitionTag(next.recognitionTag);
      setFirstPerInitial(next.firstPerInitial);
      setPerInitialLimit(next.perInitialLimit);
      setQuery(next.query);
      setOffset((next.page - 1) * PAGE_SIZE);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [searchParamsKey]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setToken(getStoredToken());
      setAuthChecked(true);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!authChecked || !token) return;
    let cancelled = false;
    listPipelinePresets(token, "label-roi")
      .then((response) => {
        if (cancelled) return;
        setPresets(response.items);
        setSelectedPresetId(response.items[0]?.id ?? "");
      })
      .catch((nextError) => {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Failed to load presets");
      });
    return () => {
      cancelled = true;
    };
  }, [authChecked, token]);

  useEffect(() => {
    if (!authChecked || !token) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setLoadedListHref(null);
      setError(null);

      try {
        const response = await listRecognitionInventory(
          { source, metaStatus: status, search: query, cvMeta, annotationStatus: annotationStatus || undefined, executionActor: executionActor || undefined, automationMode: automationMode || undefined, recognitionTag: recognitionTag || undefined, firstPerInitial, perInitialLimit, limit: PAGE_SIZE, offset },
          token
        );

        if (cancelled) return;
        setItems(response.items);
        setTotal(response.total);
        setLoadedListHref(currentListHref);
        setPresetPlanned(null);
        setSelectedKeys((current) =>
          current.filter((key) => response.items.some((item) => itemKey(item) === key))
        );
      } catch (nextError) {
        if (cancelled) return;
        setItems([]);
        setTotal(0);
        setError(nextError instanceof Error ? nextError.message : "Failed to load metadata");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [annotationStatus, authChecked, automationMode, currentListHref, cvMeta, executionActor, firstPerInitial, offset, perInitialLimit, query, recognitionTag, reloadVersion, source, status, token]);

  useEffect(() => {
    if (!authChecked || !token || loading || loadedListHref !== currentListHref || restoredScrollHref.current === currentListHref) return;
    restoredScrollHref.current = currentListHref;
    const raw = sessionStorage.getItem(recognitionListScrollKey(currentListHref));
    if (!raw) return;
    sessionStorage.removeItem(recognitionListScrollKey(currentListHref));
    try {
      const saved = JSON.parse(raw) as { y?: unknown };
      if (typeof saved.y !== "number" || !Number.isFinite(saved.y) || saved.y < 0) return;
      requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: saved.y as number, behavior: "auto" })));
    } catch {
      // Invalid/stale session data is intentionally ignored.
    }
  }, [authChecked, currentListHref, loadedListHref, loading, token]);

  const hasNextPage = offset + PAGE_SIZE < total;
  const sortedItems = useMemo(
    () =>
      [...items].sort((a, b) =>
        (a.title ?? "").localeCompare(b.title ?? "", "ru")
      ),
    [items]
  );
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId]
  );

  function handleTokenChange(nextToken: string | null) {
    setToken(nextToken);
    if (!nextToken) {
      setItems([]);
      setTotal(0);
      setError(null);
      setMessage(null);
      setSelectedKeys([]);
      setPresets([]);
      setSelectedPresetId("");
      setPresetPlanned(null);
    }
  }

  function resetFilters() {
    updateListRoute({ page: 1, query: "", source: "all", status: "", cvMeta: "all", annotationStatus: "", executionActor: "", automationMode: "", recognitionTag: "", firstPerInitial: false, perInitialLimit: 3 });
  }

  function updateListRoute(patch: Partial<RecognitionListRouteState>, history: "push" | "replace" = "replace") {
    const next = { ...listRouteState, ...patch };
    setQuery(next.query);
    setSource(next.source);
    setStatus(next.status);
    setCvMeta(next.cvMeta);
    setAnnotationStatus(next.annotationStatus);
    setExecutionActor(next.executionActor);
    setAutomationMode(next.automationMode);
    setRecognitionTag(next.recognitionTag);
    setFirstPerInitial(next.firstPerInitial);
    setPerInitialLimit(next.perInitialLimit);
    setOffset((next.page - 1) * PAGE_SIZE);
    const href = recognitionListHref(next);
    if (history === "push") router.push(href, { scroll: true });
    else router.replace(href, { scroll: false });
  }

  function rememberListPosition() {
    sessionStorage.setItem(recognitionListScrollKey(currentListHref), JSON.stringify({ y: window.scrollY, at: Date.now() }));
  }

  function toggleItem(item: RecognitionInventoryItem) {
    const key = itemKey(item);
    setSelectedKeys((current) =>
      current.includes(key) ? current.filter((value) => value !== key) : [...current, key]
    );
    setPresetPlanned(null);
  }

  function togglePage() {
    const pageKeys = sortedItems.map(itemKey);
    const allSelected = pageKeys.length > 0 && pageKeys.every((key) => selectedKeys.includes(key));
    setSelectedKeys((current) => {
      if (allSelected) return current.filter((key) => !pageKeys.includes(key));
      return Array.from(new Set([...current, ...pageKeys]));
    });
    setPresetPlanned(null);
  }

  async function generateSelected(type: "GENERATE_ALIASES" | "GENERATE_DETECTION_PROPOSAL" | "GENERATE_CV_META" | "REGENERATE_ALL_META") {
    if (!token || selectedKeys.length === 0) return;
    setActionLoading(true);
    setError(null);
    setMessage(null);

    try {
      const selectedItems = sortedItems.filter((item) => selectedKeys.includes(itemKey(item)));
      for (const item of selectedItems) {
        await createRecognitionJob(item.source, item.sourceItemId, token, type === "REGENERATE_ALL_META", type);
      }
      setMessage(`${selectedItems.length} recognition job(s) queued.`);
      setSelectedKeys([]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to queue selected jobs");
    } finally {
      setActionLoading(false);
    }
  }

  function selectedItemKeys() {
    return sortedItems
      .filter((item) => selectedKeys.includes(itemKey(item)))
      .map((item) => ({
        source: item.source as "svoe_vino" | "roskachestvo",
        sourceItemId: item.sourceItemId,
      }));
  }

  async function runSelectedLlmBatch() {
    if (!token || selectedKeys.length === 0) return;
    const selectedItems = sortedItems.filter((item) => selectedKeys.includes(itemKey(item)));
    const plannedCards = selectedItems.length;
    const modeLabel = llmExecutionMode === "session-chain" ? "one dialog session per annotation card" : "independent stage requests";
    if (!window.confirm(
      `Start LLM Wizard for ${plannedCards} new annotation version(s)?\n\nMode: ${modeLabel}.\nRange: ${llmStopAfterStage === "ocr" ? "through OCR; stop before Mask" : "full pipeline"}.\nLabel evidence: SigLIP ${llmSiglipLabelMode}; DINOv3 ${llmDinoLabelMode}.\nEach selected item receives one empty active version. A full successful run promotes it to default; an OCR-limited run remains ready for review or continuation.`,
    )) return;

    setActionLoading(true);
    setError(null);
    setMessage(null);
    try {
      const cards = selectedItems.map((item) => ({
        source: item.source as "svoe_vino" | "roskachestvo",
        sourceItemId: item.sourceItemId,
      }));
      const job = await createLlmWizardBatchJob(cards, llmExecutionMode, { labelMode: llmSiglipLabelMode, dinoMode: llmDinoLabelMode }, token, llmStopAfterStage || null);
      setMessage(`${cards.length} new annotation version(s) queued in LLM Wizard batch ${job.jobId}.`);
      setSelectedKeys([]);
      setReloadVersion((current) => current + 1);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to start selected LLM Wizard batch");
    } finally {
      setActionLoading(false);
    }
  }

  async function deleteMeta(itemsToDelete: Array<{ source: "svoe_vino" | "roskachestvo"; sourceItemId: string }>) {
    if (!token || itemsToDelete.length === 0) return;
    const confirmed = window.confirm(
      `Delete all operational Meta for ${itemsToDelete.length} item(s)?\n\nAnnotations, OCR, analysis, proposals and item jobs will be removed. Source data, images, presets and frozen datasets will remain.`,
    );
    if (!confirmed) return;
    setActionLoading(true);
    setError(null);
    setMessage(null);
    try {
      const result = await deleteRecognitionMetadata(itemsToDelete, token);
      const deletedKeys = new Set(itemsToDelete.map((item) => `${item.source}:${item.sourceItemId}`));
      setSelectedKeys((current) => current.filter((key) => !deletedKeys.has(key)));
      setPresetPlanned(null);
      setMessage(`Operational Meta deleted for ${result.requested} item(s). Source data and assets were preserved.`);
      setReloadVersion((current) => current + 1);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete item metadata");
    } finally {
      setActionLoading(false);
    }
  }

  async function estimatePresetRun() {
    if (!token || !selectedPreset) return;
    setActionLoading(true);
    setError(null);
    setMessage(null);
    try {
      if (presetScope === "selection") {
        const count = selectedItemKeys().length;
        if (!count) throw new Error("Select at least one item");
        setPresetPlanned(count);
        return;
      }
      const targetSource = presetScope === "global" ? "all" : source;
      if (targetSource === "all" && presetScope === "source") {
        throw new Error("Choose one source or use Global scope");
      }
      const estimate = await estimateRecognitionBatchJob(
        targetSource,
        token,
        10000,
        true,
        "GENERATE_DETECTION_PROPOSAL",
        {
          missingCvMeta: false,
          presetId: selectedPreset.id,
          presetRevision: selectedPreset.revision,
        }
      );
      setPresetPlanned(estimate.planned);
    } catch (nextError) {
      setPresetPlanned(null);
      setError(nextError instanceof Error ? nextError.message : "Failed to estimate preset run");
    } finally {
      setActionLoading(false);
    }
  }

  async function runPresetBatch() {
    if (!token || !selectedPreset || presetPlanned === null || presetPlanned <= 0) return;
    setActionLoading(true);
    setError(null);
    setMessage(null);
    try {
      const target = presetScope === "selection"
        ? { items: selectedItemKeys() }
        : {
            filter: {
              source: presetScope === "global" ? "all" as const : source as "svoe_vino" | "roskachestvo",
              missingCvMeta: false,
            },
          };
      const job = await createRecognitionBatchTargetJob(target, token, {
        batchSize: presetScope === "selection" ? Math.max(1, selectedItemKeys().length) : 10000,
        force: true,
        type: "GENERATE_DETECTION_PROPOSAL",
        presetId: selectedPreset.id,
        presetRevision: selectedPreset.revision,
      });
      setMessage(`${presetPlanned} frozen item(s) queued in batch ${job.jobId}. Reviewed annotations are unchanged.`);
      setPresetPlanned(null);
      setSelectedKeys([]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to start preset batch");
    } finally {
      setActionLoading(false);
    }
  }

  return (
    <main className="min-h-dvh bg-zinc-100 text-zinc-950">
      <AdminAuthPanel token={token} onTokenChange={handleTokenChange} />

      <div className="mx-auto max-w-7xl px-5 py-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Recognition metadata</h2>
            <p className="text-sm text-zinc-500">
              Item inventory with generated metadata state and group actions.
            </p>
          </div>
          <AdminNavLinks active="recognition" />
        </div>

        {!authChecked && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">
            Checking admin session...
          </section>
        )}

        {authChecked && !token && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6">
            <div className="text-sm font-semibold">Not logged in</div>
            <div className="mt-1 text-sm text-zinc-500">
              Log in to load generated recognition metadata.
            </div>
          </section>
        )}

        {authChecked && token && (
          <>
            <section className="mb-4 rounded-lg border border-zinc-200 bg-white p-4">
              <div className="grid gap-3 md:grid-cols-[1.4fr_170px_160px_150px_180px_auto]">
                <input
                  value={query}
                  onChange={(event) => {
                    updateListRoute({ query: event.target.value, page: 1 });
                  }}
                  className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
                  placeholder="Search title, producer, aliases, tokens"
                />
                <select
                  value={source}
                  onChange={(event) => {
                    updateListRoute({ source: event.target.value as RecognitionListSource, page: 1 });
                    setPresetPlanned(null);
                  }}
                  className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
                >
                  <option value="all">All sources</option>
                  <option value="svoe_vino">Svoe Vino</option>
                  <option value="roskachestvo">Roskachestvo</option>
                </select>
                <select
                  value={status}
                  onChange={(event) => {
                    updateListRoute({ status: event.target.value, page: 1 });
                  }}
                  className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
                >
                  <option value="">Any meta status</option>
                  <option value="missing">Missing meta</option>
                  <option value="generated">Generated</option>
                  <option value="reviewed">Reviewed</option>
                  <option value="disabled">Disabled</option>
                </select>
                <select
                  value={cvMeta}
                  onChange={(event) => {
                    updateListRoute({ cvMeta: event.target.value as RecognitionListCvMeta, page: 1 });
                  }}
                  className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
                >
                  <option value="all">Any raster</option>
                  <option value="present">Has cvMeta</option>
                  <option value="missing">Missing cvMeta</option>
                </select>
                <select
                  value={annotationStatus}
                  onChange={(event) => {
                    updateListRoute({ annotationStatus: event.target.value as RecognitionListAnnotationStatus, page: 1 });
                  }}
                  className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
                >
                  <option value="">Any progress</option>
                  <option value="not-started">Not started</option>
                  <option value="in-progress">In progress</option>
                  <option value="complete">Completed</option>
                </select>
                <select
                  value={executionActor}
                  onChange={(event) => updateListRoute({ executionActor: event.target.value as RecognitionListExecutionActor, page: 1 })}
                  className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
                >
                  <option value="">Any executor</option>
                  <option value="human">Human UI</option>
                  <option value="ml-agent">ML agent</option>
                  <option value="hybrid">Hybrid execution</option>
                </select>
                <select
                  value={automationMode}
                  onChange={(event) => updateListRoute({ automationMode: event.target.value as RecognitionListAutomationMode, page: 1 })}
                  className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
                >
                  <option value="">Any automation</option>
                  <option value="auto">Fully automatic</option>
                  <option value="mixed">Helper + edits</option>
                  <option value="manual">Manual stages</option>
                </select>
                <select
                  value={recognitionTag}
                  onChange={(event) => updateListRoute({ recognitionTag: event.target.value, page: 1 })}
                  className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
                >
                  <option value="">Any tag</option>
                  <option value="multipackage">Multipackage</option>
                  {RECOGNITION_LIST_TAGS.map((tag) => <option key={tag.value} value={tag.value}>{tag.label}</option>)}
                </select>
                <button
                  type="button"
                  onClick={resetFilters}
                  className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50"
                >
                  Reset
                </button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-3">
                <label className="flex h-10 items-center gap-2 rounded border border-zinc-300 px-3 text-sm">
                  <input
                    type="checkbox"
                    checked={firstPerInitial}
                    onChange={(event) => updateListRoute({ firstPerInitial: event.target.checked, page: 1 })}
                  />
                  First N items per initial
                </label>
                <label className="flex h-10 items-center gap-2 text-sm text-zinc-600">
                  <span>N</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={perInitialLimit}
                    disabled={!firstPerInitial}
                    onChange={(event) => {
                      const value = Math.max(1, Math.min(100, Number.parseInt(event.target.value, 10) || 1));
                      updateListRoute({ perInitialLimit: value, page: 1 });
                    }}
                    className="h-10 w-24 rounded border border-zinc-300 px-3 text-sm disabled:bg-zinc-100 disabled:text-zinc-400"
                  />
                </label>
                <span className="text-xs text-zinc-500">Returns up to N titles for each normalized first character after the other filters are applied.</span>
              </div>
            </section>

            <section className="mb-4 rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <div className="text-sm font-semibold">Apply label ROI preset</div>
                  <div className="mt-1 text-sm text-zinc-500">
                    Estimate first, then create one frozen batch. Only generated proposals are written.
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-[minmax(220px,1fr)_150px_auto_auto]">
                  <select
                    value={selectedPresetId}
                    onChange={(event) => {
                      setSelectedPresetId(event.target.value);
                      setPresetPlanned(null);
                    }}
                    className="h-10 rounded border border-zinc-300 px-3 text-sm"
                  >
                    {presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name} · rev {preset.revision} · {preset.status}
                      </option>
                    ))}
                  </select>
                  <select
                    value={presetScope}
                    onChange={(event) => {
                      setPresetScope(event.target.value as PresetScope);
                      setPresetPlanned(null);
                    }}
                    className="h-10 rounded border border-zinc-300 px-3 text-sm"
                  >
                    <option value="selection">Selected items</option>
                    <option value="source">Current source</option>
                    <option value="global">Global</option>
                  </select>
                  <button
                    type="button"
                    onClick={estimatePresetRun}
                    disabled={actionLoading || !selectedPreset}
                    className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium disabled:opacity-40"
                  >
                    Estimate
                  </button>
                  <button
                    type="button"
                    onClick={runPresetBatch}
                    disabled={actionLoading || !selectedPreset || presetPlanned === null || presetPlanned <= 0}
                    className="h-10 rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-40"
                  >
                    Run {presetPlanned === null ? "" : presetPlanned}
                  </button>
                </div>
              </div>
            </section>

            <section className="mb-4 rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div className="text-sm font-semibold">Selected items: {selectedKeys.length}</div>
                  <div className="mt-1 text-sm text-zinc-500">
                    Queue source-text or image-derived jobs for checked rows. Full job history is on the Jobs page.
                  </div>
                  <div className="mt-1 text-xs text-indigo-700">
                    LLM Wizard runs every annotation track of each selected item; an empty item gets one default track.
                  </div>
                </div>
                <div className="flex max-w-3xl flex-wrap justify-end gap-2">
                  <select
                    value={llmExecutionMode}
                    onChange={(event) => setLlmExecutionMode(event.target.value as "session-chain" | "one-shot-chain")}
                    disabled={actionLoading}
                    aria-label="LLM Wizard execution mode"
                    className="h-10 rounded border border-indigo-300 bg-indigo-50 px-3 text-sm text-indigo-950 disabled:opacity-40"
                  >
                    <option value="session-chain">LLM: dialog session</option>
                    <option value="one-shot-chain">LLM: independent requests</option>
                  </select>
                  <select value={llmSiglipLabelMode} onChange={(event) => setLlmSiglipLabelMode(event.target.value as SiglipLabelMode)} disabled={actionLoading} aria-label="LLM Wizard SigLIP2 mode" className="h-10 rounded border border-violet-300 bg-violet-50 px-3 text-sm text-violet-950 disabled:opacity-40">
                    <option value="off">SigLIP off</option>
                    <option value="score-only">SigLIP score only</option>
                    <option value="rerank">SigLIP rerank</option>
                  </select>
                  <select value={llmDinoLabelMode} onChange={(event) => setLlmDinoLabelMode(event.target.value as DinoLabelMode)} disabled={actionLoading} aria-label="LLM Wizard DINOv3 mode" className="h-10 rounded border border-emerald-300 bg-emerald-50 px-3 text-sm text-emerald-950 disabled:opacity-40">
                    <option value="off">DINO off</option>
                    <option value="observe">DINO observe</option>
                    <option value="refine">DINO refine ROI</option>
                  </select>
                  <select value={llmStopAfterStage} onChange={(event) => setLlmStopAfterStage(event.target.value as "" | "ocr")} disabled={actionLoading} aria-label="LLM Wizard stopping stage" className="h-10 rounded border border-amber-300 bg-amber-50 px-3 text-sm text-amber-950 disabled:opacity-40">
                    <option value="">Full pipeline</option>
                    <option value="ocr">Through OCR · no Mask</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => void runSelectedLlmBatch()}
                    disabled={actionLoading || selectedKeys.length === 0}
                    className="h-10 rounded bg-indigo-700 px-4 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-40"
                  >
                    Run LLM Wizard
                  </button>
                  <button
                    type="button"
                    onClick={() => generateSelected("GENERATE_ALIASES")}
                    disabled={actionLoading || selectedKeys.length === 0}
                    className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50 disabled:opacity-40"
                  >
                    Generate text
                  </button>
                  <button
                    type="button"
                    onClick={() => generateSelected("GENERATE_DETECTION_PROPOSAL")}
                    disabled={actionLoading || selectedKeys.length === 0}
                    className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50 disabled:opacity-40"
                  >
                    Generate proposal
                  </button>
                  <button
                    type="button"
                    onClick={() => generateSelected("GENERATE_CV_META")}
                    disabled={actionLoading || selectedKeys.length === 0}
                    className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50 disabled:opacity-40"
                  >
                    Generate image meta
                  </button>
                  <button
                    type="button"
                    onClick={() => generateSelected("REGENERATE_ALL_META")}
                    disabled={actionLoading || selectedKeys.length === 0}
                    className="h-10 rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-40"
                  >
                    Regenerate
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteMeta(selectedItemKeys())}
                    disabled={actionLoading || selectedKeys.length === 0}
                    className="h-10 rounded border border-red-300 bg-red-50 px-4 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-40"
                  >
                    Del meta
                  </button>
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
              <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 text-sm text-zinc-600">
                <span>{loading ? "Loading..." : `${total.toLocaleString()} source items`} / page {page}</span>
                {error && <span className="text-red-600">Request error</span>}
              </div>

              {error && (
                <div className="border-b border-red-100 bg-red-50 px-4 py-4 text-sm text-red-700">
                  Recognition inventory request failed: {error}
                </div>
              )}

              {message && (
                <div className="border-b border-emerald-100 bg-emerald-50 px-4 py-4 text-sm text-emerald-700">
                  {message}
                </div>
              )}

              {!loading && !error && sortedItems.length === 0 && (
                <div className="px-4 py-10 text-center text-sm text-zinc-500">
                  No source items for this filter.
                </div>
              )}

              {sortedItems.length > 0 && (
                <div className="overflow-auto">
                  <table className="w-full min-w-[1320px] border-collapse text-left text-sm">
                    <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
                      <tr>
                        <th className="w-12 px-4 py-3">
                          <input
                            type="checkbox"
                            checked={sortedItems.length > 0 && sortedItems.every((item) => selectedKeys.includes(itemKey(item)))}
                            onChange={togglePage}
                            aria-label="Select page"
                          />
                        </th>
                        <th className="w-16 px-4 py-3 text-right">#</th>
                        <th className="px-4 py-3">Source</th>
                        <th className="px-4 py-3">Title</th>
                        <th className="px-4 py-3">Meta</th>
                        <th className="px-4 py-3">Tags</th>
                        <th className="px-4 py-3">Raster</th>
                        <th className="px-4 py-3">Annotation progress</th>
                        <th className="px-4 py-3">Producer</th>
                        <th className="px-4 py-3">Category</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Latest job</th>
                        <th className="px-4 py-3">Job created</th>
                        <th className="px-4 py-3">Job started</th>
                        <th className="px-4 py-3">Job finished</th>
                        <th className="px-4 py-3">Updated</th>
                        <th className="px-4 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedItems.map((item, index) => (
                        <tr key={itemKey(item)} className="border-t border-zinc-100 hover:bg-zinc-50">
                          <td className="px-4 py-3">
                            <input
                              type="checkbox"
                              checked={selectedKeys.includes(itemKey(item))}
                              onChange={() => toggleItem(item)}
                              aria-label={`Select ${item.title ?? item.sourceItemId}`}
                            />
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-zinc-400">
                            {offset + index + 1}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-zinc-500">
                            {formatSource(item.source)}
                          </td>
                          <td className="px-4 py-3">
                            <RecognitionTitleLink
                              item={item}
                              href={recognitionItemHref(item.source, item.sourceItemId, "metadata", currentListHref)}
                              onNavigate={rememberListPosition}
                            />
                            <div className="mt-1 text-xs text-zinc-500">{item.sourceItemId}</div>
                          </td>
                          <td className="px-4 py-3">
                            <MetaBadges item={item} />
                          </td>
                          <td className="px-4 py-3">
                            <RecognitionTagBadges tags={item.recognitionTags} />
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            {hasCvMeta(item) ? (
                              <span className="rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">cvMeta</span>
                            ) : (
                              <span className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">missing</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <AnnotationBadge item={item} returnTo={currentListHref} onNavigate={rememberListPosition} />
                          </td>
                          <td className="px-4 py-3">{item.manufacturer ?? "-"}</td>
                          <td className="px-4 py-3">{item.category ?? "-"}</td>
                          <td className="whitespace-nowrap px-4 py-3">{item.metadata?.status ?? "missing"}</td>
                          <td className="px-4 py-3">
                            <LatestJobBadge item={item} />
                          </td>
                          <InventoryDateCell value={item.latestJob?.createdAt} />
                          <InventoryDateCell value={item.latestJob?.startedAt} />
                          <InventoryDateCell value={item.latestJob?.completedAt} />
                          <td className="whitespace-nowrap px-4 py-3 text-zinc-500">
                            {formatDate(item.metadata?.updatedAt ?? item.latestJob?.completedAt ?? item.latestJob?.startedAt ?? item.latestJob?.createdAt)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <button
                              type="button"
                              onClick={() => void deleteMeta([{
                                source: item.source as "svoe_vino" | "roskachestvo",
                                sourceItemId: item.sourceItemId,
                              }])}
                              disabled={actionLoading}
                              className="h-8 rounded border border-red-300 px-3 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-40"
                              aria-label={`Delete operational Meta for ${item.title ?? item.sourceItemId}`}
                            >
                              Del
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-3">
                <button
                  type="button"
                  disabled={offset === 0 || loading}
                  onClick={() => updateListRoute({ page: Math.max(1, page - 1) }, "push")}
                  className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-sm tabular-nums text-zinc-500">
                  Page {page} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
                </span>
                <button
                  type="button"
                  disabled={!hasNextPage || loading}
                  onClick={() => updateListRoute({ page: page + 1 }, "push")}
                  className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

function RecognitionTitleLink({ item, href, onNavigate }: { item: RecognitionInventoryItem; href: string; onNavigate: () => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const imageUrl = recognitionPreviewImageUrl(item.imageUrls[0]);
  const title = item.title ?? "Untitled";
  const previewPosition = anchor && typeof window !== "undefined" ? positionRecognitionPreview(anchor, window.innerWidth, window.innerHeight) : null;

  function showPreview(element: HTMLElement) {
    if (!imageUrl || imageFailed) return;
    setAnchor(element.getBoundingClientRect());
  }

  return <>
    <Link
      href={href}
      onClick={onNavigate}
      onMouseEnter={(event) => showPreview(event.currentTarget)}
      onMouseLeave={() => setAnchor(null)}
      onFocus={(event) => showPreview(event.currentTarget)}
      onBlur={() => setAnchor(null)}
      className="font-medium text-zinc-950 decoration-zinc-400 underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500"
      aria-describedby={anchor ? `recognition-image-preview-${itemKey(item)}` : undefined}
    >
      {title}
    </Link>
    {anchor && imageUrl && previewPosition && !imageFailed && typeof document !== "undefined" ? createPortal(
      <div
        id={`recognition-image-preview-${itemKey(item)}`}
        role="tooltip"
        className="pointer-events-none fixed z-[100] w-72 rounded-lg border border-zinc-300 bg-white p-2 shadow-2xl"
        style={{ left: previewPosition.left, top: previewPosition.top }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="" onError={() => { setImageFailed(true); setAnchor(null); }} className="max-h-[26rem] w-full rounded bg-zinc-50 object-contain" />
        <div className="mt-2 truncate px-1 text-xs font-medium text-zinc-700">{title}</div>
        {item.imageUrls.length > 1 ? <div className="px-1 text-[10px] text-zinc-500">Image 1 of {item.imageUrls.length}</div> : null}
      </div>,
      document.body,
    ) : null}
  </>;
}

function recognitionPreviewImageUrl(value: string | undefined) {
  if (!value) return null;
  if (/^https?:\/\//.test(value) || value.startsWith("/")) return value;
  return `/api/admin/assets/${value.replace(/\\/g, "/")}`;
}

function positionRecognitionPreview(anchor: DOMRect, viewportWidth: number, viewportHeight: number) {
  const width = 288, estimatedHeight = 460, gap = 12, margin = 12;
  const rightSide = anchor.right + gap;
  const left = rightSide + width <= viewportWidth - margin
    ? rightSide
    : Math.max(margin, anchor.left - width - gap);
  const top = Math.max(margin, Math.min(anchor.top - margin, viewportHeight - estimatedHeight - margin));
  return { left, top };
}

function itemKey(item: RecognitionInventoryItem) {
  return `${item.source}:${item.sourceItemId}`;
}

function hasCvMeta(item: RecognitionInventoryItem) {
  return item.metadata?.hasCvMeta === true;
}

function MetaBadges({ item }: { item: RecognitionInventoryItem }) {
  if (!item.metadata) {
    return <span className="rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-600">no meta</span>;
  }

  return (
    <div className="flex flex-wrap gap-1">
      <Badge label={`${item.metadata.aliasesCount} aliases`} />
      <Badge label={`${item.metadata.normalizedTokensCount} tokens`} />
      <Badge label={item.metadata.generationVersion ?? "no version"} />
    </div>
  );
}

function AnnotationBadge({
  item,
  returnTo,
  onNavigate,
}: {
  item: RecognitionInventoryItem;
  returnTo: string;
  onNavigate: () => void;
}) {
  const status = item.metadata?.annotationStatus ?? (item.metadata?.hasCvMeta ? "needs-review" : "missing");
  const href = recognitionItemHref(item.source, item.sourceItemId, "annotation", returnTo);
  const className = annotationBadgeClassName(status);
  const tracks = item.annotationTracks ?? [];
  if (tracks.length === 1) {
    return <TrackProgressLink track={tracks[0]} href={withTrack(href, tracks[0].id)} onNavigate={onNavigate} />;
  }
  if (tracks.length === 2) {
    return (
      <div className="grid gap-1">
        {tracks.map((track) => <TrackProgressLink key={track.id} track={track} href={withTrack(href, track.id)} onNavigate={onNavigate} />)}
      </div>
    );
  }
  if (tracks.length > 2) {
    return (
      <select defaultValue="" aria-label="Open annotation track" className="h-9 max-w-40 rounded border border-zinc-300 bg-white px-2 text-xs"
        onChange={(event) => { if (event.target.value) { onNavigate(); window.location.assign(withTrack(href, event.target.value)); } }}>
        <option value="">{tracks.length} annotations…</option>
        {tracks.map((track) => <option key={track.id} value={track.id}>{track.name} · {track.progress.completedStages}/11 · {track.progress.automation.mode ?? "unclassified"}</option>)}
      </select>
    );
  }
  return (
    <Link href={href} onClick={onNavigate} className={className}>
      {formatAnnotationStatus(status)}
    </Link>
  );
}

function RecognitionTagBadges({ tags = [] }: { tags?: string[] }) {
  if (!tags.length) return <span className="text-zinc-400">-</span>;
  return <div className="flex max-w-64 flex-wrap gap-1">{tags.map((tag) => (
    <span key={tag} className="rounded bg-violet-50 px-2 py-1 text-xs font-medium text-violet-700">{formatRecognitionTag(tag)}</span>
  ))}</div>;
}

function TrackProgressLink({ track, href, onNavigate }: {
  track: RecognitionInventoryItem["annotationTracks"][number]; href: string; onNavigate: () => void;
}) {
  const progress = track.progress;
  return <Link href={href} onClick={onNavigate} className={`${annotationProgressClassName(progress.status)} block min-w-36`}>
    <span className="block font-semibold">{track.name} · {progress.completedStages}/{progress.totalStages}</span>
    <span className="mt-0.5 block text-[10px] font-normal opacity-80">
      {progress.status === "complete" ? "completed" : progress.status === "not-started" ? "not started" : `next: ${formatProgressStage(progress.nextStage)}`}
      {progress.executionActor.type ? ` · ${formatExecutionActor(progress.executionActor.type)}` : ""}
    </span>
    {progress.automation.mode && <span className="mt-0.5 block text-[10px] font-normal opacity-80">
      {formatAutomation(progress.automation.mode)} · auto {progress.automation.autoStages} / edited {progress.automation.mixedStages} / manual {progress.automation.manualStages}
    </span>}
  </Link>;
}

function annotationProgressClassName(status: "not-started" | "in-progress" | "complete") {
  if (status === "complete") return "rounded bg-emerald-50 px-2 py-1 text-xs text-emerald-700";
  if (status === "in-progress") return "rounded bg-blue-50 px-2 py-1 text-xs text-blue-700";
  return "rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-600";
}

function formatProgressStage(stage: RecognitionInventoryItem["annotationTracks"][number]["progress"]["nextStage"]) {
  if (!stage) return "done";
  if (stage === "bottle") return "Object Context";
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

function formatExecutionActor(actor: NonNullable<RecognitionInventoryItem["annotationTracks"][number]["progress"]["executionActor"]["type"]>) {
  if (actor === "ml-agent") return "ML agent";
  if (actor === "hybrid") return "human + ML";
  return "human UI";
}

function formatAutomation(mode: NonNullable<RecognitionInventoryItem["annotationTracks"][number]["progress"]["automation"]["mode"]>) {
  if (mode === "auto") return "auto";
  if (mode === "manual") return "manual";
  return "mixed";
}

function withTrack(href: string, trackId: string) {
  return `${href}${href.includes("?") ? "&" : "?"}track=${encodeURIComponent(trackId)}`;
}

function LatestJobBadge({ item }: { item: RecognitionInventoryItem }) {
  if (!item.latestJob) return <span className="text-zinc-500">-</span>;
  return (
    <div>
      <span className="rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-700">{item.latestJob.status}</span>
      <div className="mt-1 font-mono text-xs text-zinc-500">{item.latestJob.id.slice(0, 8)}</div>
    </div>
  );
}

function InventoryDateCell({ value }: { value: string | null | undefined }) {
  return (
    <td className="whitespace-nowrap px-4 py-3 text-zinc-500" title={value ?? undefined}>
      {formatDate(value)}
    </td>
  );
}

function Badge({ label }: { label: string }) {
  return <span className="rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-600">{label}</span>;
}

function annotationBadgeClassName(status: string) {
  const base = "inline-flex rounded px-2 py-1 text-xs font-medium hover:underline";
  if (status === "reviewed") return `${base} bg-emerald-50 text-emerald-700`;
  if (status === "needs-review" || status === "generated") return `${base} bg-amber-50 text-amber-700`;
  if (status === "no-label") return `${base} bg-zinc-100 text-zinc-700`;
  if (status === "invalid-image") return `${base} bg-red-50 text-red-700`;
  return `${base} bg-zinc-100 text-zinc-600`;
}

function formatAnnotationStatus(status: string) {
  if (status === "needs-review") return "needs review";
  if (status === "no-label") return "no label";
  if (status === "invalid-image") return "invalid image";
  if (status === "missing") return "no annotation";
  return status;
}

function formatSource(source: string) {
  if (source === "svoe_vino") return "Svoe Vino";
  if (source === "roskachestvo") return "Roskachestvo";
  return source;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
