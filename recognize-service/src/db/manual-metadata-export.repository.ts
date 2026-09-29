import { pool } from "./pool.js";
import type { SourceName } from "../shared/types.js";
import { buildHelperConfigContract } from "../shared/helperConfigContract.js";
import { buildStageSamplesV1 } from "../shared/stageSampleContract.js";
import { normalizeQuadGeometry, sameQuad } from "../shared/quadGeometry.js";
import { getAnnotationGraph } from "./annotation-graph.repository.js";

export async function exportManualMetadata(source?: SourceName) {
  const result = await pool.query(
    `
    WITH item_keys AS (
      SELECT id AS annotation_track_id, source, source_item_id, ordinal, name, status,
        execution_actor_type, execution_actor_sources
      FROM meta.annotation_tracks WHERE status <> 'archived'
    )
    SELECT
      keys.source,
      keys.source_item_id,
      keys.annotation_track_id,
      keys.ordinal AS annotation_track_ordinal,
      keys.name AS annotation_track_name,
      keys.status AS annotation_track_status,
      (SELECT to_jsonb(item) || jsonb_build_object('visual_features', state.visual_features, 'annotations', state.annotations, 'status', state.status)
        FROM meta.items item LEFT JOIN meta.annotation_track_states state ON state.annotation_track_id = keys.annotation_track_id
        WHERE item.source = keys.source AND item.source_item_id = keys.source_item_id) AS metadata,
      (SELECT run.id::text FROM meta.ocr_runs run
        WHERE run.id = (SELECT annotation_set.ocr_run_id FROM meta.ocr_region_annotation_sets annotation_set
          WHERE annotation_set.source = keys.source AND annotation_set.source_item_id = keys.source_item_id
            AND annotation_set.annotation_track_id = keys.annotation_track_id AND annotation_set.status = 'reviewed' AND annotation_set.ocr_run_id IS NOT NULL
          ORDER BY annotation_set.revision DESC LIMIT 1)) AS ocr_run_id,
      (SELECT run.evidence FROM meta.ocr_runs run
        WHERE run.id = (SELECT annotation_set.ocr_run_id FROM meta.ocr_region_annotation_sets annotation_set
          WHERE annotation_set.source = keys.source AND annotation_set.source_item_id = keys.source_item_id
            AND annotation_set.annotation_track_id = keys.annotation_track_id AND annotation_set.status = 'reviewed' AND annotation_set.ocr_run_id IS NOT NULL
          ORDER BY annotation_set.revision DESC LIMIT 1)) AS ocr_evidence,
      COALESCE((SELECT jsonb_agg(to_jsonb(annotation) ORDER BY annotation.revision, annotation.created_at)
        FROM meta.image_annotations annotation
        WHERE annotation.source = keys.source AND annotation.source_item_id = keys.source_item_id AND annotation.annotation_track_id = keys.annotation_track_id), '[]'::jsonb) AS label_annotations,
      COALESCE((SELECT jsonb_agg(to_jsonb(proposal) ORDER BY proposal.created_at)
        FROM meta.detection_proposals proposal
        WHERE proposal.source = keys.source AND proposal.source_item_id = keys.source_item_id AND proposal.annotation_track_id = keys.annotation_track_id), '[]'::jsonb) AS label_predictions,
      COALESCE((SELECT jsonb_agg(to_jsonb(annotation) ORDER BY annotation.revision, annotation.created_at)
        FROM meta.ocr_text_annotations annotation
        WHERE annotation.source = keys.source AND annotation.source_item_id = keys.source_item_id AND annotation.annotation_track_id = keys.annotation_track_id), '[]'::jsonb) AS ocr_text_annotations,
      COALESCE((SELECT jsonb_agg(
          to_jsonb(annotation_set) || jsonb_build_object(
            'regions', COALESCE((SELECT jsonb_agg(to_jsonb(region) ORDER BY region.sort_order, region.id)
              FROM meta.ocr_region_annotations region
              WHERE region.annotation_set_id = annotation_set.id), '[]'::jsonb)
          ) ORDER BY annotation_set.revision, annotation_set.created_at)
        FROM meta.ocr_region_annotation_sets annotation_set
        WHERE annotation_set.source = keys.source AND annotation_set.source_item_id = keys.source_item_id AND annotation_set.annotation_track_id = keys.annotation_track_id), '[]'::jsonb) AS ocr_region_annotation_sets,
      COALESCE((SELECT jsonb_agg(
          to_jsonb(association_set) || jsonb_build_object(
            'associations', COALESCE((SELECT jsonb_agg(to_jsonb(association) ORDER BY association.sort_order, association.id)
              FROM meta.ocr_source_associations association
              WHERE association.association_set_id = association_set.id), '[]'::jsonb)
          ) ORDER BY association_set.revision, association_set.created_at)
        FROM meta.ocr_source_association_sets association_set
        WHERE association_set.source = keys.source AND association_set.source_item_id = keys.source_item_id AND association_set.annotation_track_id = keys.annotation_track_id), '[]'::jsonb) AS ocr_source_association_sets,
      COALESCE((SELECT jsonb_agg(
          to_jsonb(alias_set) || jsonb_build_object(
            'aliases', COALESCE((SELECT jsonb_agg(to_jsonb(alias) ORDER BY alias.sort_order, alias.id)
              FROM meta.alias_annotations alias
              WHERE alias.annotation_set_id = alias_set.id), '[]'::jsonb)
          ) ORDER BY alias_set.revision, alias_set.created_at)
        FROM meta.alias_annotation_sets alias_set
        WHERE alias_set.source = keys.source AND alias_set.source_item_id = keys.source_item_id AND alias_set.annotation_track_id = keys.annotation_track_id), '[]'::jsonb) AS alias_annotation_sets,
      COALESCE((SELECT jsonb_agg(to_jsonb(review) ORDER BY review.revision, review.created_at)
        FROM meta.label_analysis_reviews review
        WHERE review.source = keys.source AND review.source_item_id = keys.source_item_id AND review.annotation_track_id = keys.annotation_track_id), '[]'::jsonb) AS label_analysis_reviews,
      COALESCE((SELECT jsonb_agg(to_jsonb(review) ORDER BY review.revision, review.created_at)
        FROM meta.catalog_identity_reviews review
        WHERE review.source = keys.source AND review.source_item_id = keys.source_item_id AND review.annotation_track_id = keys.annotation_track_id), '[]'::jsonb) AS catalog_identity_reviews,
      COALESCE((SELECT jsonb_agg(to_jsonb(execution) ORDER BY execution.stage, execution.revision DESC)
        FROM (SELECT DISTINCT ON (stage) * FROM meta.wizard_stage_execution_records
          WHERE source = keys.source AND source_item_id = keys.source_item_id AND annotation_track_id = keys.annotation_track_id AND status <> 'superseded'
          ORDER BY stage, revision DESC) execution), '[]'::jsonb) AS stage_executions
    FROM item_keys keys
    WHERE ($1::text IS NULL OR keys.source = $1)
    ORDER BY keys.source, keys.source_item_id, keys.ordinal
    `,
    [source ?? null],
  );

  const legacyTracks = result.rows.map((row: Record<string, unknown>) => {
    const metadata = objectValue(row.metadata);
    const labelAnnotations = arrayValue(row.label_annotations);
    const labelPredictions = arrayValue(row.label_predictions);
    const labelRoi = currentLabelRoiContract(labelAnnotations, labelPredictions);
    const visualFeatures = objectValue(metadata?.visual_features);
    const sourceAnalysis = objectValue(visualFeatures?.labelSourceAnalysis);
    const analysis = objectValue(visualFeatures?.labelAnalysis);
    const cvJob = objectValue(visualFeatures?.labelCvJob);
    const ocrRegionSets = arrayValue(row.ocr_region_annotation_sets);
    const associationSets = arrayValue(row.ocr_source_association_sets);
    const analysisReviews = arrayValue(row.label_analysis_reviews);
    const helperContract = buildHelperConfigContract(metadata?.visual_features, row.ocr_evidence, row.ocr_run_id, labelRoi?.prediction ? {
      ...labelRoi.prediction,
      reviewStatus: labelRoi.status,
    } : null);
    const stageSamples = buildStageSamplesV1({
      source: String(row.source), sourceItemId: String(row.source_item_id), helperContract, labelRoi,
      sourceAnalysis, analysis, ocrRegions: ocrRegionSets.at(-1), sourceAssociations: associationSets.at(-1), cvJob,
      finalReview: analysisReviews.at(-1),
      stageExecutions: row.stage_executions,
    });
    const automation = automationFromStageSamples(stageSamples);
    return {
      source: String(row.source),
      sourceItemId: String(row.source_item_id),
      annotationTrack: {
        id: String(row.annotation_track_id), ordinal: Number(row.annotation_track_ordinal),
        name: String(row.annotation_track_name), status: String(row.annotation_track_status),
        executionActor: {
          type: stringValue(row.execution_actor_type),
          sources: arrayValue(row.execution_actor_sources).filter((value): value is string => typeof value === "string"),
        },
        automation,
      },
      metadata: row.metadata ?? null,
      vision: {
        cvMeta: {
          helpers: helperContract,
        },
      },
      labelRoi,
      stageSamples,
      stageExecutions: arrayValue(row.stage_executions),
      labelAnnotations,
      labelPredictions,
      ocrTextAnnotations: arrayValue(row.ocr_text_annotations),
      ocrRegionAnnotationSets: arrayValue(row.ocr_region_annotation_sets),
      ocrSourceAssociationSets: arrayValue(row.ocr_source_association_sets),
      aliasAnnotationSets: arrayValue(row.alias_annotation_sets),
      labelAnalysisReviews: arrayValue(row.label_analysis_reviews),
      catalogIdentityReviews: arrayValue(row.catalog_identity_reviews),
    };
  });

  const itemKeys = [...new Map(legacyTracks.map((track) => [`${track.source}:${track.sourceItemId}`, { source: track.source as SourceName, sourceItemId: track.sourceItemId }])).values()];
  const graphs = await Promise.all(itemKeys.map(({ source: graphSource, sourceItemId }) => getAnnotationGraph(graphSource, sourceItemId)));
  return {
    schemaVersion: 5,
    exportedAt: new Date().toISOString(),
    source: source ?? "all",
    itemCount: graphs.length,
    annotationTrackCount: legacyTracks.length,
    annotationTracks: legacyTracks.map((track) => ({
      source: track.source,
      sourceItemId: track.sourceItemId,
      ...track.annotationTrack,
    })),
    exportPolicy: {
      packageScope: "helper-input-only",
      objectContext: "segmentation-gt-when-reviewed",
      packageType: "classification-gt-when-reviewed",
    },
    items: graphs.map(({ operations: _operations, ...entities }) => ({
      ...entities,
      packages: entities.packages.map(({ geometry: _legacyScopeAlias, ...packageEntity }) => packageEntity),
    })),
    operationTraces: graphs.map((graph) => ({ item: graph.item, operations: graph.operations })),
    legacyTracks,
  };
}

