import { sourceAssetRef } from "../../shared/officialReference.js";
import { createHash } from "node:crypto";
import type { MetadataPayload, SourceItem } from "../../shared/types.js";
import { generateAliasSet, normalizedTokensForAliasSet } from "../recognize-core/text.js";
import { resolveLocalAssetPath } from "../recognize-node/assets.js";
import { extractCvMetaFromFile, type CvPipelineConfigSnapshot } from "../recognize-node/cvMeta.js";
import type { LabelAnnotationState } from "../../db/annotation.repository.js";
import { env } from "../../config/env.js";
import {
  detectLabelWithDino,
  type DinoLabelResult,
} from "../../vision/dinoClient.js";

export function computeSourceHash(sourceItem: SourceItem) {
  return createHash("sha256").update(JSON.stringify(sourceItem)).digest("hex");
}

export async function generateMetadata(
  sourceItem: SourceItem,
  options: { pipelineConfigSnapshot?: CvPipelineConfigSnapshot } = {},
): Promise<MetadataPayload & { sourceHash: string }> {
  const textMetadata = generateTextMetadata(sourceItem);
  const imageMetadata = await generateImageMetadata(sourceItem, options);
  const sourceHash = computeSourceHash(sourceItem);

  return {
    aliases: textMetadata.aliases,
    normalizedTokens: textMetadata.normalizedTokens,
    visualFeatures: imageMetadata.visualFeatures,
    annotations: {
      ...textMetadata.annotations,
      ...imageMetadata.annotations,
      pipeline: {
        version: "recognize-v1",
        stages: ["source-text", "image-cv"],
      },
    },
    status: "generated",
    sourceHash,
  };
}

export function generateTextMetadata(sourceItem: SourceItem): Pick<MetadataPayload, "aliases" | "normalizedTokens" | "annotations" | "status"> {
  const aliasSet = generateAliasSet(sourceItem);
  const normalizedTokens = normalizedTokensForAliasSet(aliasSet);
  return {
    aliases: aliasSet.aliases.map((alias) => alias.value),
    normalizedTokens,
    annotations: {
      aliasSet,
      sourceTextPipeline: {
        version: "recognize-v1",
        stages: ["source-aliases", "source-normalized-tokens"],
      },
    },
    status: "generated",
  };
}

export async function generateImageMetadata(
  sourceItem: SourceItem,
  options: { pipelineConfigSnapshot?: CvPipelineConfigSnapshot } = {},
): Promise<Pick<MetadataPayload, "visualFeatures" | "annotations" | "status">> {
  const { imageRef: firstImageUrl, localPath: firstImagePath } = detectionInput(sourceItem);
  const warnings: string[] = [];
  const cvMeta = firstImagePath
    ? await extractCvMetaFromFile(firstImagePath, firstImageUrl!, options.pipelineConfigSnapshot)
    : null;

  if (!firstImageUrl) warnings.push("missing-source-image");
  if (firstImageUrl && !firstImagePath) warnings.push("source-image-not-found-in-asset-store");

  const visualFeatures = {
    imageCount: sourceItem.imageUrls.length,
    hasImage: sourceItem.imageUrls.length > 0,
    cvMeta,
    structured: {
      year: sourceItem.year,
      color: sourceItem.color,
      category: sourceItem.category,
      barcode: sourceItem.barcode,
    },
    presetRuntime: options.pipelineConfigSnapshot
      ? {
          applied: true,
        }
      : {
          applied: false,
        },
    warnings,
  };

  return {
    visualFeatures,
    annotations: {
      imagePipeline: {
        version: "recognize-v1",
        stages: ["image-cv-meta"],
        pendingStages: ["ocr", "bottle-roi", "bottle-mask"],
      },
    },
    status: "generated",
  };
}

