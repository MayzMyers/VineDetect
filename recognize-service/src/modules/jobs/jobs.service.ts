import { createOfficialDraft } from "../../db/official-draft.repository.js";
import { getOfficialReference } from "../../db/official-reference.repository.js";
import { officialTargetForTrack,getSourceItemForTrack,captureOfficialDraft } from "../../db/official-draft.repository.js";
import {
  createBatchRecognizeJob,
  createRecognizeJob,
  countActiveJobsForSource,
  getGenerationJob,
  softDeleteGenerationJob,
  listGenerationJobs,
  listGenerationJobsForSourceItem,
  listChildJobs,
  markJobCancelRequested,
  requeueRecognizeJob,
  reopenParentJobForRetry,
  summarizeChildJobs,
  summarizeChildJobsForParents,
  updateGenerationJob,
} from "../../db/meta.repository.js";
import { getPipelinePresetRevision } from "../../db/preset.repository.js";
import {
  countSourceItemsForMetaGenerationScope,
  getSourceItem,
  listSourceItemsForMetaGenerationScope,
} from "../../db/source.repository.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { hashConfigSnapshot } from "../../shared/configHash.js";
import type { RecognizeJobType, SourceName } from "../../shared/types.js";
import { computeSourceHash } from "../generation/generation.pipeline.js";
import { getLatestReviewedLabelAnnotationRevision, getReviewedLabelAnnotationRevision } from "../../db/annotation.repository.js";
import { labelAnalysisProfile } from "../label-analysis/labelAnalysis.js";
import { normalizeLabelAnalysisCvConfig } from "../label-analysis/labelCropFeatures.js";
import { getAnnotationGraph } from "../../db/annotation-graph.repository.js";
import { attachAnnotationVersionJob, createFreshAnnotationVersion, resetDraftAnnotationVersion, getAnnotationVersion } from "../../db/card-version.repository.js";

const DEFAULT_PIPELINE_VERSION = "cv-meta-v2-debug-layers";

type RecognizeJobOptions = {
  force?: boolean;
  pipelineVersion?: string;
  batchSize?: number;
  presetId?: string;
  presetRevision?: number;
  configHash?: string;
  pipelineConfigSnapshot?: Record<string, unknown>;
  presetLayer?: string;
  presetRevisionId?: string;
  annotationId?: string;
  annotationRevision?: number;
  annotationTrackId?: string;
  annotationVersionId?: string;
  annotationVersionInitialization?: "empty" | "after-package";
  annotationVersionPublishPolicy?: "review" | "auto-on-success";
  llmExecutionMode?: "session-chain" | "one-shot-chain";
  visionEvidence?: { labelMode: "off" | "score-only" | "rerank" };
  analysisConfigSnapshot?: Record<string, unknown>;
  automation?: Record<string, unknown>;
};

type JobItemKey = { source: SourceName; sourceItemId: string; annotationTrackId?: string };
type RecognizeJobTarget =
  | JobItemKey
  | { filter: { source: SourceName | "all"; missingCvMeta?: boolean } }
  | { items: JobItemKey[] };

