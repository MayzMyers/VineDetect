import { sourceAssetRef } from "../../shared/officialReference.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { LabelAnalysisResultV2, NormalizedRect, SourceItem } from "../../shared/types.js";
import { resolveGeneratedAssetPath, resolveLocalAssetPath } from "../recognize-node/assets.js";
import { createLabelAnalysisOcrSnapshot } from "../../db/ocr.repository.js";
import { getMetadata } from "../../db/meta.repository.js";
import { buildGeneratedSourceMatchCandidates, buildSourceValues } from "../ocr/sourceMatcher.js";
import { classifyOcrSemantic } from "../ocr/semantic.js";
import { extractLabelCropFeatures, normalizeLabelAnalysisCvConfig } from "./labelCropFeatures.js";
import { hashConfigSnapshot } from "../../shared/configHash.js";
import { findCatalogCandidates } from "../../db/source.repository.js";
import { buildCatalogSearchInput, rankCatalogCandidates } from "../ocr/catalogMatcher.js";
import { startWizardStageExecution } from "../../db/wizard-stage-execution.repository.js";
import { ocrAlgorithm, ocrIntermediateStates, ocrStageAutoOutput, ocrStageInput, ocrStageParams } from "../../shared/wizardStageEvidence.js";
import { normalizeQuadGeometry, type QuadGeometry } from "../../shared/quadGeometry.js";
import { createRectifiedLabelCrop } from "./labelQuadCrop.js";
import type { LabelRectificationValue } from "../../shared/labelRectificationContract.js";

type ReviewedAnnotation = { id: string; revision: number; bbox: Record<string, unknown>; geometry?: QuadGeometry; rectification?: LabelRectificationValue | null };

export const LABEL_ANALYSIS_PROFILE: Record<string, unknown> = {
  version: "label-analysis-cascade-v7",
  ocr: "tesseract-cascade-v6",
  visual: "label-crop-features-v2-staged",
  matching: "source-matcher-semantic-v2+catalog-narrowing-v1",
};

export function labelAnalysisProfile(config: unknown) {
  return { ...LABEL_ANALYSIS_PROFILE, cvConfig: normalizeLabelAnalysisCvConfig(config) };
}