function automationFromStageSamples(samples: ReturnType<typeof buildStageSamplesV1>) {
  const stages = Object.fromEntries(samples.flatMap((sample) => {
    const mode = sample.execution.reviewMode === "accepted" ? "auto"
      : sample.execution.reviewMode === "manual" ? "manual"
      : sample.execution.reviewMode === "corrected" ? "mixed" : null;
    return mode ? [[sample.stage, mode]] : [];
  }));
  const modes = Object.values(stages);
  const autoStages = modes.filter((mode) => mode === "auto").length;
  const manualStages = modes.filter((mode) => mode === "manual").length;
  const mixedStages = modes.filter((mode) => mode === "mixed").length;
  const mode = modes.length === 0 ? null : autoStages === modes.length ? "auto" : manualStages === modes.length ? "manual" : "mixed";
  return { mode, autoStages, manualStages, mixedStages, classifiedStages: modes.length,
    automationRate: modes.length ? Math.round((autoStages / modes.length) * 1000) / 1000 : null, stages };
}

function currentLabelRoiContract(annotations: unknown[], predictions: unknown[]) {
  const annotationRow = objectValue(annotations.at(-1));
  if (!annotationRow) return null;
  const suggestionId = stringValue(annotationRow.suggestion_id);
  const predictionRow = suggestionId ? predictions.map(objectValue).find((item) => stringValue(item?.id) === suggestionId) ?? null : null;
  const predictionGeometry = normalizeQuadGeometry(predictionRow?.geometry, predictionRow?.bbox);
  const annotationGeometry = stringValue(annotationRow.status) === "reviewed" ? normalizeQuadGeometry(annotationRow.geometry, annotationRow.bbox) : null;
  const prediction = predictionRow && predictionGeometry ? {
    id: String(predictionRow.id),
    helperRunId: stringValue(predictionRow.helper_run_id),
    candidateId: stringValue(predictionRow.helper_candidate_id),
    roi: predictionGeometry.bbox,
    geometry: predictionGeometry,
    confidence: numberValue(predictionRow.confidence),
    algorithm: predictionAlgorithm(predictionRow),
    createdAt: dateValue(predictionRow.created_at),
  } : null;
  const annotation = annotationGeometry ? {
    id: String(annotationRow.id),
    revision: numberValue(annotationRow.revision) ?? 1,
    roi: annotationGeometry.bbox,
    geometry: annotationGeometry,
    reviewedAt: dateValue(annotationRow.updated_at),
    reviewedBy: stringValue(annotationRow.reviewed_by),
  } : null;
  const iou = prediction && annotation ? rectIoU(prediction.roi, annotation.roi) : null;
  return {
    schemaVersion: 2,
    prediction,
    annotation,
    status: annotation ? "reviewed" : stringValue(annotationRow.status) === "no-object" ? "no-label" : "invalid-image",
    reviewed: annotation !== null,
    roiEdited: predictionGeometry && annotationGeometry ? !sameQuad(predictionGeometry, annotationGeometry) : false,
    source: annotation ? prediction ? sameQuad(predictionGeometry, annotationGeometry) ? "auto" : "corrected" : "manual" : null,
    iou,
    labelRoiGt: annotation !== null,
  };
}

