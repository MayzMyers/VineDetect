import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type JsonObject = Record<string, unknown>;
type StepRecord = {
  name: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  response: unknown;
};

const options = parseOptions(process.argv.slice(2));
const steps: StepRecord[] = [];

async function main() {
  log(`controller flow probe: ${options.source}/${options.itemId}`);
  await request("recognize-health", "GET", "/health", { authenticated: false });

  const tracks = await request("list-annotation-tracks", "GET", `/management/metadata/${segment(options.source)}/${segment(options.itemId)}/annotation-tracks`);
  let annotationId = options.annotationId;
  if (options.createTrack) {
    const created = object(await request("create-annotation-track", "POST", `/management/metadata/${segment(options.source)}/${segment(options.itemId)}/annotation-tracks`, {
      body: { name: `Controller E2E ${new Date().toISOString()}` },
    }));
    annotationId = string(created.id) ?? string(created.annotationTrackId) ?? undefined;
    assert(annotationId, "Create annotation track response does not contain id");
  }
  if (!annotationId) {
    const candidates = array(tracks).map(object).map((track) => string(track.id) ?? string(track.annotationTrackId)).filter(Boolean) as string[];
    throw new Error(`Pass --annotation <id> or --create-track. Available track ids: ${candidates.join(", ") || "none"}`);
  }

  const annotationPath = `/management/items/${segment(options.source)}/${segment(options.itemId)}/annotations/${segment(annotationId)}`;
  const before = object(await request("vision-context-before", "GET", `${annotationPath}/vision-context`));
  assert(string(before.annotationId) === annotationId, "VisionContext belongs to another annotation track");

  const controllerResult = object(await request("create-local-ml-plan", "POST", `${annotationPath}/controllers/local-ml/plan`, {
    body: { render: { viewport: { type: "source" }, maxSide: options.maxSide }, input: {} },
  }));
  const controllerStatus = string(controllerResult.status);
  assert(controllerStatus === "planned" || controllerStatus === "no-action", `Unexpected controller status: ${controllerStatus ?? "missing"}`);

  const plan = object(controllerResult.plan);
  const planId = string(plan.id);
  if (!planId) {
    assert(controllerStatus === "no-action", "Controller returned neither a correction plan nor no-action");
    return finish({ annotationId, planId: null, controllerStatus, terminalStatus: "no-action" });
  }
  assert(string(plan.status) === "validated", `New plan must be validated, got ${string(plan.status) ?? "missing"}`);
  assert(plan.appliedAt == null, "New plan was unexpectedly applied by the controller");

  const planPath = `${annotationPath}/correction-plans/${segment(planId)}`;
  const persisted = object(await request("get-persisted-plan", "GET", planPath));
  assert(string(persisted.annotationTrackId) === annotationId, "Persisted plan belongs to another annotation track");
  assert(string(persisted.status) === "validated", `Persisted plan must be validated, got ${string(persisted.status) ?? "missing"}`);
  assert(persisted.appliedAt == null, "Persisted plan crossed the mutation boundary before Apply");

  if (!options.apply) {
    return finish({ annotationId, planId, controllerStatus, terminalStatus: "validated", note: "Dry run complete; pass --apply to replay the plan." });
  }

  let applied: JsonObject;
  try {
    applied = object(await request("apply-correction-plan", "POST", `${planPath}/apply`, { timeoutMs: options.applyTimeoutMs }));
  } catch (error) {
    const state = object(await request("get-plan-after-apply-error", "GET", planPath));
    throw new Error(`${message(error)}; persisted plan status after error: ${string(state.status) ?? "unknown"}`);
  }
  const terminalStatus = string(applied.status);
  assert(["applied", "partially_applied", "failed"].includes(terminalStatus ?? ""), `Unexpected terminal plan status: ${terminalStatus ?? "missing"}`);
  assert(object(applied.result).operations instanceof Array, "Apply response does not contain explicit result.operations");
  if (terminalStatus !== "applied") {
    throw new Error(`Correction plan finished with ${terminalStatus}: ${compact(object(applied.result).operations)}`);
  }

  const after = object(await request("vision-context-after", "GET", `${annotationPath}/vision-context`));
  assert(string(after.annotationId) === annotationId, "Final VisionContext belongs to another annotation track");
  let reviewedLabelId: string | null = null;
  let reviewedOcrIds: string[] = [];
  if (options.acceptFirstLabel) {
    const result = object(applied.result);
    const labelOperation = array(result.operations).map(object).find((operation) => operation.stage === "label" && operation.status === "applied");
    assert(labelOperation, "Applied plan does not contain a successful Label helper operation");
    const helperResult = object(object(labelOperation.commandResult).result);
    const candidates = array(helperResult.candidates).map(object);
    assert(candidates.length > 0, "Label helper returned no candidate to review");
    const packageId = string(object(before.package).id);
    assert(packageId, "VisionContext does not contain Package id");
    const stageExecution = object(helperResult.labelStageExecution);
    const config = object(object(helperResult.labelDetection).config);
    const review = object(await request("review-first-label-candidate", "POST",
      `/management/items/${segment(options.source)}/${segment(options.itemId)}/packages/${segment(packageId)}/labels/review`, {
        body: {
          operation: {
            helperId: string(stageExecution.helperId) ?? "label-roi-detection",
            helperVersion: string(stageExecution.algorithmVersion) ?? String(helperResult.version ?? "1"),
            initialConfig: config,
            finalConfig: config,
            candidates: candidates.map((candidate) => ({
              id: requiredString(candidate.id, "Label candidate id is missing"),
              payload: candidate,
              score: finiteNumber(candidate.score),
            })),
            reviewMode: "accepted",
          },
          reviews: candidates.map((candidate, index) => ({
            candidateId: requiredString(candidate.id, "Label candidate id is missing"),
            state: index === 0 ? "accepted" : "rejected",
            ...(index === 0 ? { geometry: rectangleGeometry(object(candidate.bbox)) } : {}),
          })),
        },
      }));
    reviewedLabelId = array(review.resultEntityIds).map(string).find((id): id is string => Boolean(id)) ?? null;
    assert(reviewedLabelId, "Label review did not create a canonical Label entity");

    const graph = object(await request("canonical-graph-after-label-review", "GET",
      `/management/items/${segment(options.source)}/${segment(options.itemId)}/annotations`));
    const graphPackage = array(graph.packages).map(object).find((item) => item.id === packageId);
    assert(graphPackage, "Reviewed Package is missing from canonical graph");
    const graphLabel = array(graphPackage.labels).map(object).find((item) => item.id === reviewedLabelId);
    assert(graphLabel, "Reviewed Label is missing from canonical graph");
    assert(graphLabel.origin === "helper", "Reviewed Label did not retain helper provenance");
    assert(graphLabel.geometryReviewStatus === "reviewed", "Canonical Label geometry is not reviewed");

    const reviewedContext = object(await request("vision-context-after-label-review", "GET", `${annotationPath}/vision-context`));
    assert(array(reviewedContext.labels).map(object).some((label) => label.id === reviewedLabelId), "Reviewed Label is missing from VisionContext");
    const labelState = object(object(object(reviewedContext.stageState).package).label);
    assert(labelState.status === "reviewed", `Label stage must be reviewed, got ${String(labelState.status ?? "missing")}`);

    if (options.acceptOcrCandidates) {
      const ocrRun = object(await request("run-label-auto-ocr", "POST",
        `/management/items/${segment(options.source)}/${segment(options.itemId)}/annotation/helpers/ocr/run`, {
          body: { scope: { type: "label", id: reviewedLabelId }, config: {} },
          timeoutMs: options.applyTimeoutMs,
        }));
      const ocrOperationId = requiredString(ocrRun.operationId, "Auto OCR response does not contain operationId");
      const ocrCandidates = array(ocrRun.candidates).map(object);
      assert(ocrRun.status === "draft", `Auto OCR must create a draft operation, got ${String(ocrRun.status ?? "missing")}`);
      assert(ocrCandidates.length > 0, "Auto OCR returned no candidates to review");

      const ocrReview = object(await request("review-auto-ocr-candidates", "POST",
        `/management/items/${segment(options.source)}/${segment(options.itemId)}/annotation/helpers/ocr/review`, {
          body: {
            operationId: ocrOperationId,
            reviews: ocrCandidates.map((candidate) => ({
              candidateId: requiredString(candidate.id, "OCR candidate id is missing"),
              state: "accepted",
              finalParent: { type: "label", packageId, labelId: reviewedLabelId },
            })),
          },
        }));
      assert(ocrReview.status === "reviewed", `OCR review must be reviewed, got ${String(ocrReview.status ?? "missing")}`);
      reviewedOcrIds = array(ocrReview.resultEntityIds).map(string).filter((id): id is string => Boolean(id));
      assert(reviewedOcrIds.length === ocrCandidates.length, "OCR review did not create one canonical entity per accepted candidate");

      const ocrGraph = object(await request("canonical-graph-after-ocr-review", "GET",
        `/management/items/${segment(options.source)}/${segment(options.itemId)}/annotations`));
      const ocrPackage = array(ocrGraph.packages).map(object).find((item) => item.id === packageId);
      const ocrLabel = array(object(ocrPackage).labels).map(object).find((item) => item.id === reviewedLabelId);
      const graphOcr = array(object(ocrLabel).ocr).map(object);
      assert(reviewedOcrIds.every((id) => graphOcr.some((ocr) => ocr.id === id)), "Reviewed OCR is missing from canonical graph");
      for (const ocr of graphOcr.filter((item) => reviewedOcrIds.includes(String(item.id)))) {
        assert(ocr.labelId === reviewedLabelId, "Canonical OCR belongs to another Label");
        const coordinateSpace = object(ocr.coordinateSpace);
        assert(coordinateSpace.type === "label-rectified" && coordinateSpace.labelId === reviewedLabelId,
          "Canonical OCR lost its Label-rectified coordinate space");
      }

      const ocrContext = object(await request("vision-context-after-ocr-review", "GET", `${annotationPath}/vision-context`));
      const contextLabel = array(ocrContext.labels).map(object).find((label) => label.id === reviewedLabelId);
      assert(array(object(contextLabel).ocr).length === reviewedOcrIds.length, "VisionContext OCR count differs from canonical review result");
      const ocrState = object(object(object(ocrContext.stageState).labels)[reviewedLabelId]);
      assert(object(ocrState.ocr).status === "reviewed", `OCR stage must be reviewed, got ${String(object(ocrState.ocr).status ?? "missing")}`);
      assert(object(ocrState.mask).valid === true, "Reviewed OCR did not unblock the Mask stage");
    }
  }
  return finish({
    annotationId,
    planId,
    controllerStatus,
    terminalStatus,
    executionEvidenceBefore: array(before.executionEvidence).length,
    executionEvidenceAfter: array(after.executionEvidence).length,
    reviewedLabelId,
    reviewedOcrIds,
    readyForCanonicalExport: object(after.validation).readyForCanonicalExport ?? null,
  });
}

