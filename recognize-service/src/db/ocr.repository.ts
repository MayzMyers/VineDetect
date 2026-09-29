import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pool } from "./pool.js";
import type { SourceName } from "../shared/types.js";
import { resolveGeneratedAssetPath, resolveLocalAssetPath } from "../modules/recognize-node/assets.js";
import { OCR_CASCADE_PROFILE_VERSION, runStandardOcrOnCrop } from "../modules/ocr/standardOcr.js";
import { normalizeOcrText } from "../modules/ocr/normalize.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import type { OcrCascadeEvidence, StandardOcrResult } from "../modules/ocr/standardOcr.js";
import type { PoolClient } from "pg";
import { normalizeQuadGeometry, sameQuad, type QuadGeometry } from "../shared/quadGeometry.js";
import { createRectifiedLabelCrop } from "../modules/label-analysis/labelQuadCrop.js";
import type { GraphOcrAnnotation } from "../shared/annotationGraphContract.js";
import { normalizeLabelRectification } from "../shared/labelRectificationContract.js";

export type OcrSnapshotDto = {
  crop: {
    id: string;
    bbox: Record<string, unknown>;
    geometry: QuadGeometry;
    width: number | null;
    height: number | null;
    assetPath: string | null;
    createdAt: string;
  };
  ocr: {
    id: string;
    executionMode: string;
    engine: string;
    engineVersion: string | null;
    configHash: string | null;
    rawText: string;
    normalizedText: string;
    confidence: number | null;
    status: string;
    runtimeMs: number | null;
    error: string | null;
    analysisJobId: string | null;
    evidence: OcrCascadeEvidence | null;
    createdAt: string;
  };
  regions: OcrRegionDto[];
};

