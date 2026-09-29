"use client";

import { useReducer, useRef, useState } from "react";
import {
  createRecognitionFlowState,
  recognitionFlowReducer,
  type RecognitionFlowAction,
  type RecognitionJobSnapshot,
  type RecognitionUIState,
} from "@/lib/scanner/recognitionFlow";

type ConsoleScenario = "match" | "no_match" | "ambiguous" | "guidance" | "failure" | "stale";
type LogEntry = {
  id: string;
  at: string;
  layer: "browser" | "bff" | "recognize" | "catalog" | "guard";
  message: string;
  detail?: unknown;
};

const STATES: RecognitionUIState[] = ["initializing", "exploring", "reading", "hypothesis", "stabilizing", "processing", "resolved", "ambiguous", "guidance", "error"];

export function RecognitionTestConsole() {
  const [initialSession] = useState(() => crypto.randomUUID());
  const [flow, dispatch] = useReducer(recognitionFlowReducer, initialSession, (id) => createRecognitionFlowState(id));
  const [scenario, setScenario] = useState<ConsoleScenario>("match");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  function log(layer: LogEntry["layer"], message: string, detail?: unknown) {
    setLogs((current) => [...current, { id: crypto.randomUUID(), at: new Date().toISOString(), layer, message, detail }]);
  }

  function transition(action: RecognitionFlowAction, message: string) {
    dispatch(action);
    log("browser", message, action);
  }

  async function run() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setLogs([]);
    const sessionId = crypto.randomUUID();

    try {
      transition({ type: "RESET", sessionId, startedAt: 0 }, "New camera session");
      transition({ type: "CAMERA_STARTING" }, "Camera viewport requested");
      await wait(220, controller.signal);
      transition({ type: "CAMERA_READY" }, "Camera stream ready; frame sampler started");

      const tagsResponse = await fetch("/api/recognition/mock/tags", { signal: controller.signal, cache: "no-store" });
      const tagCloud = await tagsResponse.json() as { version: string; tags: string[] };
      log("bff", `GET tags → ${tagsResponse.status}`, { version: tagCloud.version, count: tagCloud.tags.length, sample: tagCloud.tags.slice(0, 8) });
      await wait(250, controller.signal);

      if (scenario === "stale") {
        await runStaleScenario(sessionId, controller.signal);
      } else {
        await runCandidate({ sessionId, candidateId: "candidate-a", tokens: ["agora", "riesling"], scenario, signal: controller.signal });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        transition({ type: "FAILED", error: "NETWORK_ERROR" }, "Console flow failed");
        log("guard", "Unhandled console error", error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (abortRef.current === controller) setRunning(false);
    }
  }

  async function runCandidate(input: {
    sessionId: string;
    candidateId: string;
    tokens: string[];
    scenario: Exclude<ConsoleScenario, "stale">;
    signal: AbortSignal;
  }) {
    transition({ type: "CATALOG_SIGNALS_UPDATED", signals: input.tokens }, "Normalized OCR words matched catalog metadata");
    transition({ type: "CANDIDATE_FOUND", candidateId: input.candidateId, tokens: input.tokens }, "Meaningful OCR candidate detected");
    log("browser", "Best observation selected", { tokens: input.tokens, score: 0.86, frameBytes: 28 });
    const created = await createMockJob(input.sessionId, input.tokens, input.scenario, input.signal);
    log("bff", `POST multipart job → ${created.httpStatus}`, created.payload);
    transition({ type: "JOB_STARTED", candidateId: input.candidateId, jobId: created.payload.jobId }, "Speculative job attached to candidate");
    await wait(420, input.signal);
    transition({ type: "CANDIDATE_STABLE", candidateId: input.candidateId }, "OCR window reached stability threshold");
    await pollMockJob(created.payload.jobId, input.candidateId, input.signal);
  }

  async function runStaleScenario(sessionId: string, signal: AbortSignal) {
    const candidateA = "candidate-a";
    const candidateB = "candidate-b";
    transition({ type: "CANDIDATE_FOUND", candidateId: candidateA, tokens: ["agora"] }, "Candidate A detected");
    const jobA = await createMockJob(sessionId, ["agora"], "match", signal);
    transition({ type: "JOB_STARTED", candidateId: candidateA, jobId: jobA.payload.jobId }, "Speculative job A started");
    log("bff", `POST job A → ${jobA.httpStatus}`, jobA.payload);

    await wait(260, signal);
    transition({ type: "CANDIDATE_FOUND", candidateId: candidateB, tokens: ["cabernet", "reserve"] }, "Camera moved: candidate B replaced A");
    const jobB = await createMockJob(sessionId, ["cabernet", "reserve"], "match", signal);
    transition({ type: "JOB_STARTED", candidateId: candidateB, jobId: jobB.payload.jobId }, "Speculative job B started");
    log("bff", `POST job B → ${jobB.httpStatus}`, jobB.payload);
    transition({ type: "CANDIDATE_STABLE", candidateId: candidateB }, "Candidate B stabilized");

    await Promise.all([
      pollMockJob(jobA.payload.jobId, candidateA, signal, true),
      pollMockJob(jobB.payload.jobId, candidateB, signal),
    ]);
  }

  async function pollMockJob(jobId: string, candidateId: string, signal: AbortSignal, stale = false) {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      await wait(260, signal);
      const response = await fetch(`/api/recognition/mock/jobs/${jobId}`, { signal, cache: "no-store" });
      const job = await response.json() as RecognitionJobSnapshot;
      const debugJob = job as RecognitionJobSnapshot & { timing?: unknown; events?: unknown };
      log("recognize", `GET job · ${job.status} · ${job.stage}`, {
        attempt, jobId, candidateId, outcome: job.outcome,
        timing: debugJob.timing,
        emittedEvents: debugJob.events,
      });
      dispatch({ type: "JOB_UPDATED", candidateId, job });
      if (stale) log("guard", "Response A dispatched but ignored by reducer: active candidate/job is B", { jobId, candidateId, status: job.status });
      if (job.product) log("catalog", "BFF attached catalog product DTO", job.product);
      if (job.status === "completed" || job.status === "failed") return;
    }
    throw new Error("Mock job polling exceeded the attempt limit");
  }

  function cancel() {
    abortRef.current?.abort();
    setRunning(false);
    log("guard", "Frontend polling aborted; backend mock job remains independent");
  }

  return (
    <main className="min-h-dvh bg-zinc-950 p-5 text-zinc-100 lg:p-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Mock full-stack mode</div>
            <h1 className="mt-2 text-3xl font-semibold">Recognition flow console</h1>
            <p className="mt-2 max-w-3xl text-sm text-zinc-400">Browser reducer → Next.js BFF multipart route → mock recognize job → polling → catalog DTO. No camera, database writes or real ML calls.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <select value={scenario} disabled={running} onChange={(event) => setScenario(event.target.value as ConsoleScenario)} className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm">
              <option value="match">Successful match</option>
              <option value="no_match">No match</option>
              <option value="ambiguous">Ambiguous alternatives</option>
              <option value="guidance">Need more data</option>
              <option value="failure">Backend failure</option>
              <option value="stale">Stale response A → B</option>
            </select>
            <button type="button" disabled={running} onClick={() => void run()} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold disabled:opacity-40">Run flow</button>
            <button type="button" disabled={!running} onClick={cancel} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm disabled:opacity-40">Abort polling</button>
            <button type="button" onClick={() => setLogs([])} className="rounded-lg border border-zinc-700 px-4 py-2 text-sm">Clear log</button>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">{STATES.map((state) => <span key={state} className={`rounded-full border px-3 py-1 text-xs ${flow.uiState === state ? "border-violet-400 bg-violet-500/20 text-violet-100" : "border-zinc-800 text-zinc-500"}`}>{state}</span>)}</div>

        <div className="mt-6 grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
          <section className="space-y-4">
            <Panel title="Current reducer state"><Json value={flow} /></Panel>
            {flow.product && <Panel title="Resolved product"><div className="text-lg font-semibold">{flow.product.title}</div><div className="text-sm text-zinc-400">{flow.product.producer}</div><div className="mt-2 text-xs text-emerald-300">confidence {Math.round((flow.recognitionConfidence ?? 0) * 100)}%</div></Panel>}
          </section>
          <Panel title={`Event stream · ${logs.length}`}>
            <div className="max-h-[68dvh] space-y-2 overflow-auto pr-1">
              {logs.length === 0 && <div className="py-16 text-center text-sm text-zinc-500">Choose a scenario and run the flow.</div>}
              {logs.map((entry, index) => <LogRow key={entry.id} entry={entry} index={index + 1} />)}
            </div>
          </Panel>
        </div>
      </div>
    </main>
  );
}

