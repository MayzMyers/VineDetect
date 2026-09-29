import { officialTargetForTrack,verifyOfficialBytes } from "../../db/official-draft.repository.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import { resolveGeneratedAssetPath, resolveLocalAssetPath } from "../recognize-node/assets.js";
import { createRectifiedLabelCropBuffer, createRectifiedNormalizedQuadCropBuffer } from "../label-analysis/labelQuadCrop.js";
import { runStandardOcrOnBuffer, type OcrConsensusRegion } from "./standardOcr.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import type { GraphOcrAnnotation, OcrCoordinateSpace, RegionGeometry } from "../../shared/annotationGraphContract.js";
import type { QuadGeometry } from "../../shared/quadGeometry.js";
import type { SourceName } from "../../shared/types.js";
import { bindHelperToCard } from "../../shared/helperConfigContract.js";
import { normalizeLabelRectification } from "../../shared/labelRectificationContract.js";
import { executeEditOperationPlan } from "../wizard/wizard-edit-operation-engine.service.js";
import type { OcrEditOperation } from "../wizard/wizard.schemas.js";

type Scope = { type: "label"; id: string };
type Parent = { type: "label"; packageId: string; labelId: string };
type DuplicateClassification = "probable_duplicate" | "possible_duplicate" | "overlapping" | "unlikely";
export type DeduplicationConfig = {
  geometryWeight: number;
  textWeight: number;
  possibleThreshold: number;
  probableThreshold: number;
  overlapThreshold: number;
  minimumGeometryScore: number;
  normalizeConfusions: boolean;
  maxMatches: number;
};
export type DuplicateMatch = {
  existingOcrId: string;
  geometryScore: number;
  textScore: number | null;
  totalScore: number;
  classification: DuplicateClassification;
  existing: { transcription: string | null; regionStatus: "reviewed" | "rejected"; transcriptionStatus: "verified" | "partial" | "unreadable"; labelId: string | null; geometry: QuadGeometry };
};
type CandidatePayload = {
  geometry: QuadGeometry;
  sourceGeometry: QuadGeometry;
  coordinateSpace: OcrCoordinateSpace;
  transcription: string | null;
  transcriptionStatus: "verified" | "partial" | "unreadable";
  regionStatus: "reviewed" | "rejected";
  layout: GraphOcrAnnotation["layout"];
  rectification: GraphOcrAnnotation["rectification"];
  detectionConfidence: number | null;
  recognitionConfidence: number | null;
  suggestedParent: Parent;
  duplicateOfOcrId: string | null;
  duplicateAnalysis: { matches: DuplicateMatch[]; config: DeduplicationConfig };
  level: "line" | "word";
};

const DEFAULT_DEDUPLICATION_CONFIG: DeduplicationConfig = {
  geometryWeight: 0.55,
  textWeight: 0.45,
  possibleThreshold: 0.5,
  probableThreshold: 0.8,
  overlapThreshold: 0.45,
  minimumGeometryScore: 0.3,
  normalizeConfusions: true,
  maxMatches: 5,
};

export async function runParentScopedAutoOcr(source: SourceName, sourceItemId: string, input: { scope: Scope; config: Record<string, unknown> }) {
  const operationId = randomUUID();
  const helperConfig = Object.keys(input.config).length ? input.config : bindHelperToCard({ schemaVersion: 1, records: [] }, source, sourceItemId, "label-ocr-cascade").config;
  const deduplicationConfig = resolveDeduplicationConfig(helperConfig.deduplication);
  const config = { ...helperConfig, deduplication: deduplicationConfig };
  const context = await loadScope(source, sourceItemId, input.scope);
  const labelRevision = Number(context.label.revision ?? 1);
  const localPath = context.package.source_asset_ref ? resolveLocalAssetPath(String(context.package.source_asset_ref)) : null;
  if (!localPath) throw new ConflictError("Package has no local source asset for Auto OCR");
  const sourceMeta = await sharp(localPath).metadata();
  if (!sourceMeta.width || !sourceMeta.height) throw new ConflictError("Source image dimensions are unavailable");

  const scopeGeometry = context.label.geometry as QuadGeometry;
  const scopeRect = integerRect(scopeGeometry?.bbox ?? { x: 0, y: 0, width: sourceMeta.width, height: sourceMeta.height }, sourceMeta.width, sourceMeta.height);
  const ocrResult = await createRectifiedLabelCropBuffer(localPath, scopeRect, context.label.geometry as QuadGeometry, normalizeLabelRectification(context.label.rectification)).then(async (crop) => ({ result: await runStandardOcrOnBuffer(crop.buffer), crop }));
  const viewer = await persistLabelViewer(operationId, ocrResult.crop, labelRevision);

  const usefulRegions = selectReviewableOcrRegions(ocrResult.result.evidence.consensusRegions);
  const existing = await loadExistingOcr(source, sourceItemId, String(context.package.id), context.labels);
  const candidates = usefulRegions.map((region, index) => {
    const localGeometry = quadFromBox(region.bbox);
    const sourceGeometry = mapNormalizedQuadToSource(localGeometry, context.label.geometry as QuadGeometry);
    const suggestedParent = { type: "label" as const, packageId: String(context.package.id), labelId: String(context.label.id) };
    const coordinateSpace: OcrCoordinateSpace = { type: "label-rectified", units: "normalized", labelId: String(context.label.id), cropRevision: labelRevision, width: ocrResult.crop.width, height: ocrResult.crop.height };
    const duplicateMatches = findDuplicateMatches(sourceGeometry, region.normalizedText || region.rawText, existing, deduplicationConfig);
    const baselineAngleDeg = directionAngle(region.textDirection);
    const payload: CandidatePayload = {
      geometry: localGeometry,
      sourceGeometry, coordinateSpace,
      transcription: (region.normalizedText || region.rawText || "").trim() || null,
      transcriptionStatus: (region.normalizedText || region.rawText || "").trim() ? "verified" : "unreadable",
      regionStatus: "reviewed",
      layout: { type: region.level === "word" ? "word" : "string", flow: "linear", baselineAngleDeg, baseline: null,
        characterOrientation: region.glyphOrientation === "mixed" ? "mixed" : region.glyphOrientation === "upright" ? "upright" : "aligned" },
      rectification: Math.abs(baselineAngleDeg) < 0.05 ? null : { type: "rotation", angleDeg: -baselineAngleDeg },
      detectionConfidence: normalizeOcrConfidence(region.confidence),
      recognitionConfidence: normalizeOcrConfidence(region.confidence),
      suggestedParent,
      duplicateOfOcrId: duplicateMatches.find((match) => match.classification === "probable_duplicate" || match.classification === "possible_duplicate")?.existingOcrId ?? null,
      duplicateAnalysis: { matches: duplicateMatches, config: deduplicationConfig },
      level: region.level,
    };
    return { id: `ocr-${index + 1}-${region.key}`, payload, score: normalizeOcrConfidence(region.confidence) };
  });

  const operationStatus = candidates.length ? "draft" : "failed";
  await transaction(async (client) => {
    await client.query(`INSERT INTO meta.annotation_operations
      (id,source,source_item_id,operation_type,scope_type,scope_id,helper_output,operation_status,helper_id,helper_version,
       initial_config,final_config,review_status)
      VALUES($1,$2,$3,'run_ocr',$4,$5,$6::jsonb,$7,'auto-ocr','tesseract-cascade-v6',$8::jsonb,$8::jsonb,'manual')`,
      [operationId, source, sourceItemId, input.scope.type, input.scope.id, JSON.stringify({ viewer }), operationStatus, JSON.stringify(config)]);
    for (const [index, candidate] of candidates.entries()) {
      const payload = candidate.payload;
      await client.query(`INSERT INTO meta.annotation_candidates
        (id,operation_id,candidate_key,payload,score,sort_order,detection_confidence,recognition_confidence,
         suggested_parent_type,suggested_package_id,suggested_label_id,duplicate_of_ocr_id)
        VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)`, [
        randomUUID(), operationId, candidate.id, JSON.stringify(payload), candidate.score, index,
        payload.detectionConfidence, payload.recognitionConfidence, payload.suggestedParent.type,
        payload.suggestedParent.packageId, payload.suggestedParent.labelId,
        payload.duplicateOfOcrId,
      ]);
    }
  });
  return { operationId, helper: { id: "auto-ocr", version: "tesseract-cascade-v6" }, scope: input.scope, config, candidates, viewer, status: operationStatus };
}