export async function analyzeReviewedLabel(input: {
  jobId: string;
  sourceItem: SourceItem;
  annotationTrackId: string;
  annotation: ReviewedAnnotation;
  config?: unknown;
}): Promise<LabelAnalysisResultV2> {
  const startedAt = Date.now();
  const sourceImage = sourceAssetRef(input.sourceItem);
  const sourcePath = sourceImage ? resolveLocalAssetPath(sourceImage) : null;
  if (!sourceImage || !sourcePath) throw new Error("Source image not found in asset store");

  const metadata = await sharp(sourcePath).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (!sourceWidth || !sourceHeight) throw new Error("Source image dimensions are unavailable");
  const rect = clampBbox(input.annotation.bbox, sourceWidth, sourceHeight);
  const geometry = normalizeQuadGeometry(input.annotation.geometry, rect);
  if (!geometry) throw new Error("Reviewed label geometry is invalid");
  const relativePath = `label-analysis/${input.sourceItem.source}/${safeSegment(input.sourceItem.sourceItemId)}/${input.jobId}.webp`;
  const cropPath = resolveGeneratedAssetPath(relativePath);
  if (!cropPath) throw new Error("Invalid label analysis artifact path");
  await mkdir(path.dirname(cropPath), { recursive: true });
  const cropSize = await createRectifiedLabelCrop(sourcePath, cropPath, rect, geometry, input.annotation.rectification);

  const configSnapshot = normalizeLabelAnalysisCvConfig(input.config);
  const configHash = hashConfigSnapshot(labelAnalysisProfile(configSnapshot));
  const [ocrSnapshot, visualFeatures, currentMetadata] = await Promise.all([
    createLabelAnalysisOcrSnapshot({
      source: input.sourceItem.source, sourceItemId: input.sourceItem.sourceItemId, sourceImage,
      annotationTrackId: input.annotationTrackId,
      annotationId: input.annotation.id, annotationRevision: input.annotation.revision, bbox: rect,
      geometry, cropWidth: cropSize.width, cropHeight: cropSize.height,
      cropPath, cropAssetPath: relativePath, analysisJobId: input.jobId,
    }),
    extractLabelCropFeatures(cropPath, configSnapshot),
    getMetadata(input.sourceItem.source, input.sourceItem.sourceItemId),
  ]);
  const ocrHelper = ocrAlgorithm(ocrSnapshot);
  await startWizardStageExecution({
    source: input.sourceItem.source,
    sourceItemId: input.sourceItem.sourceItemId,
    annotationTrackId: input.annotationTrackId,
    stage: "ocr",
    helperId: "label-ocr-cascade",
    algorithm: ocrHelper.id,
    algorithmVersion: ocrHelper.version,
    stageInput: ocrStageInput(ocrSnapshot),
    initialParams: ocrStageParams(ocrSnapshot),
    autoOutput: ocrStageAutoOutput(ocrSnapshot),
    intermediateStates: ocrIntermediateStates(ocrSnapshot),
  });
  const sourceMatches = buildGeneratedSourceMatchCandidates(ocrSnapshot.regions, buildSourceValues(input.sourceItem, currentMetadata))
    .map((match) => ({ ocrRegionId: match.ocrRegionId, regionText: match.regionText, sourceField: match.field,
      sourceValue: match.value, score: match.score, matchKind: match.matchKind,
      lexicalScore: match.lexicalScore, semanticType: match.semanticType,
      semanticConfidence: match.semanticConfidence, semanticCompatibility: match.semanticCompatibility }));
  const textRegions: LabelAnalysisResultV2["textRegions"] = [];
  for (const region of ocrSnapshot.regions) {
    const bbox = normalizedRect(region.bbox);
    if (!bbox || (region.level !== "line" && region.level !== "word")) continue;
    textRegions.push({
      id: region.id, parentId: region.parentId, level: region.level, bbox, geometry: region.geometry,
      rawText: region.rawText, normalizedText: region.normalizedText, confidence: region.confidence,
      textDirection: region.textDirection as LabelAnalysisResultV2["textRegions"][number]["textDirection"],
      glyphOrientation: region.glyphOrientation as LabelAnalysisResultV2["textRegions"][number]["glyphOrientation"],
      semantic: classifyOcrSemantic(region.rawText || region.normalizedText, region.level, bbox),
    });
  }
  const catalogSearch = buildCatalogSearchInput(textRegions);
  const catalogPool = await findCatalogCandidates({
    ...catalogSearch,
    include: { source: input.sourceItem.source, sourceItemId: input.sourceItem.sourceItemId },
    limit: 250,
  });
  const catalogCandidates = rankCatalogCandidates(textRegions, catalogPool, {
    source: input.sourceItem.source,
    sourceItemId: input.sourceItem.sourceItemId,
  });
  const warnings: string[] = [];
  if (!ocrSnapshot.ocr.normalizedText) warnings.push("OCR_TEXT_EMPTY");
  if (!textRegions.some((region) => region.level === "word")) warnings.push("OCR_WORD_REGIONS_EMPTY");
  if (!sourceMatches.length) warnings.push("SOURCE_MATCHES_EMPTY");
  if (!catalogCandidates.length) warnings.push("CATALOG_CANDIDATES_EMPTY");
  const currentCatalogRank = catalogCandidates.findIndex((candidate) => candidate.isCurrentItem);
  if (currentCatalogRank < 0 || currentCatalogRank >= 5 || (catalogCandidates[currentCatalogRank]?.score ?? 0) < 0.25) warnings.push("CATALOG_CURRENT_ITEM_LOW_RANK");
  if (!visualFeatures.contours[0]?.points.length) warnings.push("VISUAL_CONTOURS_EMPTY");
  const ocrEvidence = ocrSnapshot.ocr.evidence;
  if (ocrEvidence?.completedStage === "deep") warnings.push("OCR_DEEP_STAGE_REQUIRED");
  if (ocrEvidence?.completedStage === "rescue") warnings.push("OCR_RESCUE_STAGE_REQUIRED");
  if (ocrEvidence?.stopReason === "rescue-exhausted") warnings.push("OCR_RESCUE_EXHAUSTED");
  if (ocrEvidence?.geometry?.applied) warnings.push("OCR_DESKEW_APPLIED");
  if (ocrEvidence?.geometry?.perspective?.applied) warnings.push("OCR_PERSPECTIVE_APPLIED");
  if (ocrEvidence && ocrEvidence.quality.averageConsensus < 0.45) warnings.push("OCR_CONSENSUS_LOW");
  if (ocrEvidence && ocrEvidence.quality.rejectedObservationCount > ocrEvidence.quality.validObservationCount) warnings.push("OCR_NOISE_HIGH");
  if (ocrEvidence && ocrEvidence.quality.highConfidenceSemanticRegionCount === 0) warnings.push("OCR_SEMANTICS_UNRESOLVED");
  return {
    schemaVersion: 2,
    jobId: input.jobId,
    annotationId: input.annotation.id,
    annotationRevision: input.annotation.revision,
    crop: { id: ocrSnapshot.crop.id, assetPath: relativePath, sourceImage, sourceRect: rect, sourceGeometry: geometry, width: cropSize.width, height: cropSize.height, transformMode: cropSize.transformMode },
    ocr: {
      runId: ocrSnapshot.ocr.id, engine: ocrSnapshot.ocr.engine, engineVersion: ocrSnapshot.ocr.engineVersion,
      rawText: ocrSnapshot.ocr.rawText, normalizedText: ocrSnapshot.ocr.normalizedText,
      confidence: ocrSnapshot.ocr.confidence, runtimeMs: ocrSnapshot.ocr.runtimeMs,
      evidence: ocrSnapshot.ocr.evidence,
    },
    textRegions,
    sourceMatches,
    catalogCandidates,
    visualFeatures,
    configSnapshot,
    warnings,
    runtimeMs: Date.now() - startedAt,
    provenance: { pipelineVersion: "label-analysis-v2", analysisProfileVersion: String(LABEL_ANALYSIS_PROFILE.version), engine: "detector-free-label-analysis", configHash },
  };
}

function clampBbox(value: Record<string, unknown>, sourceWidth: number, sourceHeight: number) {
  const x = clampInt(value.x, 0, Math.max(0, sourceWidth - 1));
  const y = clampInt(value.y, 0, Math.max(0, sourceHeight - 1));
  return {
    x,
    y,
    width: clampInt(value.width, 1, Math.max(1, sourceWidth - x)),
    height: clampInt(value.height, 1, Math.max(1, sourceHeight - y)),
  };
}

function clampInt(value: unknown, min: number, max: number) { const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : min; return Math.max(min, Math.min(max, number)); }
function safeSegment(value: string) { return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || "item"; }
function normalizedRect(value: Record<string, unknown>): NormalizedRect | null {
  const x = finite(value.x); const y = finite(value.y); const width = finite(value.width); const height = finite(value.height);
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}
function finite(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
