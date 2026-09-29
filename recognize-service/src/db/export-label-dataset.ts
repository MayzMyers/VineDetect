import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { closePool, pool } from "./pool.js";
import { buildHelperConfigContract } from "../shared/helperConfigContract.js";
import { buildStageSamplesV1, type StageSampleV1 } from "../shared/stageSampleContract.js";
import { normalizeQuadGeometry, sameQuad, type QuadGeometry } from "../shared/quadGeometry.js";
import type { OcrLayout, OcrRectification } from "../shared/annotationGraphContract.js";
import type { LabelRectificationValue } from "../shared/labelRectificationContract.js";

type ExportRow = {
  annotation_id: string;
  source: string;
  source_item_id: string;
  title: string | null;
  image_url: string | null;
  bbox: Record<string, unknown> | null;
  geometry: Record<string, unknown> | null;
  rectification: LabelRectificationValue | null;
  suggestion_id: string | null;
  revision: number;
  source_kind: string;
  updated_at: Date;
  label_prediction_id: string | null;
  label_prediction_candidate_id: string | null;
  label_prediction_helper_run_id: string | null;
  label_prediction_bbox: Record<string, unknown> | null;
  label_prediction_geometry: Record<string, unknown> | null;
  label_prediction_rectification: LabelRectificationValue | null;
  label_prediction_confidence: number | null;
  label_prediction_algorithm_id: string | null;
  label_prediction_algorithm_version: string | null;
  label_prediction_params: unknown;
  label_prediction_created_at: Date | null;
  ocr_review_id: string | null;
  ocr_review_text: string | null;
  ocr_review_normalized_text: string | null;
  ocr_review_status: string | null;
  ocr_review_source_kind: string | null;
  ocr_review_revision: number | null;
  ocr_review_updated_at: Date | null;
  ocr_run_id: string | null;
  ocr_engine: string | null;
  ocr_engine_version: string | null;
  ocr_confidence: number | null;
  ocr_evidence: unknown;
  ocr_regions: unknown;
  ocr_region_review_id: string | null;
  ocr_region_review_run_id: string | null;
  ocr_region_review_revision: number | null;
  ocr_region_review_created_at: Date | null;
  ocr_reviewed_regions: unknown;
  source_association_review_id: string | null;
  source_association_region_set_id: string | null;
  source_association_revision: number | null;
  source_association_created_at: Date | null;
  reviewed_source_associations: unknown;
  alias_review_id: string | null;
  alias_review_association_set_id: string | null;
  alias_review_revision: number | null;
  alias_review_created_at: Date | null;
  reviewed_aliases: unknown;
  catalog_identity_review_id: string | null;
  catalog_identity_analysis_job_id: string | null;
  catalog_identity_region_set_id: string | null;
  catalog_identity_revision: number | null;
  catalog_identity_status: string | null;
  catalog_identity_selected_source: string | null;
  catalog_identity_selected_source_item_id: string | null;
  catalog_identity_candidate_snapshot: unknown;
  catalog_identity_score: number | null;
  catalog_identity_notes: string | null;
  catalog_identity_reviewed_by: string | null;
  catalog_identity_created_at: Date | null;
  visual_features: unknown;
  stage_executions: unknown;
};