export async function rerunOcrOnLabelRegion(source: SourceName, sourceItemId: string, labelId: string, geometry: QuadGeometry) {
  const context = await loadScope(source, sourceItemId, { type: "label", id: labelId });
  const localPath = context.package.source_asset_ref ? resolveLocalAssetPath(String(context.package.source_asset_ref)) : null;
  if (!localPath) throw new ConflictError("Package has no local source asset for OCR rerun");
  const metadata = await sharp(localPath).metadata();
  if (!metadata.width || !metadata.height) throw new ConflictError("Source image dimensions are unavailable");
  const labelRect = integerRect((context.label.geometry as QuadGeometry).bbox, metadata.width, metadata.height);
  const labelCrop = await createRectifiedLabelCropBuffer(localPath, labelRect, context.label.geometry as QuadGeometry, normalizeLabelRectification(context.label.rectification));
  const regionCrop = await createRectifiedNormalizedQuadCropBuffer(labelCrop.buffer, labelCrop.width, labelCrop.height, geometry);
  const result = await runStandardOcrOnBuffer(regionCrop.buffer);
  const transcription = (result.normalizedText || result.rawText || "").trim() || null;
  return {
    transcription,
    transcriptionStatus: transcription ? "verified" as const : "unreadable" as const,
    recognitionConfidence: normalizeOcrConfidence(result.confidence),
    evidence: {
      helper: "tesseract-cascade-v6", engine: result.engine, engineVersion: result.engineVersion,
      runtimeMs: result.runtimeMs, crop: {
        mode: "perspective-quad-v1", coordinateSpace: "label-rectified-normalized", geometry,
        sourceWidth: labelCrop.width, sourceHeight: labelCrop.height, width: regionCrop.width, height: regionCrop.height,
      },
      profileVersion: result.evidence.profileVersion, completedStage: result.evidence.completedStage,
      stopReason: result.evidence.stopReason, quality: result.evidence.quality,
    },
  };
}

export function selectReviewableOcrRegions(regions: OcrConsensusRegion[], limit = 24) {
  const reviewable = regions
    .filter((region) => region.level === "line" || region.parentKey === null)
    .map((region) => ({ region, quality: reviewCandidateQuality(region) }))
    .filter(({ region }) => {
      const confidence = normalizeOcrConfidence(region.confidence) ?? 0;
      const characters = [...region.normalizedText].filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
      const highConfidence = confidence >= 0.7 && region.validityScore >= 0.5;
      const supported = confidence >= 0.35 && region.support >= 2 && region.consensus >= 0.58 && region.validityScore >= 0.5;
      const semantic = confidence >= 0.4 && region.semantic.type !== "unknown" && region.semantic.confidence >= 0.55 && region.validityScore >= 0.55;
      return characters >= 2 && (highConfidence || supported || semantic);
    })
    .sort((left, right) => right.quality - left.quality)
    .slice(0, Math.max(1, limit))
    .map(({ region }) => region);
  return reviewable.sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x);
}

function reviewCandidateQuality(region: OcrConsensusRegion) {
  return (normalizeOcrConfidence(region.confidence) ?? 0) * 0.45
    + region.validityScore * 0.25
    + region.consensus * 0.2
    + Math.min(1, region.support / 3) * 0.1;
}

export function normalizeOcrConfidence(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
}