export async function generateDetectionProposalState(
  sourceItem: SourceItem,
  options: {
    pipelineConfigSnapshot?: CvPipelineConfigSnapshot;
    presetId?: string;
    presetRevision?: number;
    configHash?: string;
  } = {},
): Promise<LabelAnnotationState> {
  const { imageRef: firstImageUrl, localPath: firstImagePath } = detectionInput(sourceItem);

  const dinoPrediction = firstImagePath
    ? await generateDinoLabelPrediction(firstImagePath, options)
    : null;

  const cvMeta = firstImagePath && !dinoPrediction
    ? await extractCvMetaFromFile(
        firstImagePath,
        firstImageUrl!,
        options.pipelineConfigSnapshot,
      )
    : null;

  const prediction =
    dinoPrediction ??
    (cvMeta ? generatedLabelRoiFromCvMeta(cvMeta, options) : null);

  return {
    schemaVersion: 2,
    prediction,
    annotation: null,
    status: prediction ? "needs-review" : "unprocessed",
    reviewed: false,
    roiEdited: false,
    source: null,
    iou: null,
    labelRoiGt: false,
    updatedAt: new Date().toISOString(),
  };
}

async function generateDinoLabelPrediction(
  imagePath: string,
  provenance: {
    presetId?: string;
    presetRevision?: number;
    configHash?: string;
  },
) {
  if (!env.DINO_ENABLED) return null;

  try {
    const result = await detectLabelWithDino({ imagePath });

    const selectedMethod =
      result.selectionMethod === "geometry-containment" ||
      result.selectionMethod === "white-label-fallback" ||
      result.selectionMethod === "compact-wordmark-fallback";

    if (!selectedMethod || !result.selected) {
      return null;
    }

    return generatedLabelRoiFromDino(result, provenance);
  } catch {
    // DINO is an optional semantic proposal stage.
    // Any service, timeout, provenance or inference failure must preserve
    // the existing classic-CV proposal path.
    return null;
  }
}

function generatedLabelRoiFromDino(
  result: DinoLabelResult,
  provenance: {
    presetId?: string;
    presetRevision?: number;
    configHash?: string;
  },
) {
  const selected = result.selected;
  if (!selected) return null;

  const [x, y, width, height] = selected.box_xywh;

  return {
    roi: {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    },
    algorithm: {
      id: "grounding-dino-label-roi",
      version: result.revision ?? result.model,
      params: {
        model: result.model,
        modelRevision: result.revision,
        prompt: result.prompt,
        threshold: result.threshold,
        textThreshold: result.textThreshold,
        selectionMethod: result.selectionMethod,
        attemptedPrompts:
          result.attemptedPrompts ?? [result.prompt],
        modelScore: selected.model_score,
        selectionScore: selected.selection_score ?? null,
        supportCount: selected.support_count ?? 0,
        containmentBonus: selected.containment_bonus ?? 0,
        geometry: selected.geometry,
        inferenceMs: result.inferenceMs,
        presetId: provenance.presetId,
        presetRevision: provenance.presetRevision,
        configHash: provenance.configHash,
      },
    },
    confidence: selected.model_score,
    createdAt: new Date().toISOString(),
  };
}

function generatedLabelRoiFromCvMeta(
  cvMeta: Record<string, unknown>,
  provenance: { presetId?: string; presetRevision?: number; configHash?: string },
) {
  const label = objectValue(cvMeta.label);
  const roi = objectValue(label?.roi);
  if (!roi) return null;
  const source = objectValue(cvMeta.source);
  const width = numberValue(source?.width) ?? 1000;
  const height = numberValue(source?.height) ?? 1000;
  const detection = objectValue(label?.detection);
  const layout = objectValue(label?.layout);
  const diagnostics = objectValue(cvMeta.diagnostics);
  return {
    roi: {
      x: Math.round((numberValue(roi.x) ?? 0) * width),
      y: Math.round((numberValue(roi.y) ?? 0) * height),
      width: Math.round((numberValue(roi.width) ?? 0) * width),
      height: Math.round((numberValue(roi.height) ?? 0) * height),
    },
    algorithm: {
      id: "cv-meta-label-roi",
      version: stringValue(diagnostics?.pipelineVersion) ?? stringValue(cvMeta.extractorVersion) ?? "cv-meta-v2",
      params: {
        candidateScore: numberValue(layout?.selectedScore),
        presetId: provenance.presetId,
        presetRevision: provenance.presetRevision,
        configHash: provenance.configHash,
      },
    },
    confidence: numberValue(detection?.confidence),
    createdAt: new Date().toISOString(),
  };
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function detectionInput(sourceItem: SourceItem) {
  const imageRef=sourceAssetRef(sourceItem);
  return {imageRef,localPath:imageRef ? resolveLocalAssetPath(imageRef) : null};
}
