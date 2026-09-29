import { getSourceItemForTrack,captureOfficialDraft,officialTargetForTrack } from "../../db/official-draft.repository.js";
import { validateOfficialJobTarget } from "../contest-official/contest-official.service.js";
import { sourceAssetRef } from "../../shared/officialReference.js";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import {
  claimQueuedRecognizeJobs,
  bindRecognizeJobAnnotationVersion,
  getGenerationJob,
  heartbeatRecognizeJob,
  isGenerationJobCancellationRequested,
  recoverExpiredRecognizeJobs,
  recoverInterruptedRecognizeJobs,
  summarizeChildJobs,
  updateGenerationJob,
  upsertGeneratedMetadata,
  upsertGeneratedMetadataPatch,
  getMetadata,
} from "../../db/meta.repository.js";
import { ensurePrimaryAnnotationTrack, getAnnotationTrackState, patchAnnotationTrackState } from "../../db/annotation-track.repository.js";
import { putLabelAnnotationState } from "../../db/annotation.repository.js";
import { getReviewedLabelAnnotationRevision } from "../../db/annotation.repository.js";
import { getSourceItem } from "../../db/source.repository.js";
import { computeSourceHash, generateDetectionProposalState, generateImageMetadata, generateMetadata, generateTextMetadata } from "../generation/generation.pipeline.js";
import type { CvPipelineConfigSnapshot } from "../recognize-node/cvMeta.js";
import { analyzeReviewedLabel } from "../label-analysis/labelAnalysis.js";
import { recordAnnotationTrackActor } from "../../db/annotation-actor.repository.js";
import { runFullAutomaticPipeline } from "../wizard/wizard-automation.service.js";
import { wizardAutomationRunSchema } from "../wizard/wizard.schemas.js";
import { LlmWizardStageError, runLlmWizardJob } from "../wizard/wizard-llm-orchestration.service.js";
import { getAnnotationGraph } from "../../db/annotation-graph.repository.js";
import { attachAnnotationVersionJob, captureActiveAnnotationVersion, getAnnotationVersionPointers, promoteAnnotationVersion, setAnnotationVersionStatus } from "../../db/card-version.repository.js";

let timer: NodeJS.Timeout | null = null;
let reaperTimer: NodeJS.Timeout | null = null;
let running = false;
let starting = false;
let stopRequested = false;
const workerId = `recognize:${process.pid}:${randomUUID()}`;
const leaseMs = Math.max(env.WORKER_LEASE_MS, env.WORKER_HEARTBEAT_MS * 3);

export function startRecognizeWorker(logger: { info: (value: unknown) => void; error: (value: unknown) => void }) {
  if (!env.WORKER_ENABLED || timer || starting) return;
  starting = true;
  stopRequested = false;
  logger.info({
    worker: "recognize",
    status: "starting",
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    concurrency: env.WORKER_CONCURRENCY,
    workerId,
    heartbeatMs: env.WORKER_HEARTBEAT_MS,
    leaseMs,
  });

  void recoverWorkerState(logger).finally(() => {
    starting = false;
    if (stopRequested) return;
    timer = setInterval(() => {
      void tick(logger);
    }, env.WORKER_POLL_INTERVAL_MS);
    reaperTimer = setInterval(() => {
      void reapExpiredJobs(logger);
    }, env.WORKER_REAPER_MS);
    void tick(logger);
  });
}

export function stopRecognizeWorker() {
  stopRequested = true;
  if (timer) clearInterval(timer);
  if (reaperTimer) clearInterval(reaperTimer);
  timer = null;
  reaperTimer = null;
}

