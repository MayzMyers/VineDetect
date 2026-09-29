export type RecognitionListSource = "all" | "svoe_vino" | "roskachestvo";
export type RecognitionListCvMeta = "all" | "present" | "missing";
export type RecognitionListAnnotationStatus = "" | "not-started" | "in-progress" | "complete" | "missing" | "needs-review" | "reviewed" | "no-label" | "invalid-image";
export type RecognitionListExecutionActor = "" | "human" | "ml-agent" | "hybrid";
export type RecognitionListAutomationMode = "" | "manual" | "auto" | "mixed";

export type RecognitionListRouteState = {
  page: number;
  query: string;
  source: RecognitionListSource;
  status: string;
  cvMeta: RecognitionListCvMeta;
  annotationStatus: RecognitionListAnnotationStatus;
  executionActor: RecognitionListExecutionActor;
  automationMode: RecognitionListAutomationMode;
  recognitionTag: string;
  firstPerInitial: boolean;
  perInitialLimit: number;
};

export const DEFAULT_RECOGNITION_LIST_ROUTE_STATE: RecognitionListRouteState = {
  page: 1,
  query: "",
  source: "all",
  status: "",
  cvMeta: "all",
  annotationStatus: "",
  executionActor: "",
  automationMode: "",
  recognitionTag: "",
  firstPerInitial: false,
  perInitialLimit: 3,
};

export function parseRecognitionListRouteState(params: Pick<URLSearchParams, "get">): RecognitionListRouteState {
  return {
    page: positiveInt(params.get("page")) ?? 1,
    query: params.get("q") ?? "",
    source: oneOf(params.get("source"), ["all", "svoe_vino", "roskachestvo"] as const) ?? "all",
    status: params.get("status") ?? "",
    cvMeta: oneOf(params.get("cv"), ["all", "present", "missing"] as const) ?? "all",
    annotationStatus: oneOf(params.get("annotation"), ["not-started", "in-progress", "complete", "missing", "needs-review", "reviewed", "no-label", "invalid-image"] as const) ?? "",
    executionActor: oneOf(params.get("actor"), ["human", "ml-agent", "hybrid"] as const) ?? "",
    automationMode: oneOf(params.get("automation"), ["manual", "auto", "mixed"] as const) ?? "",
    recognitionTag: params.get("tag") ?? "",
    firstPerInitial: params.get("firstPerInitial") === "1",
    perInitialLimit: boundedPositiveInt(params.get("perInitialLimit"), 100) ?? 3,
  };
}

export function recognitionListHref(state: RecognitionListRouteState) {
  const params = new URLSearchParams();
  if (state.page > 1) params.set("page", String(state.page));
  if (state.query) params.set("q", state.query);
  if (state.source !== "all") params.set("source", state.source);
  if (state.status) params.set("status", state.status);
  if (state.cvMeta !== "all") params.set("cv", state.cvMeta);
  if (state.annotationStatus) params.set("annotation", state.annotationStatus);
  if (state.executionActor) params.set("actor", state.executionActor);
  if (state.automationMode) params.set("automation", state.automationMode);
  if (state.recognitionTag) params.set("tag", state.recognitionTag);
  if (state.firstPerInitial) {
    params.set("firstPerInitial", "1");
    params.set("perInitialLimit", String(state.perInitialLimit));
  }
  const query = params.toString();
  return `/admin/recognition${query ? `?${query}` : ""}`;
}

export function recognitionItemHref(source: string, sourceItemId: string, section: "metadata" | "annotation", returnTo: string) {
  const params = new URLSearchParams({ section, returnTo });
  return `/admin/recognition/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}?${params.toString()}`;
}

export function recognitionDetailSectionHref(
  source: string,
  sourceItemId: string,
  section: "catalog" | "text" | "annotation" | "cv" | "saved" | "history",
  trackId?: string | null,
  returnTo?: string | null,
) {
  const querySection = section === "cv" ? "cv-lab" : section === "saved" ? "metadata" : section === "history" ? "jobs" : section;
  const params = new URLSearchParams({ section: querySection });
  if (trackId) params.set("track", trackId);
  if (returnTo) params.set("returnTo", returnTo);
  return `/admin/recognition/${encodeURIComponent(source)}/${encodeURIComponent(sourceItemId)}?${params.toString()}`;
}

export function recognitionListScrollKey(returnTo: string) {
  return `vinedetect:recognition-list-scroll:${returnTo}`;
}

function positiveInt(value: string | null) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function boundedPositiveInt(value: string | null, max: number) {
  const parsed = positiveInt(value);
  return parsed !== null && parsed <= max ? parsed : null;
}

function oneOf<const T extends readonly string[]>(value: string | null, allowed: T): T[number] | null {
  return value && allowed.includes(value) ? value as T[number] : null;
}
