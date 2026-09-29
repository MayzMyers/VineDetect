import { UpstreamServiceError } from "../../shared/errors.js";
import { externalControllerResponseSchema } from "./wizard.schemas.js";
import type { ZodType } from "zod";

export type ExternalControllerHttpOptions = Readonly<{
  url: string;
  token?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  displayName: string;
  signal?: AbortSignal;
}>;

export class ExternalControllerRequestCancelledError extends Error {
  constructor() {
    super("External controller request cancelled");
    this.name = "ExternalControllerRequestCancelledError";
  }
}

export async function requestExternalController<T = ReturnType<typeof externalControllerResponseSchema.parse>>(
  payload: Record<string, unknown>, options: ExternalControllerHttpOptions, responseSchema: ZodType<T> = externalControllerResponseSchema as unknown as ZodType<T>,
) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) throw new ExternalControllerRequestCancelledError();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  try {
    const response = await fetch(options.url, {
      method: "POST", signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    const responseText = await response.text();
    if (Buffer.byteLength(responseText) > options.maxResponseBytes) {
      throw new UpstreamServiceError(`${options.displayName} response exceeds the configured limit`, 502, {
        kind: "response_too_large", service: options.displayName, retryable: false,
      });
    }
    if (!response.ok) {
      const detail = safeControllerDetail(responseText);
      const evidence = safeControllerEvidence(responseText);
      const statusCode = response.status >= 500 ? 503 : 502;
      const providerStatus = providerHttpStatus(detail);
      throw new UpstreamServiceError(`${options.displayName} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`, statusCode, {
        kind: evidence ? "contract" : "http", service: options.displayName, controllerStatus: response.status,
        providerStatus, retryable: evidence ? false : retryableStatus(providerStatus ?? response.status), detail: detail || null,
        ...(evidence ? { providerEvidence: evidence } : {}),
      });
    }
    let value: unknown;
    try { value = JSON.parse(responseText); }
    catch { throw new UpstreamServiceError(`${options.displayName} returned invalid JSON`, 502, {
      kind: "invalid_json", service: options.displayName, controllerStatus: response.status, retryable: false,
    }); }
    const parsed = responseSchema.safeParse(value);
    if (!parsed.success) {
      const contractIssues = safeContractIssues(parsed.error.issues);
      const detail = contractIssues.slice(0, 3).map((issue) => `${issue.path || "<root>"}: ${issue.message}`).join("; ") || "invalid response";
      throw new UpstreamServiceError(`${options.displayName} response violates the correction-plan contract: ${detail}`, 502, {
        kind: "contract", service: options.displayName, controllerStatus: response.status, retryable: false,
        contractIssues, responseSummary: safeResponseSummary(value),
      });
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof UpstreamServiceError) throw error;
    if (error instanceof Error && error.name === "AbortError" && options.signal?.aborted && !timedOut) throw new ExternalControllerRequestCancelledError();
    if (error instanceof Error && error.name === "AbortError") throw new UpstreamServiceError(`${options.displayName} timed out`, 503, {
      kind: "timeout", service: options.displayName, timeoutMs: options.timeoutMs, retryable: true,
    });
    throw new UpstreamServiceError(`${options.displayName} request failed: ${error instanceof Error ? error.message : String(error)}`, 503, {
      kind: "network", service: options.displayName, retryable: true,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

type ContractIssue = Readonly<{ path: string; code: string; message: string }>;

function safeContractIssues(issues: readonly unknown[]) {
  const result: ContractIssue[] = [];
  const visit = (issue: unknown, inheritedPath: readonly unknown[] = []) => {
    if (result.length >= 20 || !issue || typeof issue !== "object" || Array.isArray(issue)) return;
    const record = issue as Record<string, unknown>;
    const ownPath = Array.isArray(record.path) ? record.path : [];
    const path = ownPath.length ? ownPath : inheritedPath;
    if (record.code === "invalid_union" && Array.isArray(record.errors)) {
      for (const branch of record.errors) {
        if (!Array.isArray(branch)) continue;
        for (const nested of branch) visit(nested, path);
      }
      return;
    }
    result.push({
      path: path.map(String).join("."),
      code: typeof record.code === "string" ? record.code : "custom",
      message: typeof record.message === "string" ? record.message.replace(/\s+/g, " ").slice(0, 300) : "Invalid value",
    });
  };
  for (const issue of issues) visit(issue);
  return result;
}

function safeResponseSummary(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valueType: value === null ? "null" : typeof value };
  const response = value as Record<string, unknown>;
  const decision = response.decision && typeof response.decision === "object" && !Array.isArray(response.decision)
    ? response.decision as Record<string, unknown>
    : {};
  const operations = Array.isArray(decision.editOperations) ? decision.editOperations : [];
  return {
    schemaVersion: response.schemaVersion ?? null,
    status: typeof response.status === "string" ? response.status : null,
    observationId: typeof response.observationId === "string" ? response.observationId.slice(0, 120) : null,
    decision: {
      stage: typeof decision.stage === "string" ? decision.stage : null,
      action: typeof decision.action === "string" ? decision.action : null,
      candidateId: typeof decision.candidateId === "string" ? decision.candidateId.slice(0, 120) : null,
      reviewCount: Array.isArray(decision.reviews) ? decision.reviews.length : null,
      topologyEditCount: Array.isArray(decision.topologyEdits) ? decision.topologyEdits.length : null,
      editOperationCount: operations.length,
      editOperationTypes: operations.slice(0, 100).map((operation) => operation && typeof operation === "object" && !Array.isArray(operation)
        ? String((operation as Record<string, unknown>).type ?? "unknown").slice(0, 80)
        : "invalid"),
    },
  };
}

function providerHttpStatus(detail: string) {
  const matches = [...detail.matchAll(/HTTP\s+(\d{3})/gi)];
  const value = Number(matches.at(-1)?.[1]);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function retryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function safeControllerDetail(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const detail = typeof record.detail === "string" ? record.detail : typeof record.error === "string" ? record.error : "";
      return detail.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
    }
  } catch { /* Non-JSON upstream bodies are intentionally not surfaced. */ }
  return "";
}

function safeControllerEvidence(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const evidence = (parsed as Record<string, unknown>).evidence;
    return evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? evidence as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