async function request(
  name: string,
  method: "GET" | "POST",
  path: string,
  input: { body?: unknown; authenticated?: boolean; timeoutMs?: number } = {},
) {
  const url = `${options.baseUrl}${path}`;
  const started = Date.now();
  log(`${name}: ${method} ${url}`);
  const headers = new Headers({ accept: "application/json" });
  if (input.authenticated !== false) {
    headers.set("x-internal-api-key", options.apiKey);
    headers.set("x-auth-role", options.actorRole);
    headers.set("x-auth-subject", options.actorSubject);
  }
  if (input.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(input.timeoutMs ?? options.timeoutMs),
  });
  const text = await response.text();
  const body = parseBody(text);
  const step = { name, method, url, status: response.status, durationMs: Date.now() - started, response: body } satisfies StepRecord;
  steps.push(step);
  log(`${name}: HTTP ${response.status} (${step.durationMs} ms)`);
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}: ${compact(body)}`);
  return body;
}

async function finish(summary: JsonObject) {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), options: publicOptions(), summary, steps };
  if (options.output) {
    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log(`report: ${output}`);
  }
  console.log(JSON.stringify(summary, null, 2));
  return report;
}

function parseOptions(args: string[]) {
  const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const source = value("--source");
  const itemId = value("--item");
  if (!source || !["svoe_vino", "roskachestvo"].includes(source)) throw new Error("--source must be svoe_vino or roskachestvo");
  if (!itemId) throw new Error("--item is required");
  const parsed = {
    baseUrl: trimSlash(value("--base-url") ?? "http://127.0.0.1:4001"),
    apiKey: value("--api-key") ?? process.env.INTERNAL_API_KEY ?? "development-secret",
    actorRole: value("--actor-role") ?? "ml-service",
    actorSubject: value("--actor-subject") ?? "controller-e2e-probe",
    source,
    itemId,
    annotationId: value("--annotation"),
    createTrack: args.includes("--create-track"),
    apply: args.includes("--apply"),
    acceptFirstLabel: args.includes("--accept-first-label"),
    acceptOcrCandidates: args.includes("--accept-ocr-candidates"),
    maxSide: positiveNumber(value("--max-side"), 768),
    timeoutMs: positiveNumber(value("--timeout-ms"), 30_000),
    applyTimeoutMs: positiveNumber(value("--apply-timeout-ms"), 180_000),
    output: value("--output"),
  };
  if (parsed.acceptFirstLabel && (!parsed.createTrack || !parsed.apply)) {
    throw new Error("--accept-first-label requires both --create-track and --apply");
  }
  if (parsed.acceptOcrCandidates && !parsed.acceptFirstLabel) {
    throw new Error("--accept-ocr-candidates requires --accept-first-label");
  }
  return parsed;
}

function publicOptions() {
  const { apiKey: _secret, ...safe } = options;
  return safe;
}
function parseBody(value: string): unknown { if (!value) return null; try { return JSON.parse(value); } catch { return value; } }
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string | null { return typeof value === "string" ? value : null; }
function segment(value: string) { return encodeURIComponent(value); }
function trimSlash(value: string) { return value.replace(/\/$/, ""); }
function positiveNumber(value: string | undefined, fallback: number) { const parsed = Number(value ?? fallback); if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected a positive number, got ${value}`); return parsed; }
function finiteNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function requiredString(value: unknown, error: string) { const result = string(value); if (!result) throw new Error(error); return result; }
function rectangleGeometry(value: JsonObject) {
  const x = finiteNumber(value.x); const y = finiteNumber(value.y); const width = finiteNumber(value.width); const height = finiteNumber(value.height);
  assert(x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0, "Label candidate bbox is invalid");
  return { type: "quad", points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], bbox: { x, y, width, height } };
}
function assert(condition: unknown, text: string): asserts condition { if (!condition) throw new Error(text); }
function compact(value: unknown) { const text = typeof value === "string" ? value : JSON.stringify(value); return text.length > 500 ? `${text.slice(0, 500)}...` : text; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function log(value: string) { process.stderr.write(`[controller-probe] ${new Date().toISOString()} ${value}\n`); }

main().catch(async (error) => {
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), options: publicOptions(), error: message(error), steps };
  if (options.output) {
    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log(`failed report: ${output}`);
  }
  console.error(error);
  process.exitCode = 1;
});
