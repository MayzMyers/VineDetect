"use client";

import { useEffect, useMemo, useState } from "react";
import { addTrainingEvaluation, createModelVersion, createTrainingRun, getDatasetArtifactReadiness, listAnnotationCohorts, listTrainingRuns, updateModelStatus, updateTrainingRunStatus, type AnnotationCohort, type DatasetArtifactReadiness, type ModelVersion, type TrainingRun, type TrainingTask } from "@/lib/admin/api";
import { getStoredToken } from "@/lib/admin/auth";
import { AdminAuthPanel } from "./AdminAuthPanel";
import { AdminNavLinks } from "./AdminNavLinks";

const TASKS: TrainingTask[] = ["label-roi", "physical-label-roi", "ocr-region", "source-matching", "alias-ranking", "bottle-outline", "label-elements", "label-palette"];

export function AdminTrainingPage() {
  const [token, setToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [cohorts, setCohorts] = useState<AnnotationCohort[]>([]);
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [artifactId, setArtifactId] = useState("");
  const [task, setTask] = useState<TrainingTask>("label-roi");
  const [name, setName] = useState("");
  const [framework, setFramework] = useState("manual-external");
  const [configText, setConfigText] = useState("{}");
  const [readiness, setReadiness] = useState<DatasetArtifactReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const artifacts = useMemo(() => cohorts.flatMap((cohort) => cohort.versions.flatMap((version) => version.artifacts ?? [])), [cohorts]);
  const selectedArtifactId = artifactId || artifacts[0]?.id || "";

  useEffect(() => {
    const id = window.setTimeout(() => { setToken(getStoredToken()); setAuthChecked(true); }, 0);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    Promise.all([listAnnotationCohorts(token), listTrainingRuns(token)])
      .then(([cohortResponse, runResponse]) => {
        if (cancelled) return;
        setCohorts(cohortResponse.items);
        setRuns(runResponse.items);
      })
      .catch((nextError) => { if (!cancelled) setError(errorMessage(nextError, "Failed to load training registry")); });
    return () => { cancelled = true; };
  }, [token]);
  useEffect(() => {
    if (!token || !selectedArtifactId) return;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      setReadiness(null);
      setReadinessLoading(true);
      try {
        const value = await getDatasetArtifactReadiness(selectedArtifactId, task, token);
        if (!cancelled) setReadiness(value);
      } catch (nextError) {
        if (!cancelled) setError(errorMessage(nextError, "Failed to validate dataset artifact"));
      } finally {
        if (!cancelled) setReadinessLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [selectedArtifactId, task, token]);

  async function reload(currentToken = token) {
    if (!currentToken) return;
    setError(null);
    try {
      const [cohortResponse, runResponse] = await Promise.all([listAnnotationCohorts(currentToken), listTrainingRuns(currentToken)]);
      setCohorts(cohortResponse.items);
      setRuns(runResponse.items);
    } catch (nextError) { setError(errorMessage(nextError, "Failed to load training registry")); }
  }

  async function act(action: () => Promise<unknown>, success: string) {
    if (!token) return;
    setBusy(true); setError(null); setMessage(null);
    try { await action(); await reload(token); setMessage(success); }
    catch (nextError) { setError(errorMessage(nextError, "Training registry action failed")); }
    finally { setBusy(false); }
  }

  async function handleCreateRun() {
    if (!selectedArtifactId || !name.trim()) return;
    let configSnapshot: Record<string, unknown>;
    try { configSnapshot = parseObject(configText); }
    catch (nextError) { setError(errorMessage(nextError, "Invalid config JSON")); return; }
    await act(() => createTrainingRun({ datasetArtifactId: selectedArtifactId, task, name: name.trim(), framework: framework.trim(), configSnapshot }, token), "Training run queued.");
    setName("");
  }

  return <main className="min-h-dvh bg-zinc-100 text-zinc-950">
    <AdminAuthPanel token={token} onTokenChange={(next) => { setToken(next); if (!next) { setRuns([]); setCohorts([]); } }} />
    <div className="mx-auto max-w-7xl px-5 py-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">Training registry</h2><p className="text-sm text-zinc-500">Track immutable inputs, external training runs, metrics and model promotion.</p></div><AdminNavLinks active="training" /></div>
      {!authChecked && <Panel>Checking admin session...</Panel>}
      {authChecked && !token && <Panel>Log in to open the training registry.</Panel>}
      {token && <>
        <section className="mb-4 rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="text-sm font-semibold uppercase text-zinc-500">Queue external training run</h3>
          {artifacts.length === 0 ? <p className="mt-3 text-sm text-amber-700">No registered dataset artifacts. Export a frozen dataset version from Annotations first.</p> : <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Field label="Dataset artifact"><select value={artifactId || artifacts[0]?.id || ""} onChange={(e) => setArtifactId(e.target.value)} className={inputClass}>{artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.outputPath} · {artifact.annotationsSha256.slice(0, 12)}</option>)}</select></Field>
            <Field label="Task"><select value={task} onChange={(e) => setTask(e.target.value as TrainingTask)} className={inputClass}>{TASKS.map((value) => <option key={value}>{value}</option>)}</select></Field>
            <div className="lg:col-span-2"><ReadinessPanel value={readiness} loading={readinessLoading} /></div>
            <Field label="Run name"><input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="label-roi-baseline" /></Field>
            <Field label="Framework"><input value={framework} onChange={(e) => setFramework(e.target.value)} className={inputClass} /></Field>
            <div className="lg:col-span-2"><Field label="Config snapshot (JSON)"><textarea value={configText} onChange={(e) => setConfigText(e.target.value)} className={`${inputClass} min-h-24 py-2 font-mono`} /></Field></div>
            <button disabled={busy || readinessLoading || !readiness?.ready || !name.trim()} onClick={() => void handleCreateRun()} className="h-10 w-fit rounded bg-zinc-950 px-4 text-sm font-semibold text-white disabled:opacity-40">Queue run</button>
          </div>}
        </section>
        {message && <div className="mb-4 rounded bg-emerald-50 p-3 text-sm text-emerald-700">{message}</div>}
        {error && <div className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        <section className="grid gap-3">{runs.length === 0 ? <Panel>No training runs registered.</Panel> : runs.map((run) => <RunCard key={run.id} run={run} busy={busy} act={act} token={token} />)}</section>
      </>}
    </div>
  </main>;
}

function RunCard({ run, busy, act, token }: { run: TrainingRun; busy: boolean; token: string; act: (action: () => Promise<unknown>, success: string) => Promise<void> }) {
  async function status(next: "running" | "completed" | "failed" | "cancelled") {
    const errorMessageValue = next === "failed" ? window.prompt("Failure reason")?.trim() : undefined;
    if (next === "failed" && !errorMessageValue) return;
    await act(() => updateTrainingRunStatus(run.id, { status: next, errorMessage: errorMessageValue }, token), `Run marked ${next}.`);
  }
  async function model() {
    const name = window.prompt("Model name")?.trim(); const artifactPath = window.prompt("Model artifact path")?.trim(); const artifactSha256 = window.prompt("Model artifact SHA-256")?.trim();
    if (!name || !artifactPath || !artifactSha256) return;
    await act(() => createModelVersion(run.id, { name, artifactPath, artifactSha256, metadata: {} }, token), "Model version registered.");
  }
  async function evaluation(modelVersionId?: string) {
    const split = window.prompt("Split: train, validation or test", "validation")?.trim() as "train" | "validation" | "test" | undefined;
    const sampleCount = Number(window.prompt("Sample count", "0")); const metricsText = window.prompt("Metrics JSON", '{"score":0}') ?? "";
    if (!split || !["train", "validation", "test"].includes(split) || !Number.isInteger(sampleCount) || sampleCount < 0) return;
    let metrics: Record<string, number>; try { metrics = parseNumberObject(metricsText); } catch { return; }
    await act(() => addTrainingEvaluation(run.id, { modelVersionId, split, sampleCount, metrics }, token), "Evaluation registered.");
  }
  return <article className="rounded-lg border border-zinc-200 bg-white p-4">
    <div className="flex flex-wrap justify-between gap-3"><div><div className="font-semibold">{run.name}</div><div className="mt-1 text-xs text-zinc-500">{run.task} · {run.framework} · dataset {run.datasetArtifactSha256.slice(0, 12)}…</div></div><Badge value={run.status} /></div>
    <div className="mt-3 flex flex-wrap gap-2">
      {run.status === "queued" && <><Button disabled={busy} onClick={() => void status("running")}>Start</Button><Button disabled={busy} onClick={() => void status("cancelled")}>Cancel</Button></>}
      {run.status === "running" && <><Button disabled={busy} onClick={() => void status("completed")}>Complete</Button><Button disabled={busy} onClick={() => void status("failed")}>Fail</Button><Button disabled={busy} onClick={() => void status("cancelled")}>Cancel</Button></>}
      {run.status === "completed" && <><Button disabled={busy} onClick={() => void model()}>Register model</Button><Button disabled={busy} onClick={() => void evaluation()}>Add run metric</Button></>}
    </div>
    {run.errorMessage && <div className="mt-3 text-sm text-red-700">{run.errorMessage}</div>}
    {run.models.map((item) => <ModelCard key={item.id} model={item} run={run} busy={busy} act={act} token={token} addEvaluation={evaluation} />)}
    {run.evaluations.length > 0 && <div className="mt-3 text-xs text-zinc-500">{run.evaluations.map((item) => <div key={item.id}>{item.split} · n={item.sampleCount} · {JSON.stringify(item.metrics)}{item.modelVersionId ? " · model-linked" : ""}</div>)}</div>}
  </article>;
}

function ModelCard({ model, run, busy, act, token, addEvaluation }: { model: ModelVersion; run: TrainingRun; busy: boolean; act: (action: () => Promise<unknown>, success: string) => Promise<void>; token: string; addEvaluation: (modelVersionId?: string) => Promise<void> }) {
  const hasValidation = run.evaluations.some((item) => item.modelVersionId === model.id && item.split === "validation");
  return <div className="mt-3 rounded border border-zinc-200 bg-zinc-50 p-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><span>{model.name} v{model.version} · {model.artifactSha256.slice(0, 12)}…</span><Badge value={model.status} /></div><div className="mt-2 flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void addEvaluation(model.id)}>Add evaluation</Button>{model.status === "candidate" && <Button disabled={busy || !hasValidation} onClick={() => void act(() => updateModelStatus(model.id, "validated", token), "Model validated.")}>Validate</Button>}{model.status === "validated" && <Button disabled={busy || !hasValidation} onClick={() => void act(() => updateModelStatus(model.id, "promoted", token), "Model promoted.")}>Promote</Button>}{model.status !== "deprecated" && <Button disabled={busy} onClick={() => void act(() => updateModelStatus(model.id, "deprecated", token), "Model deprecated.")}>Deprecate</Button>}</div></div>;
}

function ReadinessPanel({ value, loading }: { value: DatasetArtifactReadiness | null; loading: boolean }) {
  if (loading) return <div className="rounded border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-500">Validating checksum and dataset layers...</div>;
  if (!value) return <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Artifact readiness is unavailable. A run cannot be queued until validation succeeds.</div>;
  return <div className={`rounded border p-3 text-sm ${value.ready ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">Schema v{value.schemaVersion} · checksum verified</span><span>{value.eligibleItems}/{value.totalItems} item(s) · {value.eligibleSamples} sample(s) for {value.task}</span></div>
    <div className="mt-1 text-xs">train {value.splits.train.eligible}/{value.splits.train.total} · validation {value.splits.validation.eligible}/{value.splits.validation.total} · test {value.splits.test.eligible}/{value.splits.test.total}</div>
    <div className="mt-1 text-xs text-zinc-600">Layers: {Object.entries(value.layers).filter(([, count]) => count > 0).map(([key, count]) => `${key} ${count}`).join(" · ") || "none"}</div>
    {value.taskArtifact && <div className="mt-1 font-mono text-xs text-zinc-600">{value.taskArtifact.file} · adapter v{value.taskArtifact.adapterVersion} · {value.taskArtifact.sha256.slice(0, 12)}…</div>}
    {value.warnings.map((warning) => <div key={warning} className="mt-1 text-xs">{warning}</div>)}
  </div>;
}

const inputClass = "h-10 w-full rounded border border-zinc-300 px-3 text-sm outline-none focus:border-zinc-600";
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="grid gap-1 text-xs font-semibold uppercase text-zinc-500">{label}{children}</label>; }
function Panel({ children }: { children: React.ReactNode }) { return <section className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500">{children}</section>; }
function Button({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" {...props} className="h-8 rounded border border-zinc-300 bg-white px-3 text-xs font-medium disabled:opacity-40">{children}</button>; }
function Badge({ value }: { value: string }) { return <span className="h-fit rounded bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-700">{value}</span>; }
function parseObject(value: string) { const parsed: unknown = JSON.parse(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object"); return parsed as Record<string, unknown>; }
function parseNumberObject(value: string) { const parsed = parseObject(value); if (Object.values(parsed).some((item) => typeof item !== "number" || !Number.isFinite(item))) throw new Error("Metric values must be finite numbers"); return parsed as Record<string, number>; }
function errorMessage(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