async function createMockJob(sessionId: string, tokens: string[], scenario: Exclude<ConsoleScenario, "stale">, signal: AbortSignal) {
  const form = new FormData();
  form.append("image", new Blob([`mock-frame:${tokens.join("|")}`], { type: "image/jpeg" }), "mock-frame.jpg");
  form.append("tokens", JSON.stringify(tokens));
  form.append("sessionId", sessionId);
  form.append("scenario", scenario);
  const response = await fetch("/api/recognition/mock/jobs", { method: "POST", body: form, signal });
  const payload = await response.json() as { jobId: string; status: string; reused: boolean; mockTiming?: unknown; error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Mock create failed with HTTP ${response.status}`);
  return { httpStatus: response.status, payload };
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { window.clearTimeout(timeout); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 shadow-xl"><h2 className="mb-3 text-sm font-semibold text-zinc-300">{title}</h2>{children}</section>;
}

function Json({ value }: { value: unknown }) {
  return <pre className="overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/35 p-3 text-xs leading-5 text-sky-200">{JSON.stringify(value, null, 2)}</pre>;
}

function LogRow({ entry, index }: { entry: LogEntry; index: number }) {
  const color = { browser: "text-sky-300", bff: "text-violet-300", recognize: "text-amber-300", catalog: "text-emerald-300", guard: "text-rose-300" }[entry.layer];
  return <div className="rounded-lg border border-zinc-800 bg-black/25 p-3 text-xs"><div className="flex flex-wrap items-center gap-2"><span className="text-zinc-600">#{index}</span><span className={`font-semibold uppercase ${color}`}>{entry.layer}</span><span className="text-zinc-600">{entry.at.slice(11, 23)}</span><span className="text-zinc-200">{entry.message}</span></div>{entry.detail !== undefined && <details className="mt-2"><summary className="cursor-pointer text-zinc-500">payload</summary><Json value={entry.detail} /></details>}</div>;
}