export async function enqueueRecognizeJob(input: {
  type: RecognizeJobType;
  target: RecognizeJobTarget;
  options: RecognizeJobOptions;
}) {
  let options = await hydratePresetOptions(input.type, input.options);
  if (input.type === "ANNOTATION_LLM_PIPELINE" && !isSingleTarget(input.target)) return enqueueLlmWizardBatch(input.target, options);
  if (!isSingleTarget(input.target)) {
    return enqueueBatchRecognizeJob({
      type: input.type,
      target: input.target,
      options,
    });
  }

  const target = input.target;
  const sourceItem = options.annotationTrackId ? await getSourceItemForTrack(target.source, target.sourceItemId, options.annotationTrackId) : await getSourceItem(target.source, target.sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const official = options.annotationTrackId ? await officialTargetForTrack(target.source,sourceItem.sourceItemId,options.annotationTrackId) : null;
  if(options.annotationVersionId) {
    const version=await getAnnotationVersion(target.source,sourceItem.sourceItemId,options.annotationVersionId);
    if(version.origin==='contest-official' && (!official || version.annotationTrackId!==official.annotationTrackId)) throw new ConflictError('Official version requires its explicit bound track');
  }
  if (official) {
    if (!["GENERATE_DETECTION_PROPOSAL","ANALYZE_LABEL","ANNOTATION_HELPER_PIPELINE","ANNOTATION_LLM_PIPELINE"].includes(input.type)) throw new ConflictError("Official work requires a track-scoped annotation job");
    options = {...options,annotationVersionId:official.annotationVersionId,annotationVersionInitialization:undefined,annotationVersionPublishPolicy:"review"};
    await captureOfficialDraft(official,await getAnnotationGraph(target.source,sourceItem.sourceItemId));
  }
  let initializedVersion: Awaited<ReturnType<typeof resetDraftAnnotationVersion>> | null = null;
  if (input.type === "ANNOTATION_LLM_PIPELINE" && options.annotationVersionId && options.annotationVersionInitialization === "empty") {
    const initialized = await resetDraftAnnotationVersion(target.source, target.sourceItemId, options.annotationVersionId, sourceItem.imageUrls[0] ?? null);
    initializedVersion = initialized;
    options = { ...options, annotationTrackId: initialized.annotationTrackId };
  }
  if (input.type === "ANALYZE_LABEL") {
    if (!options.annotationTrackId || !options.annotationId || options.annotationRevision === undefined) throw new ConflictError("ANALYZE_LABEL requires an annotation track and reviewed annotation revision");
    const annotation = await getReviewedLabelAnnotationRevision(target.source, target.sourceItemId, options.annotationTrackId, options.annotationId, options.annotationRevision);
    if (!annotation) throw new ConflictError("Reviewed label annotation revision not found");
  }
  if ((input.type === "ANNOTATION_HELPER_PIPELINE" || input.type === "ANNOTATION_LLM_PIPELINE") && !options.annotationTrackId) {
    throw new ConflictError(`${input.type} requires annotationTrackId`);
  }
  const pipelineVersion = options.pipelineVersion ?? DEFAULT_PIPELINE_VERSION;
  const sourceHash = computeSourceHash(sourceItem);

  const job = await createRecognizeJob({
    type: input.type,
    target: official ?? undefined,
    source: target.source,
    sourceItemId: sourceItem.sourceItemId,
    annotationTrackId: options.annotationTrackId,
    annotationVersionId: options.annotationVersionId,
    options,
    pipelineVersion,
    idempotencyKey: options.force
      ? undefined
      : buildJobIdempotencyKey({
          type: input.type,
          source: target.source,
          sourceItemId: sourceItem.sourceItemId,
          pipelineVersion,
          sourceHash,
          configHash: options.configHash,
          annotationId: options.annotationId,
          annotationRevision: options.annotationRevision,
          annotationTrackId: options.annotationTrackId,
        }),
    sourceHash,
  });

  if (options.annotationVersionId) await attachAnnotationVersionJob(options.annotationVersionId, job.id);

  return {
    jobId: job.id,
    status: job.status,
    reused: job.reused,
    annotationVersionId: options.annotationVersionId ?? null,
    annotationTrackId: initializedVersion?.annotationTrackId ?? options.annotationTrackId ?? null,
  };
}

function isSingleTarget(target: RecognizeJobTarget): target is JobItemKey {
  return "source" in target && "sourceItemId" in target;
}

export async function getRecognizeJob(jobId: string) {
  const job = await getGenerationJob(jobId);
  if (!job) throw new NotFoundError("Recognize job not found");
  const childSummary = await summarizeChildJobs(jobId);
  return presentRecognizeJob(job, childSummary);
}

function presentRecognizeJob(job: Record<string, any>, childSummary: Record<string, number>) {
  const total = Number(job.total_items ?? 0);
  const queued = childSummary.queued ?? (job.status === "queued" ? total : 0);
  const running = childSummary.running ?? (job.status === "running" ? 1 : 0);
  const succeeded = childSummary.completed ?? Number(job.processed_items ?? 0);
  const failed = childSummary.failed ?? Number(job.failed_items ?? 0);

  return {
    jobId: job.id,
    parentJobId: job.parent_job_id ?? null,
    scope: job.parent_job_id ? "batch-child" : job.source_item_id ? "single-item" : "batch-parent",
    type: job.job_type ?? job.mode,
    status: job.status,
    cancelRequested: job.cancel_requested === true,
    workerId: job.worker_id ?? null,
    heartbeatAt: job.heartbeat_at?.toISOString?.() ?? job.heartbeat_at ?? null,
    leaseExpiresAt: job.lease_expires_at?.toISOString?.() ?? job.lease_expires_at ?? null,
    recoveryCount: Number(job.recovery_count ?? 0),
    annotationVersionId: job.annotation_version_id ?? null,
    target: job.target ?? {},
    options: job.options ?? {},
    progress: {
      total,
      queued,
      running,
      succeeded,
      failed,
      cancelled: childSummary.cancelled ?? 0,
      humanRequired: childSummary.blocked_by_review ?? (job.result?.status === "blocked_by_review" ? 1 : 0),
    },
    result: job.result ?? {},
    error: job.error,
    createdAt: job.created_at?.toISOString?.() ?? job.created_at,
    startedAt: job.started_at?.toISOString?.() ?? job.started_at,
    finishedAt: job.completed_at?.toISOString?.() ?? job.completed_at,
  };
}

export async function listRecognizeJobs(params: {
  status?: string;
  type?: RecognizeJobType;
  scope?: "batch-parent" | "batch-child" | "single-item";
  source?: SourceName;
  limit: number;
  offset: number;
}) {
  const { rows, total } = await listGenerationJobs(params);
  const summaries = await summarizeChildJobsForParents(rows.map((row) => String(row.id)));
  const items = rows.map((row) => presentRecognizeJob(row, summaries.get(String(row.id)) ?? {}));
  return {
    items,
    total,
    limit: params.limit,
    offset: params.offset,
  };
}

export async function listRecognizeJobItems(jobId: string, params: { status?: string; limit: number; offset: number }) {
  const job = await getGenerationJob(jobId);
  if (!job) throw new NotFoundError("Recognize job not found");
  const { rows, total } = await listChildJobs(jobId, params);
  return {
    items: rows.map((row) => ({
      jobId: row.id,
      source: row.source,
      sourceItemId: row.source_item_id,
      status: row.status,
      attempt: row.attempt,
      error: row.error,
      result: row.result ?? {},
      startedAt: row.started_at?.toISOString?.() ?? row.started_at,
      finishedAt: row.completed_at?.toISOString?.() ?? row.completed_at,
    })),
    total,
    limit: params.limit,
    offset: params.offset,
  };
}

export async function estimateRecognizeJobs(input: {
  source: SourceName | "all";
  missingCvMeta: boolean;
  force: boolean;
  pipelineVersion: string;
  batchSize: number;
  type: RecognizeJobType;
  presetId?: string;
  presetRevision?: number;
}) {
  const presetOptions = await hydratePresetOptions(input.type, {
    presetId: input.presetId,
    presetRevision: input.presetRevision,
  });
  const eligible = await countSourceItemsForMetaGenerationScope(input.source, {
    missingCvMeta: input.missingCvMeta,
    pipelineVersion: input.pipelineVersion,
    force: input.force,
  });
  const sources: SourceName[] = input.source === "all" ? ["svoe_vino", "roskachestvo"] : [input.source];
  const active = input.force
    ? 0
    : (
        await Promise.all(
          sources.map((source) =>
            countActiveJobsForSource({ source, type: input.type, pipelineVersion: input.pipelineVersion }),
          ),
        )
      ).reduce((sum, value) => sum + value, 0);
  const planned = Math.min(input.batchSize, eligible);
  return {
    source: input.source,
    pipelineVersion: input.pipelineVersion,
    missingCvMeta: input.missingCvMeta,
    force: input.force,
    eligible,
    batchSize: input.batchSize,
    planned,
    activeOrCompletedJobs: active,
    presetId: presetOptions.presetId ?? null,
    presetRevision: presetOptions.presetRevision ?? null,
    note: input.force ? "force ignores idempotency" : "non-force jobs reuse active/completed idempotency keys",
  };
}

export async function cancelRecognizeJob(jobId: string) {
  const job = await getGenerationJob(jobId);
  if (!job) throw new NotFoundError("Recognize job not found");
  if (!["queued", "running"].includes(String(job.status))) throw new ConflictError("Only an active recognize job can be cancelled");
  await markJobCancelRequested(jobId);
  return getRecognizeJob(jobId);
}

export async function retryRecognizeJob(jobId: string, mode: "current-version" | "new-version") {
  const job = await getGenerationJob(jobId);
  if (!job) throw new NotFoundError("Recognize job not found");
  if (["queued", "running"].includes(String(job.status))) throw new ConflictError("An active recognize job cannot be retried");

  const frozenTarget=jobObject(job.target);
  if (frozenTarget.mode === "contest-official") throw new ConflictError("Retry official batches through a fresh official preflight and explicit assignment selection");
  if (frozenTarget.catalogItemId) {
    if (mode !== "new-version") throw new ConflictError("Official retries require a separate new draft to preserve reviewed state");
    const reference=await getOfficialReference(String(frozenTarget.catalogItemId));
    const draft=await createOfficialDraft(reference);
    return enqueueRecognizeJob({type:String(job.job_type) as RecognizeJobType,target:{source:draft.source,sourceItemId:draft.sourceItemId},options:{...jobObject(job.options),annotationTrackId:draft.annotationTrackId,annotationVersionId:draft.annotationVersionId,force:true}});
  }
  const type = String(job.job_type ?? job.mode) as RecognizeJobType;
  const options = jobObject(job.options) as RecognizeJobOptions;
  if (mode === "current-version") {
    if (!job.source_item_id) throw new ConflictError("A batch parent cannot overwrite card versions; retry it as new instead");
    let annotationTrackId = job.annotation_track_id ? String(job.annotation_track_id) : null;
    const annotationVersionId = job.annotation_version_id ? String(job.annotation_version_id) : null;
    let nextOptions: RecognizeJobOptions = { ...options };
    if (type === "ANNOTATION_LLM_PIPELINE") {
      if (!annotationVersionId) throw new ConflictError("This LLM job is not linked to an annotation version");
      const source = String(job.source) as SourceName;
      const sourceItemId = String(job.source_item_id);
      const sourceItem = await getSourceItem(source, sourceItemId);
      if (!sourceItem) throw new NotFoundError("Source item not found");
      const reset = await resetDraftAnnotationVersion(source, sourceItemId, annotationVersionId, sourceItem.imageUrls[0] ?? null);
      annotationTrackId = reset.annotationTrackId;
      nextOptions = { ...options, annotationVersionId, annotationTrackId, annotationVersionInitialization: undefined };
    }
    const retried = await requeueRecognizeJob(jobId, { annotationTrackId, annotationVersionId, options: nextOptions as Record<string, unknown> });
    if (!retried) throw new ConflictError("Only a terminal recognize job can be retried");
    if (annotationVersionId) await attachAnnotationVersionJob(annotationVersionId, jobId);
    if (job.parent_job_id) await reopenParentJobForRetry(String(job.parent_job_id));
    return { jobId, previousJobId: jobId, retried: 1, status: "queued" as const, mode, annotationVersionId, annotationTrackId };
  }

  if (!job.source_item_id) {
    const created = await enqueueRecognizeJob({
      type,
      target: jobObject(job.target) as RecognizeJobTarget,
      options: { ...options, force: true },
    });
    return { ...created, previousJobId: jobId, retried: 1, mode };
  }

  const source = String(job.source) as SourceName;
  const sourceItemId = String(job.source_item_id);
  if (type === "ANNOTATION_LLM_PIPELINE") {
    const graph = await getAnnotationGraph(source, sourceItemId);
    const sourceItem = await getSourceItem(source, sourceItemId);
    if (!sourceItem) throw new NotFoundError("Source item not found");
    const sourceVersionId = job.annotation_version_id ? String(job.annotation_version_id) : null;
    const version = await createFreshAnnotationVersion(source, sourceItemId, graph as unknown as Record<string, unknown>, "job-retry-as-new", sourceVersionId, sourceItem.imageUrls[0] ?? null);
    const nextOptions: RecognizeJobOptions = {
      ...options,
      annotationVersionId: version.versionId,
      annotationTrackId: version.annotationTrackId,
      annotationVersionInitialization: undefined,
    };
    const created = await createRecognizeJob({
      type, source, sourceItemId,
      annotationTrackId: version.annotationTrackId,
      annotationVersionId: version.versionId,
      options: nextOptions as Record<string, unknown>,
      pipelineVersion: String(job.pipeline_version),
      sourceHash: typeof job.source_hash === "string" ? job.source_hash : undefined,
    });
    await attachAnnotationVersionJob(version.versionId, created.id);
    return {
      jobId: created.id, previousJobId: jobId, retried: 1, status: created.status, mode,
      annotationVersionId: version.versionId, annotationTrackId: version.annotationTrackId,
    };
  }

  const created = await createRecognizeJob({
    type, source, sourceItemId,
    annotationTrackId: job.annotation_track_id ? String(job.annotation_track_id) : undefined,
    options: { ...options, force: true } as Record<string, unknown>,
    pipelineVersion: String(job.pipeline_version),
    sourceHash: typeof job.source_hash === "string" ? job.source_hash : undefined,
  });
  return { jobId: created.id, previousJobId: jobId, retried: 1, status: created.status, mode };
}

const DELETABLE_JOB_STATUSES = new Set(["completed", "failed", "completed_with_errors", "cancelled"]);

export async function deleteRecognizeJob(jobId: string) {
  const job = await getGenerationJob(jobId);
  if (!job) throw new NotFoundError("Recognize job not found");
  if (!DELETABLE_JOB_STATUSES.has(String(job.status))) {
    throw new ConflictError("Active recognize job cannot be deleted; cancel it first");
  }
  const deleted = await softDeleteGenerationJob(jobId);
  if (!deleted) throw new NotFoundError("Recognize job not found");

  if (deleted.parentJobId) {
    const parent = await getGenerationJob(deleted.parentJobId);
    if (parent) {
      const summary = await summarizeChildJobs(deleted.parentJobId);
      const completed = summary.completed ?? 0;
      const failed = summary.failed ?? 0;
      const cancelled = summary.cancelled ?? 0;
      const queued = summary.queued ?? 0;
      const running = summary.running ?? 0;
      await updateGenerationJob(deleted.parentJobId, {
        totalItems: completed + failed + cancelled + queued + running,
        processedItems: completed,
        failedItems: failed,
        result: { ...parent.result, completed, failed, cancelled, queued, running },
      });
    }
  }
  return deleted;
}

async function enqueueLlmWizardBatch(target: Exclude<RecognizeJobTarget, JobItemKey>, options: RecognizeJobOptions) {
  if (!("items" in target)) throw new ConflictError("LLM Wizard batch requires an explicit frozen card selection");
  const cards = [...new Map(target.items.map((card) => [`${card.source}:${card.sourceItemId}`, card])).values()];
  const resolved = await Promise.all(cards.map(async (card) => {
    const item = await getSourceItem(card.source, card.sourceItemId);
    if (!item) throw new NotFoundError(`Source item not found: ${card.source}:${card.sourceItemId}`);
    return { card, item };
  }));
  const pipelineVersion = options.pipelineVersion ?? "wizard-llm-stage-v1";
  const parent = await createBatchRecognizeJob({
    type: "ANNOTATION_LLM_PIPELINE", source: commonSource(cards) ?? undefined,
    target: { scope: "annotation-card-versions", items: cards, resolvedAt: new Date().toISOString() },
    options, pipelineVersion, totalItems: cards.length,
  });
  for (const { card, item } of resolved) {
    const graph = await getAnnotationGraph(card.source, card.sourceItemId);
    const version = await createFreshAnnotationVersion(card.source, card.sourceItemId, graph as unknown as Record<string, unknown>, "recognition-list-batch", undefined, item.imageUrls[0] ?? null);
    const child = await createRecognizeJob({
      type: "ANNOTATION_LLM_PIPELINE", source: card.source, sourceItemId: card.sourceItemId,
      annotationTrackId: version.annotationTrackId, annotationVersionId: version.versionId, parentJobId: parent.id, status: "queued",
      options: { ...options, annotationTrackId: version.annotationTrackId, annotationVersionId: version.versionId, annotationVersionPublishPolicy: "auto-on-success" }, pipelineVersion,
      sourceHash: computeSourceHash(item),
    });
    await attachAnnotationVersionJob(version.versionId, child.id);
  }
  return { jobId: parent.id, status: parent.status, reused: false, queuedChildren: cards.length };
}

export async function listAnnotationPipelineJobs(input: { source: SourceName; sourceItemId: string; annotationTrackId: string; limit: number; offset: number }) {
  const rows = await listGenerationJobsForSourceItem({
    source: input.source, sourceItemId: input.sourceItemId, annotationTrackId: input.annotationTrackId,
    jobType: "ANNOTATION_HELPER_PIPELINE", limit: input.limit, offset: input.offset,
  });
  return { items: await Promise.all(rows.map((row) => getRecognizeJob(String(row.id)))), limit: input.limit, offset: input.offset };
}

async function enqueueBatchRecognizeJob(input: {
  type: RecognizeJobType;
  target: Exclude<RecognizeJobTarget, JobItemKey>;
  options: RecognizeJobOptions;
}) {
  if (input.type === "ANALYZE_LABEL") throw new ConflictError("Batch label analysis requires explicit annotation-track targets and is not supported");
  if (input.type === "ANNOTATION_HELPER_PIPELINE") throw new ConflictError("Batch annotation pipeline requires one annotationTrackId per item and is not supported yet");
  const limit = input.options.batchSize ?? 25;
  const pipelineVersion = input.options.pipelineVersion ?? DEFAULT_PIPELINE_VERSION;
  const items = "items" in input.target
    ? await resolveFrozenSelection(input.target.items)
    : await listSourceItemsForMetaGenerationScope(input.target.filter.source, limit, {
        missingCvMeta: input.target.filter.missingCvMeta,
        pipelineVersion,
        force: input.options.force,
      });
  const itemKeys = items.map((item) => ({ source: item.source, sourceItemId: item.sourceItemId }));
  const reviewedAnnotations: Array<Awaited<ReturnType<typeof getLatestReviewedLabelAnnotationRevision>>> = [];
  const missingReviewedIndex = reviewedAnnotations.findIndex((annotation) => !annotation);
  if (missingReviewedIndex >= 0) {
    const item = items[missingReviewedIndex];
    throw new ConflictError(`Reviewed label annotation not found: ${item.source}:${item.sourceItemId}`);
  }
  const parentSource = commonSource(itemKeys);
  const frozenTarget = {
    scope: "items" in input.target ? "selection" : input.target.filter.source === "all" ? "global" : "source",
    ...( "filter" in input.target ? { filter: input.target.filter } : {}),
    items: itemKeys,
    resolvedAt: new Date().toISOString(),
  };
  const parent = await createBatchRecognizeJob({
    type: input.type,
    source: parentSource ?? undefined,
    target: frozenTarget,
    options: input.options,
    pipelineVersion,
    totalItems: items.length,
  });

  let queuedChildren = 0;
  for (const [itemIndex, item] of items.entries()) {
    const sourceHash = computeSourceHash(item);
    const annotation = reviewedAnnotations[itemIndex] ?? null;
    const childOptions = annotation ? { ...input.options, annotationId: annotation.id, annotationRevision: annotation.revision } : input.options;
    const child = await createRecognizeJob({
      type: input.type,
      source: item.source,
      sourceItemId: item.sourceItemId,
      options: childOptions,
      pipelineVersion,
      parentJobId: parent.id,
      status: "queued",
      idempotencyKey: input.options.force
        ? undefined
        : buildJobIdempotencyKey({
            type: input.type,
            source: item.source,
            sourceItemId: item.sourceItemId,
            pipelineVersion,
            sourceHash,
            configHash: input.options.configHash,
            annotationId: childOptions.annotationId,
            annotationRevision: childOptions.annotationRevision,
          }),
      sourceHash,
    });
    if (!child.reused) queuedChildren += 1;
  }

  await updateGenerationJob(parent.id, {
    totalItems: queuedChildren,
    status: queuedChildren === 0 ? "completed" : "queued",
    result:
      queuedChildren === 0
        ? { completed: 0, failed: 0, queued: 0, running: 0, cancelled: 0, reused: items.length }
        : { reused: items.length - queuedChildren },
  });

  if (queuedChildren === 0) {
    return { jobId: parent.id, status: "completed" };
  }

  return { jobId: parent.id, status: parent.status };
}

async function resolveFrozenSelection(keys: JobItemKey[]) {
  const unique = [...new Map(keys.map((key) => [`${key.source}:${key.sourceItemId}`, key])).values()];
  const items = await Promise.all(unique.map((key) => getSourceItem(key.source, key.sourceItemId)));
  const missing = unique.filter((_key, index) => !items[index]);
  if (missing.length) {
    throw new NotFoundError(`Source items not found: ${missing.slice(0, 5).map((item) => `${item.source}:${item.sourceItemId}`).join(", ")}`);
  }
  return items.filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function commonSource(items: JobItemKey[]): SourceName | null {
  const sources = new Set(items.map((item) => item.source));
  return sources.size === 1 ? items[0]?.source ?? null : null;
}

function jobObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function buildJobIdempotencyKey(input: {
  type: RecognizeJobType;
  source: SourceName;
  sourceItemId: string;
  pipelineVersion: string;
  sourceHash: string;
  configHash?: string;
  annotationId?: string;
  annotationRevision?: number;
  annotationTrackId?: string;
}) {
  return [
    "recognize",
    input.type,
    input.source,
    input.sourceItemId,
    input.annotationTrackId ?? "no-track",
    input.pipelineVersion,
    input.configHash ?? "default-config",
    input.annotationId ?? "no-annotation",
    input.annotationRevision ?? 0,
    input.sourceHash,
  ].join(":");
}

async function hydratePresetOptions(type: RecognizeJobType, options: RecognizeJobOptions): Promise<RecognizeJobOptions> {
  if (type === "ANNOTATION_LLM_PIPELINE") {
    if (options.presetId || options.presetRevision !== undefined || options.pipelineConfigSnapshot) {
      throw new ConflictError("ANNOTATION_LLM_PIPELINE orchestrates Wizard stage helpers and does not accept CV Lab presets");
    }
    const llmExecutionMode = options.llmExecutionMode === "one-shot-chain" ? "one-shot-chain" : "session-chain";
    return { ...options, llmExecutionMode, pipelineVersion: llmExecutionMode === "session-chain" ? "wizard-llm-session-chain-v1" : "wizard-llm-one-shot-chain-v1" };
  }
  if (type === "ANNOTATION_HELPER_PIPELINE") {
    if (options.presetId || options.presetRevision !== undefined || options.pipelineConfigSnapshot) {
      throw new ConflictError("ANNOTATION_HELPER_PIPELINE uses Wizard helper configs, not CV Lab presets");
    }
    return { ...options, pipelineVersion: "wizard-helper-auto-v1" };
  }
  if (type === "ANALYZE_LABEL") {
    if (options.presetId || options.presetRevision !== undefined || options.pipelineConfigSnapshot) {
      throw new ConflictError("ANALYZE_LABEL uses a server-owned analysis profile; CV Lab presets are not accepted");
    }
    return {
      ...options,
      pipelineVersion: "label-analysis-v2",
      analysisConfigSnapshot: normalizeLabelAnalysisCvConfig(options.analysisConfigSnapshot),
      configHash: hashConfigSnapshot(labelAnalysisProfile(options.analysisConfigSnapshot)),
    };
  }
  if (!options.presetId || options.presetRevision === undefined) return options;
  const preset = await getPipelinePresetRevision(options.presetId, options.presetRevision);
  if (preset.status === "deprecated") {
    throw new ConflictError(`Preset ${preset.id} revision ${preset.revision} is deprecated`);
  }
  const allowedLayers =
    type === "GENERATE_ALIASES"
      ? ["alias-generation"]
      : type === "GENERATE_DETECTION_PROPOSAL" || type === "GENERATE_CV_META"
        ? ["label-roi"]
        : ["label-roi", "pipeline"];
  if (!allowedLayers.includes(preset.layer)) {
    throw new ConflictError(`Preset layer ${preset.layer} is not compatible with job type ${type}`);
  }
  return {
    ...options,
    presetId: preset.id,
    presetRevision: preset.revision,
    presetRevisionId: preset.revisionId,
    presetLayer: preset.layer,
    pipelineConfigSnapshot: preset.config,
    configHash: hashConfigSnapshot(preset.config),
  };
}
