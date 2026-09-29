import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { env } from "../../config/env.js";
import { getDatasetArtifact, type TrainingTask } from "../../db/training.repository.js";
import { ConflictError } from "../../shared/errors.js";
import { adaptTaskRecords, type FrozenDatasetRecord } from "./datasetTaskAdapters.js";

type Split = "train" | "validation" | "test";
type ArtifactRecord = FrozenDatasetRecord;
type ArtifactReference = { id: string; outputPath: string; annotationsSha256: string; manifest?: Record<string, unknown> };

export type DatasetArtifactReadiness = {
  artifactId: string;
  schemaVersion: number;
  checksumValid: boolean;
  ready: boolean;
  task: TrainingTask;
  totalItems: number;
  eligibleItems: number;
  eligibleSamples: number;
  skippedItems: number;
  splits: Record<Split, { total: number; eligible: number }>;
  layers: Record<string, number>;
  taskArtifact: { file: string; count: number; sha256: string; adapterVersion: number } | null;
  warnings: string[];
};

const EXPORT_ROOT = path.resolve(process.cwd(), env.DATASET_EXPORT_ROOT);

export async function inspectDatasetArtifact(artifactId: string, task: TrainingTask): Promise<DatasetArtifactReadiness> {
  const artifact = await getDatasetArtifact(artifactId);
  return inspectDatasetArtifactFiles(artifact, task);
}

export async function inspectDatasetArtifactFiles(artifact: ArtifactReference, task: TrainingTask): Promise<DatasetArtifactReadiness> {
  const artifactRoot = await resolveArtifactRoot(artifact.outputPath);
  const annotationsPath = resolveChild(artifactRoot, "annotations.jsonl");
  const manifestPath = resolveChild(artifactRoot, "manifest.json");
  const [manifest, checksum] = await Promise.all([readJsonObject(manifestPath), sha256File(annotationsPath)]);
  const schemaVersion = integerValue(manifest.schemaVersion);
  if (schemaVersion === null || schemaVersion < 1 || schemaVersion > 5) {
    throw new ConflictError(`Unsupported dataset artifact schema version: ${String(manifest.schemaVersion ?? "missing")}`);
  }
  const manifestChecksum = stringValue(manifest.annotationsSha256);
  if (checksum !== artifact.annotationsSha256 || (manifestChecksum && checksum !== manifestChecksum)) {
    throw new ConflictError("Dataset artifact checksum does not match its immutable registry record");
  }

  const records = await readRecords(annotationsPath);
  const splits = emptySplits();
  const layers: Record<string, number> = {
    label: 0, ocrRegions: 0, sourceAssociations: 0, aliases: 0,
    bottle: 0, elements: 0, contours: 0, palette: 0,
    annotationGraph: 0, packages: 0, canonicalLabels: 0, canonicalOcr: 0,
  };
  let eligibleItems = 0;
  let eligibleSamples = 0;
  for (const record of records) {
    splits[record.split].total += 1;
    countLayers(record.snapshot, layers);
    const sampleCount = schemaVersion >= 5 ? adaptTaskRecords(record, task).length : isEligible(record.snapshot, task) ? 1 : 0;
    if (sampleCount > 0) {
      eligibleItems += 1;
      eligibleSamples += sampleCount;
      splits[record.split].eligible += 1;
    }
  }
  const warnings: string[] = [];
  if (schemaVersion < 3) warnings.push("Legacy artifact: visual annotations/CV metadata from schema v3 are unavailable.");
  if (schemaVersion < 4) warnings.push("Legacy artifact: canonical StageSampleV1 execution traces are unavailable.");
  if (schemaVersion < 5) warnings.push("Legacy artifact: canonical Package/Label/OCR annotation graph is unavailable.");
  if (records.length && eligibleItems < records.length) warnings.push(`${records.length - eligibleItems} item(s) do not contain reviewed data required by ${task}.`);
  if (!eligibleItems) warnings.push(`No trainable ${task} samples were found.`);
  const taskArtifact = await validateTaskArtifact(artifactRoot, manifest, artifact.manifest, task, eligibleSamples);
  if (!taskArtifact) warnings.push("Legacy artifact: no materialized task JSONL; the universal snapshot remains readable.");
  return {
    artifactId: artifact.id,
    schemaVersion,
    checksumValid: true,
    ready: eligibleItems > 0,
    task,
    totalItems: records.length,
    eligibleItems,
    eligibleSamples,
    skippedItems: records.length - eligibleItems,
    splits,
    layers,
    taskArtifact,
    warnings,
  };
}

