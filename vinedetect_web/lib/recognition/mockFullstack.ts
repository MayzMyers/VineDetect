import "server-only";
import { randomInt, randomUUID } from "node:crypto";
import bootstrap from "@/public/mock/recognition-bootstrap.v1.json";

export type MockRecognitionScenario = "match" | "no_match" | "ambiguous" | "guidance" | "failure";

type MockJob = {
  jobId: string;
  sessionId: string;
  scenario: MockRecognitionScenario;
  tokens: string[];
  catalogKey?: string;
  catalogCandidate?: MockCatalogCandidate;
  createdAt: number;
  image: { name: string; type: string; size: number };
  timeline: MockTimelineEvent[];
};

type MockCatalogCandidate = {
  wineId: string;
  title: string;
  producer?: string;
  imageUrl?: string;
};

type MockTimelineEvent = {
  atMs: number;
  status: "queued" | "processing" | "completed" | "failed";
  stage: string;
  message: string;
};

const globalStore = globalThis as typeof globalThis & {
  __vinedetectMockRecognitionJobs?: Map<string, MockJob>;
};
const jobs = globalStore.__vinedetectMockRecognitionJobs ??= new Map<string, MockJob>();
const mockItems = bootstrap.items as Array<{
  catalogKey: string;
  displayTitle: string;
  producer?: string;
  imageUrl?: string;
  metadata?: {
    region?: string;
    vintage?: number;
    color?: string;
    sweetness?: string;
    grapes?: string[];
  };
  tags: Array<{ value: string; weight: number }>;
}>;

export function createMockRecognitionJob(input: Omit<MockJob, "jobId" | "createdAt" | "timeline">) {
  const dedup = [...jobs.values()].find((job) =>
    job.sessionId === input.sessionId &&
    job.scenario === input.scenario &&
    job.tokens.join("|") === input.tokens.join("|")
  );
  if (dedup) return { job: dedup, reused: true };

  const job = {
    ...input,
    jobId: randomUUID(),
    createdAt: Date.now(),
    timeline: buildRandomTimeline(input.scenario),
  };
  jobs.set(job.jobId, job);
  return { job, reused: false };
}

export function getMockRecognitionJob(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const elapsed = Date.now() - job.createdAt;
  const currentIndex = findCurrentEventIndex(job.timeline, elapsed);
  const current = job.timeline[currentIndex];
  const next = job.timeline[currentIndex + 1];
  const common = {
    jobId: job.jobId,
    sessionId: job.sessionId,
    status: current.status,
    stage: current.stage,
    events: job.timeline.slice(0, currentIndex + 1).map((event) => ({ ...event, occurredAt: new Date(job.createdAt + event.atMs).toISOString() })),
    timing: {
      elapsedMs: elapsed,
      nextTransitionInMs: next ? Math.max(0, next.atMs - elapsed) : null,
      plannedDurationMs: job.timeline.at(-1)?.atMs ?? 0,
    },
  };

  if (current.status === "queued" || current.status === "processing") {
    return { ...common, outcome: null, product: null };
  }
  if (current.status === "failed") {
    return { ...common, outcome: null, product: null, error: "MOCK_RECOGNITION_FAILED" };
  }
  if (job.scenario === "no_match") {
    return { ...common, outcome: "no_match", recognition: { confidence: 0 }, product: null };
  }

  if (job.scenario === "guidance") {
    return {
      ...common,
      outcome: "need_more_data",
      recognition: { confidence: 0.34, alternatives: [] },
      product: null,
      guidance: { type: "label_bottom", message: "Покажите нижнюю часть этикетки" },
    };
  }

  if (job.scenario === "ambiguous") {
    const alternatives = mockItems.slice(0, 3).map((item, index) => ({
      source: "mock_catalog",
      sourceItemId: item.catalogKey,
      confidence: [0.84, 0.81, 0.68][index] ?? 0.6,
      product: toMockProduct(item),
    }));
    return {
      ...common,
      outcome: "ambiguous",
      recognition: { confidence: alternatives[0]?.confidence ?? 0, alternatives },
      alternatives,
      product: null,
    };
  }

  const source = mockItems.find((item) => item.catalogKey === job.catalogKey)
    ?? mockItems.find((item) => item.imageUrl)
    ?? mockItems[0];
  return {
    ...common,
    status: "completed",
    stage: "completed",
    outcome: "match",
    recognition: { confidence: 0.93, alternatives: [] },
    product: job.catalogCandidate
      ? toMockCandidateProduct(job.catalogCandidate)
      : source ? toMockProduct(source) : null,
  };
}

