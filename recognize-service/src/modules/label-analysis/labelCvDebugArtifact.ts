import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SourceName } from "../../shared/types.js";
import { resolveGeneratedAssetPath } from "../recognize-node/assets.js";

type JsonObject = Record<string, unknown>;

export async function detachLabelCvDebugArtifact(source: SourceName, sourceItemId: string, cvJob: JsonObject): Promise<JsonObject> {
  const separated = separateInlineDebugLayers(cvJob);
  const layers = separated.layers;
  if (!layers.length) return cvJob;
  const compactCvJob = separated.cvJob;

  const analysisJobId = safeSegment(String(cvJob.analysisJobId ?? "unknown-job"));
  const relativePath = `label-analysis/${source}/${safeSegment(sourceItemId)}/${analysisJobId}-cv-debug.json`;
  const artifactPath = resolveGeneratedAssetPath(relativePath);
  if (!artifactPath) return cvJob;

  const artifact = {
    schemaVersion: 1,
    kind: "label-cv-debug",
    source,
    sourceItemId,
    analysisJobId: cvJob.analysisJobId ?? null,
    previewStage: cvJob.previewStage ?? null,
    generatedAt: new Date().toISOString(),
    layers,
  };
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact), "utf8");

  return {
    ...compactCvJob,
    debugArtifact: { schemaVersion: 1, kind: "label-cv-debug", assetPath: relativePath },
  };
}

export async function hydrateLabelCvDebugArtifact(cvJob: JsonObject): Promise<JsonObject> {
  const reference = objectValue(cvJob.debugArtifact);
  const relativePath = typeof reference.assetPath === "string" ? reference.assetPath : null;
  if (!relativePath) return cvJob;
  const artifactPath = resolveGeneratedAssetPath(relativePath);
  if (!artifactPath) return cvJob;
  try {
    const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as JsonObject;
    const layers = Array.isArray(artifact.layers) ? artifact.layers : [];
    return attachInlineDebugLayers(cvJob, layers);
  } catch {
    return cvJob;
  }
}

export function separateInlineDebugLayers(cvJob: JsonObject): { cvJob: JsonObject; layers: unknown[] } {
  const preview = objectValue(cvJob.preview);
  const cvDebug = objectValue(preview.cvDebug);
  const label = objectValue(cvDebug.label);
  const debug = objectValue(label.debug);
  const layers = Array.isArray(debug.layers) ? debug.layers : [];
  if (!layers.length) return { cvJob, layers: [] };
  return {
    layers,
    cvJob: { ...cvJob, preview: { ...preview, cvDebug: { ...cvDebug, label: { ...label, debug: { ...debug, layers: [] } } } } },
  };
}

export function attachInlineDebugLayers(cvJob: JsonObject, layers: unknown[]): JsonObject {
  const preview = objectValue(cvJob.preview);
  const cvDebug = objectValue(preview.cvDebug);
  const label = objectValue(cvDebug.label);
  const debug = objectValue(label.debug);
  return { ...cvJob, preview: { ...preview, cvDebug: { ...cvDebug, label: { ...label, debug: { ...debug, layers } } } } };
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "item";
}
