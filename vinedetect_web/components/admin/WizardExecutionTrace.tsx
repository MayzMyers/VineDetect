"use client";

import { useState } from "react";
import type { StageSampleV1, WizardStage } from "@/lib/admin/api";
import { RawJsonBlock } from "./RawJsonBlock";

const STAGES: WizardStage[] = ["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"];

export function WizardExecutionTrace({ samples, compact = false }: { samples: StageSampleV1[]; compact?: boolean }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const ordered = STAGES.map((stage) => samples.find((sample) => sample.stage === stage)).filter((sample): sample is StageSampleV1 => Boolean(sample));
  const nativeRunCount = ordered.reduce((sum, sample) => sum + sample.execution.runs.length, 0);
  const selectedCount = ordered.filter((sample) => sample.execution.selection).length;

  async function copyTrace() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(ordered, null, 2));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
    }
  }

  return (
    <section className="rounded-lg border border-violet-200 bg-violet-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold uppercase text-violet-950">Execution trace</h3>
          <div className="mt-1 text-xs text-violet-700">
            {ordered.length} stage sample(s) · {nativeRunCount} native helper run(s) · {selectedCount} selected candidate(s)
          </div>
        </div>
        <div className="flex items-center gap-2">
          {copyState === "error" ? <span role="status" className="text-xs text-red-700">Clipboard failed</span> : null}
          <button type="button" onClick={() => void copyTrace()} className="h-8 rounded border border-violet-300 bg-white px-3 text-xs font-medium text-violet-900 hover:bg-violet-100">
            {copyState === "copied" ? "Copied" : "Copy trace"}
          </button>
        </div>
      </div>

      {!ordered.length ? <div className="mt-3 text-sm text-violet-800">No stage samples are available for this card.</div> : (
        <div className={`mt-3 grid gap-2 ${compact ? "" : "lg:grid-cols-2"}`}>
          {ordered.map((sample) => <StageTrace key={sample.stage} sample={sample} />)}
        </div>
      )}
    </section>
  );
}

