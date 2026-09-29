import { getSourceItemForTrack } from "../../db/official-draft.repository.js";
import { sourceAssetRef } from "../../shared/officialReference.js";
import { getSourceItem } from "../../db/source.repository.js";
import { NotFoundError } from "../../shared/errors.js";
import type { SourceName } from "../../shared/types.js";
import { resolveLocalAssetPath } from "../recognize-node/assets.js";
import { extractCvMetaFromFile, type CvPipelineConfigSnapshot } from "../recognize-node/cvMeta.js";

export async function runCvPlayground(input: {
  source: SourceName;
  sourceItemId: string;
  annotationTrackId?: string;
  config?: Record<string, unknown>;
  mode: "preview" | "full";
}) {
  const sourceItem = input.annotationTrackId ? await getSourceItemForTrack(input.source,input.sourceItemId,input.annotationTrackId) : await getSourceItem(input.source, input.sourceItemId);
  if (!sourceItem) throw new NotFoundError("Source item not found");

  const imageUrl = sourceAssetRef(sourceItem);
  const imagePath = imageUrl ? resolveLocalAssetPath(imageUrl) : null;
  if (!imageUrl) throw new NotFoundError("Source image is missing");
  if (!imagePath) throw new NotFoundError("Source image not found in asset store");

  const startedAt = Date.now();
  const cvMeta = await extractCvMetaFromFile(imagePath, imageUrl, input.config as CvPipelineConfigSnapshot | undefined);
  const label = cvMeta.label;
  const bottle = cvMeta.bottle;
  const layout = label?.layout && typeof label.layout === "object" ? (label.layout as Record<string, unknown>) : null;
  const topCandidates = Array.isArray(layout?.topCandidates) ? layout.topCandidates : [];
  const selected = topCandidates[0] as Record<string, unknown> | undefined;

  return {
    runId: `playground-${Date.now().toString(36)}`,
    mode: input.mode,
    source: sourceItem.source,
    sourceItemId: sourceItem.sourceItemId,
    imageUrl,
    metrics: {
      runtimeMs: Date.now() - startedAt,
      candidateCount: topCandidates.length,
      selectedScore: typeof selected?.score === "number" ? selected.score : null,
      selectedConfidence: typeof label?.confidence === "number" ? label.confidence : null,
      labelFound: Boolean(label?.roi),
      bottleFound: Boolean(bottle?.roi),
      qualityScore: estimateQualityScore({
        candidateCount: topCandidates.length,
        selectedScore: typeof selected?.score === "number" ? selected.score : null,
        selectedConfidence: typeof label?.confidence === "number" ? label.confidence : null,
        labelFound: Boolean(label?.roi),
        bottleFound: Boolean(bottle?.roi),
      }),
    },
    cvMeta,
  };
}

function estimateQualityScore(input: {
  candidateCount: number;
  selectedScore: number | null;
  selectedConfidence: number | null;
  labelFound: boolean;
  bottleFound: boolean;
}) {
  if (!input.labelFound) return 0;
  const score = input.selectedScore ?? 0;
  const confidence = input.selectedConfidence ?? 0;
  const candidatePenalty = Math.min(0.18, Math.max(0, input.candidateCount - 12) * 0.015);
  const bottleBonus = input.bottleFound ? 0.08 : 0;
  return round(Math.max(0, Math.min(1, score * 0.58 + confidence * 0.34 + bottleBonus - candidatePenalty)));
}

function round(value: number) {
  return Math.round(value * 10000) / 10000;
}

export async function runCvPlaygroundSweep(input: {
  source: SourceName;
  sourceItemId: string;
  annotationTrackId?: string;
  baseConfig: Record<string, unknown>;
  sweeps: Array<{
    parameterPath: string;
    values: number[];
  }>;
  mode: "preview" | "full";
}) {
  const startedAt = Date.now();
  const groups = [];
  for (const sweep of input.sweeps) {
    const variants = [];
    for (const value of sweep.values) {
      const config = setConfigValue(input.baseConfig, sweep.parameterPath, value);
      const result = await runCvPlayground({
        annotationTrackId: input.annotationTrackId,
        source: input.source,
        sourceItemId: input.sourceItemId,
        config,
        mode: input.mode,
      });
      variants.push({
        parameterPath: sweep.parameterPath,
        value,
        config,
        configHash: hashConfig(config),
        metrics: result.metrics,
        cvMeta: result.cvMeta,
      });
    }
    groups.push({
      parameterPath: sweep.parameterPath,
      values: sweep.values,
      variants,
    });
  }

  return {
    runId: `sweep-${Date.now().toString(36)}`,
    mode: input.mode,
    source: input.source,
    sourceItemId: input.sourceItemId,
    totalVariants: groups.reduce((sum, group) => sum + group.variants.length, 0),
    runtimeMs: Date.now() - startedAt,
    groups,
  };
}

function setConfigValue(config: Record<string, unknown>, path: string, value: number) {
  const next = JSON.parse(JSON.stringify(config || {})) as Record<string, unknown>;
  if (path === "color.distanceThreshold") {
    const color = ensureRecord(next, "color");
    color.distanceThreshold = value;
    const threshold = ensureRecord(next, "threshold");
    threshold.value = value;
  } else if (path === "selection.minScore") {
    ensureRecord(next, "selection").minScore = value;
  } else if (path === "morphology.kernelWidth") {
    ensureRecord(next, "morphology").kernelWidth = oddInt(value);
  } else if (path === "morphology.kernelHeight") {
    ensureRecord(next, "morphology").kernelHeight = oddInt(value);
  } else if (path === "morphology.iterations") {
    ensureRecord(next, "morphology").iterations = Math.max(1, Math.round(value));
  }
  return next;
}

function ensureRecord(target: Record<string, unknown>, key: string) {
  const value = target[key];
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  target[key] = next;
  return next;
}

function oddInt(value: number) {
  const rounded = Math.max(1, Math.round(value));
  return rounded % 2 === 0 ? rounded + 1 : rounded;
}

function hashConfig(config: Record<string, unknown>) {
  const value = JSON.stringify(config);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