export async function runManualOcrDedupePreflight(source: SourceName, sourceItemId: string, input: {
  parent: Scope;
  geometry: QuadGeometry;
  coordinateSpace: OcrCoordinateSpace;
  regionStatus: "reviewed" | "rejected";
  transcription: { text: string | null; status: "verified" | "partial" | "unreadable" };
  layout: CandidatePayload["layout"];
  rectification: CandidatePayload["rectification"];
  confidence?: number | null;
  config?: Record<string, unknown>;
}) {
  const operationId = randomUUID();
  const context = await loadScope(source, sourceItemId, input.parent);
  const config = resolveDeduplicationConfig(input.config?.deduplication ?? input.config);
  validateManualCoordinateSpace(input.parent, input.coordinateSpace);
  const sourceGeometry = mapNormalizedQuadToSource(input.geometry, context.label.geometry as QuadGeometry);
  const existing = await loadExistingOcr(source, sourceItemId, String(context.package.id), context.labels);
  const matches = findDuplicateMatches(sourceGeometry, input.transcription.text ?? "", existing, config);
  const parent: Parent = { type: "label", packageId: String(context.package.id), labelId: input.parent.id };
  const candidateId = "manual-ocr-1";
  const payload: CandidatePayload = {
    geometry: input.geometry, sourceGeometry, coordinateSpace: input.coordinateSpace,
    transcription: input.transcription.text, transcriptionStatus: input.transcription.status, regionStatus: input.regionStatus, layout: input.layout, rectification: input.rectification,
    detectionConfidence: input.confidence ?? null,
    recognitionConfidence: input.confidence ?? null, suggestedParent: parent,
    duplicateOfOcrId: matches.find((match) => match.classification === "probable_duplicate" || match.classification === "possible_duplicate")?.existingOcrId ?? null,
    duplicateAnalysis: { matches, config }, level: "line",
  };
  await transaction(async (client) => {
    await client.query(`INSERT INTO meta.annotation_operations
      (id,source,source_item_id,operation_type,scope_type,scope_id,helper_output,operation_status,helper_id,helper_version,
       initial_config,final_config,review_status)
      VALUES($1,$2,$3,'run_ocr',$4,$5,$6::jsonb,'draft','ocr-dedupe-preflight','v1',$7::jsonb,$7::jsonb,'manual')`,
      [operationId, source, sourceItemId, input.parent.type, input.parent.id, JSON.stringify({ entryPoint: "manual-create" }), JSON.stringify({ deduplication: config })]);
    await client.query(`INSERT INTO meta.annotation_candidates
      (id,operation_id,candidate_key,payload,score,sort_order,detection_confidence,recognition_confidence,
       suggested_parent_type,suggested_package_id,suggested_label_id,duplicate_of_ocr_id)
      VALUES($1,$2,$3,$4::jsonb,NULL,0,$5,$5,$6,$7,$8,$9)`, [randomUUID(), operationId, candidateId,
      JSON.stringify(payload), input.confidence ?? null, parent.type, parent.packageId, parent.labelId, payload.duplicateOfOcrId]);
  });
  return { operationId, candidateId, parent, matches, config, status: "draft" as const };
}