async function validateTaskArtifact(
  artifactRoot: string,
  fileManifest: Record<string, unknown>,
  registeredManifest: Record<string, unknown> | undefined,
  task: TrainingTask,
  eligibleSamples: number,
): Promise<DatasetArtifactReadiness["taskArtifact"]> {
  const fileEntry = taskManifestEntry(fileManifest, task);
  const registeredEntry = registeredManifest ? taskManifestEntry(registeredManifest, task) : null;
  if (!fileEntry && !registeredEntry) return null;
  if (!fileEntry || !registeredEntry || JSON.stringify(fileEntry) !== JSON.stringify(registeredEntry)) {
    throw new ConflictError(`Dataset ${task} adapter manifest does not match its immutable registry record`);
  }
  if (fileEntry.count !== eligibleSamples) throw new ConflictError(`Dataset ${task} adapter count does not match reviewed snapshot sample count`);
  const taskPath = resolveChild(artifactRoot, fileEntry.file);
  if (await sha256File(taskPath) !== fileEntry.sha256) throw new ConflictError(`Dataset ${task} adapter checksum does not match its manifest`);
  return fileEntry;
}

function taskManifestEntry(manifest: Record<string, unknown>, task: TrainingTask): DatasetArtifactReadiness["taskArtifact"] {
  const entry = objectValue(objectValue(objectValue(manifest.files)?.tasks)?.[task]);
  if (!entry) return null;
  const file = stringValue(entry.file);
  const count = integerValue(entry.count);
  const sha256 = stringValue(entry.sha256);
  const adapterVersion = integerValue(entry.adapterVersion);
  if (!file || count === null || !sha256?.match(/^[0-9a-f]{64}$/) || adapterVersion === null) {
    throw new ConflictError(`Invalid ${task} adapter manifest entry`);
  }
  return { file, count, sha256, adapterVersion };
}

async function resolveArtifactRoot(outputPath: string) {
  const candidates = [
    path.resolve(outputPath),
    path.resolve(EXPORT_ROOT, portableBasename(outputPath)),
  ].filter((value, index, values) => values.indexOf(value) === index && isWithin(EXPORT_ROOT, value));
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch { /* try portable fallback */ }
  }
  throw new ConflictError(`Dataset artifact files are unavailable under ${EXPORT_ROOT}`);
}

