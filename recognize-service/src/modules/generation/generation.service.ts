import { createGenerationJob, getGenerationJob, updateGenerationJob, upsertGeneratedMetadata } from "../../db/meta.repository.js";
import { getSourceItem, listSourceItems } from "../../db/source.repository.js";
import { NotFoundError } from "../../shared/errors.js";
import type { SourceName } from "../../shared/types.js";
import { generateMetadata } from "./generation.pipeline.js";
import { toMetadataDto } from "../metadata/metadata.service.js";

export async function generateOne(input: { source: SourceName; sourceItemId: string; overwrite: boolean }) {
  const sourceItem = await getSourceItem(input.source, input.sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");
  const generated = await generateMetadata(sourceItem);
  const metadata = await upsertGeneratedMetadata({
    source: input.source,
    sourceItemId: input.sourceItemId,
    metadata: generated,
    overwrite: input.overwrite,
    sourceHash: generated.sourceHash,
  });
  return { item: toMetadataDto(metadata, sourceItem), generated: true };
}

export async function queueBatchGeneration(input: { sources: SourceName[]; mode: string; limit: number }) {
  const job = await createGenerationJob({ mode: input.mode, source: input.sources.length === 1 ? input.sources[0] : undefined });
  void runBatch(job.id, input).catch(async (error) => {
    await updateGenerationJob(job.id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
  });
  return { jobId: job.id, status: job.status };
}

export async function getJobStatus(jobId: string) {
  const job = await getGenerationJob(jobId);
  if (!job) throw new NotFoundError("Generation job not found");
  return {
    jobId: job.id,
    source: job.source,
    mode: job.mode,
    status: job.status,
    totalItems: job.total_items,
    processedItems: job.processed_items,
    failedItems: job.failed_items,
    error: job.error,
  };
}

async function runBatch(jobId: string, input: { sources: SourceName[]; mode: string; limit: number }) {
  await updateGenerationJob(jobId, { status: "running" });
  let processedItems = 0;
  let failedItems = 0;
  const items = (await Promise.all(input.sources.map((source) => listSourceItems(source, input.limit)))).flat().slice(0, input.limit);
  await updateGenerationJob(jobId, { totalItems: items.length });
  for (const item of items) {
    try {
      const generated = await generateMetadata(item);
      await upsertGeneratedMetadata({
        source: item.source,
        sourceItemId: item.sourceItemId,
        metadata: generated,
        overwrite: input.mode !== "missing-only",
        sourceHash: generated.sourceHash,
      });
      processedItems += 1;
    } catch {
      failedItems += 1;
    }
    await updateGenerationJob(jobId, { processedItems, failedItems });
  }
  await updateGenerationJob(jobId, { status: "completed", processedItems, failedItems });
}