async function tick(logger: { error: (value: unknown) => void }) {
  if (running) return;
  running = true;
  try {
    const leaseToken = randomUUID();
    const jobs = await claimQueuedRecognizeJobs(env.WORKER_CONCURRENCY, workerId, leaseToken, leaseMs);
    await Promise.all(
      jobs.map((job) =>
        runWithHeartbeat(job, logger).catch(async (error) => {
          try {
            await handleClaimedJobFailure(job, error, logger);
          } catch (handlerError) {
            logger.error({
              worker: "recognize",
              event: "job_failure_handler_failed",
              jobId: String(job.id),
              originalFailure: generationJobFailure(error),
              handlerFailure: generationJobFailure(handlerError),
              stack: handlerError instanceof Error ? handlerError.stack : undefined,
            });
          }
        }),
      ),
    );
  } catch (error) {
    logger.error({
      worker: "recognize",
      event: "worker_tick_failed",
      failure: generationJobFailure(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  } finally {
    running = false;
  }
}

async function runWithHeartbeat(job: Record<string, unknown>, logger: { error: (value: unknown) => void }) {
  const jobId = String(job.id);
  const leaseToken = String(job.lease_token);
  let heartbeatPending = false;
  const heartbeat = async () => {
    if (heartbeatPending) return;
    heartbeatPending = true;
    try {
      const renewed = await heartbeatRecognizeJob(jobId, workerId, leaseToken, leaseMs);
      if (!renewed) logger.error({ worker: "recognize", event: "job_lease_lost", jobId, workerId, leaseToken });
    } catch (error) {
      logger.error({ worker: "recognize", event: "job_heartbeat_failed", jobId, workerId, failure: generationJobFailure(error) });
    } finally {
      heartbeatPending = false;
    }
  };
  const heartbeatTimer = setInterval(() => { void heartbeat(); }, env.WORKER_HEARTBEAT_MS);
  try {
    return await processClaimedJob(job);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

async function reapExpiredJobs(logger: { info?: (value: unknown) => void; error: (value: unknown) => void }) {
  try {
    const recovered = await recoverExpiredRecognizeJobs();
    for (const job of recovered) {
      if (job.annotationVersionId && job.status === "cancelled") await setAnnotationVersionStatus(job.annotationVersionId, "cancelled");
      if (job.annotationVersionId && job.status === "failed") await setAnnotationVersionStatus(job.annotationVersionId, "failed");
    }
    for (const parentJobId of new Set(recovered.flatMap((job) => job.parentJobId ? [job.parentJobId] : []))) {
      await syncParentProgress(parentJobId, true);
    }
    if (recovered.length) logger.info?.({
      worker: "recognize",
      event: "expired_job_leases_recovered",
      requeued: recovered.filter((job) => job.status === "queued").length,
      cancelled: recovered.filter((job) => job.status === "cancelled").length,
      failed: recovered.filter((job) => job.status === "failed").length,
    });
  } catch (error) {
    logger.error({ worker: "recognize", event: "job_lease_reaper_failed", failure: generationJobFailure(error) });
  }
}

async function recoverWorkerState(logger: { info: (value: unknown) => void; error: (value: unknown) => void }) {
  try {
    const recovery = await recoverInterruptedRecognizeJobs();
    for (const job of recovery.jobs) {
      if (job.status === "cancelled" && job.annotationVersionId) {
        await setAnnotationVersionStatus(job.annotationVersionId, "cancelled");
      }
    }
    for (const parentJobId of recovery.parentJobIds) await syncParentProgress(parentJobId, true);
    await reapExpiredJobs(logger);
    if (recovery.jobs.length || recovery.parentJobIds.length) {
      logger.info({
        worker: "recognize",
        event: "interrupted_jobs_recovered",
        requeued: recovery.jobs.filter((job) => job.status === "queued").length,
        cancelled: recovery.jobs.filter((job) => job.status === "cancelled").length,
        parentsReconciled: recovery.parentJobIds.length,
      });
    }
  } catch (error) {
    logger.error({
      worker: "recognize",
      event: "worker_recovery_failed",
      failure: generationJobFailure(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

async function handleClaimedJobFailure(job: Record<string, unknown>, error: unknown, logger: { error: (value: unknown) => void }) {
  const failure = generationJobFailure(error);
  const jobOptions = normalizeObject(job.options);
  if (!job.annotation_version_id && jobOptions.annotationVersionInitialization === "after-package" && job.source && job.source_item_id) {
    const pointers = await getAnnotationVersionPointers(job.source as never, String(job.source_item_id));
    if (pointers?.activeVersionId && job.annotation_track_id) {
      await bindRecognizeJobAnnotationVersion(String(job.id), pointers.activeVersionId, String(job.annotation_track_id));
      await attachAnnotationVersionJob(pointers.activeVersionId, String(job.id));
      job.annotation_version_id = pointers.activeVersionId;
    }
  }
  logger.error({
    worker: "recognize", event: "job_failed", jobId: String(job.id), parentJobId: job.parent_job_id ?? null,
    jobType: job.job_type ?? job.mode, source: job.source ?? null, sourceItemId: job.source_item_id ?? null,
    annotationTrackId: job.annotation_track_id ?? null, failure,
    stack: error instanceof Error ? error.stack : undefined,
  });
  await updateGenerationJob(String(job.id), {
    status: "failed",
    failedItems: 1,
    error: failure.message,
    result: {
      status: "failed", failure,
      ...(error instanceof LlmWizardStageError ? { stages: error.completedStages } : {}),
    },
  });
  if (job.annotation_version_id) await setAnnotationVersionStatus(String(job.annotation_version_id), "failed");
  if (job.parent_job_id) await syncParentProgress(String(job.parent_job_id), true);
}

async function processClaimedJob(job: Record<string, unknown>) {
  const parentJobId = nullableString(job.parent_job_id);
  if (parentJobId) {
    const parent = await getGenerationJob(parentJobId);
    if (parent?.cancel_requested) {
      await updateGenerationJob(String(job.id), { status: "cancelled" });
      if (job.annotation_version_id) await setAnnotationVersionStatus(String(job.annotation_version_id), "cancelled");
      await syncParentProgress(parentJobId, true);
      return;
    }
    if (parent?.status === "queued") {
      await updateGenerationJob(parentJobId, { status: "running" });
    }
  }

  const source = String(job.source);
  const sourceItemId = String(job.source_item_id);
  const official = await validateOfficialJobTarget(job);
  const trackId = nullableString(job.annotation_track_id);
  const sourceItem = trackId ? await getSourceItemForTrack(source as never,sourceItemId,trackId) : await getSourceItem(source as never, sourceItemId);
  if (sourceItem?.officialReference && !official) throw new Error("Official job is missing a frozen assignment target");
  if (!sourceItem) throw new Error("Source item not found");

  const jobType = String(job.job_type);
  const sourceHash = computeSourceHash(sourceItem);
  const options = normalizeObject(job.options);
  const pipelineConfigSnapshot = normalizePipelineConfigSnapshot(options.pipelineConfigSnapshot);
  const overwrite = jobType === "REGENERATE_ALL_META" || Boolean(options.force);
  if (jobType === "ANNOTATION_LLM_PIPELINE") {
    const annotationTrackId = nullableString(job.annotation_track_id) ?? nullableString(options.annotationTrackId);
    if (!annotationTrackId) throw new Error("LLM Wizard job track identity is missing");
    const llmExecutionMode = options.llmExecutionMode === "one-shot-chain" ? "one-shot-chain" : "session-chain";
    const visionEvidence = normalizeVisionEvidence(options.visionEvidence);
    const pipeline = await runLlmWizardJob(sourceItem.source, sourceItem.sourceItemId, annotationTrackId, llmExecutionMode, {
      shouldCancel: () => isGenerationJobCancellationRequested(String(job.id)),
      visionEvidence,
    });
    let annotationVersionId = nullableString(job.annotation_version_id) ?? nullableString(options.annotationVersionId);
    if (!annotationVersionId) {
      const pointers = await getAnnotationVersionPointers(sourceItem.source, sourceItem.sourceItemId);
      annotationVersionId = pointers?.activeVersionId ?? null;
      if (annotationVersionId) {
        await bindRecognizeJobAnnotationVersion(String(job.id), annotationVersionId, annotationTrackId);
        await attachAnnotationVersionJob(annotationVersionId, String(job.id));
        job.annotation_version_id = annotationVersionId;
      }
    }
    if (annotationVersionId) {
      const graph = await getAnnotationGraph(sourceItem.source, sourceItem.sourceItemId);
      if (official) await captureOfficialDraft(official,graph);
      else await captureActiveAnnotationVersion(sourceItem.source, sourceItem.sourceItemId, graph as unknown as Record<string, unknown>);
      if (!official && pipeline.status === "completed" && options.annotationVersionPublishPolicy === "auto-on-success") {
        await promoteAnnotationVersion(sourceItem.source, sourceItem.sourceItemId, annotationVersionId, graph as unknown as Record<string, unknown>);
      } else {
        await setAnnotationVersionStatus(annotationVersionId, pipeline.status === "cancelled" ? "cancelled" : "review_required");
      }
    }
    await recordAnnotationTrackActor(annotationTrackId, { type: "ml-agent", source: `annotation-api:llm-${llmExecutionMode}-worker` });
    if (pipeline.status === "cancelled") {
      await updateGenerationJob(String(job.id), {
        status: "cancelled",
        result: { ...pipeline, status: "cancelled", stopReason: "cancel_requested" },
      });
      if (parentJobId) await syncParentProgress(parentJobId, true);
      return;
    }
    if (await finishCancellationIfRequested(String(job.id), parentJobId, pipeline)) return;
    await updateGenerationJob(String(job.id), {
      status: "completed", processedItems: 1, failedItems: 0,
      result: { source: sourceItem.source, sourceItemId: sourceItem.sourceItemId, annotationTrackId, metadataKind: "annotation-llm-pipeline", ...pipeline },
    });
    if (parentJobId) await syncParentProgress(parentJobId, true);
    return;
  }
  if (jobType === "ANNOTATION_HELPER_PIPELINE") {
    const annotationTrackId = nullableString(job.annotation_track_id) ?? nullableString(options.annotationTrackId);
    if (!annotationTrackId) throw new Error("Annotation pipeline track identity is missing");
    const automation = wizardAutomationRunSchema.parse(options.automation ?? {});
    const pipeline = await runFullAutomaticPipeline(sourceItem.source, sourceItem.sourceItemId, annotationTrackId, automation);
    if (official) await captureOfficialDraft(official,await getAnnotationGraph(sourceItem.source,sourceItem.sourceItemId));
    await recordAnnotationTrackActor(annotationTrackId, { type: "ml-agent", source: "annotation-api:helper-only-worker" });
    if (await finishCancellationIfRequested(String(job.id), parentJobId, pipeline)) return;
    await updateGenerationJob(String(job.id), {
      status: "completed", processedItems: 1, failedItems: 0,
      result: {
        source: sourceItem.source, sourceItemId: sourceItem.sourceItemId, annotationTrackId,
        metadataKind: "annotation-helper-pipeline", ...pipeline,
      },
    });
    if (parentJobId) await syncParentProgress(parentJobId, true);
    return;
  }
  if (jobType === "ANALYZE_LABEL") {
    const annotationTrackId = nullableString(job.annotation_track_id) ?? nullableString(options.annotationTrackId);
    const annotationId = nullableString(options.annotationId);
    const annotationRevision = positiveInteger(options.annotationRevision);
    if (!annotationTrackId || !annotationId || !annotationRevision) throw new Error("Label analysis track/annotation identity is missing");
    const annotation = await getReviewedLabelAnnotationRevision(sourceItem.source, sourceItem.sourceItemId, annotationTrackId, annotationId, annotationRevision);
    if (official && annotation?.imageUrl !== official.referencePath) throw new Error("Reviewed label belongs to a different asset");
    if (!annotation) throw new Error("Reviewed label annotation revision not found");
    const analysis = await analyzeReviewedLabel({
      jobId: String(job.id),
      sourceItem,
      annotationTrackId,
      annotation,
      config: options.analysisConfigSnapshot,
    });
    if (await finishCancellationIfRequested(String(job.id), parentJobId, { metadataKind: "label-analysis" })) return;
    const current = await getAnnotationTrackState(sourceItem.source, sourceItem.sourceItemId, annotationTrackId);
    const metadata = await patchAnnotationTrackState(sourceItem.source, sourceItem.sourceItemId, annotationTrackId, {
        visualFeatures: { ...(current?.visual_features ?? {}), labelAnalysis: analysis },
        annotations: {
          ...(current?.annotations ?? {}),
          labelAnalysis: { annotationId, annotationRevision, jobId: String(job.id), configHash: analysis.provenance.configHash },
        },
        status: current?.status ?? "generated",
      });
    await updateGenerationJob(String(job.id), {
      status: "completed", processedItems: 1, failedItems: 0,
      result: {
        source: sourceItem.source, sourceItemId: sourceItem.sourceItemId, annotationTrackId,
        metadataKind: "label-analysis", annotationId, annotationRevision,
        cropAssetPath: analysis.crop.assetPath, configHash: analysis.provenance.configHash,
        ocrRunId: analysis.ocr.runId, textRegionCount: analysis.textRegions.length,
        sourceMatchCount: analysis.sourceMatches.length, warnings: analysis.warnings, runtimeMs: analysis.runtimeMs,
      },
    });
    if (parentJobId) await syncParentProgress(parentJobId, true);
    return;
  }
  if (jobType === "GENERATE_DETECTION_PROPOSAL") {
    const annotationTrackId = nullableString(job.annotation_track_id) ?? await ensurePrimaryAnnotationTrack(sourceItem.source, sourceItem.sourceItemId);
    const annotationState = await generateDetectionProposalState(sourceItem, {
      pipelineConfigSnapshot,
      presetId: nullableString(options.presetId) ?? undefined,
      presetRevision: positiveInteger(options.presetRevision),
      configHash: nullableString(options.configHash) ?? undefined,
    });
    if (official) await validateOfficialJobTarget(job);
    const savedState = await putLabelAnnotationState(sourceItem.source, sourceItem.sourceItemId, annotationTrackId, annotationState, sourceAssetRef(sourceItem));
    if (await finishCancellationIfRequested(String(job.id), parentJobId, { metadataKind: "detection-proposal" })) return;
    await updateGenerationJob(String(job.id), {
      status: "completed",
      processedItems: 1,
      failedItems: 0,
      result: {
        source: sourceItem.source,
        sourceItemId: sourceItem.sourceItemId,
        metadataKind: "detection-proposal",
        hasGeneratedLabelRoi: Boolean(savedState.prediction?.roi),
        annotationStatus: savedState.status,
      },
    });
    if (parentJobId) await syncParentProgress(parentJobId, true);
    return;
  }

  const metadata =
    jobType === "GENERATE_ALIASES"
      ? await upsertGeneratedMetadataPatch({
          source: sourceItem.source,
          sourceItemId: sourceItem.sourceItemId,
          metadata: generateTextMetadata(sourceItem),
          overwrite,
          sourceHash,
        })
      : jobType === "GENERATE_CV_META"
        ? await upsertGeneratedMetadataPatch({
            source: sourceItem.source,
            sourceItemId: sourceItem.sourceItemId,
            metadata: await generateImageMetadata(sourceItem, { pipelineConfigSnapshot }),
            overwrite,
            sourceHash,
          })
        : await upsertGeneratedMetadata({
            source: sourceItem.source,
            sourceItemId: sourceItem.sourceItemId,
            metadata: await generateMetadata(sourceItem, { pipelineConfigSnapshot }),
            overwrite,
            sourceHash,
          });

  if (await finishCancellationIfRequested(String(job.id), parentJobId, { metadataKind: "recognition-metadata" })) return;

  await updateGenerationJob(String(job.id), {
    status: "completed",
    processedItems: 1,
    failedItems: 0,
    result: {
      source: metadata.source,
      sourceItemId: metadata.source_item_id,
      metadataId: metadata.id,
      metadataKind: jobType === "GENERATE_ALIASES" ? "source-text" : jobType === "GENERATE_CV_META" ? "image-derived" : "all",
      aliases: metadata.aliases.length,
      normalizedTokens: metadata.normalized_tokens.length,
      hasCvMeta: Boolean(metadata.visual_features.cvMeta),
      warnings: metadata.visual_features.warnings ?? [],
    },
  });

  if (parentJobId) await syncParentProgress(parentJobId, true);
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

async function syncParentProgress(parentJobId: string, finalize = false) {
  const parent = await getGenerationJob(parentJobId);
  const summary = await summarizeChildJobs(parentJobId);
  const completed = summary.completed ?? 0;
  const failed = summary.failed ?? 0;
  const queued = summary.queued ?? 0;
  const runningCount = summary.running ?? 0;
  const cancelled = summary.cancelled ?? 0;
  const terminal = queued + runningCount === 0;
  const llmBatch = String(parent?.job_type ?? parent?.mode ?? "") === "ANNOTATION_LLM_PIPELINE";
  const status =
    finalize && terminal
      ? failed > 0
        ? llmBatch ? "failed" : "completed_with_errors"
        : cancelled > 0
          ? "cancelled"
          : "completed"
      : "running";

  await updateGenerationJob(parentJobId, {
    status,
    processedItems: completed,
    failedItems: failed,
    error: terminal ? failed > 0 ? `${failed} child pipeline job(s) failed` : null : undefined,
    result: { status, completed, failed, queued, running: runningCount, cancelled },
  });
}

async function finishCancellationIfRequested(jobId: string, parentJobId: string | null, result: Record<string, unknown>) {
  if (!await isGenerationJobCancellationRequested(jobId)) return false;
  await updateGenerationJob(jobId, {
    status: "cancelled",
    result: { ...result, status: "cancelled", stopReason: "cancel_requested" },
  });
  const job = await getGenerationJob(jobId);
  if (job?.annotation_version_id) await setAnnotationVersionStatus(String(job.annotation_version_id), "cancelled");
  if (parentJobId) await syncParentProgress(parentJobId, true);
  return true;
}

export function generationJobFailure(error: unknown) {
  if (error instanceof LlmWizardStageError) return {
    kind: "llm_stage" as const,
    ...error.failure,
    message: error.message,
  };
  return {
    kind: "job" as const,
    stage: null,
    labelId: null,
    sessionId: null,
    message: error instanceof Error ? error.message : String(error),
    failedAt: new Date().toISOString(),
  };
}

function normalizeObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizePipelineConfigSnapshot(value: unknown): CvPipelineConfigSnapshot | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as CvPipelineConfigSnapshot) : undefined;
}

function normalizeVisionEvidence(value: unknown): { labelMode: "off" | "score-only" | "rerank" } | undefined {
  const item = normalizeObject(value);
  return item.labelMode === "off" || item.labelMode === "score-only" || item.labelMode === "rerank"
    ? { labelMode: item.labelMode }
    : undefined;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}