function predictionAlgorithm(row: Record<string, unknown>) {
  const snapshot = objectValue(row.config_snapshot);
  return {
    id: stringValue(row.detector_type) ?? "unknown",
    version: stringValue(row.detector_version),
    params: objectValue(snapshot?.params) ?? snapshot ?? {},
    defaultParams: objectValue(snapshot?.defaultParams),
  };
}

function rectIoU(left: Record<string, unknown>, right: Record<string, unknown>) {
  const lx=numberValue(left.x)??0,ly=numberValue(left.y)??0,lw=Math.max(0,numberValue(left.width)??0),lh=Math.max(0,numberValue(left.height)??0);
  const rx=numberValue(right.x)??0,ry=numberValue(right.y)??0,rw=Math.max(0,numberValue(right.width)??0),rh=Math.max(0,numberValue(right.height)??0);
  const intersection=Math.max(0,Math.min(lx+lw,rx+rw)-Math.max(lx,rx))*Math.max(0,Math.min(ly+lh,ry+rh)-Math.max(ly,ry));
  const union=lw*lh+rw*rh-intersection;
  return union>0?Math.round(intersection/union*1_000_000)/1_000_000:0;
}

function stringValue(value: unknown) { return typeof value === "string" ? value : null; }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && Number.isFinite(Number(value)) ? Number(value) : null; }
function dateValue(value: unknown) { return value instanceof Date ? value.toISOString() : stringValue(value); }

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