export async function reviewParentScopedAutoOcr(source: SourceName, sourceItemId: string, input: {
  operationId: string;
  reviews: Array<{ candidateId: string; state: "accepted" | "edited" | "rejected" | "merged"; sourceOperationId?: string; mergeGroupId?: string; resultEntityId?: string | null; finalParent?: Parent | null; geometry?: QuadGeometry; regionStatus?: "reviewed" | "rejected"; transcription?: { text: string | null; status: "verified" | "partial" | "unreadable" }; layout?: CandidatePayload["layout"]; rectification?: CandidatePayload["rectification"]; splitOutputs?: Array<{ geometry: QuadGeometry; regionStatus: "reviewed"; transcription: { text: string | null; status: "verified" | "partial" | "unreadable" }; layout: CandidatePayload["layout"]; rectification: CandidatePayload["rectification"]; confidence: number | null; sourceOperationId: string }> }>;
  compositions?: Array<{ sourceOperationId: string; memberSourceOperationIds: string[]; text: string | null; transcriptionStatus: "verified" | "partial" | "unreadable"; sortOrder: number }>;
  decomposeCompositionIds?: string[];
  editOperations?: OcrEditOperation[];
  reviewActor?: "human" | "llm";
}) {
  return transaction(async (client) => {
    const operation = (await client.query(`SELECT * FROM meta.annotation_operations WHERE id=$1 AND source=$2 AND source_item_id=$3 FOR UPDATE`, [input.operationId, source, sourceItemId])).rows[0];
    if (!operation) throw new NotFoundError("Auto OCR operation not found");
    if (operation.operation_type !== "run_ocr" || operation.operation_status !== "draft") throw new ConflictError("Auto OCR operation is not an open draft");
    const candidateRows = (await client.query(`SELECT * FROM meta.annotation_candidates WHERE operation_id=$1 ORDER BY sort_order,id`, [input.operationId])).rows;
    const reviewById = new Map(input.reviews.map((review) => [review.candidateId, review]));
    if (reviewById.size !== candidateRows.length || candidateRows.some((row) => !reviewById.has(String(row.candidate_key)))) {
      throw new ConflictError("Every Auto OCR candidate must be accepted, edited, rejected or merged exactly once");
    }
    if (operation.scope_type !== "label") throw new ConflictError("Legacy Package OCR runs cannot be reviewed; select a Label and rerun Auto OCR");
    const scope: Scope = { type: "label", id: String(operation.scope_id) };
    const context = await loadScopeWithClient(client, source, sourceItemId, scope);
    const results: string[] = [];
    const resultIdBySourceOperation = new Map<string, string>();
    const existingOcrRows = (await client.query(`SELECT id FROM meta.annotation_ocr WHERE label_id=$1 AND deleted_at IS NULL`, [context.label.id])).rows;
    for (const row of existingOcrRows) resultIdBySourceOperation.set(String(row.id), String(row.id));
    const processedCandidates = new Set<string>();
    const mergeGroupIds = [...new Set(input.reviews.flatMap((review) => review.mergeGroupId ? [review.mergeGroupId] : []))];
    for (const mergeGroupId of mergeGroupIds) {
      const members = input.reviews.filter((review) => review.mergeGroupId === mergeGroupId);
      if (members.length < 2) throw new ConflictError(`OCR merge group ${mergeGroupId} requires at least two candidates`);
      const rows = members.map((review) => candidateRows.find((row) => String(row.candidate_key) === review.candidateId));
      if (rows.some((row) => !row)) throw new ConflictError(`OCR merge group ${mergeGroupId} references an unknown candidate`);
      const parents = members.map((review) => review.finalParent!);
      if (parents.some((parent) => !parent || parent.packageId !== parents[0]!.packageId || parent.labelId !== parents[0]!.labelId)) throw new ConflictError("Merged OCR regions must share one final Label parent");
      const parent = parents[0]!;
      validateParent(context.package.id, context.labels, parent);
      const entries = members.map((review, index) => ({ review, payload: rows[index]!.payload as CandidatePayload }));
      const geometry = quadFromBox(unionBboxes(entries.map(({ review, payload }) => (review.geometry ?? payload.geometry).bbox)));
      const transcriptionParts = [...new Set(entries
        .map(({ review, payload }) => (review.transcription?.text ?? payload.transcription ?? "").trim())
        .filter(Boolean))];
      const transcriptionStatuses = entries.map(({ review, payload }) => review.transcription?.status ?? payload.transcriptionStatus);
      const transcription = {
        text: transcriptionParts.length ? transcriptionParts.join(" ") : null,
        status: transcriptionStatuses.every((status) => status === "verified") ? "verified" as const : transcriptionParts.length ? "partial" as const : "unreadable" as const,
      };
      const first = entries[0]!;
      const coordinateSpace = labelCoordinateSpace(parent.labelId, context.labels);
      const id = randomUUID();
      await client.query(`INSERT INTO meta.annotation_ocr
        (id,package_id,label_id,geometry,coordinate_space,transcription,status,region_status,transcription_status,layout_type,text_direction,glyph_orientation,
         layout_flow,baseline_angle_deg,layout_baseline,character_orientation,rectification,confidence)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,'reviewed',$8,$9,$10,$11,$12,$13,$14::jsonb,$15,NULL,NULL)`, [id, parent.packageId, parent.labelId,
        JSON.stringify(geometry), JSON.stringify(coordinateSpace), transcription.text, legacyStatus("reviewed", transcription.status), transcription.status,
        first.payload.layout.type, legacyDirection(first.payload.layout), legacyOrientation(first.payload.layout), first.payload.layout.flow,
        first.payload.layout.baselineAngleDeg, first.payload.layout.baseline ? JSON.stringify(first.payload.layout.baseline) : null, first.payload.layout.characterOrientation]);
      await client.query(`INSERT INTO meta.annotation_operation_results (operation_id,entity_type,entity_id) VALUES($1,'ocr',$2) ON CONFLICT DO NOTHING`, [input.operationId, id]);
      for (const { review, payload } of entries) {
        await insertCandidateReview(client, input.operationId, review.candidateId, { ...review, state: "edited", finalParent: parent, regionStatus: "reviewed", transcription, layout: payload.layout, rectification: null }, id, geometry, transcription.text);
        if (review.sourceOperationId) resultIdBySourceOperation.set(review.sourceOperationId, id);
        processedCandidates.add(review.candidateId);
      }
      results.push(id);
    }
    for (const row of candidateRows) {
      const candidateId = String(row.candidate_key);
      if (processedCandidates.has(candidateId)) continue;
      const review = reviewById.get(candidateId)!;
      const payload = row.payload as CandidatePayload;
      if (review.splitOutputs?.length) {
        const parent = review.finalParent!;
        validateParent(context.package.id, context.labels, parent);
        const coordinateSpace: OcrCoordinateSpace = labelCoordinateSpace(parent.labelId, context.labels);
        const resultIds: string[] = [];
        for (const output of review.splitOutputs) {
          const id = randomUUID();
          await client.query(`INSERT INTO meta.annotation_ocr
            (id,package_id,label_id,geometry,coordinate_space,transcription,status,region_status,transcription_status,layout_type,text_direction,glyph_orientation,
             layout_flow,baseline_angle_deg,layout_baseline,character_orientation,rectification,confidence)
            VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18)`, [id, parent.packageId, parent.labelId,
            JSON.stringify(output.geometry), JSON.stringify(coordinateSpace), output.transcription.text,
            legacyStatus(output.regionStatus, output.transcription.status), output.regionStatus, output.transcription.status,
            output.layout.type, legacyDirection(output.layout), legacyOrientation(output.layout), output.layout.flow,
            output.layout.baselineAngleDeg, output.layout.baseline ? JSON.stringify(output.layout.baseline) : null, output.layout.characterOrientation,
            output.rectification ? JSON.stringify(output.rectification) : null, output.confidence]);
          await client.query(`INSERT INTO meta.annotation_operation_results (operation_id,entity_type,entity_id) VALUES($1,'ocr',$2) ON CONFLICT DO NOTHING`, [input.operationId, id]);
          resultIdBySourceOperation.set(output.sourceOperationId, id);
          resultIds.push(id); results.push(id);
        }
        await insertCandidateReview(client, input.operationId, candidateId, review, null, null, null, resultIds);
        continue;
      }
      if (review.state === "rejected") {
        await insertCandidateReview(client, input.operationId, candidateId, review, null, null, null);
        continue;
      }
      if (review.state === "merged") {
        const target = (await client.query(`SELECT ocr.* FROM meta.annotation_ocr ocr
          WHERE ocr.id=$1 AND ocr.package_id=$2 AND ocr.deleted_at IS NULL`, [review.resultEntityId, context.package.id])).rows[0];
        if (!target) throw new ConflictError(`Merge target for candidate ${candidateId} must be an active OCR entity in the same Package`);
        const canonicalParent: Parent = { type: "label", packageId: String(target.package_id), labelId: String(target.label_id) };
        await client.query(`INSERT INTO meta.annotation_operation_results (operation_id,entity_type,entity_id)
          VALUES($1,'ocr',$2) ON CONFLICT DO NOTHING`, [input.operationId, target.id]);
        await insertCandidateReview(client, input.operationId, candidateId, { ...review, finalParent: canonicalParent }, String(target.id), null, null);
        if (review.sourceOperationId) resultIdBySourceOperation.set(review.sourceOperationId, String(target.id));
        if (!results.includes(String(target.id))) results.push(String(target.id));
        continue;
      }
      const parent = review.finalParent!;
      validateParent(context.package.id, context.labels, parent);
      const draftGeometry = review.geometry ?? payload.geometry;
      const sourceGeometry = mapNormalizedQuadToSource(draftGeometry, context.label.geometry as QuadGeometry);
      const finalGeometry = mapSourceQuadToNormalized(sourceGeometry, parent.labelId, context.labels);
      const coordinateSpace: OcrCoordinateSpace = labelCoordinateSpace(parent.labelId, context.labels);
      const transcription = review.transcription ?? { text: payload.transcription, status: payload.transcriptionStatus };
      const regionStatus = review.regionStatus ?? payload.regionStatus;
      const layout = review.layout ?? payload.layout;
      const rectification = review.rectification !== undefined ? review.rectification : payload.rectification;
      const id = randomUUID();
      await client.query(`INSERT INTO meta.annotation_ocr
        (id,package_id,label_id,geometry,coordinate_space,transcription,status,region_status,transcription_status,layout_type,text_direction,glyph_orientation,
         layout_flow,baseline_angle_deg,layout_baseline,character_orientation,rectification,confidence)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18)`, [id, parent.packageId, parent.labelId,
        JSON.stringify(finalGeometry), JSON.stringify(coordinateSpace), transcription.text,
        legacyStatus(regionStatus, transcription.status), regionStatus, transcription.status, layout.type, legacyDirection(layout), legacyOrientation(layout),
        layout.flow, layout.baselineAngleDeg, layout.baseline ? JSON.stringify(layout.baseline) : null, layout.characterOrientation,
        rectification ? JSON.stringify(rectification) : null, payload.recognitionConfidence]);
      await client.query(`INSERT INTO meta.annotation_operation_results (operation_id,entity_type,entity_id) VALUES($1,'ocr',$2) ON CONFLICT DO NOTHING`, [input.operationId, id]);
      await insertCandidateReview(client, input.operationId, candidateId, { ...review, regionStatus, transcription, layout, rectification }, id, finalGeometry, transcription.text);
      resultIdBySourceOperation.set(review.sourceOperationId ?? candidateId, id);
      results.push(id);
    }
    const decomposeIds = [...new Set(input.decomposeCompositionIds ?? [])];
    if (decomposeIds.length) {
      const removed = await client.query(`UPDATE meta.annotation_ocr_compositions SET deleted_at=now(),updated_at=now()
        WHERE label_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL RETURNING id`, [context.label.id, decomposeIds]);
      if (removed.rowCount !== decomposeIds.length) throw new ConflictError("OCR decompose_string must reference active compositions in the selected Label");
    }
    const compositionResultIds: string[] = [];
    for (const composition of input.compositions ?? []) {
      const memberIds = composition.memberSourceOperationIds.map((sourceId) => resultIdBySourceOperation.get(sourceId));
      if (memberIds.some((id) => !id)) throw new ConflictError(`OCR composition ${composition.sourceOperationId} references an output that was not persisted by this review`);
      if (new Set(memberIds).size !== memberIds.length) throw new ConflictError("OCR composition members must resolve to distinct canonical regions");
      const id = randomUUID();
      await client.query(`INSERT INTO meta.annotation_ocr_compositions
        (id,package_id,label_id,member_ids,transcription,transcription_status,sort_order,origin,source_operation_id)
        VALUES($1,$2,$3,$4::uuid[],$5,$6,$7,'llm',$8)`, [id, context.package.id, context.label.id, memberIds,
        composition.text, composition.transcriptionStatus, composition.sortOrder, composition.sourceOperationId]);
      compositionResultIds.push(id);
    }
    const reviewMode = input.reviews.some((review) => review.state !== "accepted") ? "edited" : "accepted";
    await client.query(`UPDATE meta.annotation_operations
      SET operation_status='reviewed', review_status=$2,
          helper_output=jsonb_set(COALESCE(helper_output,'{}'::jsonb), '{ocrReview}', $3::jsonb, true)
      WHERE id=$1`, [input.operationId, reviewMode, JSON.stringify({
        reviews: input.reviews,
        compositions: input.compositions ?? [],
        decomposeCompositionIds: decomposeIds,
        compositionResultIds,
        editEngineVersion: input.editOperations?.length ? "edit-engine-v1" : undefined,
        editOperations: input.editOperations ?? [],
        reviewActor: input.reviewActor ?? null,
      })]);
    return { operationId: input.operationId, status: "reviewed" as const, resultEntityIds: results, compositionResultIds, decomposeCompositionIds: decomposeIds, reviews: input.reviews };
  });
}