type DatasetItem = {
  id: string;
  source: string;
  sourceItemId: string;
  title: string | null;
  imageRef: string;
  annotation: {
    id: string;
    type: "label-bbox";
    bbox: {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    geometry: QuadGeometry;
    revision: number;
    source: string;
    updatedAt: string;
  };
  suggestionId: string | null;
  catalogIdentity: {
    id: string;
    analysisJobId: string;
    ocrRegionAnnotationSetId: string | null;
    revision: number;
    status: "confirmed" | "corrected" | "no-match" | "ambiguous";
    selectedSource: string | null;
    selectedSourceItemId: string | null;
    candidateSnapshot: Record<string, unknown>;
    score: number | null;
    notes: string;
    reviewedBy: string | null;
    createdAt: string;
  } | null;
  ocr: {
    review: {
      id: string;
      text: string;
      normalizedText: string;
      status: string;
      source: string;
      revision: number;
      updatedAt: string;
    } | null;
    generated: {
      runId: string;
      engine: string;
      engineVersion: string | null;
      confidence: number | null;
      wordBoxes: Array<{
        id: string;
        text: string;
        normalizedText: string;
        confidence: number | null;
        textDirection: string;
        glyphOrientation: string;
        bbox: {
          x: number;
          y: number;
          width: number;
          height: number;
        };
        geometry: QuadGeometry;
      }>;
    } | null;
    regionsReview: {
      id: string;
      ocrRunId: string | null;
      revision: number;
      createdAt: string;
      regions: Array<{
        id: string;
        sourceRegionIds: string[];
        level: string;
        text: string | null;
        normalizedText: string | null;
        transcriptionStatus: string;
        prediction: { bbox: { x: number; y: number; width: number; height: number }; geometry: QuadGeometry; text: string | null; confidence: number | null; layout: OcrLayout; rectification: OcrRectification | null } | null;
        annotation: { bbox: { x: number; y: number; width: number; height: number }; geometry: QuadGeometry; text: string | null; transcriptionStatus: string };
        bboxEdited: boolean;
        textEdited: boolean;
        detectionGt: true;
        recognitionGt: boolean;
        source: string;
        textDirection: string;
        glyphOrientation: string;
        layout: OcrLayout;
        rectification: OcrRectification | null;
        bbox: { x: number; y: number; width: number; height: number };
        geometry: QuadGeometry;
      }>;
    } | null;
    sourceAssociations: {
      id: string;
      ocrRegionAnnotationSetId: string | null;
      revision: number;
      createdAt: string;
      associations: Array<{
        id: string;
        ocrRegionAnnotationId: string | null;
        regionText: string;
        sourceField: string;
        sourceValue: string;
        source: string;
        matchKind: string;
        score: number | null;
      }>;
    } | null;
    aliasesReview: {
      id: string;
      sourceAssociationSetId: string | null;
      revision: number;
      createdAt: string;
      aliases: Array<{
        id: string;
        value: string;
        normalizedValue: string;
        type: string;
        source: string;
        score: number | null;
        sourceAssociationIds: string[];
        components: Record<string, unknown>;
      }>;
    } | null;
  };
  labelRoi: {
    schemaVersion: 2;
    prediction: { id: string; roi: Record<string, unknown>; rectification: LabelRectificationValue | null; confidence: number | null; algorithm: { id: string; version: string | null; params: Record<string, unknown>; defaultParams: Record<string, unknown> | null }; createdAt: string | null } | null;
    annotation: { id: string; revision: number; roi: Record<string, unknown>; rectification: LabelRectificationValue | null; reviewedAt: string };
    reviewed: true;
    roiEdited: boolean;
    source: "auto" | "corrected" | "manual";
    iou: number | null;
    labelRoiGt: true;
  };
  stageSamples: StageSampleV1[];
  vision: {
    annotations: {
      bottle: Record<string, unknown> | null;
      bottlePalette: unknown[];
      componentDecisions: Record<string, unknown>;
      elements: unknown[];
      contours: unknown[];
      palette: unknown[];
    };
    cvMeta: {
      config: Record<string, unknown>;
      helpers: {
        schemaVersion: 1;
        records: Array<{
          helperId: string;
          algorithm: string;
          configSchemaVersion: number;
          config: Record<string, unknown>;
          role: "conditioning-input";
          provenance: Record<string, unknown>;
          review: Record<string, unknown>;
        }>;
      };
      coordinateSpace: Record<string, unknown> | null;
      bottleCoordinateSpace: Record<string, unknown> | null;
      morphologyProposal: Record<string, unknown> | null;
      effectiveMorphology: Record<string, unknown> | null;
      morphologyProposalScore: number | null;
      componentProposals: unknown[];
      elementProposals: unknown[];
      rawContours: unknown[];
    };
    provenance: {
      schemaVersion: number;
      annotationId: string | null;
      annotationRevision: number | null;
      analysisJobId: string | null;
      reviewedAt: string | null;
    };
  } | null;
  split: "train" | "validation" | "test";
};

const DEFAULT_DATASET_NAME = "annotation-dataset-v4";

async function main() {
  const datasetName = readArg("--name") ?? DEFAULT_DATASET_NAME;
  const source = readArg("--source") ?? "all";
  const outputRoot = path.resolve(process.cwd(), "..", "exports", datasetName);
  const rows = await readReviewedAnnotations(source);
  const items = rows.flatMap((row) => {
    const geometry = normalizeQuadGeometry(row.geometry, row.bbox);
    const bbox = geometry?.bbox ?? null;
    if (!geometry || !bbox || !row.image_url) return [];
    const id = `${row.source}:${row.source_item_id}:${row.annotation_id}`;
    const predictionGeometry = normalizeQuadGeometry(row.label_prediction_geometry, row.label_prediction_bbox);
    const predictionBbox = predictionGeometry?.bbox ?? null;
    const predictionSnapshot = objectValue(row.label_prediction_params);
    const labelIou = predictionBbox ? bboxIoU(predictionBbox, bbox) : null;
    const labelRoi = {
      schemaVersion: 2 as const,
      prediction: row.label_prediction_id && predictionBbox && predictionGeometry ? {
        id: row.label_prediction_id, helperRunId: row.label_prediction_helper_run_id, candidateId: row.label_prediction_candidate_id, roi: predictionBbox, geometry: predictionGeometry, rectification: row.label_prediction_rectification, confidence: row.label_prediction_confidence,
        algorithm: { id: row.label_prediction_algorithm_id ?? "unknown", version: row.label_prediction_algorithm_version,
          params: objectValue(predictionSnapshot?.params) ?? predictionSnapshot ?? {}, defaultParams: objectValue(predictionSnapshot?.defaultParams) },
        createdAt: row.label_prediction_created_at instanceof Date ? row.label_prediction_created_at.toISOString() : null,
      } : null,
      annotation: { id: row.annotation_id, revision: Number(row.revision ?? 1), roi: bbox, geometry, rectification: row.rectification, reviewedAt: row.updated_at.toISOString() },
      reviewed: true as const, roiEdited: predictionGeometry ? !sameQuad(predictionGeometry, geometry) : false,
      source: predictionGeometry ? sameQuad(predictionGeometry, geometry) ? "auto" as const : "corrected" as const : "manual" as const,
      iou: labelIou, labelRoiGt: true as const,
    };
    const labelPrediction = row.label_prediction_id ? {
      id: row.label_prediction_id,
      helperRunId: row.label_prediction_helper_run_id,
      candidateId: row.label_prediction_candidate_id,
      algorithm: { id: row.label_prediction_algorithm_id, version: row.label_prediction_algorithm_version,
        params: objectValue(predictionSnapshot?.params) ?? predictionSnapshot ?? {}, defaultParams: objectValue(predictionSnapshot?.defaultParams) },
      createdAt: row.label_prediction_created_at?.toISOString() ?? null, reviewStatus: "reviewed",
    } : null;
    const helperContract = buildHelperConfigContract(row.visual_features, row.ocr_evidence, row.ocr_run_id, labelPrediction);
    const vision = normalizeVisionFeatures(row.visual_features, row.ocr_evidence, row.ocr_run_id, labelPrediction);
    const visualFeatures = objectValue(row.visual_features) ?? {};
    const stageSamples = buildStageSamplesV1({
      source: row.source, sourceItemId: row.source_item_id, helperContract, labelRoi,
      sourceAnalysis: visualFeatures.labelSourceAnalysis, analysis: visualFeatures.labelAnalysis,
      ocrRegions: row.ocr_region_review_id ? { id: row.ocr_region_review_id, status: "reviewed", regions: normalizeReviewedOcrRegions(row.ocr_reviewed_regions), createdAt: row.ocr_region_review_created_at?.toISOString() } : null,
      sourceAssociations: row.source_association_review_id ? { id: row.source_association_review_id, status: "reviewed", associations: normalizeSourceAssociations(row.reviewed_source_associations) } : null,
      cvJob: visualFeatures.labelCvJob,
      stageExecutions: row.stage_executions,
    });
    return [
      {
        id,
        source: row.source,
        sourceItemId: row.source_item_id,
        title: row.title,
        imageRef: row.image_url,
        annotation: {
          id: row.annotation_id,
          type: "label-bbox" as const,
          bbox,
          geometry,
          revision: Number(row.revision ?? 1),
          source: row.source_kind,
          updatedAt: row.updated_at.toISOString(),
        },
        suggestionId: row.suggestion_id,
        catalogIdentity: row.catalog_identity_review_id
          ? {
              id: row.catalog_identity_review_id,
              analysisJobId: row.catalog_identity_analysis_job_id ?? "",
              ocrRegionAnnotationSetId: row.catalog_identity_region_set_id,
              revision: Number(row.catalog_identity_revision ?? 1),
              status: normalizeCatalogIdentityStatus(row.catalog_identity_status),
              selectedSource: row.catalog_identity_selected_source,
              selectedSourceItemId: row.catalog_identity_selected_source_item_id,
              candidateSnapshot: objectValue(row.catalog_identity_candidate_snapshot) ?? {},
              score: row.catalog_identity_score,
              notes: row.catalog_identity_notes ?? "",
              reviewedBy: row.catalog_identity_reviewed_by,
              createdAt: row.catalog_identity_created_at instanceof Date ? row.catalog_identity_created_at.toISOString() : new Date().toISOString(),
            }
          : null,
        ocr: {
          review: row.ocr_review_id
            ? {
                id: row.ocr_review_id,
                text: row.ocr_review_text ?? "",
                normalizedText: row.ocr_review_normalized_text ?? "",
                status: row.ocr_review_status ?? "reviewed",
                source: row.ocr_review_source_kind ?? "manual",
                revision: Number(row.ocr_review_revision ?? 1),
                updatedAt: row.ocr_review_updated_at instanceof Date ? row.ocr_review_updated_at.toISOString() : new Date().toISOString(),
              }
            : null,
          generated: row.ocr_run_id
            ? {
                runId: row.ocr_run_id,
                engine: row.ocr_engine ?? "unknown",
                engineVersion: row.ocr_engine_version,
                confidence: row.ocr_confidence,
                wordBoxes: normalizeOcrRegions(row.ocr_regions),
              }
            : null,
          regionsReview: row.ocr_region_review_id
            ? {
                id: row.ocr_region_review_id,
                ocrRunId: row.ocr_region_review_run_id,
                revision: Number(row.ocr_region_review_revision ?? 1),
                createdAt: row.ocr_region_review_created_at instanceof Date
                  ? row.ocr_region_review_created_at.toISOString()
                  : new Date().toISOString(),
                regions: normalizeReviewedOcrRegions(row.ocr_reviewed_regions),
              }
            : null,
          sourceAssociations: row.source_association_review_id
            ? {
                id: row.source_association_review_id,
                ocrRegionAnnotationSetId: row.source_association_region_set_id,
                revision: Number(row.source_association_revision ?? 1),
                createdAt: row.source_association_created_at instanceof Date
                  ? row.source_association_created_at.toISOString()
                  : new Date().toISOString(),
                associations: normalizeSourceAssociations(row.reviewed_source_associations),
              }
            : null,
          aliasesReview: row.alias_review_id
            ? {
                id: row.alias_review_id,
                sourceAssociationSetId: row.alias_review_association_set_id,
                revision: Number(row.alias_review_revision ?? 1),
                createdAt: row.alias_review_created_at instanceof Date
                  ? row.alias_review_created_at.toISOString()
                  : new Date().toISOString(),
                aliases: normalizeReviewedAliases(row.reviewed_aliases),
              }
            : null,
        },
        labelRoi,
        vision,
        stageSamples,
        split: splitForId(id),
      },
    ];
  });

  await mkdir(outputRoot, { recursive: true });
  await writeFile(path.join(outputRoot, "manifest.json"), JSON.stringify(buildManifest(datasetName, items), null, 2), "utf8");
  await writeFile(path.join(outputRoot, "annotations.jsonl"), `${items.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  await writeFile(path.join(outputRoot, "splits.json"), JSON.stringify(buildSplits(items), null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        datasetName,
        source,
        outputRoot,
        reviewedRows: rows.length,
        exportedItems: items.length,
        skipped: rows.length - items.length,
        withOcrReview: items.filter((item) => item.ocr.review).length,
        withOcrWordBoxes: items.filter((item) => item.ocr.generated?.wordBoxes.length).length,
        withReviewedOcrRegions: items.filter((item) => item.ocr.regionsReview?.regions.length).length,
        withReviewedSourceAssociations: items.filter((item) => item.ocr.sourceAssociations?.associations.length).length,
        withReviewedAliases: items.filter((item) => item.ocr.aliasesReview?.aliases.length).length,
        withReviewedCatalogIdentity: items.filter((item) => item.catalogIdentity).length,
        withBottleAnnotation: items.filter((item) => item.vision?.annotations.bottle).length,
        withReviewedElements: items.filter((item) => item.vision?.annotations.elements.length).length,
        withReviewedPalette: items.filter((item) => item.vision?.annotations.palette.length).length,
        splits: countSplits(items),
      },
      null,
      2,
    ),
  );
}

async function readReviewedAnnotations(source: string) {
  const result = await pool.query<ExportRow>(`
    WITH catalog AS (
      SELECT
        'svoe_vino'::text AS source,
        COALESCE(w.external_id, w.slug, w.id::text) AS source_item_id,
        w.title,
        (
          SELECT i.local_path
          FROM svoe_vino.wine_images AS i
          WHERE i.wine_id = w.id
            AND i.local_path IS NOT NULL
            AND i.local_path <> ''
          ORDER BY i.id
          LIMIT 1
        ) AS image_url
      FROM svoe_vino.wines AS w
      UNION ALL
      SELECT
        'roskachestvo'::text AS source,
        p.rskrf_product_id AS source_item_id,
        COALESCE(p.title, p.list_name) AS title,
        NULLIF(p.image_local_path, '') AS image_url
      FROM roskachestvo.products AS p
    )
    SELECT
      a.id::text AS annotation_id,
      a.source,
      a.source_item_id,
      c.title,
      COALESCE(NULLIF(a.image_url, ''), c.image_url) AS image_url,
      a.bbox,
      a.geometry,
      a.rectification,
      a.suggestion_id::text,
      a.revision,
      a.source_kind,
      a.updated_at,
      label_prediction.id::text AS label_prediction_id,
      label_prediction.helper_run_id AS label_prediction_helper_run_id,
      label_prediction.helper_candidate_id AS label_prediction_candidate_id,
      label_prediction.bbox AS label_prediction_bbox,
      label_prediction.geometry AS label_prediction_geometry,
      label_prediction.rectification AS label_prediction_rectification,
      label_prediction.confidence AS label_prediction_confidence,
      label_prediction.detector_type AS label_prediction_algorithm_id,
      label_prediction.detector_version AS label_prediction_algorithm_version,
      label_prediction.config_snapshot AS label_prediction_params,
      label_prediction.created_at AS label_prediction_created_at,
      ocr_review.id::text AS ocr_review_id,
      ocr_review.text AS ocr_review_text,
      ocr_review.normalized_text AS ocr_review_normalized_text,
      ocr_review.status AS ocr_review_status,
      ocr_review.source_kind AS ocr_review_source_kind,
      ocr_review.revision AS ocr_review_revision,
      ocr_review.updated_at AS ocr_review_updated_at,
      ocr_run.id::text AS ocr_run_id,
      ocr_run.engine AS ocr_engine,
      ocr_run.engine_version AS ocr_engine_version,
      ocr_run.confidence AS ocr_confidence,
      ocr_run.evidence AS ocr_evidence,
      COALESCE(ocr_regions.items, '[]'::json) AS ocr_regions,
      ocr_region_review.id::text AS ocr_region_review_id,
      ocr_region_review.ocr_run_id::text AS ocr_region_review_run_id,
      ocr_region_review.revision AS ocr_region_review_revision,
      ocr_region_review.created_at AS ocr_region_review_created_at,
      COALESCE(ocr_reviewed_regions.items, '[]'::json) AS ocr_reviewed_regions,
      source_association_review.id::text AS source_association_review_id,
      source_association_review.ocr_region_annotation_set_id::text AS source_association_region_set_id,
      source_association_review.revision AS source_association_revision,
      source_association_review.created_at AS source_association_created_at,
      COALESCE(reviewed_source_associations.items, '[]'::json) AS reviewed_source_associations,
      alias_review.id::text AS alias_review_id,
      alias_review.source_association_set_id::text AS alias_review_association_set_id,
      alias_review.revision AS alias_review_revision,
      alias_review.created_at AS alias_review_created_at,
      COALESCE(reviewed_aliases.items, '[]'::json) AS reviewed_aliases,
      catalog_identity_review.id::text AS catalog_identity_review_id,
      catalog_identity_review.analysis_job_id::text AS catalog_identity_analysis_job_id,
      catalog_identity_review.ocr_region_annotation_set_id::text AS catalog_identity_region_set_id,
      catalog_identity_review.revision AS catalog_identity_revision,
      catalog_identity_review.status AS catalog_identity_status,
      catalog_identity_review.selected_source AS catalog_identity_selected_source,
      catalog_identity_review.selected_source_item_id AS catalog_identity_selected_source_item_id,
      catalog_identity_review.candidate_snapshot AS catalog_identity_candidate_snapshot,
      catalog_identity_review.score AS catalog_identity_score,
      catalog_identity_review.notes AS catalog_identity_notes,
      catalog_identity_review.reviewed_by AS catalog_identity_reviewed_by,
      catalog_identity_review.created_at AS catalog_identity_created_at,
      COALESCE(meta_item.visual_features, '{}'::jsonb) AS visual_features,
      COALESCE(stage_execution_rows.items, '[]'::json) AS stage_executions
    FROM meta.image_annotations AS a
    LEFT JOIN meta.detection_proposals AS label_prediction ON label_prediction.id = a.suggestion_id
    LEFT JOIN meta.items AS meta_item
      ON meta_item.source = a.source
     AND meta_item.source_item_id = a.source_item_id
    LEFT JOIN catalog AS c
      ON c.source = a.source
     AND c.source_item_id = a.source_item_id
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta.ocr_text_annotations AS r
      WHERE r.source = a.source
        AND r.source_item_id = a.source_item_id
      ORDER BY r.updated_at DESC
      LIMIT 1
    ) AS ocr_review ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta.ocr_runs AS r
      WHERE r.id = (
        SELECT region_set.ocr_run_id
        FROM meta.ocr_region_annotation_sets AS region_set
        WHERE region_set.source = a.source
          AND region_set.source_item_id = a.source_item_id
          AND region_set.status = 'reviewed'
          AND region_set.ocr_run_id IS NOT NULL
        ORDER BY region_set.revision DESC
        LIMIT 1
      )
    ) AS ocr_run ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'id', region.id::text,
          'text', region.raw_text,
          'normalizedText', region.normalized_text,
          'confidence', region.confidence,
          'textDirection', region.text_direction,
          'glyphOrientation', region.glyph_orientation,
          'bbox', region.bbox,
          'geometry', region.geometry
        )
        ORDER BY region.created_at ASC, region.id ASC
      ) AS items
      FROM meta.ocr_regions AS region
      WHERE region.ocr_run_id = ocr_run.id
        AND region.level = 'word'
    ) AS ocr_regions ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta.ocr_region_annotation_sets AS region_set
      WHERE region_set.source = a.source
        AND region_set.source_item_id = a.source_item_id
        AND region_set.status = 'reviewed'
      ORDER BY region_set.revision DESC
      LIMIT 1
    ) AS ocr_region_review ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'id', region.id::text,
          'sourceRegionIds', region.source_region_ids,
          'level', region.level,
          'text', region.text,
          'normalizedText', region.normalized_text,
          'transcriptionStatus', region.transcription_status,
          'prediction', CASE WHEN region.prediction_bbox IS NULL THEN NULL ELSE json_build_object('bbox', region.prediction_bbox, 'geometry', region.prediction_geometry, 'text', region.prediction_text, 'confidence', region.prediction_confidence, 'layout', region.prediction_layout, 'rectification', region.prediction_rectification) END,
          'annotation', json_build_object('bbox', region.bbox, 'geometry', region.geometry, 'text', region.text, 'transcriptionStatus', region.transcription_status),
          'source', region.source_kind,
          'textDirection', region.text_direction,
          'glyphOrientation', region.glyph_orientation,
          'layout', json_build_object('type', CASE WHEN region.level = 'word' THEN 'word' ELSE 'string' END, 'flow', region.layout_flow, 'baselineAngleDeg', region.baseline_angle_deg, 'baseline', region.layout_baseline, 'characterOrientation', region.character_orientation),
          'rectification', region.rectification,
          'bbox', region.bbox,
          'geometry', region.geometry
        )
        ORDER BY region.sort_order ASC, region.id ASC
      ) AS items
      FROM meta.ocr_region_annotations AS region
      WHERE region.annotation_set_id = ocr_region_review.id
        AND region.status = 'reviewed'
    ) AS ocr_reviewed_regions ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta.ocr_source_association_sets AS association_set
      WHERE association_set.source = a.source
        AND association_set.source_item_id = a.source_item_id
        AND association_set.status = 'reviewed'
        AND association_set.ocr_region_annotation_set_id = ocr_region_review.id
      ORDER BY association_set.revision DESC
      LIMIT 1
    ) AS source_association_review ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'id', association.id::text,
          'ocrRegionAnnotationId', association.ocr_region_annotation_id::text,
          'regionText', association.region_text_snapshot,
          'sourceField', association.source_field,
          'sourceValue', association.source_value,
          'source', association.source_kind,
          'matchKind', association.match_kind,
          'score', association.score
        )
        ORDER BY association.sort_order ASC, association.id ASC
      ) AS items
      FROM meta.ocr_source_associations AS association
      WHERE association.association_set_id = source_association_review.id
        AND association.status = 'reviewed'
    ) AS reviewed_source_associations ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta.alias_annotation_sets AS alias_set
      WHERE alias_set.source = a.source
        AND alias_set.source_item_id = a.source_item_id
        AND alias_set.status = 'reviewed'
        AND alias_set.source_association_set_id IS NOT DISTINCT FROM source_association_review.id
      ORDER BY alias_set.revision DESC
      LIMIT 1
    ) AS alias_review ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(
        json_build_object(
          'id', alias.id::text,
          'value', alias.value,
          'normalizedValue', alias.normalized_value,
          'type', alias.alias_type,
          'source', alias.source_kind,
          'score', alias.score,
          'sourceAssociationIds', alias.source_association_ids,
          'components', alias.components
        )
        ORDER BY alias.sort_order ASC, alias.id ASC
      ) AS items
      FROM meta.alias_annotations AS alias
      WHERE alias.annotation_set_id = alias_review.id
        AND alias.status = 'reviewed'
    ) AS reviewed_aliases ON TRUE
    LEFT JOIN LATERAL (
      SELECT *
      FROM meta.catalog_identity_reviews AS identity_review
      WHERE identity_review.source = a.source
        AND identity_review.source_item_id = a.source_item_id
      ORDER BY identity_review.revision DESC
      LIMIT 1
    ) AS catalog_identity_review ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(to_jsonb(latest_execution) ORDER BY latest_execution.stage) AS items
      FROM (
        SELECT DISTINCT ON (execution.stage) execution.*
        FROM meta.wizard_stage_execution_records AS execution
        WHERE execution.source = a.source AND execution.source_item_id = a.source_item_id AND execution.status <> 'superseded'
        ORDER BY execution.stage, execution.revision DESC
      ) AS latest_execution
    ) AS stage_execution_rows ON TRUE
    WHERE a.annotation_type = 'label-bbox'
      AND a.status = 'reviewed'
      AND a.bbox IS NOT NULL
      AND ($1 = 'all' OR a.source = $1)
    ORDER BY a.updated_at DESC, a.source, a.source_item_id
  `, [source]);
  return result.rows;
}

function buildManifest(datasetName: string, items: DatasetItem[]) {
  return {
    schemaVersion: 4,
    datasetName,
    task: "label-bbox-bottle-ocr-elements-palette-and-catalog-identity",
    generatedAt: new Date().toISOString(),
    source: {
      table: "meta.image_annotations",
      filter: {
        annotationType: "label-bbox",
        status: "reviewed",
        ocrText: "latest reviewed OCR text when available",
        ocrWords: "latest generated OCR word boxes when available",
        ocrRegions: "latest reviewed OCR region revision when available",
        sourceAssociations: "latest reviewed OCR-to-source association revision when available",
        aliases: "latest reviewed alias revision for the exported source-association revision when available",
        catalogIdentity: "latest immutable reviewed catalog identity decision when available",
        visionAnnotations: "reviewed bottle, component decisions, elements, element contours and palette from visual_features.labelCvJob",
        cvMeta: "generation config, auto morphology proposal, component/element proposals and raw contours kept separate from annotations",
      },
      groundTruth: "reviewed annotations only",
    },
    counts: {
      total: items.length,
      splits: countSplits(items),
      withBottleAnnotation: items.filter((item) => item.vision?.annotations.bottle).length,
      withReviewedElements: items.filter((item) => item.vision?.annotations.elements.length).length,
      withReviewedPalette: items.filter((item) => item.vision?.annotations.palette.length).length,
      withStageSamples: items.filter((item) => Array.isArray(item.stageSamples) && item.stageSamples.length === 11).length,
    },
    files: {
      annotations: "annotations.jsonl",
      splits: "splits.json",
    },
  };
}

function normalizeVisionFeatures(value: unknown, ocrEvidenceValue?: unknown, ocrRunIdValue?: unknown, labelPredictionValue?: unknown): DatasetItem["vision"] {
  const visual = objectValue(value) ?? {};
  const sourceAnalysis = objectValue(visual.labelSourceAnalysis) ?? {};
  const bottleDetection = objectValue(sourceAnalysis.bottleDetection) ?? {};
  const cvJob = objectValue(visual.labelCvJob) ?? {};
  if (!Object.keys(sourceAnalysis).length && !Object.keys(cvJob).length) return null;
  const preview = objectValue(cvJob.preview) ?? {};
  const review = objectValue(cvJob.review) ?? {};
  const debug = objectValue(preview.cvDebug) ?? {};
  const allElements = arrayValue(preview.elements).filter((element) => (objectValue(element) ?? {}).status !== "unreviewed");
  const acceptedElementIds = new Set(allElements.filter((element) => (objectValue(element) ?? {}).status === "accepted").map((element) => String((objectValue(element) ?? {}).id ?? "")));
  const allContours = arrayValue(preview.contours);
  const annotationContours = allContours.filter((contour) => acceptedElementIds.has(String((objectValue(contour) ?? {}).elementId ?? "")));
  return {
    annotations: {
      bottle: nullableObject(bottleDetection.annotation),
      bottlePalette: arrayValue(bottleDetection.palette),
      componentDecisions: objectValue(review.componentDecisions) ?? {},
      elements: allElements,
      contours: annotationContours,
      palette: arrayValue(cvJob.palette),
    },
    cvMeta: {
      config: objectValue(cvJob.config) ?? {},
      helpers: buildHelperConfigContract(value, ocrEvidenceValue, ocrRunIdValue, labelPredictionValue),
      coordinateSpace: nullableObject(debug.source),
      bottleCoordinateSpace: nullableObject(sourceAnalysis.sourceImage),
      morphologyProposal: nullableObject(debug.autoMorphologyConfig),
      effectiveMorphology: nullableObject(debug.effectiveMorphologyConfig),
      morphologyProposalScore: finiteNumber(debug.autoMorphologyScore),
      componentProposals: arrayValue(preview.components),
      elementProposals: arrayValue(preview.elementProposals),
      rawContours: allContours.map((contour) => {
        const record = objectValue(contour) ?? {};
        return { componentId: record.componentId ?? null, elementId: record.elementId ?? null, rawPoints: arrayValue(record.rawPoints) };
      }),
    },
    provenance: {
      schemaVersion: Number(cvJob.schemaVersion ?? 0),
      annotationId: nullableString(cvJob.annotationId),
      annotationRevision: finiteNumber(cvJob.annotationRevision),
      analysisJobId: nullableString(cvJob.analysisJobId),
      reviewedAt: nullableString(cvJob.reviewedAt),
    },
  };
}

function normalizeCatalogIdentityStatus(value: string | null): NonNullable<DatasetItem["catalogIdentity"]>["status"] {
  if (value === "confirmed" || value === "corrected" || value === "no-match" || value === "ambiguous") return value;
  return "ambiguous";
}

function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function nullableObject(value: unknown): Record<string, unknown> | null { const object = objectValue(value); return object && Object.keys(object).length ? object : null; }
function finiteNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function nullableString(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }

function normalizeReviewedOcrRegions(value: unknown): NonNullable<DatasetItem["ocr"]["regionsReview"]>["regions"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectValue(item);
    if (!record) return [];
    const geometry = normalizeQuadGeometry(record.geometry, record.bbox);
    const bbox = geometry?.bbox ?? null;
    if (!geometry || !bbox) return [];
    const sourceRegionIds = Array.isArray(record.sourceRegionIds)
      ? record.sourceRegionIds.flatMap((id) => (typeof id === "string" ? [id] : []))
      : [];
    const predictionRecord = objectValue(record.prediction);
    const predictionGeometry = normalizeQuadGeometry(predictionRecord?.geometry, predictionRecord?.bbox);
    const prediction = predictionGeometry ? { bbox: predictionGeometry.bbox, geometry: predictionGeometry, text: nullableString(predictionRecord?.text), confidence: finiteNumber(predictionRecord?.confidence), layout: normalizeOcrLayout(predictionRecord?.layout, stringValue(record.level), stringValue(record.textDirection), stringValue(record.glyphOrientation)), rectification: normalizeRectification(predictionRecord?.rectification) } : null;
    const text = nullableString(record.text);
    const transcriptionStatus = stringValue(record.transcriptionStatus) === "partially-readable" ? "partial" : stringValue(record.transcriptionStatus) ?? "verified";
    const bboxEdited = Boolean(prediction && !sameQuad(prediction.geometry, geometry));
    const textEdited = Boolean(prediction && prediction.text !== text);
    return [{
      id: stringValue(record.id) ?? "",
      sourceRegionIds,
      level: stringValue(record.level) ?? "word",
      text,
      normalizedText: nullableString(record.normalizedText),
      transcriptionStatus,
      prediction,
      annotation: { bbox, geometry, text, transcriptionStatus },
      bboxEdited,
      textEdited,
      detectionGt: true as const,
      recognitionGt: transcriptionStatus === "verified" && text !== null,
      source: stringValue(record.source) ?? "manual",
      textDirection: stringValue(record.textDirection) ?? "right",
      glyphOrientation: stringValue(record.glyphOrientation) ?? "upright",
      layout: normalizeOcrLayout(record.layout, stringValue(record.level), stringValue(record.textDirection), stringValue(record.glyphOrientation)),
      rectification: normalizeRectification(record.rectification),
      bbox,
      geometry,
    }];
  });
}

function normalizeSourceAssociations(value: unknown): NonNullable<DatasetItem["ocr"]["sourceAssociations"]>["associations"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectValue(item);
    if (!record) return [];
    return [{
      id: stringValue(record.id) ?? "",
      ocrRegionAnnotationId: stringValue(record.ocrRegionAnnotationId),
      regionText: stringValue(record.regionText) ?? "",
      sourceField: stringValue(record.sourceField) ?? "",
      sourceValue: stringValue(record.sourceValue) ?? "",
      source: stringValue(record.source) ?? "manual",
      matchKind: stringValue(record.matchKind) ?? "manual",
      score: numberValue(record.score),
    }];
  });
}

function normalizeReviewedAliases(value: unknown): NonNullable<DatasetItem["ocr"]["aliasesReview"]>["aliases"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectValue(item);
    if (!record) return [];
    return [{
      id: stringValue(record.id) ?? "",
      value: stringValue(record.value) ?? "",
      normalizedValue: stringValue(record.normalizedValue) ?? "",
      type: stringValue(record.type) ?? "manual",
      source: stringValue(record.source) ?? "manual",
      score: numberValue(record.score),
      sourceAssociationIds: Array.isArray(record.sourceAssociationIds)
        ? record.sourceAssociationIds.flatMap((id) => typeof id === "string" ? [id] : [])
        : [],
      components: objectValue(record.components) ?? {},
    }];
  });
}

function normalizeOcrRegions(value: unknown): NonNullable<DatasetItem["ocr"]["generated"]>["wordBoxes"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectValue(item);
    if (!record) return [];
    const geometry = normalizeQuadGeometry(record.geometry, record.bbox);
    const bbox = geometry?.bbox ?? null;
    if (!geometry || !bbox) return [];
    return [
      {
        id: stringValue(record.id) ?? "",
        text: stringValue(record.text) ?? "",
        normalizedText: stringValue(record.normalizedText) ?? "",
        confidence: numberValue(record.confidence),
        textDirection: stringValue(record.textDirection) ?? "right",
        glyphOrientation: stringValue(record.glyphOrientation) ?? "upright",
        bbox,
        geometry,
      },
    ];
  });
}

function buildSplits(items: DatasetItem[]) {
  return {
    train: items.filter((item) => item.split === "train").map((item) => item.id),
    validation: items.filter((item) => item.split === "validation").map((item) => item.id),
    test: items.filter((item) => item.split === "test").map((item) => item.id),
  };
}

function countSplits(items: DatasetItem[]) {
  return items.reduce(
    (counts, item) => {
      counts[item.split] += 1;
      return counts;
    },
    { train: 0, validation: 0, test: 0 },
  );
}

function splitForId(id: string): DatasetItem["split"] {
  const bucket = stableBucket(id);
  if (bucket < 70) return "train";
  if (bucket < 90) return "validation";
  return "test";
}

function stableBucket(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % 100;
}

function normalizeBbox(value: Record<string, unknown> | null) {
  const x = numberValue(value?.x);
  const y = numberValue(value?.y);
  const width = numberValue(value?.width);
  const height = numberValue(value?.height);
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function normalizeOcrLayout(value: unknown, level: string | null, direction: string | null, orientation: string | null): OcrLayout {
  const record = objectValue(value);
  const flow = record?.flow === "curved" ? "curved" : "linear";
  const baseline = Array.isArray(record?.baseline)
    ? record.baseline.flatMap((point) => { const item=objectValue(point),x=numberValue(item?.x),y=numberValue(item?.y); return x === null || y === null ? [] : [{ x, y }]; })
    : null;
  const characterOrientation = record?.characterOrientation === "aligned" || record?.characterOrientation === "tangent-aligned" || record?.characterOrientation === "mixed"
    ? record.characterOrientation : "upright";
  return {
    type: record?.type === "word" || level === "word" ? "word" : "string",
    flow,
    baselineAngleDeg: numberValue(record?.baselineAngleDeg) ?? (direction === "down" ? 90 : direction === "left" ? 180 : direction === "up" ? -90 : 0),
    baseline: flow === "curved" ? baseline : null,
    characterOrientation: orientation === "mixed" && !record ? "mixed" : characterOrientation,
  };
}

function normalizeRectification(value: unknown): OcrRectification | null {
  const record = objectValue(value);
  if (!record) return null;
  if (record.type === "rotation" && numberValue(record.angleDeg) !== null) return { type: "rotation", angleDeg: numberValue(record.angleDeg)! };
  if (record.type === "affine" && Array.isArray(record.matrix) && record.matrix.length === 6 && record.matrix.every((item) => numberValue(item) !== null)) return { type: "affine", matrix: record.matrix.map(Number) as [number, number, number, number, number, number] };
  if (record.type === "perspective" && Array.isArray(record.homography) && record.homography.length === 9 && record.homography.every((item) => numberValue(item) !== null)) return { type: "perspective", homography: record.homography.map(Number) as [number, number, number, number, number, number, number, number, number] };
  const path = Array.isArray(record.path) ? record.path.flatMap((point) => { const item=objectValue(point),x=numberValue(item?.x),y=numberValue(item?.y); return x === null || y === null ? [] : [{ x, y }]; }) : [];
  return record.type === "curved" && path.length >= 2 ? { type: "curved", path, params: Object.fromEntries(Object.entries(objectValue(record.params) ?? {}).flatMap(([key, item]) => numberValue(item) === null ? [] : [[key, numberValue(item)!]])) } : null;
}

function bboxIoU(left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }) {
  const intersectionWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const intersectionHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = intersectionWidth * intersectionHeight;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? Math.round(intersection / union * 1_000_000) / 1_000_000 : 0;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readArg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
