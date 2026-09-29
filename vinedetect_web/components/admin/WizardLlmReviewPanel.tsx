"use client";

import { useEffect, useMemo, useState } from "react";
import { RawJsonBlock } from "./RawJsonBlock";
import {
  applyWizardCorrectionPlan,
  closeLlmWizardSession,
  getCurrentLlmWizardSession,
  getWizardVisionContext,
  getWizardCorrectionPlan,
  reviewLlmWizardPlan,
  runLlmWizardPlan,
  startLlmWizardSession,
  type LlmControllerPlanResponse,
  type LlmFinalEditor,
  type LlmReviewVerdict,
  type LlmSession,
  type GpuMinerEvidenceContext,
  type WizardCorrectionPlan,
  type WizardStage,
} from "@/lib/admin/api";

type Props = {
  source: string;
  sourceItemId: string;
  annotationId: string;
  selectedLabelId?: string | null;
  currentStage: WizardStage;
  token: string | null;
  disabled?: boolean;
  onChanged?: () => Promise<unknown> | unknown;
  onError?: (message: string) => void;
};

const VERDICT_LABELS: Record<LlmReviewVerdict, string> = {
  llm_correct: "Correct",
  llm_false_accept: "False accept",
  llm_false_correction: "False correction",
  llm_partially_correct: "Partially correct",
};