function toMockCandidateProduct(candidate: MockCatalogCandidate) {
  return {
    id: candidate.wineId,
    catalogKey: candidate.wineId,
    slug: candidate.wineId.split(":").slice(1).join(":"),
    title: candidate.title,
    producer: candidate.producer ?? null,
    image: candidate.imageUrl ?? null,
    category: null,
    region: null,
    vintage: null,
    description: "Мы сопоставили текст и оформление этикетки с информацией из винной коллекции.",
  };
}

export function describeMockRecognitionJob(job: MockJob) {
  return {
    plannedDurationMs: job.timeline.at(-1)?.atMs ?? 0,
    stages: job.timeline.map((event) => ({ atMs: event.atMs, status: event.status, stage: event.stage })),
  };
}

export function getMockRecognitionTags() {
  const weighted = new Map<string, number>();
  for (const item of mockItems) {
    for (const tag of item.tags) weighted.set(tag.value, Math.max(weighted.get(tag.value) ?? 0, tag.weight));
  }
  return {
    version: `mock-fullstack:${bootstrap.version}`,
    tags: [...weighted].sort((a, b) => b[1] - a[1]).slice(0, 120).map(([tag]) => tag),
  };
}

function buildRandomTimeline(scenario: MockRecognitionScenario): MockTimelineEvent[] {
  let atMs = 0;
  const events: MockTimelineEvent[] = [
    { atMs, status: "queued", stage: "queued", message: "Job accepted by BFF" },
  ];
  const add = (stage: string, message: string, minimum: number, maximum: number) => {
    atMs += randomInt(minimum, maximum + 1);
    events.push({ atMs, status: "processing", stage, message });
  };
  add("upload-accepted", "Best frame attached", 120, 360);
  add("frame-validation", "Raster validated", 160, 480);
  add("ocr-evidence", "OCR evidence normalized", 220, 620);
  add("matching", "Recognition candidates ranked", 260, 760);
  if (scenario === "match" || scenario === "ambiguous") add("catalog-enrichment", "Catalog product loaded", 180, 520);
  atMs += randomInt(180, 520);
  events.push({
    atMs,
    status: scenario === "failure" ? "failed" : "completed",
    stage: scenario === "failure" ? "failed" : "completed",
    message: scenario === "failure" ? "Recognition pipeline failed" : scenario === "no_match" ? "No catalog match" : "Product DTO ready",
  });
  return events;
}

function toMockProduct(item: typeof mockItems[number]) {
  const category = [item.metadata?.color, item.metadata?.sweetness].filter(Boolean).join(" ");
  const grapes = item.metadata?.grapes?.filter(Boolean) ?? [];
  return {
    id: item.catalogKey,
    catalogKey: item.catalogKey,
    slug: item.catalogKey.split(":").slice(1).join(":"),
    title: item.displayTitle,
    producer: item.producer ?? null,
    image: item.imageUrl ?? null,
    category: category || null,
    region: item.metadata?.region ?? null,
    vintage: item.metadata?.vintage ?? null,
    description: grapes.length > 0
      ? `Сорта винограда: ${grapes.join(", ")}. Информация подобрана по деталям этикетки.`
      : "Информация подобрана по деталям этикетки.",
  };
}

function findCurrentEventIndex(timeline: MockTimelineEvent[], elapsed: number) {
  let current = 0;
  for (let index = 1; index < timeline.length; index += 1) {
    if (timeline[index].atMs > elapsed) break;
    current = index;
  }
  return current;
}