async function readRecords(filePath: string): Promise<ArtifactRecord[]> {
  const records: ArtifactRecord[] = [];
  const lines = readline.createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch { throw new ConflictError(`Invalid annotations.jsonl at line ${lineNumber}`); }
      const record = objectValue(parsed);
      if (!record) throw new ConflictError(`Invalid dataset record at line ${lineNumber}`);
      const snapshot = objectValue(record.snapshot);
      const split = splitValue(record.split);
      if (!snapshot || !split) throw new ConflictError(`Invalid dataset record at line ${lineNumber}`);
      const source = stringValue(record.source) ?? stringValue(snapshot.source) ?? "unknown";
      const sourceItemId = stringValue(record.sourceItemId) ?? stringValue(snapshot.sourceItemId) ?? `line-${lineNumber}`;
      records.push({
        id: stringValue(record.id) ?? `${source}:${sourceItemId}`,
        source,
        sourceItemId,
        split,
        snapshotHash: stringValue(record.snapshotHash) ?? "unavailable",
        snapshot,
      });
    }
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    throw new ConflictError(`Cannot read dataset annotations: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (!records.length) throw new ConflictError("Dataset artifact contains no annotation records");
  return records;
}

function isEligible(snapshot: Record<string, unknown>, task: TrainingTask) {
  // Old artifacts cannot prove physical-label semantics. New artifacts contain
  // the materialized task file and are inspected without this legacy fallback.
  if (task === "physical-label-roi") return false;
  if (task === "label-roi") return Boolean(objectValue(snapshot.label));
  if (task === "ocr-region") return arrayValue(objectValue(snapshot.ocrRegions)?.regions).length > 0;
  if (task === "source-matching") return arrayValue(objectValue(snapshot.sourceAssociations)?.associations).length > 0;
  if (task === "alias-ranking") return arrayValue(objectValue(snapshot.aliases)?.aliases).length > 0;
  const annotations = objectValue(objectValue(snapshot.vision)?.annotations);
  if (task === "bottle-outline") return Boolean(objectValue(annotations?.bottle));
  if (task === "label-elements") return arrayValue(annotations?.elements).length > 0 && arrayValue(annotations?.contours).length > 0;
  return arrayValue(annotations?.palette).length > 0;
}

function countLayers(snapshot: Record<string, unknown>, layers: Record<string, number>) {
  if (objectValue(snapshot.label)) layers.label += 1;
  if (arrayValue(objectValue(snapshot.ocrRegions)?.regions).length) layers.ocrRegions += 1;
  if (arrayValue(objectValue(snapshot.sourceAssociations)?.associations).length) layers.sourceAssociations += 1;
  if (arrayValue(objectValue(snapshot.aliases)?.aliases).length) layers.aliases += 1;
  const annotations = objectValue(objectValue(snapshot.vision)?.annotations);
  if (objectValue(annotations?.bottle)) layers.bottle += 1;
  if (arrayValue(annotations?.elements).length) layers.elements += 1;
  if (arrayValue(annotations?.contours).length) layers.contours += 1;
  if (arrayValue(annotations?.palette).length) layers.palette += 1;
  const graph = objectValue(snapshot.annotationGraph);
  const packages = arrayValue(graph?.packages).map(objectValue).filter(Boolean);
  if (graph) layers.annotationGraph += 1;
  layers.packages += packages.length;
  layers.canonicalLabels += packages.reduce((total, packageItem) => total + arrayValue(packageItem?.labels).length, 0);
  layers.canonicalOcr += packages.reduce((total, packageItem) => total + arrayValue(packageItem?.ocr).length + arrayValue(packageItem?.labels).map(objectValue).filter(Boolean).reduce((labelTotal, label) => labelTotal + arrayValue(label?.ocr).length, 0), 0);
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch (error) {
    throw new ConflictError(`Cannot checksum dataset annotations: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

async function readJsonObject(filePath: string) {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    const object = objectValue(value);
    if (!object) throw new Error("expected an object");
    return object;
  } catch (error) {
    throw new ConflictError(`Invalid dataset manifest: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function resolveChild(root: string, name: string) {
  const resolved = path.resolve(root, name);
  if (!isWithin(root, resolved)) throw new ConflictError("Invalid dataset artifact file path");
  return resolved;
}
function isWithin(root: string, value: string) { return value === root || value.startsWith(`${root}${path.sep}`); }
function portableBasename(value: string) { return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? ""; }
function emptySplits(): DatasetArtifactReadiness["splits"] { return { train: { total: 0, eligible: 0 }, validation: { total: 0, eligible: 0 }, test: { total: 0, eligible: 0 } }; }
function splitValue(value: unknown): Split | null { return value === "train" || value === "validation" || value === "test" ? value : null; }
function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function objectValue(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function stringValue(value: unknown): string | null { return typeof value === "string" ? value : null; }
function integerValue(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) ? value : null; }