export async function reviewParentScopedAutoOcrActions(source: SourceName, sourceItemId: string, input: {
  operationId: string;
  editOperations: OcrEditOperation[];
  reuseExisting: Array<{ candidateId: string; resultEntityId: string }>;
}) {
  const operation = (await pool.query(`SELECT scope_type,scope_id,operation_status FROM meta.annotation_operations WHERE id=$1 AND source=$2 AND source_item_id=$3`, [input.operationId, source, sourceItemId])).rows[0];
  if (!operation) throw new NotFoundError("Auto OCR operation not found");
  if (operation.scope_type !== "label" || operation.operation_status !== "draft") throw new ConflictError("Auto OCR operation is not an open Label-scoped draft");
  const candidateRows = (await pool.query(`SELECT candidate_key,payload FROM meta.annotation_candidates WHERE operation_id=$1 ORDER BY sort_order,id`, [input.operationId])).rows;
  const candidates = candidateRows.map((row) => ({ id: String(row.candidate_key), payload: row.payload as CandidatePayload }));
  const compositionRows = (await pool.query(`SELECT id,member_ids,transcription AS text,transcription_status AS "transcriptionStatus",sort_order AS "sortOrder" FROM meta.annotation_ocr_compositions WHERE label_id=$1 AND deleted_at IS NULL`, [operation.scope_id])).rows;
  const initialNodes = [
    ...candidates.map((candidate) => ({ id: candidate.id, payload: candidate.payload as unknown as Record<string, unknown>, sources: new Map([[candidate.id, candidate.payload as unknown as Record<string, unknown>]]) })),
    ...compositionRows.map((composition) => ({ id: String(composition.id), payload: { ...composition, kind: "string-composition" }, sources: new Map<string, Record<string, unknown>>() })),
  ];
  const execution = executeEditOperationPlan({ stage: "ocr", initialNodes, operations: input.editOperations });
  const accepted = [...new Map(execution.accepted.map((node) => [node.id, node])).values()];
  const reuseByCandidate = new Map(input.reuseExisting.map((item) => [item.candidateId, item.resultEntityId]));
  if ([...reuseByCandidate.keys()].some((candidateId) => !candidates.some((candidate) => candidate.id === candidateId))) throw new ConflictError("OCR reuse references an unknown candidate");
  const ownerByCandidate = new Map<string, typeof accepted>();
  for (const output of accepted) for (const sourceId of output.sources.keys()) {
    if (execution.rejectedSourceIds.has(sourceId)) throw new ConflictError("Rejected OCR candidate cannot contribute to an approved output");
    ownerByCandidate.set(sourceId, [...(ownerByCandidate.get(sourceId) ?? []), output]);
  }
  for (const candidateId of reuseByCandidate.keys()) if ((ownerByCandidate.get(candidateId) ?? []).length) throw new ConflictError("A reused OCR candidate cannot also produce a new approved region");
  const reviews = candidates.map((candidate) => {
    const reusedId = reuseByCandidate.get(candidate.id);
    if (reusedId) return { candidateId: candidate.id, state: "merged" as const, resultEntityId: reusedId, sourceOperationId: candidate.id };
    const outputs = ownerByCandidate.get(candidate.id) ?? [];
    if (!outputs.length) return { candidateId: candidate.id, state: "rejected" as const };
    if (outputs.length > 1) return {
      candidateId: candidate.id, state: "edited" as const, finalParent: candidate.payload.suggestedParent,
      splitOutputs: outputs.map((output) => ({
        geometry: output.payload.geometry as QuadGeometry, regionStatus: "reviewed" as const,
        transcription: { text: typeof output.payload.transcription === "string" ? output.payload.transcription : null, status: ocrTranscriptionStatus(output.payload.transcriptionStatus) },
        layout: (output.payload.layout ?? candidate.payload.layout) as CandidatePayload["layout"], rectification: (output.payload.rectification ?? null) as CandidatePayload["rectification"],
        confidence: typeof output.payload.recognitionConfidence === "number" ? output.payload.recognitionConfidence : null, sourceOperationId: output.id,
      })),
    };
    const output = outputs[0]!;
    const merged = output.sources.size > 1;
    const geometryChanged = stableOcrJson(output.payload.geometry) !== stableOcrJson(candidate.payload.geometry);
    const layoutChanged = stableOcrJson(output.payload.layout) !== stableOcrJson(candidate.payload.layout)
      || stableOcrJson(output.payload.rectification ?? null) !== stableOcrJson(candidate.payload.rectification ?? null);
    const text = typeof output.payload.transcription === "string" ? output.payload.transcription : null;
    const status = ocrTranscriptionStatus(output.payload.transcriptionStatus);
    const textChanged = text !== candidate.payload.transcription || status !== candidate.payload.transcriptionStatus;
    return {
      candidateId: candidate.id, state: geometryChanged || layoutChanged || textChanged || merged ? "edited" as const : "accepted" as const,
      sourceOperationId: output.id, finalParent: candidate.payload.suggestedParent,
      ...(geometryChanged || layoutChanged || merged ? { geometry: output.payload.geometry as QuadGeometry, layout: output.payload.layout as CandidatePayload["layout"], rectification: (output.payload.rectification ?? null) as CandidatePayload["rectification"] } : {}),
      ...(textChanged || merged ? { transcription: { text, status } } : {}),
      ...(merged ? { mergeGroupId: `human-${output.id}` } : {}),
    };
  });
  const acceptedById = new Map(accepted.map((node) => [node.id, node]));
  const decomposedNodeIds = new Set(input.editOperations.filter((item) => item.type === "decompose_string").flatMap((item) => item.inputIds));
  const compositions = input.editOperations.flatMap((item) => {
    if (item.type !== "compose_string" || decomposedNodeIds.has(item.operationId)) return [];
    const node = execution.nodes.get(item.operationId); const payload = node?.payload ?? {};
    const memberSourceOperationIds: string[] = Array.isArray(payload.memberNodeIds) ? payload.memberNodeIds.map(String) : [];
    if (memberSourceOperationIds.some((id) => !acceptedById.has(id))) throw new ConflictError("OCR composition may reference final approved regions only");
    return [{ sourceOperationId: item.operationId, memberSourceOperationIds, text: typeof payload.text === "string" ? payload.text : null, transcriptionStatus: ocrTranscriptionStatus(payload.transcriptionStatus), sortOrder: Number(payload.sortOrder ?? 0) }];
  });
  const existingCompositionIds = new Set(compositionRows.map((row) => String(row.id)));
  const decomposeCompositionIds = [...decomposedNodeIds].filter((id) => existingCompositionIds.has(id));
  return reviewParentScopedAutoOcr(source, sourceItemId, { operationId: input.operationId, reviews, compositions, decomposeCompositionIds, editOperations: input.editOperations, reviewActor: "human" });
}