function StageTrace({ sample }: { sample: StageSampleV1 }) {
  const { execution } = sample;
  const selected = execution.selection;
  const native = sample.provenance.adapter.includes("-native-execution-");
  return (
    <details className="rounded border border-violet-200 bg-white p-3">
      <summary className="cursor-pointer list-none">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-medium text-zinc-900">{stageLabel(sample.stage)}</div>
            <div className="mt-1 font-mono text-[10px] text-zinc-500">{sample.helper.id} · {sample.helper.algorithm ?? "algorithm unavailable"}</div>
          </div>
          <div className="flex flex-wrap justify-end gap-1 text-[10px] font-semibold uppercase">
            <span className={`rounded px-2 py-1 ${native ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-600"}`}>{native ? "native" : "legacy"}</span>
            <span className={`rounded px-2 py-1 ${reviewModeClass(execution.reviewMode)}`}>{reviewModeLabel(execution.reviewMode)}</span>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-600">
          <span>{execution.runs.length} run(s)</span>
          <span>·</span>
          <span>{selected ? `candidate ${selected.candidateId}` : "no candidate selected"}</span>
          {sample.provenance.migrationGap ? <><span>·</span><span className="text-amber-700">historical run unavailable</span></> : null}
        </div>
      </summary>

      <div className="mt-3 grid gap-2 border-t border-violet-100 pt-3">
        {execution.runs.length ? execution.runs.map((run) => {
          const isSelected = selected?.runId === run.id;
          return (
            <div key={run.id} className={`rounded border p-2 ${isSelected ? "border-emerald-400 bg-emerald-50" : "border-zinc-200 bg-zinc-50"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-zinc-900">Run #{run.runIndex}{isSelected ? " · selected" : ""}</span>
                <span className="text-zinc-500">{run.candidates.length} candidate(s){run.createdAt ? ` · ${formatDate(run.createdAt)}` : ""}</span>
              </div>
              <div className="mt-1 break-all font-mono text-[10px] text-zinc-500">{run.id}</div>
              <HelperStateTrace states={run.intermediateStates ?? []} />
              <JsonDetails title="Config" value={run.config} />
              <JsonDetails title="Candidates" value={run.candidates} />
              <JsonDetails title="Auto output" value={run.output} />
              {run.artifact ? <JsonDetails title="Artifact" value={run.artifact} /> : null}
            </div>
          );
        }) : <div className="rounded border border-dashed border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">No native helper run was captured. This is expected for historical data; rerun the stage to create execution evidence.</div>}

        <div className="rounded border border-zinc-200 p-2">
          <div className="text-xs font-semibold text-zinc-800">Reviewed boundary</div>
          <div className="mt-1 text-[11px] text-zinc-500">
            params edited: {formatBoolean(sample.humanCorrection.paramsEdited)} · output edited: {formatBoolean(sample.humanCorrection.outputEdited)}
          </div>
          {sample.humanCorrection.changedFields.length ? <div className="mt-1 break-words text-[10px] text-amber-700">{sample.humanCorrection.changedFields.join(", ")}</div> : null}
          <JsonDetails title="Final params" value={execution.finalParams} />
          <JsonDetails title="Reviewed output" value={execution.reviewedOutput} />
          {execution.proposal ? (
            <div className="mt-2 rounded border border-indigo-200 bg-indigo-50 p-2">
              <div className="flex flex-wrap items-center gap-1 text-[10px] font-semibold uppercase text-indigo-900">
                <span>proposal · {execution.proposal.executor}</span>
                {execution.proposal.interactionMode ? <span>· {execution.proposal.interactionMode}</span> : null}
                {execution.proposal.llmDecision ? <span className="rounded bg-violet-200 px-2 py-1">{execution.proposal.llmDecision.mode.replaceAll("_", " ")}</span> : null}
              </div>
              {execution.proposal.review ? <div className="mt-2 text-[11px] text-indigo-900">Human verdict: <strong>{execution.proposal.review.verdict.replaceAll("_", " ")}</strong> · final editor {execution.proposal.review.finalEditor}{execution.proposal.review.reviewerSubject ? ` · ${execution.proposal.review.reviewerSubject}` : ""}</div> : <div className="mt-2 text-[11px] text-amber-800">Human verdict is not recorded yet.</div>}
            </div>
          ) : null}
        </div>
      </div>
    </details>
  );
}

function HelperStateTrace({ states }: { states: StageSampleV1["execution"]["runs"][number]["intermediateStates"] }) {
  if (!states.length) return null;
  const ids = new Set(states.map((state) => state.id));
  const depth = (state: (typeof states)[number]) => {
    let result = 0;
    let parentId = state.parentId;
    const visited = new Set<string>();
    while (parentId && ids.has(parentId) && !visited.has(parentId) && result < 6) {
      visited.add(parentId);
      result += 1;
      parentId = states.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    }
    return result;
  };
  return (
    <details className="mt-2 rounded border border-sky-200 bg-sky-50 p-2">
      <summary className="cursor-pointer text-[11px] font-medium text-sky-900">Helper states · {states.length}</summary>
      <div className="mt-2 grid gap-1">
        {[...states].sort((left, right) => left.sequence - right.sequence).map((state) => (
          <div key={state.id} className="rounded border border-sky-100 bg-white px-2 py-1 text-[10px]" style={{ marginLeft: `${depth(state) * 12}px` }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono font-semibold text-sky-950">{state.id}</span>
              <span className={state.status === "failed" ? "text-red-700" : state.status === "pending" ? "text-amber-700" : "text-emerald-700"}>{state.status}</span>
            </div>
            {state.algorithm ? <div className="mt-0.5 font-mono text-zinc-500">{state.algorithm}</div> : null}
            {Object.keys(state.summary).length ? <RawJsonBlock value={state.summary} containerClassName="mt-1" className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[10px] leading-4 text-zinc-100" /> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function JsonDetails({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="mt-2 rounded border border-zinc-200 bg-white p-2">
      <summary className="cursor-pointer text-[11px] font-medium text-zinc-700">{title}</summary>
      <RawJsonBlock value={value} containerClassName="mt-2" className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950 p-2 pr-20 font-mono text-[10px] leading-4 text-zinc-100" />
    </details>
  );
}

function stageLabel(stage: WizardStage) {
  const index = STAGES.indexOf(stage) + 1;
  return `${index}. ${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
}

function reviewModeClass(mode: StageSampleV1["execution"]["reviewMode"]) {
  if (mode === "accepted") return "bg-emerald-100 text-emerald-800";
  if (mode === "corrected") return "bg-amber-100 text-amber-800";
  if (mode === "manual") return "bg-sky-100 text-sky-800";
  return "bg-zinc-100 text-zinc-600";
}

function reviewModeLabel(mode: StageSampleV1["execution"]["reviewMode"]) {
  if (mode === "accepted") return "unchanged";
  if (mode === "corrected") return "changed";
  if (mode === "manual") return "manual";
  return "not reviewed";
}

function formatBoolean(value: boolean | null) {
  return value === null ? "unknown" : value ? "yes" : "no";
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