export type OcrTextReviewDto = {
  id: string;
  source: string;
  sourceItemId: string;
  ocrRunId: string | null;
  text: string;
  normalizedText: string;
  status: string;
  sourceKind: string;
  revision: number;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OcrRegionDto = {
  id: string;
  parentId: string | null;
  level: string;
  bbox: Record<string, unknown>;
  geometry: QuadGeometry;
  rawText: string;
  normalizedText: string;
  confidence: number | null;
  reviewStatus: string;
  textDirection: string;
  glyphOrientation: string;
  createdAt: string;
};

export type OcrRegionReviewDto = {
  id: string;
  source: string;
  sourceItemId: string;
  ocrRunId: string | null;
  revision: number;
  status: string;
  reviewedBy: string | null;
  createdAt: string;
  compositions: OcrStringComposition[];
  reviewOperations: OcrReviewOperation[];
  regions: Array<{
    id: string;
    sourceRegionIds: string[];
    level: string;
    bbox: Record<string, unknown>;
    geometry: QuadGeometry;
    text: string | null;
    normalizedText: string | null;
    transcriptionStatus: "verified" | "partial" | "unreadable";
    prediction: { bbox: Record<string, unknown>; geometry: QuadGeometry; text: string | null; confidence: number | null; layout: GraphOcrAnnotation["layout"]; rectification: GraphOcrAnnotation["rectification"] } | null;
    annotation: { bbox: Record<string, unknown>; geometry: QuadGeometry; text: string | null; transcriptionStatus: "verified" | "partial" | "unreadable" };
    bboxEdited: boolean;
    textEdited: boolean;
    detectionGt: true;
    recognitionGt: boolean;
    source: "manual" | "auto" | "partially-corrected" | "fully-corrected";
    status: string;
    sourceKind: string;
    textDirection: string;
    glyphOrientation: string;
    layout: GraphOcrAnnotation["layout"];
    rectification: GraphOcrAnnotation["rectification"];
    sortOrder: number;
  }>;
};

export type OcrStringComposition = {
  id: string;
  kind: "string";
  memberIds: string[];
  text: string | null;
  transcriptionStatus: "verified" | "partial" | "unreadable";
  sortOrder: number;
};

export type OcrReviewOperation = {
  id: string;
  type: "approve_region" | "approve_text" | "reject" | "edit_region" | "edit_text" | "merge_region" | "split_region" | "create_region" | "compose_string";
  inputIds: string[];
  outputIds: string[];
  actor: "human";
};

export async function getLatestOcrRegionReview(
  source: SourceName,
  sourceItemId: string,
  annotationTrackId: string,
): Promise<OcrRegionReviewDto | null> {
  const result = await pool.query(
    `
    SELECT *
    FROM meta.ocr_region_annotation_sets
    WHERE source = $1 AND source_item_id = $2 AND annotation_track_id = $3
    ORDER BY revision DESC
    LIMIT 1
    `,
    [source, sourceItemId, annotationTrackId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToRegionReview(row, await listReviewedOcrRegions(String(row.id)));
}

export async function putOcrRegionReview(
  source: SourceName,
  sourceItemId: string,
  annotationTrackId: string,
  input: {
    baseRevision: number;
    ocrRunId?: string | null;
    status: string;
    reviewedBy?: string;
    regions: Array<{
      clientId?: string;
      sourceRegionIds: string[];
      level: string;
      prediction: { bbox: Record<string, number>; geometry?: QuadGeometry; text: string | null; confidence?: number | null; layout?: GraphOcrAnnotation["layout"]; rectification?: GraphOcrAnnotation["rectification"] } | null;
      annotation: { bbox: Record<string, number>; geometry?: QuadGeometry; text: string | null; transcriptionStatus: "verified" | "partial" | "unreadable" };
      textDirection: string;
      glyphOrientation: string;
      layout?: GraphOcrAnnotation["layout"];
      rectification?: GraphOcrAnnotation["rectification"];
      sortOrder?: number;
    }>;
    compositions?: Array<{
      clientId: string;
      kind: "string";
      memberClientIds: string[];
      text: string | null;
      transcriptionStatus: "verified" | "partial" | "unreadable";
      sortOrder?: number;
    }>;
  },
): Promise<OcrRegionReviewDto> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${annotationTrackId}:ocr-regions`]);
    const currentResult = await client.query(
      `
      SELECT revision
      FROM meta.ocr_region_annotation_sets
      WHERE annotation_track_id = $1
      ORDER BY revision DESC
      LIMIT 1
      FOR UPDATE
      `,
      [annotationTrackId],
    );
    const currentRevision = Number(currentResult.rows[0]?.revision ?? 0);
    if (input.baseRevision !== currentRevision) {
      throw new ConflictError(`OCR region revision conflict: expected ${input.baseRevision}, current ${currentRevision}`);
    }

    if (input.ocrRunId) {
      const run = await client.query(
        `SELECT id FROM meta.ocr_runs WHERE id = $1 AND source = $2 AND source_item_id = $3 AND annotation_track_id = $4`,
        [input.ocrRunId, source, sourceItemId, annotationTrackId],
      );
      if (!run.rowCount) throw new NotFoundError("OCR run not found for source item");
    }

    const sourceRegionIds = [...new Set(input.regions.flatMap((region) => region.sourceRegionIds))];
    let autoRegionIds: string[] = [];
    if (sourceRegionIds.length) {
      if (!input.ocrRunId) throw new ConflictError("sourceRegionIds require ocrRunId");
      const sourceRegions = await client.query(
        `SELECT id FROM meta.ocr_regions WHERE ocr_run_id = $1 AND id = ANY($2::uuid[])`,
        [input.ocrRunId, sourceRegionIds],
      );
      if (sourceRegions.rowCount !== sourceRegionIds.length) {
        throw new ConflictError("One or more source OCR regions do not belong to the selected OCR run");
      }
      const allSourceRegions = await client.query(`SELECT id FROM meta.ocr_regions WHERE ocr_run_id = $1`, [input.ocrRunId]);
      autoRegionIds = allSourceRegions.rows.map((item) => String(item.id));
    } else if (input.ocrRunId) {
      const allSourceRegions = await client.query(`SELECT id FROM meta.ocr_regions WHERE ocr_run_id = $1`, [input.ocrRunId]);
      autoRegionIds = allSourceRegions.rows.map((item) => String(item.id));
    }

    const setId = randomUUID();
    const revision = currentRevision + 1;
    const setResult = await client.query(
      `
      INSERT INTO meta.ocr_region_annotation_sets (
        id, source, source_item_id, annotation_track_id, ocr_run_id, revision, status, reviewed_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [setId, source, sourceItemId, annotationTrackId, input.ocrRunId ?? null, revision, input.status, input.reviewedBy ?? null],
    );

    const insertedRegions: Record<string, unknown>[] = [];
    const regionIdByClientId = new Map<string, string>();
    const finalUseBySourceId = new Map<string, number>();
    for (const region of input.regions) for (const sourceId of region.sourceRegionIds) {
      finalUseBySourceId.set(sourceId, (finalUseBySourceId.get(sourceId) ?? 0) + 1);
    }
    for (const [index, region] of input.regions.entries()) {
      const annotationGeometry = normalizeQuadGeometry(region.annotation.geometry, region.annotation.bbox);
      const predictionGeometry = region.prediction ? normalizeQuadGeometry(region.prediction.geometry, region.prediction.bbox) : null;
      if (!annotationGeometry || (region.prediction && !predictionGeometry)) {
        throw new ConflictError("OCR region geometry must be a valid convex quad");
      }
      const layout = region.layout ?? legacyLayout(region.level, region.textDirection, region.glyphOrientation);
      const inserted = await client.query(
        `
        INSERT INTO meta.ocr_region_annotations (
          id, annotation_set_id, source_region_ids, level, bbox, geometry, text,
          normalized_text, transcription_status, status, source_kind, sort_order, text_direction, glyph_orientation,
          layout_flow, baseline_angle_deg, layout_baseline, character_orientation, rectification,
          prediction_bbox, prediction_geometry, prediction_text, prediction_confidence, prediction_layout, prediction_rectification
        )
        VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7, $8, $9, 'reviewed', $10, $11, $12, $13,
          $14, $15, $16::jsonb, $17, $18::jsonb, $19, $20, $21, $22, $23::jsonb, $24::jsonb)
        RETURNING *
        `,
        [
          randomUUID(),
          setId,
          region.sourceRegionIds,
          region.level,
          JSON.stringify(annotationGeometry.bbox),
          JSON.stringify(annotationGeometry),
          region.annotation.text,
          region.annotation.text === null ? null : normalizeOcrText(region.annotation.text),
          region.annotation.transcriptionStatus,
          region.sourceRegionIds.length > 1
            ? "merged"
            : region.sourceRegionIds.some((id) => (finalUseBySourceId.get(id) ?? 0) > 1)
              ? "split"
              : derivedRegionSource(region.prediction, region.annotation),
          region.sortOrder ?? index,
          region.textDirection,
          region.glyphOrientation,
          layout.flow,
          layout.baselineAngleDeg,
          layout.baseline ? JSON.stringify(layout.baseline) : null,
          layout.characterOrientation,
          region.rectification ? JSON.stringify(region.rectification) : null,
          predictionGeometry ? JSON.stringify(predictionGeometry.bbox) : null,
          predictionGeometry ? JSON.stringify(predictionGeometry) : null,
          region.prediction?.text ?? null,
          region.prediction?.confidence ?? null,
          region.prediction?.layout ? JSON.stringify(region.prediction.layout) : null,
          region.prediction?.rectification ? JSON.stringify(region.prediction.rectification) : null,
        ],
      );
      insertedRegions.push(inserted.rows[0] as Record<string, unknown>);
      regionIdByClientId.set(region.clientId ?? `region:${index}`, String(inserted.rows[0]?.id));
    }
    const reviewedRegions = insertedRegions.map(rowToReviewedRegion);
    const compositions = (input.compositions ?? []).map((composition, index): OcrStringComposition => {
      const memberIds = composition.memberClientIds.map((id) => regionIdByClientId.get(id));
      if (memberIds.some((id) => !id)) throw new ConflictError("OCR string composition references an unknown reviewed region");
      return {
        id: randomUUID(), kind: "string", memberIds: memberIds as string[], text: composition.text,
        transcriptionStatus: composition.transcriptionStatus, sortOrder: composition.sortOrder ?? index,
      };
    });
    const reviewOperations = deriveOcrReviewOperations(reviewedRegions, autoRegionIds, compositions);
    await client.query(
      `UPDATE meta.ocr_region_annotation_sets SET compositions = $2::jsonb, review_operations = $3::jsonb WHERE id = $1`,
      [setId, JSON.stringify(compositions), JSON.stringify(reviewOperations)],
    );
    if (input.status === "reviewed") {
      const reviewedText = aggregateReviewedRegionText(input.regions);
      await insertOcrTextReview(client, source, sourceItemId, annotationTrackId, {
        text: reviewedText,
        ocrRunId: input.ocrRunId ?? null,
        sourceKind: input.regions.some((region) => derivedRegionSource(region.prediction, region.annotation) !== "accepted-generated")
          ? "corrected-generated"
          : "accepted-generated",
        status: reviewedText ? "reviewed" : "empty",
        reviewedBy: input.reviewedBy ?? null,
      });
    }
    await client.query("COMMIT");
    return rowToRegionReview(
      setResult.rows[0] as Record<string, unknown>,
      reviewedRegions,
      compositions,
      reviewOperations,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getLatestOcrTextReview(source: SourceName, sourceItemId: string, annotationTrackId: string): Promise<OcrTextReviewDto | null> {
  const result = await pool.query(
    `
    SELECT *
    FROM meta.ocr_text_annotations
    WHERE source = $1 AND source_item_id = $2 AND annotation_track_id = $3
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [source, sourceItemId, annotationTrackId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToTextReview(row) : null;
}

export async function putOcrTextReview(
  source: SourceName,
  sourceItemId: string,
  annotationTrackId: string,
  input: {
    text: string;
    ocrRunId?: string | null;
    sourceKind?: string;
    status?: string;
    reviewedBy?: string | null;
  },
): Promise<OcrTextReviewDto> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const review = await insertOcrTextReview(client, source, sourceItemId, annotationTrackId, input);
    await client.query("COMMIT");
    return review;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertOcrTextReview(
  client: PoolClient,
  source: SourceName,
  sourceItemId: string,
  annotationTrackId: string,
  input: {
    text: string;
    ocrRunId?: string | null;
    sourceKind?: string;
    status?: string;
    reviewedBy?: string | null;
  },
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${annotationTrackId}:ocr-text`]);
  const current = await client.query(
    `SELECT revision FROM meta.ocr_text_annotations
     WHERE annotation_track_id = $1
     ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
    [annotationTrackId],
  );
  const result = await client.query(
    `
    INSERT INTO meta.ocr_text_annotations (
      id, source, source_item_id, annotation_track_id, ocr_run_id, text, normalized_text,
      status, source_kind, revision, reviewed_by
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
    `,
    [
      randomUUID(),
      source,
      sourceItemId,
      annotationTrackId,
      input.ocrRunId ?? null,
      input.text,
      normalizeOcrText(input.text),
      input.status ?? "reviewed",
      input.sourceKind ?? "manual",
      Number(current.rows[0]?.revision ?? 0) + 1,
      input.reviewedBy ?? null,
    ],
  );
  return rowToTextReview(result.rows[0] as Record<string, unknown>);
}

function aggregateReviewedRegionText(regions: Array<{
  level: string;
  annotation: { bbox: Record<string, number>; text: string | null; transcriptionStatus: string };
}>) {
  const reviewed = regions.flatMap((region) => region.annotation.transcriptionStatus === "verified" && region.annotation.text?.trim()
    ? [{ ...region, bbox: region.annotation.bbox, text: region.annotation.text }]
    : []);
  return reviewed.filter((region) => region.level !== "word" || !reviewed.some((container) => {
    if (container === region || container.level === "word") return false;
    const containerText = normalizeOcrText(container.text);
    const wordText = normalizeOcrText(region.text);
    return containerText.split(/[\s-]+/).includes(wordText)
      && bboxOverlapOverSmaller(container.bbox, region.bbox) >= 0.65;
  })).map((region) => region.text.trim()).join("\n");
}

function bboxOverlapOverSmaller(left: Record<string, number>, right: Record<string, number>) {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = width * height;
  return intersection / Math.max(0.000001, Math.min(left.width * left.height, right.width * right.height));
}

export async function getLatestOcrSnapshot(source: SourceName, sourceItemId: string, annotationTrackId: string): Promise<OcrSnapshotDto | null> {
  const result = await pool.query(
    `
    SELECT
      r.*,
      c.bbox AS crop_bbox,
      c.geometry AS crop_geometry,
      c.width AS crop_width,
      c.height AS crop_height,
      c.asset_path AS crop_asset_path,
      c.created_at AS crop_created_at
    FROM meta.ocr_runs AS r
    LEFT JOIN meta.label_crops AS c ON c.id = r.crop_id
    WHERE r.source = $1 AND r.source_item_id = $2 AND r.annotation_track_id = $3
    ORDER BY r.created_at DESC
    LIMIT 1
    `,
    [source, sourceItemId, annotationTrackId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToSnapshot(row, await listOcrRegions(String(row.id)));
}

export async function createBackendOcrSnapshot(source: SourceName, sourceItemId: string, annotationTrackId: string, imageUrl: string | null): Promise<OcrSnapshotDto> {
  const annotation = await getLatestReviewedAnnotation(source, sourceItemId, annotationTrackId);
  const geometry = annotation?.geometry ?? (await getLatestGeneratedGeometry(source, sourceItemId, annotationTrackId));
  if (!geometry) throw new Error("No label geometry available for OCR");

  const cropId = randomUUID();
  const ocrId = randomUUID();
  const localPath = imageUrl ? resolveLocalAssetPath(imageUrl) : null;
  if (!localPath) throw new Error("No local image available for OCR");
  const numericBbox = toNumericBbox(geometry.bbox);
  const relativePath = `label-ocr/${source}/${safeSegment(sourceItemId)}/${ocrId}.webp`;
  const cropPath = resolveGeneratedAssetPath(relativePath);
  if (!cropPath) throw new Error("Invalid standalone OCR crop artifact path");
  await mkdir(path.dirname(cropPath), { recursive: true });
  const cropSize = await createRectifiedLabelCrop(localPath, cropPath, numericBbox, geometry, annotation?.rectification);
  const ocrResult = await runStandardOcrOnCrop({ imagePath: cropPath, bbox: { x: 0, y: 0, width: cropSize.width, height: cropSize.height } });
  const configHash = createHash("sha1")
    .update(JSON.stringify({ source, sourceItemId, geometry, engine: ocrResult.engine, version: ocrResult.engineVersion, profile: OCR_CASCADE_PROFILE_VERSION }))
    .digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const crop = await client.query(
      `
      INSERT INTO meta.label_crops (
        id, source, source_item_id, annotation_track_id, image_url, annotation_id, annotation_revision,
        bbox, geometry, padding, width, height, asset_path
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12)
      RETURNING *
      `,
      [
        cropId,
        source,
        sourceItemId,
        annotationTrackId,
        imageUrl,
        annotation?.id ?? null,
        annotation?.revision ?? null,
        JSON.stringify(numericBbox),
        JSON.stringify(geometry),
        cropSize.width,
        cropSize.height,
        relativePath,
      ],
    );
    const ocr = await client.query(
      `
      INSERT INTO meta.ocr_runs (
        id, source, source_item_id, annotation_track_id, crop_id, execution_mode, engine, engine_version,
        config_hash, raw_text, normalized_text, confidence, status, runtime_ms, evidence
      )
      VALUES ($1, $2, $3, $4, $5, 'backend-cascade-v6', $6, $7, $8, $9, $10, $11, 'completed', $12, $13::jsonb)
      RETURNING *
      `,
      [
        ocrId,
        source,
        sourceItemId,
        annotationTrackId,
        cropId,
        ocrResult.engine,
        ocrResult.engineVersion,
        configHash,
        ocrResult.rawText,
        ocrResult.normalizedText,
        ocrResult.confidence,
        ocrResult.runtimeMs,
        JSON.stringify(ocrResult.evidence),
      ],
    );
    const regionRows = await insertGeneratedOcrRegions(client, ocrId, ocrResult);
    await client.query("COMMIT");
    return rowToSnapshot({
      ...ocr.rows[0],
      crop_bbox: crop.rows[0].bbox,
      crop_geometry: crop.rows[0].geometry,
      crop_width: crop.rows[0].width,
      crop_height: crop.rows[0].height,
      crop_asset_path: crop.rows[0].asset_path,
      crop_created_at: crop.rows[0].created_at,
    }, regionRows.map(rowToRegion));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getOcrSnapshotForAnalysisJob(analysisJobId: string): Promise<OcrSnapshotDto | null> {
  const result = await pool.query(
    `SELECT r.*, c.bbox AS crop_bbox, c.geometry AS crop_geometry, c.width AS crop_width, c.height AS crop_height,
            c.asset_path AS crop_asset_path, c.created_at AS crop_created_at
     FROM meta.ocr_runs r LEFT JOIN meta.label_crops c ON c.id = r.crop_id
     WHERE r.analysis_job_id = $1 LIMIT 1`,
    [analysisJobId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToSnapshot(row, await listOcrRegions(String(row.id))) : null;
}

export async function createLabelAnalysisOcrSnapshot(input: {
  source: SourceName;
  sourceItemId: string;
  annotationTrackId: string;
  sourceImage: string;
  annotationId: string;
  annotationRevision: number;
  bbox: { x: number; y: number; width: number; height: number };
  geometry?: QuadGeometry;
  cropWidth?: number;
  cropHeight?: number;
  cropPath: string;
  cropAssetPath: string;
  analysisJobId: string;
}): Promise<OcrSnapshotDto> {
  const existing = await getOcrSnapshotForAnalysisJob(input.analysisJobId);
  if (existing) return existing;
  const cropWidth = input.cropWidth ?? input.bbox.width;
  const cropHeight = input.cropHeight ?? input.bbox.height;
  const ocrResult = await runStandardOcrOnCrop({
    imagePath: input.cropPath,
    bbox: { x: 0, y: 0, width: cropWidth, height: cropHeight },
  });
  const cropId = randomUUID();
  const ocrId = randomUUID();
  const configHash = createHash("sha256").update(JSON.stringify({
    executionMode: "label-analysis-cascade-v6", engine: ocrResult.engine, engineVersion: ocrResult.engineVersion,
  })).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const crop = await client.query(
      `INSERT INTO meta.label_crops (
         id, source, source_item_id, annotation_track_id, image_url, annotation_id, annotation_revision,
         bbox, geometry, padding, width, height, asset_path
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$11,$12) RETURNING *`,
      [cropId, input.source, input.sourceItemId, input.annotationTrackId, input.sourceImage, input.annotationId, input.annotationRevision,
       JSON.stringify(input.bbox), input.geometry ? JSON.stringify(input.geometry) : null, cropWidth, cropHeight, input.cropAssetPath],
    );
    const ocr = await client.query(
      `INSERT INTO meta.ocr_runs (
         id, source, source_item_id, annotation_track_id, crop_id, analysis_job_id, execution_mode, engine, engine_version,
         config_hash, raw_text, normalized_text, confidence, status, runtime_ms, evidence
       ) VALUES ($1,$2,$3,$4,$5,$6,'label-analysis-cascade-v6',$7,$8,$9,$10,$11,$12,'completed',$13,$14::jsonb) RETURNING *`,
      [ocrId, input.source, input.sourceItemId, input.annotationTrackId, cropId, input.analysisJobId, ocrResult.engine, ocrResult.engineVersion,
       configHash, ocrResult.rawText, ocrResult.normalizedText, ocrResult.confidence, ocrResult.runtimeMs,
       JSON.stringify(ocrResult.evidence)],
    );
    const regionRows = await insertGeneratedOcrRegions(client, ocrId, ocrResult);
    await client.query("COMMIT");
    return rowToSnapshot({
      ...ocr.rows[0], crop_bbox: crop.rows[0].bbox, crop_geometry: crop.rows[0].geometry, crop_width: crop.rows[0].width,
      crop_height: crop.rows[0].height, crop_asset_path: crop.rows[0].asset_path,
      crop_created_at: crop.rows[0].created_at,
    }, regionRows.map(rowToRegion));
  } catch (error) {
    await client.query("ROLLBACK");
    const raced = await getOcrSnapshotForAnalysisJob(input.analysisJobId);
    if (raced) return raced;
    throw error;
  } finally { client.release(); }
}

async function insertGeneratedOcrRegions(client: PoolClient, ocrId: string, ocrResult: StandardOcrResult) {
  const rows: Record<string, unknown>[] = [];
  const ids = new Map(ocrResult.regions.map((region) => [region.key, randomUUID()]));
  const regionsByKey = new Map(ocrResult.regions.map((region) => [region.key, region]));
  const insertedKeys = new Set<string>();
  const pending = [...ocrResult.regions];

  while (pending.length) {
    let insertIndex = pending.findIndex((region) => !region.parentKey
      || !regionsByKey.has(region.parentKey)
      || insertedKeys.has(region.parentKey));
    if (insertIndex < 0) insertIndex = 0;
    const [region] = pending.splice(insertIndex, 1);
    const parentId = region.parentKey && insertedKeys.has(region.parentKey)
      ? ids.get(region.parentKey) ?? null
      : null;
    const geometry = normalizeQuadGeometry(null, region.bbox);
    if (!geometry) throw new Error(`OCR generated region ${region.key} has no valid bbox`);
    const inserted = await client.query(
      `INSERT INTO meta.ocr_regions (
         id, ocr_run_id, parent_id, level, bbox, geometry, raw_text, normalized_text, confidence, review_status,
         text_direction, glyph_orientation
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'generated',$10,$11) RETURNING *`,
      [ids.get(region.key), ocrId, parentId, region.level,
       JSON.stringify(geometry.bbox), JSON.stringify(geometry), region.rawText, region.normalizedText, region.confidence,
       region.textDirection, region.glyphOrientation],
    );
    rows.push(inserted.rows[0] as Record<string, unknown>);
    insertedKeys.add(region.key);
  }
  return rows;
}

async function listOcrRegions(ocrRunId: string): Promise<OcrRegionDto[]> {
  const result = await pool.query(
    `
    SELECT *
    FROM meta.ocr_regions
    WHERE ocr_run_id = $1
    ORDER BY created_at ASC, id ASC
    `,
    [ocrRunId],
  );
  return result.rows.map((row) => rowToRegion(row as Record<string, unknown>));
}

async function listReviewedOcrRegions(annotationSetId: string) {
  const result = await pool.query(
    `
    SELECT *
    FROM meta.ocr_region_annotations
    WHERE annotation_set_id = $1
    ORDER BY sort_order ASC, id ASC
    `,
    [annotationSetId],
  );
  return result.rows.map((row) => rowToReviewedRegion(row as Record<string, unknown>));
}

async function getLatestReviewedAnnotation(source: SourceName, sourceItemId: string, annotationTrackId: string) {
  const result = await pool.query(
    `
    SELECT id, bbox, geometry, rectification, revision
    FROM meta.image_annotations
    WHERE source = $1
      AND source_item_id = $2
      AND annotation_track_id = $3
      AND annotation_type = 'label-bbox'
      AND status = 'reviewed'
      AND bbox IS NOT NULL
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [source, sourceItemId, annotationTrackId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const geometry = normalizeQuadGeometry(row.geometry, row.bbox);
  if (!geometry) return null;
  return {
    id: String(row.id),
    bbox: geometry.bbox,
    geometry,
    rectification: normalizeLabelRectification(row.rectification),
    revision: numberValue(row.revision),
  };
}

async function getLatestGeneratedGeometry(source: SourceName, sourceItemId: string, annotationTrackId: string) {
  const proposal = await pool.query(
    `
    SELECT bbox, geometry
    FROM meta.detection_proposals
    WHERE source = $1 AND source_item_id = $2 AND annotation_track_id = $3 AND bbox IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [source, sourceItemId, annotationTrackId],
  );
  const proposalGeometry = normalizeQuadGeometry(proposal.rows[0]?.geometry, proposal.rows[0]?.bbox);
  if (proposalGeometry) return proposalGeometry;

  const metadata = await pool.query(
    `
    SELECT annotations, visual_features
    FROM meta.annotation_track_states
    WHERE annotation_track_id = $1
    LIMIT 1
    `,
    [annotationTrackId],
  );
  const row = metadata.rows[0] as Record<string, unknown> | undefined;
  const legacy = objectValue(objectValue(row?.annotations)?.labelAnnotation);
  const legacyBbox = objectValue(objectValue(legacy?.reviewed)?.bbox) ?? objectValue(objectValue(legacy?.generated)?.bbox);
  if (legacyBbox) return normalizeQuadGeometry(null, legacyBbox);
  return null;
}

function rowToSnapshot(row: Record<string, unknown>, regions: OcrRegionDto[]): OcrSnapshotDto {
  const cropGeometry = normalizeQuadGeometry(row.crop_geometry, row.crop_bbox);
  if (!cropGeometry) throw new Error(`OCR crop ${String(row.crop_id ?? "unknown")} has no valid geometry`);
  return {
    crop: {
      id: String(row.crop_id ?? ""),
      bbox: cropGeometry.bbox,
      geometry: cropGeometry,
      width: numberValue(row.crop_width),
      height: numberValue(row.crop_height),
      assetPath: stringValue(row.crop_asset_path),
      createdAt: dateString(row.crop_created_at),
    },
    ocr: {
      id: String(row.id),
      executionMode: stringValue(row.execution_mode) ?? "backend-standard",
      engine: stringValue(row.engine) ?? "unknown",
      engineVersion: stringValue(row.engine_version),
      configHash: stringValue(row.config_hash),
      rawText: stringValue(row.raw_text) ?? "",
      normalizedText: stringValue(row.normalized_text) ?? "",
      confidence: numberValue(row.confidence),
      status: stringValue(row.status) ?? "completed",
      runtimeMs: numberValue(row.runtime_ms),
      error: stringValue(row.error),
      analysisJobId: stringValue(row.analysis_job_id),
      evidence: cascadeEvidenceValue(row.evidence),
      createdAt: dateString(row.created_at),
    },
    regions,
  };
}

function rowToRegion(row: Record<string, unknown>): OcrRegionDto {
  const geometry = normalizeQuadGeometry(row.geometry, row.bbox);
  if (!geometry) throw new Error(`OCR region ${String(row.id)} has no valid geometry`);
  return {
    id: String(row.id),
    parentId: stringValue(row.parent_id),
    level: stringValue(row.level) ?? "word",
    bbox: geometry.bbox,
    geometry,
    rawText: stringValue(row.raw_text) ?? "",
    normalizedText: stringValue(row.normalized_text) ?? "",
    confidence: numberValue(row.confidence),
    reviewStatus: stringValue(row.review_status) ?? "generated",
    textDirection: stringValue(row.text_direction) ?? "right",
    glyphOrientation: stringValue(row.glyph_orientation) ?? "upright",
    createdAt: dateString(row.created_at),
  };
}

function rowToTextReview(row: Record<string, unknown>): OcrTextReviewDto {
  return {
    id: String(row.id),
    source: stringValue(row.source) ?? "",
    sourceItemId: stringValue(row.source_item_id) ?? "",
    ocrRunId: stringValue(row.ocr_run_id),
    text: stringValue(row.text) ?? "",
    normalizedText: stringValue(row.normalized_text) ?? "",
    status: stringValue(row.status) ?? "reviewed",
    sourceKind: stringValue(row.source_kind) ?? "manual",
    revision: numberValue(row.revision) ?? 1,
    reviewedBy: stringValue(row.reviewed_by),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
  };
}

function rowToRegionReview(
  row: Record<string, unknown>,
  regions: OcrRegionReviewDto["regions"],
  compositions = ocrCompositionsValue(row.compositions),
  reviewOperations = ocrReviewOperationsValue(row.review_operations),
): OcrRegionReviewDto {
  return {
    id: String(row.id),
    source: stringValue(row.source) ?? "",
    sourceItemId: stringValue(row.source_item_id) ?? "",
    ocrRunId: stringValue(row.ocr_run_id),
    revision: numberValue(row.revision) ?? 1,
    status: stringValue(row.status) ?? "reviewed",
    reviewedBy: stringValue(row.reviewed_by),
    createdAt: dateString(row.created_at),
    compositions,
    reviewOperations,
    regions,
  };
}

function rowToReviewedRegion(row: Record<string, unknown>): OcrRegionReviewDto["regions"][number] {
  const geometry = normalizeQuadGeometry(row.geometry, row.bbox);
  if (!geometry) throw new Error(`Reviewed OCR region ${String(row.id)} has no valid geometry`);
  const bbox = geometry.bbox;
  const transcriptionStatus = transcriptionStatusValue(row.transcription_status);
  const text = transcriptionStatus === "unreadable" ? null : stringValue(row.text);
  const predictionGeometry = normalizeQuadGeometry(row.prediction_geometry, row.prediction_bbox);
  const prediction = predictionGeometry ? { bbox: predictionGeometry.bbox, geometry: predictionGeometry, text: stringValue(row.prediction_text), confidence: numberValue(row.prediction_confidence), layout: layoutValue(row.prediction_layout, legacyLayout(row.level, row.text_direction, row.glyph_orientation)), rectification: rectificationValue(row.prediction_rectification) } : null;
  const bboxEdited = Boolean(prediction && !sameQuad(prediction.geometry, geometry));
  const textEdited = Boolean(prediction && prediction.text !== text);
  return {
    id: String(row.id),
    sourceRegionIds: Array.isArray(row.source_region_ids)
      ? row.source_region_ids.filter((value): value is string => typeof value === "string")
      : [],
    level: stringValue(row.level) ?? "word",
    bbox,
    geometry,
    text,
    normalizedText: stringValue(row.normalized_text),
    transcriptionStatus,
    prediction,
    annotation: { bbox, geometry, text, transcriptionStatus },
    bboxEdited,
    textEdited,
    detectionGt: true,
    recognitionGt: transcriptionStatus === "verified" && text !== null,
    source: !prediction ? "manual" : bboxEdited && textEdited ? "fully-corrected" : bboxEdited || textEdited ? "partially-corrected" : "auto",
    status: stringValue(row.status) ?? "reviewed",
    sourceKind: stringValue(row.source_kind) ?? "manual",
    textDirection: stringValue(row.text_direction) ?? "right",
    glyphOrientation: stringValue(row.glyph_orientation) ?? "upright",
    layout: layoutFromRow(row),
    rectification: rectificationValue(row.rectification),
    sortOrder: numberValue(row.sort_order) ?? 0,
  };
}

function toNumericBbox(bbox: Record<string, unknown>) {
  return {
    x: Math.max(0, Math.round(numberValue(bbox.x) ?? 0)),
    y: Math.max(0, Math.round(numberValue(bbox.y) ?? 0)),
    width: Math.max(1, Math.round(numberValue(bbox.width) ?? 1)),
    height: Math.max(1, Math.round(numberValue(bbox.height) ?? 1)),
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function layoutFromRow(row: Record<string, unknown>): GraphOcrAnnotation["layout"] {
  const flow = row.layout_flow === "curved" ? "curved" : "linear";
  const baseline = Array.isArray(row.layout_baseline)
    ? row.layout_baseline.map(objectValue).filter((point): point is Record<string, unknown> => point !== null).map((point) => ({ x: numberValue(point.x) ?? 0, y: numberValue(point.y) ?? 0 }))
    : null;
  const characterOrientation = row.character_orientation === "aligned" || row.character_orientation === "tangent-aligned" || row.character_orientation === "mixed" ? row.character_orientation : "upright";
  return { type: row.level === "word" ? "word" : "string", flow, baselineAngleDeg: numberValue(row.baseline_angle_deg) ?? directionAngle(row.text_direction), baseline: flow === "curved" ? baseline : null, characterOrientation };
}

function legacyLayout(level: unknown, direction: unknown, orientation: unknown): GraphOcrAnnotation["layout"] {
  return { type: level === "word" ? "word" : "string", flow: "linear", baselineAngleDeg: directionAngle(direction), baseline: null,
    characterOrientation: orientation === "mixed" ? "mixed" : orientation === "upright" || orientation == null ? "upright" : "aligned" };
}

function layoutValue(value: unknown, fallback: GraphOcrAnnotation["layout"]): GraphOcrAnnotation["layout"] {
  const record = objectValue(value);
  if (!record || (record.flow !== "linear" && record.flow !== "curved")) return fallback;
  const baseline = Array.isArray(record.baseline)
    ? record.baseline.map(objectValue).filter((point): point is Record<string, unknown> => point !== null).map((point) => ({ x: numberValue(point.x) ?? 0, y: numberValue(point.y) ?? 0 }))
    : null;
  const characterOrientation = record.characterOrientation === "aligned" || record.characterOrientation === "tangent-aligned" || record.characterOrientation === "mixed" ? record.characterOrientation : "upright";
  return { type: record.type === "word" ? "word" : "string", flow: record.flow, baselineAngleDeg: numberValue(record.baselineAngleDeg) ?? 0, baseline: record.flow === "curved" ? baseline : null, characterOrientation };
}

function directionAngle(value: unknown) { return value === "down" ? 90 : value === "left" ? 180 : value === "up" ? -90 : 0; }
function rectificationValue(value: unknown): GraphOcrAnnotation["rectification"] { return objectValue(value) as GraphOcrAnnotation["rectification"]; }

function cascadeEvidenceValue(value: unknown): OcrCascadeEvidence | null {
  const evidence = objectValue(value);
  return evidence?.schemaVersion === 1 ? evidence as OcrCascadeEvidence : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function transcriptionStatusValue(value: unknown): OcrRegionReviewDto["regions"][number]["transcriptionStatus"] {
  return value === "partial" || value === "partially-readable" ? "partial" : value === "unreadable" ? "unreadable" : "verified";
}

function derivedRegionSource(
  prediction: { bbox: Record<string, number>; geometry?: QuadGeometry; text: string | null } | null,
  annotation: { bbox: Record<string, number>; geometry?: QuadGeometry; text: string | null },
) {
  if (!prediction) return "manual";
  const predictionGeometry = normalizeQuadGeometry(prediction.geometry, prediction.bbox);
  const annotationGeometry = normalizeQuadGeometry(annotation.geometry, annotation.bbox);
  return sameQuad(predictionGeometry, annotationGeometry) && prediction.text === annotation.text ? "accepted-generated" : "corrected-generated";
}

export function deriveOcrReviewOperations(
  regions: OcrRegionReviewDto["regions"],
  autoRegionIds: string[],
  compositions: OcrStringComposition[],
): OcrReviewOperation[] {
  const operations: OcrReviewOperation[] = [];
  const sourceUse = new Map<string, string[]>();
  for (const region of regions) for (const sourceId of region.sourceRegionIds) {
    sourceUse.set(sourceId, [...(sourceUse.get(sourceId) ?? []), region.id]);
  }
  for (const sourceId of autoRegionIds) {
    if (!sourceUse.has(sourceId)) operations.push(ocrReviewOperation("reject", [sourceId], []));
  }
  const splitSources = new Set([...sourceUse].filter(([, outputs]) => outputs.length > 1).map(([sourceId]) => sourceId));
  for (const sourceId of splitSources) operations.push(ocrReviewOperation("split_region", [sourceId], sourceUse.get(sourceId) ?? []));

  for (const region of regions) {
    if (!region.sourceRegionIds.length) {
      operations.push(ocrReviewOperation("create_region", [], [region.id]));
      continue;
    }
    if (region.sourceRegionIds.length > 1) {
      operations.push(ocrReviewOperation("merge_region", region.sourceRegionIds, [region.id]));
      continue;
    }
    if (splitSources.has(region.sourceRegionIds[0]!)) continue;
    const inputId = region.sourceRegionIds[0]!;
    if (region.bboxEdited) operations.push(ocrReviewOperation("edit_region", [inputId], [region.id]));
    else operations.push(ocrReviewOperation("approve_region", [inputId], [region.id]));
    if (region.textEdited || region.transcriptionStatus !== "verified") operations.push(ocrReviewOperation("edit_text", [inputId], [region.id]));
    else operations.push(ocrReviewOperation("approve_text", [inputId], [region.id]));
  }
  for (const composition of compositions) operations.push(ocrReviewOperation("compose_string", composition.memberIds, [composition.id]));
  return operations;
}

function ocrReviewOperation(type: OcrReviewOperation["type"], inputIds: string[], outputIds: string[]): OcrReviewOperation {
  return { id: randomUUID(), type, inputIds, outputIds, actor: "human" };
}

function ocrCompositionsValue(value: unknown): OcrStringComposition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = objectValue(item);
    const memberIds = Array.isArray(row?.memberIds) ? row.memberIds.filter((id): id is string => typeof id === "string") : [];
    if (!row || typeof row.id !== "string" || memberIds.length < 2) return [];
    return [{ id: row.id, kind: "string" as const, memberIds, text: stringValue(row.text), transcriptionStatus: transcriptionStatusValue(row.transcriptionStatus), sortOrder: numberValue(row.sortOrder) ?? 0 }];
  });
}

function ocrReviewOperationsValue(value: unknown): OcrReviewOperation[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<OcrReviewOperation["type"]>(["approve_region", "approve_text", "reject", "edit_region", "edit_text", "merge_region", "split_region", "create_region", "compose_string"]);
  return value.flatMap((item) => {
    const row = objectValue(item);
    if (!row || typeof row.id !== "string" || typeof row.type !== "string" || !allowed.has(row.type as OcrReviewOperation["type"])) return [];
    const inputIds = Array.isArray(row.inputIds) ? row.inputIds.filter((id): id is string => typeof id === "string") : [];
    const outputIds = Array.isArray(row.outputIds) ? row.outputIds.filter((id): id is string => typeof id === "string") : [];
    return [{ id: row.id, type: row.type as OcrReviewOperation["type"], inputIds, outputIds, actor: "human" as const }];
  });
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function dateString(value: unknown) {
  return value instanceof Date ? value.toISOString() : new Date().toISOString();
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120) || "item";
}