export function WizardLlmReviewPanel({ source, sourceItemId, annotationId, selectedLabelId, currentStage, token, disabled = false, onChanged, onError }: Props) {
  const [response, setResponse] = useState<LlmControllerPlanResponse | null>(null);
  const [plan, setPlan] = useState<WizardCorrectionPlan | null>(null);
  const [session, setSession] = useState<LlmSession | null>(null);
  const [loadedSessionKey, setLoadedSessionKey] = useState<string | null>(null);
  const [busy, setBusy] = useState<"session" | "plan" | "apply" | "review" | null>(null);
  const [lastRunMode, setLastRunMode] = useState<"session" | "one-shot" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [minerEvidence, setMinerEvidence] = useState<GpuMinerEvidenceContext | null>(null);
  const appliedStages = useMemo(() => {
    const resultOperations = plan?.result?.operations ?? [];
    const resultStages = resultOperations
      .filter((item) => item.status === "applied" && typeof item.stage === "string")
      .map((item) => item.stage as WizardStage);
    return [...new Set(resultStages)];
  }, [plan]);
  const [reviewStage, setReviewStage] = useState<WizardStage>(currentStage);
  const supported = true;
  const sessionKey = `${source}:${sourceItemId}:${annotationId}`;
  const activeSession = token && loadedSessionKey === sessionKey ? session : null;
  const sessionLoading = Boolean(token && loadedSessionKey !== sessionKey);

  useEffect(() => {
    let current = true;
    if (!token) return () => { current = false; };
    void getCurrentLlmWizardSession(source, sourceItemId, annotationId, token)
      .then((value) => { if (current) { setSession(value); setLoadedSessionKey(sessionKey); } })
      .catch(() => { if (current) { setSession(null); setLoadedSessionKey(sessionKey); } });
    return () => { current = false; };
  }, [annotationId, sessionKey, source, sourceItemId, token]);

  useEffect(() => {
    let current = true;
    if (!token) {
      queueMicrotask(() => { if (current) setMinerEvidence(null); });
      return () => { current = false; };
    }
    void getWizardVisionContext(source, sourceItemId, annotationId, token)
      .then((value) => { if (current) setMinerEvidence(value.minerEvidence); })
      .catch(() => { if (current) setMinerEvidence(null); });
    return () => { current = false; };
  }, [annotationId, source, sourceItemId, token]);

  async function startSession() {
    if (!token) return;
    setBusy("session"); setNotice(null); onError?.("");
    try {
      const result = await startLlmWizardSession(source, sourceItemId, annotationId, token);
      setSession(result.session);
      setLoadedSessionKey(sessionKey);
      const gate = await runLlmWizardPlan(source, sourceItemId, annotationId, { currentStage: "package", llmSessionId: result.session.id }, token);
      setLastRunMode("session"); setResponse(gate); setPlan(gate.plan); setReviewStage("package");
      setNotice(gate.status === "no-action"
        ? gate.reason ?? "Package count needs human review."
        : `${result.reused ? "Active LLM session resumed" : "LLM session started"}. Review the single/multipackage gate before continuing.`);
      await refreshSession();
    } catch (error) { report(error, "Starting the LLM session failed"); }
    finally { setBusy(null); }
  }

  async function refreshSession() {
    if (!token) return;
    const value = await getCurrentLlmWizardSession(source, sourceItemId, annotationId, token);
    setSession(value);
    setLoadedSessionKey(sessionKey);
  }

  async function closeSession() {
    if (!token || !activeSession) return;
    setBusy("session"); setNotice(null);
    try {
      await closeLlmWizardSession(source, sourceItemId, annotationId, activeSession.id, "completed", token);
      setSession(null); setResponse(null); setPlan(null); setLastRunMode(null);
      setNotice("LLM session completed. Its stage-run trace remains persisted.");
    } catch (error) { report(error, "Closing the LLM session failed"); }
    finally { setBusy(null); }
  }

  async function runPlan() {
    if (!token) return;
    const activeSessionId = activeSession?.id;
    setBusy("plan"); setNotice(null); onError?.("");
    try {
      const next = await runLlmWizardPlan(source, sourceItemId, annotationId, { selectedLabelId: selectedLabelId ?? undefined, currentStage, llmSessionId: activeSessionId }, token);
      setLastRunMode(activeSessionId ? "session" : "one-shot");
      setResponse(next); setPlan(next.plan);
      if (next.plan) setReviewStage(next.plan.operations.some((item) => item.stage === currentStage) ? currentStage : next.plan.operations[0]?.stage ?? currentStage);
      setNotice(next.status === "no-action"
        ? next.reason ?? "LLM found no safe correction."
        : activeSessionId ? "Session proposal is validated. Inspect it before applying." : "One-shot proposal is validated. Inspect it before applying.");
      if (activeSessionId) await refreshSession();
    } catch (error) { report(error, "LLM planning failed"); }
    finally { setBusy(null); }
  }

  async function applyPlan() {
    if (!token || !plan) return;
    setBusy("apply"); setNotice(null);
    try {
      const applied = await applyWizardCorrectionPlan(source, sourceItemId, annotationId, plan.id, token);
      setPlan(applied);
      const stages = (applied.result?.operations ?? []).filter((item) => item.status === "applied").map((item) => item.stage).filter((stage): stage is WizardStage => typeof stage === "string");
      if (stages.length) setReviewStage(stages.includes(currentStage) ? currentStage : stages[0]);
      setNotice(`${applied.result?.applied ?? 0} operation(s) applied${applied.result?.failures ? `, ${applied.result.failures} failed` : ""}.`);
      await onChanged?.();
      if (activeSession) await refreshSession();
    } catch (error) {
      try {
        const current = await getWizardCorrectionPlan(source, sourceItemId, annotationId, plan.id, token);
        if (current.status === "applied" || current.status === "partially_applied" || current.status === "failed") {
          setPlan(current);
          setNotice(`Plan was already ${current.status.replaceAll("_", " ")}; loaded its persisted result without replaying commands.`);
          await onChanged?.();
          if (activeSession) await refreshSession();
          return;
        }
        if (current.status === "applying") {
          report(new Error("Correction plan is currently applying or its previous apply was interrupted. Wait for completion or request a new plan."), "Applying the LLM proposal failed");
          return;
        }
      } catch {
        // Preserve the original apply error when the recovery read also fails.
      }
      report(error, "Applying the LLM proposal failed");
    }
    finally { setBusy(null); }
  }

  async function recordVerdict(verdict: LlmReviewVerdict) {
    if (!token || !plan) return;
    const finalEditor = editorFor(plan, verdict);
    setBusy("review"); setNotice(null);
    try {
      const result = await reviewLlmWizardPlan(source, sourceItemId, annotationId, plan.id, { stage: reviewStage, verdict, finalEditor }, token);
      setNotice(`${VERDICT_LABELS[verdict]} recorded for ${reviewStage} by ${result.review.reviewerSubject ?? "human reviewer"}.`);
      await onChanged?.();
      if (activeSession) await refreshSession();
    } catch (error) { report(error, "Saving the LLM verdict failed"); }
    finally { setBusy(null); }
  }

  function report(error: unknown, fallback: string) {
    const message = error instanceof Error ? error.message : fallback;
    setNotice(message); onError?.(message);
  }

  const canApply = plan?.status === "validated";
  const canReview = Boolean(plan && (plan.status === "applied" || plan.status === "partially_applied") && appliedStages.length);
  const decision = plan?.llmDecision?.mode;
  const verdicts = validVerdicts(decision);

  return (
    <section className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase text-indigo-950">LLM assistant</h3>
          <p className="mt-1 text-xs leading-5 text-indigo-700">Runs/reviews the deterministic helper for the current stage. Nothing changes until Apply.</p>
        </div>
        {plan ? <span className={`rounded px-2 py-1 text-[10px] font-semibold uppercase ${plan.status === "validated" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>{plan.status.replaceAll("_", " ")}</span> : null}
      </div>

      <MinerEvidencePanel evidence={minerEvidence} />

      <SessionMonitor session={activeSession} loading={sessionLoading} currentStage={currentStage} onClose={closeSession} disabled={busy !== null || disabled} />

      {!response && !activeSession ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" disabled={disabled || !token || sessionLoading || busy !== null} onClick={() => void startSession()} className="h-10 rounded border border-indigo-400 bg-white px-3 text-sm font-semibold text-indigo-900 disabled:opacity-50">
            {busy === "session" ? "Starting…" : "Start session"}
          </button>
          <button type="button" disabled={disabled || !token || sessionLoading || busy !== null || !supported} onClick={() => void runPlan()} className="h-10 rounded bg-indigo-700 px-3 text-sm font-semibold text-white disabled:opacity-50">
            {busy === "plan" ? "Running…" : supported ? `Run ${currentStage} once` : "No Package helper review"}
          </button>
        </div>
      ) : null}

      {!response && activeSession ? (
        <button type="button" disabled={disabled || !token || busy !== null || !supported} onClick={() => void runPlan()} className="mt-3 h-10 w-full rounded bg-indigo-700 px-4 text-sm font-semibold text-white disabled:opacity-50">
          {busy === "plan" ? "Reviewing…" : supported ? `Review ${currentStage} in session` : "No Package helper review"}
        </button>
      ) : null}

      {response ? (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase">
            <span className="rounded bg-white px-2 py-1 text-indigo-800">{String(response.controller.model ?? response.controller.id ?? "LLM")}</span>
            <span className="rounded bg-white px-2 py-1 text-indigo-800">{response.interactionMode}</span>
            {lastRunMode ? <span className="rounded bg-white px-2 py-1 text-indigo-800">{lastRunMode}</span> : null}
            {decision ? <span className="rounded bg-violet-200 px-2 py-1 text-violet-900">{decision.replaceAll("_", " ")}</span> : null}
          </div>

          <DecisionLayers response={response} plan={plan} />

          <OcrSemanticEvidencePanel response={response} plan={plan} />

          {plan ? <PlanOperations plan={plan} /> : null}

          {canApply ? (
            <div className="grid grid-cols-2 gap-2">
              <button type="button" disabled={busy !== null || disabled} onClick={() => { setResponse(null); setPlan(null); setLastRunMode(null); setNotice(null); }} className="h-9 rounded border border-indigo-300 bg-white text-xs font-medium text-indigo-900">Dismiss</button>
              <button type="button" disabled={busy !== null || disabled} onClick={() => void applyPlan()} className="h-9 rounded bg-indigo-700 text-xs font-semibold text-white disabled:opacity-50">{busy === "apply" ? "Applying…" : "Apply plan"}</button>
            </div>
          ) : null}

          {canReview ? (
            <div className="rounded border border-indigo-200 bg-white p-3">
              <label className="text-xs font-semibold text-zinc-800">Human evaluation</label>
              <select value={reviewStage} onChange={(event) => setReviewStage(event.target.value as WizardStage)} className="mt-2 h-9 w-full rounded border border-zinc-300 bg-white px-2 text-xs">
                {appliedStages.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
              </select>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {verdicts.map((verdict) => <button key={verdict} type="button" disabled={busy !== null || disabled} onClick={() => void recordVerdict(verdict)} className="min-h-9 rounded border border-indigo-300 bg-indigo-50 px-2 py-1 text-[11px] font-medium text-indigo-950 hover:bg-indigo-100 disabled:opacity-50">{VERDICT_LABELS[verdict]}</button>)}
              </div>
            </div>
          ) : null}

          <button type="button" disabled={busy !== null || disabled || !supported} onClick={() => void runPlan()} className="h-8 w-full rounded border border-indigo-300 bg-white text-xs font-medium text-indigo-900 disabled:opacity-50">{activeSession ? "Run another in session" : "Run another once"}</button>
        </div>
      ) : null}

      {notice ? <p role="status" className="mt-3 break-words text-xs leading-5 text-indigo-900">{notice}</p> : null}
    </section>
  );
}

function MinerEvidencePanel({ evidence }: { evidence: GpuMinerEvidenceContext | null }) {
  const dino = evidence?.families.dinov3;
  const siglip = evidence?.families.siglip2;
  if (!dino && !siglip) return <div className="mt-3 rounded border border-dashed border-indigo-300 bg-white/70 p-3 text-xs text-indigo-800">GPU miner evidence not imported for this item.</div>;
  return (
    <details className="mt-3 rounded border border-indigo-200 bg-white p-3" open>
      <summary className="cursor-pointer text-xs font-semibold text-indigo-950">GPU miner evidence · {[dino, siglip].filter(Boolean).length}/2</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {dino ? <MinerFamilyCard title="DINOv3" value={dino} detail={denseSummary(dino.features)} /> : <MissingMinerFamily title="DINOv3" />}
        {siglip ? <MinerFamilyCard title="SigLIP2" value={siglip} detail={similaritySummary(siglip.features, siglip.metrics)} /> : <MissingMinerFamily title="SigLIP2" />}
      </div>
      <details className="mt-2"><summary className="cursor-pointer text-[10px] font-semibold uppercase text-zinc-500">Raw miner evidence</summary><RawJsonBlock value={evidence} containerClassName="mt-2" className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[9px] leading-4 text-zinc-100" /></details>
    </details>
  );
}

function MinerFamilyCard({ title, value, detail }: { title: string; value: NonNullable<GpuMinerEvidenceContext["families"]["dinov3"]>; detail: string }) {
  return <div className={`rounded border p-2 text-[11px] ${value.status === "completed" ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}><div className="flex items-center justify-between gap-2"><strong>{title}</strong><span className="uppercase">{value.status}</span></div><div className="mt-1">{detail}</div><div className="mt-1 truncate text-zinc-500" title={`${value.model.id ?? "unknown"}@${value.model.revision ?? "unknown"}`}>{value.model.id ?? "unknown model"}</div><div className="text-zinc-500">run {value.runId.slice(0, 12)} · {value.artifactsAvailable ? "artifacts linked" : "metadata only"}</div></div>;
}
function MissingMinerFamily({ title }: { title: string }) { return <div className="rounded border border-dashed border-zinc-300 bg-zinc-50 p-2 text-[11px] text-zinc-500"><strong className="block text-zinc-700">{title}</strong>Not imported</div>; }
function denseSummary(features: Record<string, unknown>) { const shape = Array.isArray(features.denseShape) ? features.denseShape.join("×") : "none"; return `dense ${shape} · dim ${String(features.embeddingDim ?? "—")}`; }
function similaritySummary(features: Record<string, unknown>, metrics: Record<string, unknown>) { const raw = Number(features.imageTextSimilarity ?? metrics.imageTextSimilarity); return Number.isFinite(raw) ? `image ↔ catalog ${raw.toFixed(4)}` : "image ↔ catalog unavailable"; }

function DecisionLayers({ response, plan }: { response: LlmControllerPlanResponse; plan: WizardCorrectionPlan | null }) {
  const evidence = record(plan?.proposedOutput ?? response.proposedOutput);
  const observation = record(evidence.observation);
  const decision = record(evidence.stageDecision);
  const candidateIds = Array.isArray(observation.candidateIds) ? observation.candidateIds : [];
  const humanState = !plan ? "required / advisory" : plan.status === "validated" ? "pending apply" : "pending evaluation";
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <div className="rounded border border-sky-200 bg-sky-50 p-2 text-[11px]"><strong className="block uppercase text-sky-900">Auto result</strong><span>{candidateIds.length} candidate(s)</span></div>
      <div className="rounded border border-violet-200 bg-violet-50 p-2 text-[11px]"><strong className="block uppercase text-violet-900">LLM decision</strong><span>{String(decision.action ?? response.status)}</span></div>
      <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px]"><strong className="block uppercase text-amber-900">Human result</strong><span>{humanState}</span></div>
    </div>
  );
}

function OcrSemanticEvidencePanel({ response, plan }: { response: LlmControllerPlanResponse; plan: WizardCorrectionPlan | null }) {
  const evidence = record(plan?.proposedOutput ?? response.proposedOutput);
  const inventory = record(record(evidence.observation).semanticTextInventory);
  if (!Object.keys(inventory).length) return null;
  const items = Array.isArray(inventory.items) ? inventory.items.map(record) : [];
  const reconciliation = record(inventory.reconciliation);
  const reconciled = Array.isArray(reconciliation.items) ? reconciliation.items.map(record) : [];
  const localization = record(inventory.localization);
  const localized = Array.isArray(localization.items) ? localization.items.map(record) : [];
  const reconcileById = new Map(reconciled.map((item) => [String(item.semanticId ?? ""), item]));
  const localizationById = new Map(localized.map((item) => [String(item.id ?? ""), item]));
  return (
    <details className="rounded border border-cyan-200 bg-cyan-50 p-3" open>
      <summary className="cursor-pointer text-xs font-semibold text-cyan-950">
        OCR semantic evidence · {String(inventory.status ?? "unknown")} · {String(reconciliation.matched ?? 0)} matched / {String(reconciliation.missing ?? 0)} missing
      </summary>
      <p className="mt-2 text-[10px] leading-4 text-cyan-800">Clean-image reading is independent from Auto-OCR. Spatial matches and targeted quads are proposals until the final raster review.</p>
      <div className="mt-2 space-y-1">
        {items.map((item, index) => {
          const id = String(item.id ?? `semantic-${index + 1}`);
          const match = reconcileById.get(id) ?? {};
          const suggestion = record(match.spatialSuggestion);
          const location = localizationById.get(id);
          const status = String(match.status ?? "unmatched");
          return (
            <div key={id} className="rounded border border-cyan-100 bg-white px-2 py-1.5 text-[11px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="break-words text-zinc-950">{String(item.text ?? "—")}</strong>
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${status === "matched" ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{status}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-600">
                <span>{String(item.granularity ?? "line")} · order {String(item.readingOrder ?? index + 1)}</span>
                {match.bestCandidateId ? <span>OCR: {String(match.bestCandidateId)} · score {String(match.score ?? "—")}</span> : null}
                {suggestion.candidateId ? <span>suggested: {String(suggestion.candidateId)} · {String(suggestion.confidence ?? "—")}</span> : null}
                {location ? <span>locator: {location.found === true ? `found · ${String(location.confidence ?? "—")}` : "not found"}</span> : null}
              </div>
            </div>
          );
        })}
        {!items.length ? <div className="rounded bg-white p-2 text-[11px] text-zinc-500">No text was returned by the clean-image pass.</div> : null}
      </div>
      <details className="mt-2">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase text-cyan-800">Raw OCR semantic evidence</summary>
        <RawJsonBlock value={inventory} containerClassName="mt-2" className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[9px] leading-4 text-zinc-100" />
      </details>
    </details>
  );
}

function SessionMonitor({ session, loading, currentStage, onClose, disabled }: { session: LlmSession | null; loading: boolean; currentStage: WizardStage; onClose: () => Promise<void>; disabled: boolean }) {
  if (loading) return <p className="mt-3 rounded border border-dashed border-indigo-300 bg-white/70 p-3 text-xs leading-5 text-indigo-800">Checking for an active card session…</p>;
  if (!session) return <p className="mt-3 rounded border border-dashed border-indigo-300 bg-white/70 p-3 text-xs leading-5 text-indigo-800">No active session. Run this stage once, or start a card session to carry reviewed stage context forward.</p>;
  const stageRuns = session.stageRuns.filter((run) => run.stage === currentStage);
  const last = stageRuns.at(-1);
  return (
    <div className="mt-3 rounded border border-indigo-200 bg-white p-3 text-xs text-indigo-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>Session {session.id.slice(0, 8)}</strong>
        <div className="flex items-center gap-2"><span className="rounded bg-emerald-100 px-2 py-1 text-[10px] font-semibold uppercase text-emerald-800">{session.status}</span><button type="button" disabled={disabled} onClick={() => void onClose()} className="text-[10px] font-semibold uppercase text-zinc-500 hover:text-zinc-900 disabled:opacity-50">Complete</button></div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-zinc-600">
        <span>Model</span><span className="text-right text-zinc-900">{session.model}</span>
        <span>Provider</span><span className="text-right text-zinc-900">{session.provider}</span>
        <span>Conversation</span><span className="truncate text-right text-zinc-900" title={session.providerConversationId ?? "not attached"}>{session.providerConversationId ? session.providerConversationId.slice(0, 12) : "not attached"}</span>
        <span>Prompt</span><span className="text-right text-zinc-900">{session.promptVersion}</span>
        <span>Canonical stage</span><span className="text-right text-zinc-900">{session.currentStage ?? "not started"}</span>
        <span>Context events</span><span className="text-right text-zinc-900">{session.contextEvents.length}</span>
        <span>Current stage runs</span><span className="text-right text-zinc-900">{stageRuns.length}</span>
        <span>Last status</span><span className="text-right text-zinc-900">{last?.status ?? "waiting"}</span>
        {last?.latencyMs !== null && last?.latencyMs !== undefined ? <><span>Last latency</span><span className="text-right text-zinc-900">{last.latencyMs} ms</span></> : null}
      </div>
      {last ? <details className="mt-2 border-t border-indigo-100 pt-2">
        <summary className="cursor-pointer font-medium">Transition trace · {last.iterationCount} decision(s)</summary>
        <div className="mt-2 space-y-1">
          {last.decisions.map((raw, index) => {
            const trace = record(raw); const decision = record(trace.decision); const patch = record(decision.paramsPatch);
            return <div key={`${last.id}:${index}`} className="rounded bg-indigo-50 px-2 py-1">{index + 1}. helper.run → llm.{String(decision.action ?? "unknown")}{patch.adjustment ? ` (${String(patch.adjustment)})` : ""}</div>;
          })}
          {!last.decisions.length ? <div className="text-zinc-500">No provider decision was persisted.</div> : null}
        </div>
      </details> : null}
    </div>
  );
}

function PlanOperations({ plan }: { plan: WizardCorrectionPlan }) {
  const iterationTrace = Array.isArray(plan.proposedOutput?.iterationTrace) ? plan.proposedOutput.iterationTrace : [];
  return (
    <details className="rounded border border-indigo-200 bg-white p-3" open>
      <summary className="cursor-pointer text-xs font-semibold text-zinc-900">Proposed operations · {plan.operations.length}</summary>
      {iterationTrace.length ? (
        <div className="mt-2 rounded border border-violet-200 bg-violet-50 p-2 text-[11px] text-violet-950">
          <strong>Controller trace: {iterationTrace.length}</strong>
          <div className="mt-1 flex flex-wrap gap-1">
            {iterationTrace.map((raw, index) => {
              const item = record(raw); const decision = record(item.decision); const patch = record(decision.paramsPatch);
              const runtime = record(item.runtimeBefore); const helper = record(runtime.helper);
              const helperStates = Array.isArray(helper.intermediateStates) ? helper.intermediateStates.length : 0;
              const reviews = Array.isArray(decision.reviews) ? decision.reviews.length : 0;
              const topologyEdits = Array.isArray(decision.topologyEdits) ? decision.topologyEdits.length : 0;
              const helperStateSuffix = helperStates ? ` · ${helperStates} helper states` : "";
              const systemOperations = Array.isArray(item.systemOperations) ? item.systemOperations.length : 0;
              return <span key={String(item.observationId ?? index)} className="rounded bg-white px-2 py-1">#{index + 1} {String(decision.action ?? item.event ?? "unknown")}{patch.adjustment ? ` · ${String(patch.adjustment)}` : ""}{helperStateSuffix}{reviews ? ` · ${reviews} review` : ""}{topologyEdits ? ` · ${topologyEdits} move` : ""}{systemOperations ? ` · ${systemOperations} region(s)` : ""}</span>;
            })}
          </div>
        </div>
      ) : null}
      <div className="mt-2 space-y-2">
        {plan.operations.map((operation, index) => {
          const proposed = record(operation.proposedOutput);
          const editOperations = Array.isArray(proposed.operations) ? proposed.operations : [];
          return (
            <details key={operation.operationId ?? `${operation.stage}:${index}`} className="rounded border border-zinc-200 bg-zinc-50 p-2" open={editOperations.length > 0}>
              <summary className="cursor-pointer text-xs"><strong>{operation.stage}</strong> · {operation.command}</summary>
              {editOperations.length ? <EditEngineTrace operations={editOperations} applied={plan.status === "applied" || plan.status === "partially_applied"} /> : null}
              <details className="mt-2">
                <summary className="cursor-pointer text-[10px] font-semibold uppercase text-zinc-500">Raw operation</summary>
                <RawJsonBlock value={{ target: operation.target, payload: operation.payload, proposedOutput: operation.proposedOutput }} containerClassName="mt-2" className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[10px] leading-4 text-zinc-100" />
              </details>
            </details>
          );
        })}
      </div>
    </details>
  );
}

function EditEngineTrace({ operations, applied }: { operations: unknown[]; applied: boolean }) {
  return (
    <div className="mt-2 rounded border border-violet-200 bg-violet-50 p-2 text-[11px] text-violet-950">
      <div className="flex items-center justify-between gap-2">
        <strong>Edit operation graph</strong>
        <span className="rounded bg-violet-100 px-2 py-0.5 text-[9px] font-semibold uppercase">LLM + system</span>
      </div>
      <ol className="mt-2 space-y-1 font-mono text-[10px] leading-4">
        {operations.map((raw, index) => {
          const operation = record(raw);
          const type = String(operation.type ?? "unknown");
          const inputs = Array.isArray(operation.inputIds) ? operation.inputIds.map(String) : [];
          const split = record(operation.split);
          const splitFractions = Array.isArray(split.fractions) ? split.fractions : [];
          const composition = record(operation.composition);
          const output = type === "split_region"
            ? `${String(operation.operationId ?? `op-${index + 1}`)}:1..${splitFractions.length + 1}`
            : ["edit", "merge", "edit_region", "edit_text", "merge_region", "create_region", "rerun_ocr", "compose_string", "set_status"].includes(type)
              ? String(operation.operationId ?? `op-${index + 1}`)
              : null;
          const adjustment = record(operation.adjustment);
          const detail = (type === "edit" || type === "edit_region") && adjustment.direction
            ? ` · ${String(adjustment.direction)} ${String(adjustment.edge ?? "all")} ${String(adjustment.strength ?? "")}`
            : type === "edit_text" || type === "create_region"
              ? ` · ${String(operation.transcriptionStatus ?? "unknown")}: ${operation.text === null ? "∅" : String(operation.text ?? "")}`
              : type === "split_region" ? ` · ${String(split.axis ?? "unknown")} @ ${splitFractions.join(", ")}`
                : type === "compose_string" ? ` · ${String(composition.transcriptionStatus ?? "unknown")}: ${composition.text === null ? "∅" : String(composition.text ?? "")}`
                : type === "decompose_string" ? " · remove relation only"
                : type === "set_status" ? ` · ${String(operation.transcriptionStatus ?? "unknown")}`
                : type === "rerun_ocr" ? ` · ${String(record(operation.result).transcription ?? "∅")}` : "";
          const actor = type === "rerun_ocr" ? "SYSTEM" : "LLM";
          return <li key={String(operation.operationId ?? index)} className="rounded bg-white px-2 py-1"><span className="mr-1 text-[9px] font-semibold text-zinc-500">{actor}</span>{index + 1}. {type.toUpperCase()} {inputs.join(" + ")}{output ? ` → ${output}` : ""}{detail}</li>;
        })}
      </ol>
      <div className="mt-2 flex items-center gap-2 border-t border-violet-200 pt-2 text-[10px]">
        <span className={`rounded px-2 py-0.5 font-semibold uppercase ${applied ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{applied ? "applied" : "awaiting apply"}</span>
        <span>Final approval actor: {applied ? "trusted caller" : "not recorded yet"}</span>
      </div>
    </div>
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function validVerdicts(mode: "accepted_helper" | "modified_helper" | "manual_created" | undefined): LlmReviewVerdict[] {
  if (mode === "accepted_helper") return ["llm_correct", "llm_false_accept"];
  if (mode === "modified_helper") return ["llm_correct", "llm_false_correction", "llm_partially_correct"];
  return ["llm_correct", "llm_partially_correct"];
}

function editorFor(plan: WizardCorrectionPlan, verdict: LlmReviewVerdict): LlmFinalEditor {
  if (verdict !== "llm_correct") return "human";
  return plan.llmDecision?.mode === "accepted_helper" ? "helper" : "llm";
}