async function loadScope(source: SourceName, sourceItemId: string, scope: Scope) {
  const client = await pool.connect();
  try { return await loadScopeWithClient(client, source, sourceItemId, scope); } finally { client.release(); }
}

async function loadScopeWithClient(client: PoolClient, source: SourceName, sourceItemId: string, scope: Scope) {
  const packageRow = (await client.query(`SELECT package.* FROM meta.annotation_labels label JOIN meta.annotation_packages package ON package.id=label.package_id WHERE label.id=$1 AND package.source=$2 AND package.source_item_id=$3 AND label.deleted_at IS NULL AND package.deleted_at IS NULL`, [scope.id, source, sourceItemId])).rows[0];
  if (!packageRow) throw new NotFoundError("Auto OCR scope not found");
  if(packageRow.legacy_annotation_track_id) {
    const official=await officialTargetForTrack(source,sourceItemId,String(packageRow.legacy_annotation_track_id),client);
    if(official)await verifyOfficialBytes(official);
  }
  const labels = (await client.query(`SELECT * FROM meta.annotation_labels WHERE package_id=$1 AND deleted_at IS NULL ORDER BY created_at,id`, [packageRow.id])).rows;
  const label = labels.find((row) => String(row.id) === scope.id);
  if (!label) throw new NotFoundError("Auto OCR Label scope not found");
  return { package: packageRow, labels, label };
}

async function loadExistingOcr(source: SourceName, sourceItemId: string, packageId: string, labels: Array<Record<string, unknown>>) {
  const rows = (await pool.query(`SELECT ocr.* FROM meta.annotation_ocr ocr JOIN meta.annotation_packages package ON package.id=ocr.package_id
    WHERE ocr.package_id=$1 AND package.source=$2 AND package.source_item_id=$3
      AND ocr.deleted_at IS NULL AND ocr.region_status='reviewed' AND ocr.status<>'rejected'
      AND (ocr.legacy_ocr_region_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM meta.annotation_operation_results result
        JOIN meta.annotation_operations operation ON operation.id=result.operation_id
        WHERE result.entity_type='ocr' AND result.entity_id=ocr.id AND result.deleted_at IS NULL
          AND operation.operation_status='reviewed'
      ))`, [packageId, source, sourceItemId])).rows;
  return rows.flatMap((row) => {
    const label = row.label_id ? labels.find((candidate) => String(candidate.id) === String(row.label_id)) : null;
    if (row.label_id && !label) return [];
    return [{ id: String(row.id), text: String(row.transcription ?? ""), regionStatus: row.region_status === "rejected" ? "rejected" as const : "reviewed" as const,
      transcriptionStatus: row.transcription_status === "verified" || row.transcription_status === "partial" ? row.transcription_status : "unreadable" as const,
      labelId: String(row.label_id), geometry: row.geometry as QuadGeometry,
      sourceGeometry: mapNormalizedQuadToSource(row.geometry as QuadGeometry, label!.geometry as QuadGeometry) }];
  });
}

export function findDuplicateMatches(geometry: QuadGeometry, text: string, existing: Array<{ id: string; text: string; regionStatus: DuplicateMatch["existing"]["regionStatus"]; transcriptionStatus: DuplicateMatch["existing"]["transcriptionStatus"]; labelId: string | null; geometry: QuadGeometry; sourceGeometry: QuadGeometry }>, config: DeduplicationConfig): DuplicateMatch[] {
  const candidateText = normalizeTextForMatching(text, config.normalizeConfusions);
  return existing.map((item) => {
    const geometryScore = geometrySimilarity(geometry, item.sourceGeometry);
    const existingText = normalizeTextForMatching(item.text, config.normalizeConfusions);
    const textScore = candidateText && existingText ? textSimilarity(candidateText, existingText) : null;
    const totalScore = textScore === null ? geometryScore : geometryScore * config.geometryWeight + textScore * config.textWeight;
    const classification: DuplicateClassification = textScore === null
      ? geometryScore >= config.probableThreshold ? "possible_duplicate" : geometryScore >= config.overlapThreshold ? "overlapping" : "unlikely"
      : geometryScore >= config.minimumGeometryScore && totalScore >= config.probableThreshold ? "probable_duplicate"
      : geometryScore >= config.minimumGeometryScore && totalScore >= config.possibleThreshold ? "possible_duplicate"
      : geometryScore >= config.overlapThreshold ? "overlapping" : "unlikely";
    return {
      existingOcrId: item.id,
      geometryScore: roundScore(geometryScore), textScore: textScore === null ? null : roundScore(textScore), totalScore: roundScore(totalScore), classification,
      existing: { transcription: item.text || null, regionStatus: item.regionStatus, transcriptionStatus: item.transcriptionStatus, labelId: item.labelId, geometry: item.geometry },
    };
  }).filter((match) => match.classification !== "unlikely")
    .sort((left, right) => right.totalScore - left.totalScore)
    .slice(0, config.maxMatches);
}

