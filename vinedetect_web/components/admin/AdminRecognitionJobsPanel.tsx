"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  cancelRecognitionJob,
  createLlmWizardBatchJob,
  createRecognitionBatchJob,
  deleteRecognitionJob,
  estimateRecognitionBatchJob,
  listRecognitionJobItems,
  listRecognitionJobs,
  retryRecognitionJob,
  type RecognitionJobEstimate,
  type RecognitionJob,
  type RecognitionJobType,
  type SiglipLabelMode,
  type DinoLabelMode,
} from "@/lib/admin/api";

type Props = {
  token: string;
};

type BatchSource = "svoe_vino" | "roskachestvo";
type JobStatusFilter = "" | "queued" | "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";
type JobScopeFilter = "" | RecognitionJob["scope"];

const JOB_PAGE_SIZES = [25, 50, 100] as const;
const CHILD_PAGE_SIZE = 50;

export function AdminRecognitionJobsPanel({ token }: Props) {
  const [source, setSource] = useState<BatchSource>("roskachestvo");
  const [jobType, setJobType] = useState<RecognitionJobType>("GENERATE_CV_META");
  const [batchSize, setBatchSize] = useState(25);
  const [force, setForce] = useState(false);
  const [jobs, setJobs] = useState<RecognitionJob[]>([]);
  const [jobsTotal, setJobsTotal] = useState(0);
  const [jobsOffset, setJobsOffset] = useState(0);
  const [jobsPageSize, setJobsPageSize] = useState<number>(50);
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("");
  const [typeFilter, setTypeFilter] = useState<"" | RecognitionJobType>("");
  const [scopeFilter, setScopeFilter] = useState<JobScopeFilter>("");
  const [sourceFilter, setSourceFilter] = useState<"" | BatchSource>("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedItemStatus, setSelectedItemStatus] = useState("");
  const [jobItems, setJobItems] = useState<JobItem[]>([]);
  const [jobItemsTotal, setJobItemsTotal] = useState(0);
  const [jobItemsOffset, setJobItemsOffset] = useState(0);
  const [estimate, setEstimate] = useState<RecognitionJobEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [selectedForDelete, setSelectedForDelete] = useState<Map<string, RecognitionJob["scope"]>>(new Map());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [llmCardsText, setLlmCardsText] = useState("");
  const [llmExecutionMode, setLlmExecutionMode] = useState<"session-chain" | "one-shot-chain">("session-chain");
  const [llmSiglipLabelMode, setLlmSiglipLabelMode] = useState<SiglipLabelMode>("off");
  const [llmDinoLabelMode, setLlmDinoLabelMode] = useState<DinoLabelMode>("off");
  const [llmStopAfterStage, setLlmStopAfterStage] = useState<"" | "ocr">("");

  async function refreshJobs() {
    setLoading(true);
    setError(null);
    try {
      const response = await listRecognitionJobs(token, {
        status: statusFilter || undefined,
        type: typeFilter || undefined,
        scope: scopeFilter || undefined,
        source: sourceFilter || undefined,
        limit: jobsPageSize,
        offset: jobsOffset,
      });
      setJobs(response.items);
      setJobsTotal(response.total);
      if (response.items.length === 0 && response.total > 0 && jobsOffset > 0) {
        setJobsOffset(Math.floor((response.total - 1) / jobsPageSize) * jobsPageSize);
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(refreshJobs, 0);
    const intervalId = window.setInterval(refreshJobs, 2500);
    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
    };
    // Poll the currently selected journal page and filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsOffset, jobsPageSize, scopeFilter, sourceFilter, statusFilter, token, typeFilter]);

  useEffect(() => {
    if (!selectedJobId) return;

    let cancelled = false;
    const jobId = selectedJobId;
    async function loadItems() {
      const response = await listRecognitionJobItems(jobId, token, {
        status: selectedItemStatus || undefined,
        limit: CHILD_PAGE_SIZE,
        offset: jobItemsOffset,
      });
      if (!cancelled) {
        setJobItems(response.items);
        setJobItemsTotal(response.total);
        if (response.items.length === 0 && response.total > 0 && jobItemsOffset > 0) {
          setJobItemsOffset(Math.floor((response.total - 1) / CHILD_PAGE_SIZE) * CHILD_PAGE_SIZE);
        }
      }
    }

    loadItems().catch((nextError) => {
      if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Failed to load job items");
    });

    return () => {
      cancelled = true;
    };
  }, [jobItemsOffset, selectedItemStatus, selectedJobId, token]);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.jobId === selectedJobId) ?? null,
    [jobs, selectedJobId]
  );
  const visibleJobItems = selectedJobId ? jobItems : [];
  const jobsPage = Math.floor(jobsOffset / jobsPageSize) + 1;
  const jobsPageCount = Math.max(1, Math.ceil(jobsTotal / jobsPageSize));
  const selectablePageJobs = jobs.filter(isTerminalJob);
  const allPageJobsSelected = selectablePageJobs.length > 0
    && selectablePageJobs.every((job) => selectedForDelete.has(job.jobId));

  function resetJournalFilters() {
    setStatusFilter("");
    setTypeFilter("");
    setScopeFilter("");
    setSourceFilter("");
    setJobsOffset(0);
  }

  async function loadEstimate() {
    setLoading(true);
    setError(null);
    try {
      const response = await estimateRecognitionBatchJob(source, token, batchSize, force, jobType);
      setEstimate(response);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to estimate batch");
    } finally {
      setLoading(false);
    }
  }

  async function startBatch() {
    setLoading(true);
    setError(null);
    try {
      const job = await createRecognitionBatchJob(source, token, batchSize, force, jobType);
      setSelectedJobId(job.jobId);
      setEstimate(null);
      await refreshJobs();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to start batch");
    } finally {
      setLoading(false);
    }
  }

  async function startLlmBatch() {
    setLoading(true); setError(null);
    try {
      const cards = parseLlmCards(llmCardsText);
      if (!cards.length) throw new Error("Add at least one source,item,annotationTrackId line");
      const job = await createLlmWizardBatchJob(cards, llmExecutionMode, { labelMode: llmSiglipLabelMode, dinoMode: llmDinoLabelMode }, token, llmStopAfterStage || null);
      setSelectedJobId(job.jobId); setSelectedItemStatus("");
      await refreshJobs();
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Failed to start LLM Wizard batch"); }
    finally { setLoading(false); }
  }

  async function cancelJob(jobId: string) {
    setBusyJobId(jobId);
    setError(null);
    setActionMessage(null);
    try {
      await cancelRecognitionJob(jobId, token);
      await refreshJobs();
      setActionMessage(`Cancellation requested for ${jobId.slice(0, 8)}.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to cancel job");
    } finally {
      setBusyJobId(null);
    }
  }

  async function retryJob(job: RecognitionJob, mode: "current-version" | "new-version") {
    const annotationJob = job.type === "ANNOTATION_LLM_PIPELINE";
    const label = mode === "new-version"
      ? annotationJob ? "create a new annotation version and job" : "create a new job"
      : annotationJob ? "clear and overwrite the current annotation version result" : "overwrite the current job result";
    if (!window.confirm(`Retry ${job.jobId.slice(0, 8)} and ${label}?`)) return;
    setBusyJobId(job.jobId);
    setError(null);
    setActionMessage(null);
    try {
      const retried = await retryRecognitionJob(job.jobId, mode, token);
      await refreshJobs();
      setSelectedJobId(retried.jobId);
      setActionMessage(mode === "new-version"
        ? annotationJob
          ? `Created job ${retried.jobId.slice(0, 8)} with a new annotation version.`
          : `Created replacement job ${retried.jobId.slice(0, 8)}.`
        : annotationJob
          ? `Job ${retried.jobId.slice(0, 8)} queued against its current annotation version.`
          : `Job ${retried.jobId.slice(0, 8)} queued again.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to retry job");
    } finally {
      setBusyJobId(null);
    }
  }

  async function deleteJob(job: RecognitionJob) {
    const description = job.scope === "batch-parent"
      ? "this batch job and all of its terminal child jobs"
      : "this job entry";
    if (!window.confirm(`Delete ${description} ${job.jobId.slice(0, 8)}? Pipeline data and annotation versions will be retained.`)) return;
    setBusyJobId(job.jobId);
    setError(null);
    setActionMessage(null);
    try {
      const deleted = await deleteRecognitionJob(job.jobId, token);
      setSelectedForDelete((current) => {
        if (job.scope === "batch-parent") return new Map();
        const next = new Map(current);
        next.delete(job.jobId);
        return next;
      });
      if (selectedJobId === job.jobId) {
        setSelectedJobId(null);
        setJobItems([]);
      }
      await refreshJobs();
      setActionMessage(`Deleted ${deleted.deleted} job entr${deleted.deleted === 1 ? "y" : "ies"}.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to delete job");
    } finally {
      setBusyJobId(null);
    }
  }

  function toggleJobSelection(job: RecognitionJob) {
    if (!isTerminalJob(job)) return;
    setSelectedForDelete((current) => {
      const next = new Map(current);
      if (next.has(job.jobId)) next.delete(job.jobId);
      else next.set(job.jobId, job.scope);
      return next;
    });
  }

  function togglePageSelection() {
    setSelectedForDelete((current) => {
      const next = new Map(current);
      if (allPageJobsSelected) {
        for (const job of selectablePageJobs) next.delete(job.jobId);
      } else {
        for (const job of selectablePageJobs) next.set(job.jobId, job.scope);
      }
      return next;
    });
  }

  async function deleteSelectedJobs() {
    const selected = [...selectedForDelete.entries()];
    if (selected.length === 0) return;
    if (!window.confirm(`Delete ${selected.length} selected job entries? Batch parents also remove their terminal child entries. Pipeline data and annotation versions will be retained.`)) return;
    setBulkDeleting(true);
    setError(null);
    setActionMessage(null);
    const ordered = selected.sort((left, right) => deletionOrder(left[1]) - deletionOrder(right[1]));
    const deletedIds: string[] = [];
    const failures: string[] = [];
    let deletedEntries = 0;
    for (const [jobId] of ordered) {
      try {
        const deleted = await deleteRecognitionJob(jobId, token);
        deletedIds.push(jobId);
        deletedEntries += deleted.deleted;
      } catch (nextError) {
        failures.push(`${jobId.slice(0, 8)}: ${nextError instanceof Error ? nextError.message : "delete failed"}`);
      }
    }
    setSelectedForDelete((current) => {
      const next = new Map(current);
      for (const jobId of deletedIds) next.delete(jobId);
      return next;
    });
    if (selectedJobId && deletedIds.includes(selectedJobId)) {
      setSelectedJobId(null);
      setJobItems([]);
    }
    await refreshJobs();
    if (deletedIds.length > 0) setActionMessage(`Deleted ${deletedEntries} job entr${deletedEntries === 1 ? "y" : "ies"}.`);
    if (failures.length > 0) setError(`Could not delete ${failures.length} selected job(s): ${failures.join("; ")}`);
    setBulkDeleting(false);
  }

  return (
    <section className="mb-4 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase text-zinc-500">Recognition jobs</h3>
          <div className="mt-1 text-sm text-zinc-600">
            Unified journal for batch runs, child tasks, and item-card pipelines.
          </div>
        </div>
        <div className="rounded bg-zinc-100 px-3 py-2 text-sm tabular-nums text-zinc-700">
          {jobsTotal.toLocaleString()} jobs
        </div>
      </div>

      <div className="mt-4 rounded border border-zinc-200 bg-zinc-50 p-3">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Journal filters</div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_7rem_auto]">
          <select
            value={statusFilter}
            onChange={(event) => { setStatusFilter(event.target.value as JobStatusFilter); setJobsOffset(0); }}
            className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
          >
            <option value="">Any status</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="completed_with_errors">Completed with errors</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select
            value={typeFilter}
            onChange={(event) => { setTypeFilter(event.target.value as "" | RecognitionJobType); setJobsOffset(0); }}
            className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
          >
            <option value="">Any pipeline</option>
            <option value="ANNOTATION_LLM_PIPELINE">LLM annotation pipeline</option>
            <option value="ANNOTATION_HELPER_PIPELINE">Helper annotation pipeline</option>
            <option value="ANALYZE_LABEL">Label analysis</option>
            <option value="GENERATE_ALIASES">Source text metadata</option>
            <option value="GENERATE_DETECTION_PROPOSAL">Detection proposals</option>
            <option value="GENERATE_CV_META">Image metadata</option>
            <option value="GENERATE_ALL_META">All metadata</option>
            <option value="REGENERATE_ALL_META">Regenerate text and raster</option>
          </select>
          <select
            value={scopeFilter}
            onChange={(event) => { setScopeFilter(event.target.value as JobScopeFilter); setJobsOffset(0); }}
            className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
          >
            <option value="">Any scope</option>
            <option value="batch-parent">Batch parent</option>
            <option value="batch-child">Batch item</option>
            <option value="single-item">Item card</option>
          </select>
          <select
            value={sourceFilter}
            onChange={(event) => { setSourceFilter(event.target.value as "" | BatchSource); setJobsOffset(0); }}
            className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
          >
            <option value="">Any source</option>
            <option value="roskachestvo">Roskachestvo</option>
            <option value="svoe_vino">Svoe Vino</option>
          </select>
          <select
            value={jobsPageSize}
            onChange={(event) => { setJobsPageSize(Number(event.target.value)); setJobsOffset(0); }}
            aria-label="Jobs per page"
            className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
          >
            {JOB_PAGE_SIZES.map((size) => <option key={size} value={size}>{size} / page</option>)}
          </select>
          <button type="button" onClick={resetJournalFilters} className="h-10 rounded border border-zinc-300 bg-white px-4 text-sm font-medium hover:bg-zinc-100">
            Reset
          </button>
        </div>
      </div>

      {error && <div className="mt-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {actionMessage && <div className="mt-3 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{actionMessage}</div>}

      <details className="mt-3 rounded border border-zinc-200 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-zinc-800">Start metadata batch</summary>
        <p className="mt-2 text-xs leading-5 text-zinc-500">Creates a CV/text metadata batch from a source inventory filter. This form does not filter the journal above.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[180px_220px_110px_120px_auto_auto]">
          <select value={source} onChange={(event) => setSource(event.target.value as BatchSource)} className="h-10 rounded border border-zinc-300 px-3 text-sm">
            <option value="roskachestvo">Roskachestvo</option>
            <option value="svoe_vino">Svoe Vino</option>
          </select>
          <select value={jobType} onChange={(event) => setJobType(event.target.value as RecognitionJobType)} className="h-10 rounded border border-zinc-300 px-3 text-sm">
            <option value="GENERATE_ALIASES">Source text metadata</option>
            <option value="GENERATE_DETECTION_PROPOSAL">Detection proposals</option>
            <option value="GENERATE_CV_META">Image metadata</option>
            <option value="GENERATE_ALL_META">All metadata</option>
            <option value="REGENERATE_ALL_META">Regenerate text and raster</option>
          </select>
          <input value={batchSize} onChange={(event) => setBatchSize(Math.max(1, Number(event.target.value) || 1))} type="number" min={1} max={5000} aria-label="Batch size" className="h-10 rounded border border-zinc-300 px-3 text-sm" />
          <label className="flex h-10 items-center gap-2 rounded border border-zinc-300 px-3 text-sm"><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />Force</label>
          <button type="button" onClick={loadEstimate} disabled={loading} className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50">Estimate</button>
          <button type="button" onClick={startBatch} disabled={loading} className="h-10 rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-50">Start</button>
        </div>
      </details>

      <details className="mt-3 rounded border border-indigo-200 bg-indigo-50 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-indigo-950">LLM Wizard batch</summary>
        <p className="mt-2 text-xs leading-5 text-indigo-800">One frozen annotation card per line: <code>source,itemId,annotationTrackId</code>. Jobs orchestrates the same atomic stage runners and stops only the dependent card branch on human review.</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_11rem_11rem_11rem_12rem_auto]">
          <textarea value={llmCardsText} onChange={(event) => setLlmCardsText(event.target.value)} rows={3} placeholder="roskachestvo,3181011,478c582a-6289-4d79-9f9a-85681b257184" className="rounded border border-indigo-200 bg-white p-2 font-mono text-xs" />
          <select value={llmExecutionMode} onChange={(event) => setLlmExecutionMode(event.target.value as "session-chain" | "one-shot-chain")} className="h-10 rounded border border-indigo-200 bg-white px-2 text-xs">
            <option value="session-chain">Dialog session</option>
            <option value="one-shot-chain">Independent requests</option>
          </select>
          <select value={llmSiglipLabelMode} onChange={(event) => setLlmSiglipLabelMode(event.target.value as SiglipLabelMode)} className="h-10 rounded border border-violet-200 bg-white px-2 text-xs">
            <option value="off">SigLIP off</option>
            <option value="score-only">SigLIP score only</option>
            <option value="rerank">SigLIP rerank</option>
          </select>
          <select value={llmDinoLabelMode} onChange={(event) => setLlmDinoLabelMode(event.target.value as DinoLabelMode)} aria-label="LLM Wizard DINOv3 mode" className="h-10 rounded border border-emerald-200 bg-white px-2 text-xs">
            <option value="off">DINO off</option>
            <option value="observe">DINO observe</option>
            <option value="refine">DINO refine ROI</option>
          </select>
          <select value={llmStopAfterStage} onChange={(event) => setLlmStopAfterStage(event.target.value as "" | "ocr")} aria-label="LLM Wizard stopping stage" className="h-10 rounded border border-amber-200 bg-white px-2 text-xs">
            <option value="">Full pipeline</option>
            <option value="ocr">Through OCR · no Mask</option>
          </select>
          <button type="button" disabled={loading || !llmCardsText.trim()} onClick={() => void startLlmBatch()} className="rounded bg-indigo-700 px-4 text-sm font-semibold text-white disabled:opacity-50">Start LLM batch</button>
        </div>
      </details>

      {estimate && (
        <div className="mt-3 grid gap-3 rounded border border-zinc-200 bg-zinc-50 p-3 text-sm sm:grid-cols-4">
          <Metric label="Eligible" value={estimate.eligible} />
          <Metric label="Will queue" value={estimate.planned} />
          <Metric label="Batch size" value={estimate.batchSize} />
          <Metric label="Existing jobs" value={estimate.activeOrCompletedJobs} />
        </div>
      )}

      {selectedForDelete.size > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded border border-red-200 bg-red-50 px-3 py-2">
          <span className="text-sm font-medium text-red-900">Selected: {selectedForDelete.size}</span>
          <div className="flex gap-2">
            <button type="button" onClick={() => setSelectedForDelete(new Map())} disabled={bulkDeleting} className="h-9 rounded border border-red-200 bg-white px-3 text-sm font-medium text-red-800 disabled:opacity-50">Clear</button>
            <button type="button" onClick={() => void deleteSelectedJobs()} disabled={bulkDeleting} className="h-9 rounded bg-red-700 px-4 text-sm font-semibold text-white disabled:opacity-50">{bulkDeleting ? "Deleting…" : "Delete selected"}</button>
          </div>
        </div>
      )}

      <div className="mt-4 overflow-auto">
        <table className="w-full min-w-[1320px] border-collapse text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
            <tr>
              <th className="w-10 px-3 py-2">
                <input type="checkbox" checked={allPageJobsSelected} onChange={togglePageSelection} disabled={selectablePageJobs.length === 0 || bulkDeleting} aria-label="Select all deletable jobs on this page" />
              </th>
              <th className="px-3 py-2">Job</th>
              <th className="px-3 py-2">Scope</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Progress</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Started</th>
              <th className="px-3 py-2">Finished</th>
              <th className="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!loading && jobs.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-10 text-center text-sm text-zinc-500">No jobs match the selected filters.</td></tr>
            )}
            {jobs.map((job) => {
              const active = job.status === "queued" || job.status === "running";
              const terminal = ["completed", "failed", "completed_with_errors", "cancelled"].includes(job.status);
              const annotationJob = job.type === "ANNOTATION_LLM_PIPELINE";
              const annotationNeedsRetry = ["failed", "completed_with_errors", "cancelled"].includes(job.status)
                || job.result.status === "blocked_by_review"
                || job.result.status === "blocked_multipackage";
              const transport = jobTransportFailure(job.result);
              const canRetryCurrent = terminal && job.scope !== "batch-parent"
                && (!annotationJob || Boolean(job.annotationVersionId) && annotationNeedsRetry);
              return (
              <tr key={job.jobId} className="border-t border-zinc-100">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selectedForDelete.has(job.jobId)}
                    onChange={() => toggleJobSelection(job)}
                    disabled={!terminal || bulkDeleting}
                    aria-label={terminal ? `Select job ${job.jobId.slice(0, 8)} for deletion` : `Job ${job.jobId.slice(0, 8)} must be stopped before deletion`}
                    title={terminal ? "Select for deletion" : "Cancel the active job before deleting it"}
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => { setSelectedJobId(job.jobId); setJobItemsOffset(0); }}
                    className="font-mono text-xs text-zinc-950 hover:underline"
                  >
                    {job.jobId.slice(0, 8)}
                  </button>
                  <div className="mt-1 text-xs text-zinc-500">{job.type}</div>
                </td>
                <td className="px-3 py-2">
                  <span className="rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700">
                    {formatJobScope(job.scope)}
                  </span>
                  {job.parentJobId && (
                    <div className="mt-1 font-mono text-xs text-zinc-500">parent {job.parentJobId.slice(0, 8)}</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <JobTargetLink target={job.target} />
                </td>
                <td className="px-3 py-2">
                  <span>{job.status}</span>
                  {job.status === "running" && job.heartbeatAt && <div className="mt-1 text-[11px] text-sky-700" title={job.workerId ?? undefined}>heartbeat {formatRelativeAge(job.heartbeatAt)}</div>}
                  {Boolean(job.recoveryCount) && <div className="mt-1 text-[11px] text-amber-700">recovered {job.recoveryCount} time(s)</div>}
                  {transport && <div className="mt-1 text-[11px] font-medium text-red-700">{formatTransportFailure(transport)}</div>}
                  {job.error && <div className="mt-1 max-w-72 text-xs text-red-700">{job.error}</div>}
                </td>
                <td className="px-3 py-2">
                  <ProgressBar job={job} />
                </td>
                <JobDateCell value={job.createdAt} />
                <JobDateCell value={job.startedAt} />
                <JobDateCell value={job.finishedAt} />
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    {active && <button
                      type="button"
                      onClick={() => cancelJob(job.jobId)}
                      disabled={bulkDeleting || busyJobId === job.jobId || job.status === "running" && job.cancelRequested}
                      className="h-8 rounded border border-amber-300 px-3 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                    >
                      {job.cancelRequested ? "Stopping…" : "Cancel"}
                    </button>}
                    {canRetryCurrent && <button
                      type="button"
                      onClick={() => retryJob(job, "current-version")}
                      disabled={bulkDeleting || busyJobId === job.jobId}
                      className="h-8 rounded border border-zinc-300 px-3 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                    >
                      {annotationJob ? "Retry current version" : "Retry same job"}
                    </button>}
                    {terminal && <button
                      type="button"
                      onClick={() => retryJob(job, "new-version")}
                      disabled={bulkDeleting || busyJobId === job.jobId}
                      className="h-8 rounded border border-indigo-300 px-3 text-xs font-medium text-indigo-800 hover:bg-indigo-50 disabled:opacity-50"
                    >
                      {annotationJob ? "Retry as new version" : "Retry as new job"}
                    </button>}
                    {terminal && <button
                      type="button"
                      onClick={() => void deleteJob(job)}
                      disabled={bulkDeleting || busyJobId === job.jobId}
                      className="h-8 rounded border border-red-300 px-3 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      Delete
                    </button>}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-3">
        <span className="text-sm tabular-nums text-zinc-500">
          {jobsTotal === 0 ? "0 jobs" : `${jobsOffset + 1}-${Math.min(jobsOffset + jobs.length, jobsTotal)} of ${jobsTotal}`}
        </span>
        <div className="flex items-center gap-3">
          <button type="button" disabled={jobsOffset === 0 || loading} onClick={() => setJobsOffset(Math.max(0, jobsOffset - jobsPageSize))} className="h-9 rounded border border-zinc-300 px-3 text-sm font-medium disabled:opacity-40">Previous</button>
          <span className="text-sm tabular-nums text-zinc-500">Page {jobsPage} of {jobsPageCount}</span>
          <button type="button" disabled={jobsOffset + jobsPageSize >= jobsTotal || loading} onClick={() => setJobsOffset(jobsOffset + jobsPageSize)} className="h-9 rounded border border-zinc-300 px-3 text-sm font-medium disabled:opacity-40">Next</button>
        </div>
      </div>

      {selectedJob && (
        <div className="mt-4 rounded border border-zinc-200 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-sm font-semibold">Child items for {selectedJob.jobId.slice(0, 8)}</div>
              <select
                value={selectedItemStatus}
                onChange={(event) => { setSelectedItemStatus(event.target.value); setJobItemsOffset(0); }}
                className="h-8 rounded border border-zinc-300 px-2 text-xs outline-none focus:border-zinc-600"
              >
                <option value="">All</option>
                <option value="queued">Queued</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>
            <button
              type="button"
              onClick={() => { setSelectedJobId(null); setJobItemsOffset(0); }}
              className="h-8 rounded border border-zinc-300 px-3 text-xs font-medium hover:bg-zinc-50"
            >
              Close
            </button>
          </div>
          {visibleJobItems.length === 0 ? (
            <div className="mt-2 text-sm text-zinc-500">No child jobs for this filter.</div>
          ) : (
            <div className="mt-2 grid gap-2">
              {visibleJobItems.map((item) => (
                <div key={item.jobId} className="rounded bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
                  <Link
                    href={jobItemHref(item)}
                    className="font-medium text-zinc-950 hover:underline"
                  >
                    {item.source}/{item.sourceItemId}
                  </Link>
                  <span className="ml-2 text-zinc-500">{item.status}</span>
                  {item.result.status === "blocked_by_review" && <span className="ml-2 rounded bg-amber-100 px-2 py-1 text-xs text-amber-800">human required</span>}
                  {failedStage(item.result) && <span className="ml-2 rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-800">stage: {failedStage(item.result)}</span>}
                  {jobTransportFailure(item.result) && <span className="ml-2 rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-800">{formatTransportFailure(jobTransportFailure(item.result)!)}</span>}
                  {item.error && <span className="ml-2 text-red-700">{item.error}</span>}
                </div>
              ))}
            </div>
          )}
          {jobItemsTotal > CHILD_PAGE_SIZE && (
            <div className="mt-3 flex items-center justify-between border-t border-zinc-200 pt-3">
              <span className="text-xs tabular-nums text-zinc-500">{jobItemsOffset + 1}-{Math.min(jobItemsOffset + jobItems.length, jobItemsTotal)} of {jobItemsTotal}</span>
              <div className="flex gap-2">
                <button type="button" disabled={jobItemsOffset === 0} onClick={() => setJobItemsOffset(Math.max(0, jobItemsOffset - CHILD_PAGE_SIZE))} className="h-8 rounded border border-zinc-300 px-3 text-xs disabled:opacity-40">Previous</button>
                <button type="button" disabled={jobItemsOffset + CHILD_PAGE_SIZE >= jobItemsTotal} onClick={() => setJobItemsOffset(jobItemsOffset + CHILD_PAGE_SIZE)} className="h-8 rounded border border-zinc-300 px-3 text-xs disabled:opacity-40">Next</button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-xs uppercase text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-950">{value.toLocaleString()}</div>
    </div>
  );
}

type JobItem = {
  jobId: string;
  source: string;
  sourceItemId: string;
  status: string;
  attempt: number;
  error: string | null;
  result: Record<string, unknown>;
};

function failedStage(result: Record<string, unknown>) {
  const failure = result.failure;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  return typeof (failure as Record<string, unknown>).stage === "string" ? String((failure as Record<string, unknown>).stage) : null;
}

function jobTransportFailure(result: Record<string, unknown>) {
  const failure = result.failure;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  const transport = (failure as Record<string, unknown>).transport;
  return transport && typeof transport === "object" && !Array.isArray(transport) ? transport as Record<string, unknown> : null;
}

function formatTransportFailure(transport: Record<string, unknown>) {
  const status = transport.providerStatus ?? transport.controllerStatus;
  const kind = typeof transport.kind === "string" ? transport.kind : "transport";
  return `${kind}${typeof status === "number" ? ` · HTTP ${status}` : ""}${transport.retryable === true ? " · retryable" : ""}`;
}

function formatRelativeAge(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "unknown";
  if (elapsed < 5_000) return "now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  return `${Math.floor(elapsed / 60_000)}m ago`;
}

function ProgressBar({ job }: { job: RecognitionJob }) {
  const total = Math.max(1, job.progress.total);
  const done = job.progress.succeeded + job.progress.failed + (job.progress.cancelled ?? 0);
  const width = Math.min(100, Math.round((done / total) * 100));

  return (
    <div>
      <div className="h-2 w-full overflow-hidden rounded bg-zinc-100">
        <div className="h-full bg-zinc-950" style={{ width: `${width}%` }} />
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        {job.progress.succeeded}/{job.progress.total} ok, {job.progress.humanRequired ?? 0} human, {job.progress.failed} failed, {job.progress.queued} queued
      </div>
    </div>
  );
}

function JobTargetLink({ target }: { target: Record<string, unknown> }) {
  const source = target.source;
  const sourceItemId = target.sourceItemId;
  if (typeof source === "string" && typeof sourceItemId === "string") {
    return (
      <Link
        href={`/admin/recognition/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}?section=jobs`}
        className="font-medium text-zinc-950 hover:underline"
      >
        {formatSource(source)} / {sourceItemId}
      </Link>
    );
  }

  return <span>{formatTarget(target)}</span>;
}

function formatTarget(target: Record<string, unknown>) {
  const filter = target.filter as { source?: string } | undefined;
  const items = Array.isArray(target.items) ? target.items : [];
  const scope = typeof target.scope === "string" ? target.scope : "batch";
  if (filter?.source) return `${scope} / ${formatSource(filter.source)} / ${items.length} frozen`;
  if (items.length) return `${scope} / ${items.length} frozen`;
  const source = target.source;
  const sourceItemId = target.sourceItemId;
  return `${typeof source === "string" ? formatSource(source) : "-"} / ${typeof sourceItemId === "string" ? sourceItemId : "-"}`;
}

function formatSource(value: string) {
  if (value === "svoe_vino") return "Svoe Vino";
  if (value === "roskachestvo") return "Roskachestvo";
  return value;
}

function formatJobScope(value: RecognitionJob["scope"]) {
  if (value === "batch-parent") return "Batch parent";
  if (value === "batch-child") return "Batch item";
  return "Item card";
}

function isTerminalJob(job: RecognitionJob) {
  return ["completed", "failed", "completed_with_errors", "cancelled"].includes(job.status);
}

function deletionOrder(scope: RecognitionJob["scope"]) {
  if (scope === "batch-child") return 0;
  if (scope === "single-item") return 1;
  return 2;
}

function formatDate(value: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function JobDateCell({ value }: { value: string | null }) {
  return (
    <td className="whitespace-nowrap px-3 py-2 text-zinc-500" title={value ?? undefined}>
      {value ? formatDate(value) : "—"}
    </td>
  );
}

function parseLlmCards(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const [source, sourceItemId, annotationTrackId] = line.split(",").map((part) => part.trim());
    if ((source !== "svoe_vino" && source !== "roskachestvo") || !sourceItemId || !annotationTrackId) throw new Error(`Invalid LLM card at line ${index + 1}`);
    return { source: source as "svoe_vino" | "roskachestvo", sourceItemId, annotationTrackId };
  });
}

function jobItemHref(item: JobItem) {
  const track = typeof item.result.annotationTrackId === "string" ? item.result.annotationTrackId : null;
  const blocked = item.result.status === "blocked_by_review";
  const params = new URLSearchParams({ section: blocked ? "annotation" : "jobs" });
  if (track) params.set("track", track);
  return `/admin/recognition/${encodeURIComponent(item.source)}/${encodeURIComponent(item.sourceItemId)}?${params}`;
}
