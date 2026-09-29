"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createAnnotationCohort, createDatasetVersion, createRecognitionBatchTargetJob, exportDatasetVersionArtifact, getAnnotationSummary, listAnnotationCohorts, listRecognitionInventory, type AnnotationCohort, type AnnotationSummary, type DatasetVersion, type RecognitionInventoryItem } from "@/lib/admin/api";
import { getStoredToken } from "@/lib/admin/auth";
import { AdminAuthPanel } from "./AdminAuthPanel";
import { AdminNavLinks } from "./AdminNavLinks";

type CatalogSource = "all" | "svoe_vino" | "roskachestvo";
type AnnotationStatus = "missing" | "needs-review" | "reviewed" | "no-label" | "invalid-image" | "needs-ocr" | "needs-ocr-review" | "ready-for-export";
type AnalysisStatus = "analysis-missing" | "analysis-needs-review" | "analysis-accepted" | "analysis-needs-tuning" | "analysis-rejected";
type CatalogIdentityStatus = "identity-missing" | "identity-confirmed" | "identity-corrected" | "identity-no-match" | "identity-ambiguous";
type QueueMode = AnnotationStatus | AnalysisStatus | CatalogIdentityStatus | "missing-proposal";

const PAGE_SIZE = 50;

export function AdminAnnotationQueuePage() {
  const [token, setToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [items, setItems] = useState<RecognitionInventoryItem[]>([]);
  const [source, setSource] = useState<CatalogSource>("all");
  const [queueMode, setQueueMode] = useState<QueueMode>("needs-review");
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<AnnotationSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [cohorts, setCohorts] = useState<AnnotationCohort[]>([]);
  const [actionLoading, setActionLoading] = useState(false);
  const isAnalysisQueue = queueMode.startsWith("analysis-");
  const isCatalogIdentityQueue = queueMode.startsWith("identity-");
  const annotationStatus: AnnotationStatus = isAnalysisQueue || isCatalogIdentityQueue ? "reviewed" : queueMode === "missing-proposal" ? "missing" : queueMode as AnnotationStatus;
  const analysisStatus = isAnalysisQueue ? queueMode.replace("analysis-", "") as "missing" | "needs-review" | "accepted" | "needs-tuning" | "rejected" : undefined;
  const catalogIdentityStatus = isCatalogIdentityQueue ? queueMode.replace("identity-", "") as "missing" | "confirmed" | "corrected" | "no-match" | "ambiguous" : undefined;

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

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await listRecognitionInventory(
          { source, annotationStatus, analysisStatus, catalogIdentityStatus, limit: PAGE_SIZE, offset },
          token
        );
        const nextSummary = await getAnnotationSummary(source, token);
        const cohortResponse = await listAnnotationCohorts(token).catch(() => ({ items: [] as AnnotationCohort[] }));
        if (cancelled) return;
        setItems(response.items);
        setTotal(response.total);
        setSummary(nextSummary);
        setCohorts(cohortResponse.items);
      } catch (nextError) {
        if (cancelled) return;
        setItems([]);
        setTotal(0);
        setSummary(null);
        setError(nextError instanceof Error ? nextError.message : "Failed to load annotation queue");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [analysisStatus, annotationStatus, authChecked, catalogIdentityStatus, offset, source, token]);

  async function handleBatchAnalyze() {
    if (!token || selectedKeys.length === 0) return;
    setActionLoading(true); setError(null); setMessage(null);
    try {
      const job = await createRecognitionBatchTargetJob({ items: selectedKeys.map(parseCohortItemKey) }, token, { batchSize: selectedKeys.length, force: true, type: "ANALYZE_LABEL" });
      setMessage(`Label analysis batch queued: ${job.jobId}.`); setSelectedKeys([]);
    } catch (nextError) { setError(nextError instanceof Error ? nextError.message : "Failed to queue label analysis"); }
    finally { setActionLoading(false); }
  }

  const queueItems = useMemo(
    () =>
      [...items]
        .filter((item) => (queueMode === "missing-proposal" ? !item.metadata?.hasGeneratedLabelRoi : true))
        .sort((a, b) => annotationRank(a) - annotationRank(b) || (a.title ?? "").localeCompare(b.title ?? "", "ru")),
    [items, queueMode]
  );
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const hasNextPage = offset + PAGE_SIZE < total;

  function handleTokenChange(nextToken: string | null) {
    setToken(nextToken);
    if (!nextToken) {
      setItems([]);
      setTotal(0);
      setSummary(null);
      setError(null);
      setSelectedKeys([]);
      setCohorts([]);
    }
  }

  function toggleSelected(item: RecognitionInventoryItem) {
    const key = cohortItemKey(item.source, item.sourceItemId);
    setSelectedKeys((current) => current.includes(key) ? current.filter((value) => value !== key) : [...current, key]);
  }

  async function handleCreateCohort() {
    if (!token || selectedKeys.length === 0) return;
    const name = window.prompt("Cohort name", `annotation-cohort-${new Date().toISOString().slice(0, 10)}`)?.trim();
    if (!name) return;
    setActionLoading(true);
    setError(null);
    setMessage(null);
    try {
      const cohort = await createAnnotationCohort({ name, items: selectedKeys.map(parseCohortItemKey) }, token);
      setCohorts((current) => [cohort, ...current]);
      setSelectedKeys([]);
      setMessage(`Cohort ${cohort.name} created with ${cohort.itemCount} item(s).`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to create cohort");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleFreezeVersion(cohort: AnnotationCohort) {
    if (!token) return;
    const nextVersion = (cohort.versions[0]?.version ?? 0) + 1;
    const name = window.prompt("Dataset version name", `${cohort.name}-v${nextVersion}`)?.trim();
    if (!name) return;
    setActionLoading(true);
    setError(null);
    setMessage(null);
    try {
      const version = await createDatasetVersion(cohort.id, { name }, token);
      const response = await listAnnotationCohorts(token);
      setCohorts(response.items);
      setMessage(`Dataset ${version.name} frozen with ${version.itemCount} item(s).`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to freeze dataset version");
    } finally {
      setActionLoading(false);
    }
  }

  async function handleExportVersion(version: DatasetVersion) {
    if (!token) return;
    setActionLoading(true);
    setError(null);
    setMessage(null);
    try {
      const artifact = await exportDatasetVersionArtifact(version.id, token);
      setMessage(`Exported ${artifact.itemCount} item(s) to ${artifact.outputRoot}; SHA-256 ${artifact.annotationsSha256.slice(0, 12)}…`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to export dataset version");
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
            <h2 className="text-lg font-semibold">Label annotation queue</h2>
            <p className="text-sm text-zinc-500">Review detector proposals and create training ground truth.</p>
          </div>
          <AdminNavLinks active="annotations" />
        </div>

        {!authChecked && <section className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">Checking admin session...</section>}

        {authChecked && !token && (
          <section className="rounded-lg border border-zinc-200 bg-white p-6">
            <div className="text-sm font-semibold">Not logged in</div>
            <div className="mt-1 text-sm text-zinc-500">Log in to open the annotation queue.</div>
          </section>
        )}

        {authChecked && token && (
          <>
            <AnnotationSummaryPanel summary={summary} loading={loading} />

            <section className="mb-4 rounded-lg border border-zinc-200 bg-white p-4">
              <div className="grid gap-3 md:grid-cols-[220px_220px_auto]">
                <select
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value as CatalogSource);
                    setOffset(0);
                  }}
                  className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
                >
                  <option value="all">All sources</option>
                  <option value="svoe_vino">Svoe Vino</option>
                  <option value="roskachestvo">Roskachestvo</option>
                </select>
                <select
                  value={queueMode}
                  onChange={(event) => {
                    setQueueMode(event.target.value as QueueMode);
                    setOffset(0);
                  }}
                  className="h-10 rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600"
                >
                  <option value="needs-review">Needs review</option>
                  <option value="missing-proposal">Missing proposal</option>
                  <option value="missing">No annotation</option>
                  <option value="reviewed">Reviewed</option>
                  <option value="needs-ocr">Needs OCR</option>
                  <option value="needs-ocr-review">Needs OCR review</option>
                  <option value="ready-for-export">Ready for text export</option>
                  <option value="no-label">No label</option>
                  <option value="invalid-image">Invalid image</option>
                  <option value="analysis-missing">CV analysis missing</option>
                  <option value="analysis-needs-review">CV analysis needs review</option>
                  <option value="analysis-accepted">CV analysis accepted</option>
                  <option value="analysis-needs-tuning">CV analysis needs tuning</option>
                  <option value="analysis-rejected">CV analysis rejected</option>
                  <option value="identity-missing">Catalog identity missing</option>
                  <option value="identity-confirmed">Catalog identity confirmed</option>
                  <option value="identity-corrected">Catalog identity corrected</option>
                  <option value="identity-no-match">Catalog identity no match</option>
                  <option value="identity-ambiguous">Catalog identity ambiguous</option>
                </select>
                <div className="flex items-center text-sm text-zinc-500">
                  {loading ? "Loading..." : `${queueItems.length.toLocaleString()} shown / ${total.toLocaleString()} item(s) / page ${page}`}
                </div>
              </div>
            </section>

            <section className="mb-4 rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold uppercase text-zinc-500">Cohorts and dataset versions</h3>
                  <div className="mt-1 text-sm text-zinc-500">{selectedKeys.length} item(s) selected on the queue.</div>
                </div>
                <div className="flex gap-2"><button type="button" onClick={() => void handleBatchAnalyze()} disabled={actionLoading || selectedKeys.length === 0} className="h-10 rounded border border-zinc-300 px-4 text-sm font-semibold disabled:opacity-40">Analyze selected</button><button type="button" onClick={() => void handleCreateCohort()} disabled={actionLoading || selectedKeys.length === 0} className="h-10 rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-40">Create cohort</button></div>
              </div>
              {cohorts.length > 0 && (
                <div className="mt-3 grid gap-2">
                  {cohorts.slice(0, 8).map((cohort) => (
                    <div key={cohort.id} className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                        <div className="text-sm font-medium text-zinc-900">{cohort.name}</div>
                        <div className="text-xs text-zinc-500">{cohort.itemCount} items · {cohort.status} · {cohort.versions.length} version(s)</div>
                        </div>
                        <button type="button" onClick={() => void handleFreezeVersion(cohort)} disabled={actionLoading || cohort.status === "archived"} className="h-9 rounded border border-zinc-300 px-3 text-xs font-medium disabled:opacity-40">
                          Freeze new version
                        </button>
                      </div>
                      {cohort.versions.length > 0 && (
                        <div className="mt-2 grid gap-1 border-t border-zinc-200 pt-2">
                          {cohort.versions.slice(0, 5).map((version) => (
                            <div key={version.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-600">
                              <span>{version.name} · v{version.version} · {version.itemCount} items</span>
                              <button type="button" onClick={() => void handleExportVersion(version)} disabled={actionLoading} className="h-8 rounded border border-zinc-300 bg-white px-3 font-medium disabled:opacity-40">
                                Export artifact
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {message && <section className="mb-4 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-700">{message}</section>}
            {error && <section className="mb-4 rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</section>}

            <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
              {queueItems.length === 0 && !loading ? (
                <div className="px-4 py-10 text-center text-sm text-zinc-500">No items in this queue.</div>
              ) : (
                <div className="divide-y divide-zinc-100">
                  {queueItems.map((item, index) => (
                    <QueueRow
                      key={`${item.source}:${item.sourceItemId}`}
                      item={item}
                      prevItem={queueItems[index - 1] ?? null}
                      nextItem={queueItems[index + 1] ?? null}
                      position={offset + index + 1}
                      total={total}
                      queueMode={queueMode}
                      selected={selectedKeys.includes(cohortItemKey(item.source, item.sourceItemId))}
                      onToggleSelected={() => toggleSelected(item)}
                    />
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between border-t border-zinc-200 px-4 py-3">
                <button
                  type="button"
                  disabled={offset === 0 || loading}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  className="h-10 rounded border border-zinc-300 px-4 text-sm font-medium disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={!hasNextPage || loading}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
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

function AnnotationSummaryPanel({ summary, loading }: { summary: AnnotationSummary | null; loading: boolean }) {
  const exportPercent = summary?.exportReadyPercent ?? 0;
  return (
    <section className="mb-4 rounded-lg border border-zinc-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase text-zinc-500">Dataset readiness</h3>
          <div className="mt-1 text-sm text-zinc-500">
            {loading && !summary ? "Loading summary..." : `${formatNumber(summary?.readyForExport)} ready for export / ${formatNumber(summary?.totalItems)} total`}
          </div>
        </div>
        <div className="text-right">
          <div className="text-2xl font-semibold text-zinc-950">{exportPercent}%</div>
          <div className="text-xs uppercase text-zinc-400">export ready</div>
        </div>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded bg-zinc-100">
        <div className="h-full rounded bg-emerald-500" style={{ width: `${Math.max(0, Math.min(100, exportPercent))}%` }} />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryMetric label="Total items" value={summary?.totalItems} />
        <SummaryMetric label="With proposal" value={summary?.withProposal} suffix={`${summary?.proposalCoveragePercent ?? 0}%`} />
        <SummaryMetric label="Missing proposal" value={summary?.missingProposal} />
        <SummaryMetric label="Needs review" value={summary?.needsReview} />
        <SummaryMetric label="Reviewed bbox" value={summary?.reviewedBbox} suffix={`${summary?.reviewedPercent ?? 0}%`} />
        <SummaryMetric label="Backend OCR" value={summary?.withBackendOcr} />
        <SummaryMetric label="Reviewed OCR" value={summary?.withReviewedOcrText} />
        <SummaryMetric label="Text export ready" value={summary?.textReadyForExport} suffix={`${summary?.ocrReadyPercent ?? 0}%`} />
        <SummaryMetric label="Needs OCR" value={summary?.needsOcr} />
        <SummaryMetric label="Needs OCR review" value={summary?.needsOcrReview} />
        <SummaryMetric label="CV analyzed" value={summary?.withLabelAnalysis} />
        <SummaryMetric label="CV needs review" value={summary?.needsLabelAnalysisReview} />
        <SummaryMetric label="CV accepted" value={summary?.labelAnalysisAccepted} />
        <SummaryMetric label="CV needs tuning" value={summary?.labelAnalysisNeedsTuning} />
        <SummaryMetric label="CV rejected" value={summary?.labelAnalysisRejected} />
        <SummaryMetric label="Identity reviewed" value={summary?.withCatalogIdentity} suffix={`${summary?.catalogIdentityReadyPercent ?? 0}% of analyzed`} />
        <SummaryMetric label="Identity missing" value={summary?.needsCatalogIdentity} />
        <SummaryMetric label="Identity confirmed" value={summary?.catalogIdentityConfirmed} />
        <SummaryMetric label="Identity corrected" value={summary?.catalogIdentityCorrected} />
        <SummaryMetric label="Identity no match" value={summary?.catalogIdentityNoMatch} />
        <SummaryMetric label="Identity ambiguous" value={summary?.catalogIdentityAmbiguous} />
        <SummaryMetric label="No label" value={summary?.noLabel} />
        <SummaryMetric label="Invalid image" value={summary?.invalidImage} />
        <SummaryMetric label="No annotation" value={summary?.noAnnotation} />
      </div>
    </section>
  );
}

function SummaryMetric({ label, value, suffix }: { label: string; value: number | undefined; suffix?: string }) {
  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2">
      <div className="text-xs font-semibold uppercase text-zinc-400">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-lg font-semibold text-zinc-950">{formatNumber(value)}</span>
        {suffix ? <span className="text-xs text-zinc-500">{suffix}</span> : null}
      </div>
    </div>
  );
}

function formatNumber(value: number | undefined) {
  return typeof value === "number" ? value.toLocaleString() : "-";
}

function QueueRow({
  item,
  prevItem,
  nextItem,
  position,
  total,
  queueMode,
  selected,
  onToggleSelected,
}: {
  item: RecognitionInventoryItem;
  prevItem: RecognitionInventoryItem | null;
  nextItem: RecognitionInventoryItem | null;
  position: number;
  total: number;
  queueMode: QueueMode;
  selected: boolean;
  onToggleSelected: () => void;
}) {
  const href = annotationHref(item, prevItem, nextItem, position, total, queueMode);
  const status = item.metadata?.annotationStatus ?? (item.metadata?.hasCvMeta ? "needs-review" : "missing");
  return (
    <div className="grid gap-3 px-4 py-4 hover:bg-zinc-50 md:grid-cols-[32px_1fr_160px_140px] md:items-center">
      <input type="checkbox" checked={selected} onChange={onToggleSelected} aria-label={`Select ${item.title ?? item.sourceItemId}`} className="h-4 w-4" />
      <Link href={href} className="min-w-0 hover:underline">
        <div className="font-medium text-zinc-950">{item.title ?? "Untitled"}</div>
        <div className="mt-1 text-xs text-zinc-500">
          {formatSource(item.source)} / {item.sourceItemId}
        </div>
      </Link>
      <span className={annotationBadgeClassName(status)}>{formatAnnotationStatus(status)}</span>
      <div className="text-sm text-zinc-500">
        {queueMode.startsWith("identity-")
          ? item.metadata?.catalogIdentityStatus
            ? `${item.metadata.catalogIdentityStatus} · r${item.metadata.catalogIdentityRevision ?? "?"}`
            : "identity missing"
          : item.metadata?.hasReviewedOcrText
          ? "ocr reviewed"
          : item.metadata?.hasBackendOcr
            ? "ocr snapshot"
            : item.metadata?.hasReviewedLabelRoi
              ? "needs ocr"
              : item.metadata?.hasGeneratedLabelRoi
                ? "proposal"
                : "no bbox"}
      </div>
    </div>
  );
}

function annotationHref(
  item: RecognitionInventoryItem,
  prevItem: RecognitionInventoryItem | null,
  nextItem: RecognitionInventoryItem | null,
  position: number,
  total: number,
  queueMode: QueueMode
) {
  const params = new URLSearchParams({
    section: "annotation",
    queue: queueMode,
    pos: String(position),
    total: String(total),
  });
  if (prevItem) params.set("prev", itemHref(prevItem));
  if (nextItem) params.set("next", itemHref(nextItem));
  return `${itemHref(item)}?${params.toString()}`;
}

function itemHref(item: RecognitionInventoryItem) {
  return `/admin/recognition/${encodeURIComponent(item.source)}/${encodeURIComponent(item.sourceItemId)}`;
}

function annotationRank(item: RecognitionInventoryItem) {
  const status = item.metadata?.annotationStatus ?? (item.metadata?.hasCvMeta ? "needs-review" : "missing");
  if (status === "needs-review") return 0;
  if (status === "missing") return 1;
  if (status === "invalid-image") return 2;
  if (status === "reviewed") return 3;
  return 4;
}

function annotationBadgeClassName(status: string) {
  const base = "inline-flex w-fit rounded px-2 py-1 text-xs font-medium";
  if (status === "reviewed") return `${base} bg-emerald-50 text-emerald-700`;
  if (status === "needs-review" || status === "generated") return `${base} bg-amber-50 text-amber-700`;
  if (status === "no-label") return `${base} bg-zinc-100 text-zinc-700`;
  if (status === "invalid-image") return `${base} bg-red-50 text-red-700`;
  return `${base} bg-zinc-100 text-zinc-600`;
}

function formatAnnotationStatus(status: string) {
  if (status === "needs-review") return "needs review";
  if (status === "needs-ocr") return "needs ocr";
  if (status === "needs-ocr-review") return "needs ocr review";
  if (status === "ready-for-export") return "ready for text export";
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

function cohortItemKey(source: string, sourceItemId: string) {
  return `${source}\u0000${sourceItemId}`;
}

function parseCohortItemKey(key: string): { source: "svoe_vino" | "roskachestvo"; sourceItemId: string } {
  const separator = key.indexOf("\u0000");
  return {
    source: key.slice(0, separator) as "svoe_vino" | "roskachestvo",
    sourceItemId: key.slice(separator + 1),
  };
}