function validateParent(packageId: unknown, labels: Array<Record<string, unknown>>, parent: Parent) {
  if (parent.packageId !== String(packageId)) throw new ConflictError("Final OCR parent must belong to the helper scope Package");
  if (parent.type === "label" && !labels.some((label) => String(label.id) === parent.labelId)) throw new ConflictError("Final OCR Label belongs to another Package");
}

function validateManualCoordinateSpace(parent: Scope, coordinateSpace: OcrCoordinateSpace) {
  if (coordinateSpace.type !== "label-rectified" || coordinateSpace.labelId !== parent.id) throw new ConflictError("OCR preflight requires normalized coordinates for the same Label/VisualRegion");
}

function labelCoordinateSpace(labelId: string, labels: Array<Record<string, unknown>>): OcrCoordinateSpace {
  const label = labels.find((item) => String(item.id) === labelId);
  const geometry = label?.geometry as QuadGeometry;
  const width = Math.max(1, Math.round((distance(geometry.points[0], geometry.points[1]) + distance(geometry.points[3], geometry.points[2])) / 2));
  const height = Math.max(1, Math.round((distance(geometry.points[0], geometry.points[3]) + distance(geometry.points[1], geometry.points[2])) / 2));
  return { type: "label-rectified", units: "normalized", labelId, cropRevision: Number(label?.revision ?? 1), width, height };
}

async function insertCandidateReview(client: PoolClient, operationId: string, candidateId: string, review: { state: string; finalParent?: Parent | null; regionStatus?: string; transcription?: { status: string }; layout?: CandidatePayload["layout"]; rectification?: CandidatePayload["rectification"]; splitOutputs?: unknown[] }, resultId: string | null, geometry: QuadGeometry | null, transcription: string | null, resultIds: string[] = resultId ? [resultId] : []) {
  await client.query(`INSERT INTO meta.annotation_candidate_reviews
    (operation_id,candidate_key,state,final_package_id,final_label_id,result_entity_id,result_entity_ids,reviewed_geometry,reviewed_transcription,reviewed_region_status,reviewed_transcription_status,reviewed_layout,reviewed_rectification)
    VALUES($1,$2,$3,$4,$5,$6,$7::uuid[],$8::jsonb,$9,$10,$11,$12::jsonb,$13::jsonb)`, [operationId, candidateId, review.state,
    review.finalParent?.packageId ?? null, review.finalParent?.labelId ?? null,
    resultId, resultIds, geometry ? JSON.stringify(geometry) : null, transcription, review.regionStatus ?? null, review.transcription?.status ?? null,
    review.layout ? JSON.stringify(review.layout) : null, review.rectification ? JSON.stringify(review.rectification) : null]);
}

function directionAngle(direction: unknown) { return direction === "down" ? 90 : direction === "left" ? 180 : direction === "up" ? -90 : 0; }
function legacyDirection(layout: CandidatePayload["layout"]) { const angle=layout.baselineAngleDeg; return Math.abs(angle)<=45 ? "right" : angle>45&&angle<135 ? "down" : angle<=-45&&angle>-135 ? "up" : "left"; }
function legacyOrientation(layout: CandidatePayload["layout"]) { return layout.characterOrientation === "mixed" ? "mixed" : layout.characterOrientation === "upright" ? "upright" : "clockwise"; }

function legacyStatus(regionStatus: "reviewed" | "rejected", transcriptionStatus: "verified" | "partial" | "unreadable") {
  return regionStatus === "rejected" ? "rejected" : transcriptionStatus === "verified" ? "verified" : transcriptionStatus === "unreadable" ? "unreadable" : "no_transcription";
}

function quadFromBox(box: { x: number; y: number; width: number; height: number }): QuadGeometry {
  return { type: "quad", points: [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }], bbox: box };
}
function unionBboxes(boxes: Array<{ x: number; y: number; width: number; height: number }>) {
  const x = Math.min(...boxes.map((box) => box.x)), y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width)), bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}
