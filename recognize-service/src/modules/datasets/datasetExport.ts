import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDatasetVersionBundle } from "../../db/dataset.repository.js";
import { registerDatasetArtifact } from "../../db/training.repository.js";
import { env } from "../../config/env.js";
import { ConflictError } from "../../shared/errors.js";
import { buildTaskDatasets, TASK_ADAPTER_VERSION, type FrozenDatasetRecord } from "../training/datasetTaskAdapters.js";

const EXPORT_ROOT = path.resolve(process.cwd(), env.DATASET_EXPORT_ROOT);

export async function exportDatasetVersion(datasetVersionId: string) {
  const bundle = await getDatasetVersionBundle(datasetVersionId);
  const directoryName = `${slug(bundle.version.name)}-v${bundle.version.version}-${bundle.version.id.slice(0, 8)}`;
  const outputRoot = resolveWithin(EXPORT_ROOT, directoryName);
  const temporaryRoot = resolveWithin(EXPORT_ROOT, `.tmp-${directoryName}-${randomUUID()}`);
  await mkdir(EXPORT_ROOT, { recursive: true });
  try {
    await mkdir(temporaryRoot, { recursive: false });
    const records: FrozenDatasetRecord[] = bundle.items.map((item) => ({
      id: `${item.source}:${item.sourceItemId}`,
      source: item.source,
      sourceItemId: item.sourceItemId,
      split: item.split,
      snapshotHash: item.snapshotHash,
      snapshot: item.snapshot,
    }));
    const annotations = `${records.map((item) => JSON.stringify(item)).join("\n")}\n`;
    const annotationsSha256 = createHash("sha256").update(annotations).digest("hex");
    const taskDatasets = buildTaskDatasets(records);
    const taskArtifacts = Object.fromEntries(Object.entries(taskDatasets).map(([task, items]) => {
      const contents = items.length ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
      return [task, {
        file: `tasks/${task}.jsonl`,
        count: items.length,
        sha256: createHash("sha256").update(contents).digest("hex"),
        adapterVersion: TASK_ADAPTER_VERSION,
        contents,
      }];
    }));
    const splits = {
      train: records.filter((item) => item.split === "train").map((item) => item.id),
      validation: records.filter((item) => item.split === "validation").map((item) => item.id),
      test: records.filter((item) => item.split === "test").map((item) => item.id),
    };
    const manifest = {
      schemaVersion: bundle.version.schemaVersion,
      artifactType: "frozen-annotation-dataset",
      datasetVersion: bundle.version,
      exportedAt: new Date().toISOString(),
      annotationsSha256,
      files: {
        annotations: "annotations.jsonl",
        splits: "splits.json",
        tasks: Object.fromEntries(Object.entries(taskArtifacts).map(([task, item]) => [task, { file: item.file, count: item.count, sha256: item.sha256, adapterVersion: item.adapterVersion }])),
      },
    };
    await mkdir(path.join(temporaryRoot, "tasks"), { recursive: false });
    await Promise.all([
      writeFile(path.join(temporaryRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8"),
      writeFile(path.join(temporaryRoot, "annotations.jsonl"), annotations, "utf8"),
      writeFile(path.join(temporaryRoot, "splits.json"), JSON.stringify(splits, null, 2), "utf8"),
      ...Object.values(taskArtifacts).map((item) => writeFile(path.join(temporaryRoot, item.file), item.contents, "utf8")),
    ]);
    try {
      await rename(temporaryRoot, outputRoot);
    } catch (error) {
      void error;
      throw new ConflictError(`Dataset export already exists or cannot be finalized: ${directoryName}`);
    }
    try {
      const artifact = await registerDatasetArtifact({ datasetVersionId, outputPath: outputRoot, annotationsSha256, manifest });
      return { ...artifact, outputRoot, itemCount: records.length, files: manifest.files };
    } catch (error) {
      await rm(outputRoot, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function slug(value: string) {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return normalized || "dataset";
}

function resolveWithin(root: string, child: string) {
  const resolved = path.resolve(root, child);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid dataset export path");
  return resolved;
}