function mapNormalizedQuadToSource(quad: QuadGeometry, label: QuadGeometry): QuadGeometry { return geometryFromPoints(quad.points.map((point) => project(label.points, point.x, point.y)) as QuadGeometry["points"]); }
function mapNormalizedQuadToSourceRect(quad: QuadGeometry, rect: { x: number; y: number; width: number; height: number }): QuadGeometry { return geometryFromPoints(quad.points.map((point) => ({ x: rect.x + point.x * rect.width, y: rect.y + point.y * rect.height })) as QuadGeometry["points"]); }
function mapSourceQuadToNormalized(quad: QuadGeometry, labelId: string, labels: Array<Record<string, unknown>>): QuadGeometry {
  const label = labels.find((row) => String(row.id) === labelId)?.geometry as QuadGeometry;
  return geometryFromPoints(quad.points.map((point) => inverseProject(label.points, point)) as QuadGeometry["points"]);
}
function geometryFromPoints(points: QuadGeometry["points"]): QuadGeometry { const xs=points.map((p)=>p.x), ys=points.map((p)=>p.y); return { type:"quad", points, bbox:{ x:Math.min(...xs), y:Math.min(...ys), width:Math.max(...xs)-Math.min(...xs), height:Math.max(...ys)-Math.min(...ys) } }; }
function project(points: QuadGeometry["points"], u: number, v: number) { const [p0,p1,p2,p3]=points; const dx1=p1.x-p2.x,dx2=p3.x-p2.x,sx=p0.x-p1.x+p2.x-p3.x,dy1=p1.y-p2.y,dy2=p3.y-p2.y,sy=p0.y-p1.y+p2.y-p3.y,d=dx1*dy2-dx2*dy1,g=Math.abs(d)<1e-9?0:(sx*dy2-dx2*sy)/d,h=Math.abs(d)<1e-9?0:(dx1*sy-sx*dy1)/d,a=p1.x-p0.x+g*p1.x,b=p3.x-p0.x+h*p3.x,e=p1.y-p0.y+g*p1.y,f=p3.y-p0.y+h*p3.y,s=g*u+h*v+1; return {x:(a*u+b*v+p0.x)/s,y:(e*u+f*v+p0.y)/s}; }
function inverseProject(points: QuadGeometry["points"], target: {x:number;y:number}) { let u=(target.x-Math.min(...points.map(p=>p.x)))/Math.max(1,Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x))),v=(target.y-Math.min(...points.map(p=>p.y)))/Math.max(1,Math.max(...points.map(p=>p.y))-Math.min(...points.map(p=>p.y))); for(let i=0;i<10;i++){const p=project(points,u,v),px=project(points,u+1e-4,v),py=project(points,u,v+1e-4),a=(px.x-p.x)/1e-4,b=(py.x-p.x)/1e-4,c=(px.y-p.y)/1e-4,d=(py.y-p.y)/1e-4,det=a*d-b*c;if(Math.abs(det)<1e-9)break;const ex=target.x-p.x,ey=target.y-p.y;u+=(ex*d-b*ey)/det;v+=(a*ey-ex*c)/det;} return {x:clamp01(u),y:clamp01(v)}; }
function integerRect(rect:{x:number;y:number;width:number;height:number}, maxWidth:number,maxHeight:number){const x=Math.max(0,Math.min(maxWidth-1,Math.floor(rect.x))),y=Math.max(0,Math.min(maxHeight-1,Math.floor(rect.y)));return{x,y,width:Math.max(1,Math.min(maxWidth-x,Math.ceil(rect.width))),height:Math.max(1,Math.min(maxHeight-y,Math.ceil(rect.height)))};}
function pointInPolygon(point:{x:number;y:number},points:Array<{x:number;y:number}>){let inside=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if(((a.y>point.y)!==(b.y>point.y))&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;}
function geometrySimilarity(a:QuadGeometry,b:QuadGeometry){const intersection=bboxIntersection(a.bbox,b.bbox),areaA=Math.max(1,a.bbox.width*a.bbox.height),areaB=Math.max(1,b.bbox.width*b.bbox.height),iou=intersection/Math.max(1,areaA+areaB-intersection),containment=intersection/Math.max(1,Math.min(areaA,areaB));return Math.max(iou,containment*0.92);}
function bboxIntersection(a:{x:number;y:number;width:number;height:number},b:{x:number;y:number;width:number;height:number}){const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),r=Math.min(a.x+a.width,b.x+b.width),bt=Math.min(a.y+a.height,b.y+b.height);return Math.max(0,r-x)*Math.max(0,bt-y);}
function normalizeTextForMatching(value:string,normalizeConfusions:boolean){let normalized=value.normalize("NFKC").trim().toLocaleLowerCase("ru").replace(/[^\p{L}\p{N}]+/gu," ").replace(/\s+/g," ");if(normalizeConfusions)normalized=normalized.replace(/0/g,"o").replace(/[1l]/g,"i");return normalized;}
function textSimilarity(a:string,b:string){if(a===b)return 1;const longest=Math.max(a.length,b.length);if(!longest)return 1;return 1-levenshtein(a,b)/longest;}
function levenshtein(a:string,b:string){const previous=Array.from({length:b.length+1},(_,index)=>index);for(let i=1;i<=a.length;i++){let diagonal=previous[0];previous[0]=i;for(let j=1;j<=b.length;j++){const above=previous[j],cost=a[i-1]===b[j-1]?0:1;previous[j]=Math.min(previous[j]+1,previous[j-1]+1,diagonal+cost);diagonal=above;}}return previous[b.length];}
function resolveDeduplicationConfig(value:unknown):DeduplicationConfig{const record=value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};const bounded=(key:keyof DeduplicationConfig,fallback:number,min:number,max:number)=>typeof record[key]==="number"&&Number.isFinite(record[key])?Math.max(min,Math.min(max,Number(record[key]))):fallback;const geometryWeight=bounded("geometryWeight",DEFAULT_DEDUPLICATION_CONFIG.geometryWeight,0,1),textWeight=bounded("textWeight",DEFAULT_DEDUPLICATION_CONFIG.textWeight,0,1),weightSum=Math.max(0.0001,geometryWeight+textWeight),possible=bounded("possibleThreshold",DEFAULT_DEDUPLICATION_CONFIG.possibleThreshold,0,1),probable=bounded("probableThreshold",DEFAULT_DEDUPLICATION_CONFIG.probableThreshold,0,1);return{geometryWeight:geometryWeight/weightSum,textWeight:textWeight/weightSum,possibleThreshold:Math.min(possible,probable),probableThreshold:Math.max(possible,probable),overlapThreshold:bounded("overlapThreshold",DEFAULT_DEDUPLICATION_CONFIG.overlapThreshold,0,1),minimumGeometryScore:bounded("minimumGeometryScore",DEFAULT_DEDUPLICATION_CONFIG.minimumGeometryScore,0,1),normalizeConfusions:typeof record.normalizeConfusions==="boolean"?record.normalizeConfusions:DEFAULT_DEDUPLICATION_CONFIG.normalizeConfusions,maxMatches:Math.round(bounded("maxMatches",DEFAULT_DEDUPLICATION_CONFIG.maxMatches,1,20))};}
function roundScore(value:number){return Math.round(value*10_000)/10_000;}
function stableOcrJson(value: unknown) { return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item); }
function ocrTranscriptionStatus(value: unknown): "verified" | "partial" | "unreadable" { return value === "verified" || value === "partial" ? value : "unreadable"; }
function distance(a:{x:number;y:number},b:{x:number;y:number}){return Math.hypot(b.x-a.x,b.y-a.y);}
function clamp01(value:number){return Math.max(0,Math.min(1,value));}
async function persistLabelViewer(operationId:string,crop:{buffer:Buffer;width:number;height:number},labelRevision:number){const assetPath=`label-analysis/graph-ocr/${operationId}.webp`;const localPath=resolveGeneratedAssetPath(assetPath);if(!localPath)throw new ConflictError("Auto OCR viewer asset path is invalid");await mkdir(path.dirname(localPath),{recursive:true});await writeFile(localPath,crop.buffer);return{assetPath,width:crop.width,height:crop.height,coordinateSpace:"label-rectified" as const,labelRevision};}
async function transaction<T>(work:(client:PoolClient)=>Promise<T>){const client=await pool.connect();try{await client.query("BEGIN");const result=await work(client);await client.query("COMMIT");return result;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
