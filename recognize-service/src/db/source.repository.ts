import { pool } from "./pool.js";
import type { SourceItem, SourceName } from "../shared/types.js";

export type InventorySource = SourceName | "all";

export type InventoryItemRow = SourceItem & {
  recognitionTags: string[];
  annotationTracks: Array<{ id: string; ordinal: number; name: string; status: string; previewBbox: Record<string, unknown> | null; progress: AnnotationTrackProgress }>;
  annotationWorkflow: { status: "not-started" | "in-progress" | "complete"; executionActor: AnnotationExecutionActor; automation: AnnotationAutomationSummary };
  metadata: {
    id: string;
    status: string;
    aliasesCount: number;
    normalizedTokensCount: number;
    hasCvMeta: boolean;
    generationVersion: string | null;
    sourceHash: string | null;
    updatedAt: Date | null;
    annotationStatus: string | null;
    hasGeneratedLabelRoi: boolean;
    hasReviewedLabelRoi: boolean;
    hasBackendOcr: boolean;
    hasReviewedOcrText: boolean;
    catalogIdentityStatus: string | null;
    catalogIdentityRevision: number | null;
  } | null;
  latestJob: {
    id: string;
    type: string | null;
    status: string;
    createdAt: Date;
    completedAt: Date | null;
    error: string | null;
  } | null;
};

export type AnnotationTrackProgress = {
  completedStages: number;
  totalStages: 11;
  nextStage: AnnotationWizardStage | null;
  status: "not-started" | "in-progress" | "complete";
  executionActor: AnnotationExecutionActor;
  automation: AnnotationAutomationSummary;
};

export type AnnotationWizardStage = "package" | "label" | "bottle" | "ocr" | "mask" | "morphology" | "components" | "elements" | "contours" | "palette" | "summary";
export type AnnotationExecutionActor = { type: "human" | "ml-agent" | "hybrid" | null; sources: string[] };
export type AnnotationAutomationMode = "auto" | "manual" | "mixed" | null;
export type AnnotationAutomationSummary = {
  mode: AnnotationAutomationMode;
  autoStages: number;
  manualStages: number;
  mixedStages: number;
  classifiedStages: number;
  automationRate: number | null;
  stages: Partial<Record<AnnotationWizardStage, Exclude<AnnotationAutomationMode, null>>>;
};

export type AnnotationSummaryRow = {
  source: InventorySource;
  totalItems: number;
  withProposal: number;
  missingProposal: number;
  needsReview: number;
  reviewed: number;
  reviewedBbox: number;
  noLabel: number;
  invalidImage: number;
  noAnnotation: number;
  readyForExport: number;
  withBackendOcr: number;
  withReviewedOcrText: number;
  needsOcr: number;
  needsOcrReview: number;
  textReadyForExport: number;
  withLabelAnalysis: number;
  needsLabelAnalysisReview: number;
  labelAnalysisAccepted: number;
  labelAnalysisNeedsTuning: number;
  labelAnalysisRejected: number;
  withCatalogIdentity: number;
  needsCatalogIdentity: number;
  catalogIdentityConfirmed: number;
  catalogIdentityCorrected: number;
  catalogIdentityNoMatch: number;
  catalogIdentityAmbiguous: number;
};

export async function getSourceItem(source: SourceName, sourceItemId: string): Promise<SourceItem | null> {
  if (source === "svoe_vino") return readSvoeVinoItem(sourceItemId);
  if (source === "roskachestvo") return readRoskachestvoItem(sourceItemId);
  return null;
}

export async function listSourceItems(source: SourceName, limit: number): Promise<SourceItem[]> {
  return listSourceItemsInternal(source, limit, { missingCvMeta: false });
}

export async function findCatalogCandidates(input: {
  terms: string[];
  years: string[];
  barcodes: string[];
  include: { source: SourceName; sourceItemId: string };
  limit?: number;
}): Promise<SourceItem[]> {
  const patterns = [...new Set(input.terms.map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 3))]
    .slice(0, 16).map((term) => `%${term}%`);
  const years = [...new Set(input.years.filter((value) => /^(?:19|20)\d{2}$/.test(value)))].slice(0, 6);
  const barcodes = [...new Set(input.barcodes.filter((value) => /^\d{8,14}$/.test(value)))].slice(0, 6);
  const result = await pool.query(
    `
    WITH candidates AS (
      SELECT catalog.*,
        lower(concat_ws(' ', catalog.source_item_id, catalog.title, catalog.manufacturer,
          catalog.category_name, catalog.region_name, catalog.year::text, catalog.barcode,
          catalog.color, catalog.description, COALESCE(m.aliases::text, ''), COALESCE(m.normalized_tokens::text, ''))) AS search_text
      FROM (${inventoryCatalogSql()}) AS catalog
      LEFT JOIN meta.items AS m
        ON m.source = catalog.source
       AND m.source_item_id = catalog.source_item_id
    )
    SELECT candidates.*
    FROM candidates
    WHERE (
      candidates.search_text LIKE ANY($1::text[])
      OR candidates.year::text = ANY($2::text[])
      OR candidates.barcode = ANY($3::text[])
      OR (candidates.source = $4 AND candidates.source_item_id = $5)
    )
    ORDER BY
      (candidates.source = $4 AND candidates.source_item_id = $5) DESC,
      (candidates.barcode = ANY($3::text[])) DESC,
      (SELECT COUNT(*) FROM unnest($1::text[]) AS pattern WHERE candidates.search_text LIKE pattern) DESC,
      (candidates.year::text = ANY($2::text[])) DESC,
      lower(COALESCE(candidates.title, '')), candidates.source, candidates.source_item_id
    LIMIT $6
    `,
    [patterns, years, barcodes, input.include.source, input.include.sourceItemId, Math.max(1, Math.min(input.limit ?? 250, 500))],
  );
  return result.rows.map(rowToCatalogSourceItem);
}

export async function listSourceItemsForMetaGeneration(
  source: SourceName,
  limit: number,
  options: { missingCvMeta?: boolean; pipelineVersion: string; force?: boolean },
): Promise<SourceItem[]> {
  return listSourceItemsInternal(source, limit, options);
}

export async function listSourceItemsForMetaGenerationScope(
  source: SourceName | "all",
  limit: number,
  options: { missingCvMeta?: boolean; pipelineVersion: string; force?: boolean },
): Promise<SourceItem[]> {
  if (source !== "all") return listSourceItemsForMetaGeneration(source, limit, options);
  const [svoeVino, roskachestvo] = await Promise.all([
    listSourceItemsForMetaGeneration("svoe_vino", limit, options),
    listSourceItemsForMetaGeneration("roskachestvo", limit, options),
  ]);
  return [...svoeVino, ...roskachestvo]
    .sort((left, right) => {
      const titleOrder = left.title.localeCompare(right.title, "ru");
      if (titleOrder) return titleOrder;
      return `${left.source}:${left.sourceItemId}`.localeCompare(`${right.source}:${right.sourceItemId}`);
    })
    .slice(0, limit);
}

export async function countSourceItemsForMetaGeneration(
  source: SourceName,
  options: { missingCvMeta?: boolean; pipelineVersion: string; force?: boolean },
) {
  const metaFilter = buildMetaFilter(options, 1);
  if (source === "svoe_vino") {
    const result = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM svoe_vino.wines AS w
      LEFT JOIN meta.items AS m
        ON m.source = 'svoe_vino'
       AND m.source_item_id = COALESCE(w.external_id, w.slug, w.id::text)
      ${metaFilter.sql}
      `,
      metaFilter.values,
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  const result = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM roskachestvo.products AS p
    LEFT JOIN meta.items AS m
      ON m.source = 'roskachestvo'
     AND m.source_item_id = p.rskrf_product_id
    ${metaFilter.sql}
    `,
    metaFilter.values,
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function countSourceItemsForMetaGenerationScope(
  source: SourceName | "all",
  options: { missingCvMeta?: boolean; pipelineVersion: string; force?: boolean },
) {
  if (source !== "all") return countSourceItemsForMetaGeneration(source, options);
  const [svoeVino, roskachestvo] = await Promise.all([
    countSourceItemsForMetaGeneration("svoe_vino", options),
    countSourceItemsForMetaGeneration("roskachestvo", options),
  ]);
  return svoeVino + roskachestvo;
}

export async function listInventoryItems(params: {
  source: InventorySource;
  search?: string;
  metaStatus?: string;
  cvMeta?: "all" | "present" | "missing";
  annotationStatus?: string;
  executionActor?: "human" | "ml-agent" | "hybrid";
  automationMode?: "manual" | "auto" | "mixed";
  recognitionTag?: string;
  analysisStatus?: string;
  catalogIdentityStatus?: string;
  firstPerInitial?: boolean;
  perInitialLimit?: number;
  limit: number;
  offset: number;
}) {
  const values: unknown[] = [];
  const where: string[] = [];

  if (params.source !== "all") {
    values.push(params.source);
    where.push(`catalog.source = $${values.length}`);
  }

  if (params.search) {
    values.push(`%${params.search}%`);
    where.push(`(
      catalog.source_item_id ILIKE $${values.length}
      OR catalog.title ILIKE $${values.length}
      OR catalog.manufacturer ILIKE $${values.length}
      OR catalog.category_name ILIKE $${values.length}
      OR catalog.barcode ILIKE $${values.length}
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(m.aliases, '[]'::jsonb)) AS alias(value)
        WHERE alias.value ILIKE $${values.length}
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(COALESCE(m.normalized_tokens, '[]'::jsonb)) AS token(value)
        WHERE token.value ILIKE $${values.length}
      )
    )`);
  }

  if (params.metaStatus) {
    if (params.metaStatus === "missing") {
      where.push("m.id IS NULL");
    } else {
      values.push(params.metaStatus);
      where.push(`m.status = $${values.length}`);
    }
  }

  if (params.cvMeta === "present") {
    where.push("m.visual_features->'cvMeta' IS NOT NULL");
  } else if (params.cvMeta === "missing") {
    where.push("(m.id IS NULL OR m.visual_features->'cvMeta' IS NULL)");
  }

  if (params.annotationStatus) {
    if (["not-started", "in-progress", "complete"].includes(params.annotationStatus)) {
      values.push(params.annotationStatus);
      where.push(`COALESCE(track_summary.workflow_status, 'not-started') = $${values.length}`);
    } else if (params.annotationStatus === "missing") {
      where.push(`(
        latest_annotation.id IS NULL
        AND latest_proposal.id IS NULL
        AND m.annotations->'labelAnnotation' IS NULL
        AND m.visual_features->'cvMeta'->'label'->'roi' IS NULL
      )`);
    } else if (params.annotationStatus === "needs-review") {
      where.push(`COALESCE(
        CASE
          WHEN latest_annotation.status = 'reviewed' THEN 'reviewed'
          WHEN latest_annotation.status = 'no-object' THEN 'no-label'
          WHEN latest_annotation.status = 'rejected' THEN 'invalid-image'
          ELSE NULL
        END,
        CASE WHEN latest_proposal.id IS NOT NULL THEN 'needs-review' ELSE NULL END,
        m.annotations->'labelAnnotation'->>'status',
        CASE WHEN m.visual_features->'cvMeta'->'label'->'roi' IS NOT NULL THEN 'needs-review' ELSE NULL END
      ) = 'needs-review'`);
    } else if (params.annotationStatus === "needs-ocr") {
      where.push(`(
        latest_annotation.status = 'reviewed'
        AND latest_annotation.bbox IS NOT NULL
        AND latest_ocr_run.id IS NULL
      )`);
    } else if (params.annotationStatus === "needs-ocr-review") {
      where.push(`(
        latest_annotation.status = 'reviewed'
        AND latest_annotation.bbox IS NOT NULL
        AND latest_ocr_run.id IS NOT NULL
        AND latest_ocr_review.id IS NULL
      )`);
    } else if (params.annotationStatus === "ready-for-export") {
      where.push(`(
        latest_annotation.status = 'reviewed'
        AND latest_annotation.bbox IS NOT NULL
        AND latest_ocr_review.id IS NOT NULL
      )`);
    } else {
      values.push(params.annotationStatus);
      where.push(`COALESCE(
        CASE
          WHEN latest_annotation.status = 'reviewed' THEN 'reviewed'
          WHEN latest_annotation.status = 'no-object' THEN 'no-label'
          WHEN latest_annotation.status = 'rejected' THEN 'invalid-image'
          ELSE NULL
        END,
        m.annotations->'labelAnnotation'->>'status',
        ''
      ) = $${values.length}`);
    }
  }
  if (params.analysisStatus) {
    if (params.analysisStatus === "missing") where.push("m.visual_features->'labelAnalysis' IS NULL");
    else if (params.analysisStatus === "needs-review") where.push(`m.visual_features->'labelAnalysis' IS NOT NULL AND (latest_analysis_review.job_id IS NULL OR latest_analysis_review.job_id::text <> m.visual_features->'labelAnalysis'->>'jobId' OR latest_analysis_review.config_hash <> m.visual_features->'labelAnalysis'->'provenance'->>'configHash')`);
    else { values.push(params.analysisStatus); where.push(`latest_analysis_review.status = $${values.length} AND latest_analysis_review.job_id::text = m.visual_features->'labelAnalysis'->>'jobId' AND latest_analysis_review.config_hash = m.visual_features->'labelAnalysis'->'provenance'->>'configHash'`); }
  }
  if (params.catalogIdentityStatus) {
    if (params.catalogIdentityStatus === "missing") where.push("m.visual_features->'labelAnalysis' IS NOT NULL AND latest_catalog_identity.id IS NULL");
    else {
      values.push(params.catalogIdentityStatus);
      where.push(`latest_catalog_identity.status = $${values.length}`);
    }
  }
  if (params.executionActor) {
    values.push(params.executionActor);
    where.push(`track_summary.workflow_actor_type = $${values.length}`);
  }
  if (params.automationMode) {
    values.push(params.automationMode);
    where.push(`track_summary.workflow_automation_mode = $${values.length}`);
  }
  if (params.recognitionTag) {
    values.push(params.recognitionTag);
    where.push(`recognition_tag_summary.tags ? $${values.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const fromSql = `
    FROM (${inventoryCatalogSql()}) AS catalog
    LEFT JOIN meta.items AS m
      ON m.source = catalog.source
     AND m.source_item_id = catalog.source_item_id
    LEFT JOIN LATERAL (
      SELECT id, bbox, status, source_kind, updated_at
      FROM meta.image_annotations AS a
      WHERE a.source = catalog.source
        AND a.source_item_id = catalog.source_item_id
        AND a.annotation_type = 'label-bbox'
      ORDER BY a.updated_at DESC
      LIMIT 1
    ) AS latest_annotation ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, bbox, confidence, candidate_score, created_at
      FROM meta.detection_proposals AS p
      WHERE p.source = catalog.source
        AND p.source_item_id = catalog.source_item_id
      ORDER BY p.created_at DESC
      LIMIT 1
    ) AS latest_proposal ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, status, created_at
      FROM meta.ocr_runs AS r
      WHERE r.source = catalog.source
        AND r.source_item_id = catalog.source_item_id
      ORDER BY r.created_at DESC
      LIMIT 1
    ) AS latest_ocr_run ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, status, updated_at
      FROM meta.ocr_text_annotations AS r
      WHERE r.source = catalog.source
        AND r.source_item_id = catalog.source_item_id
      ORDER BY r.updated_at DESC
      LIMIT 1
    ) AS latest_ocr_review ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, job_type, status, created_at, completed_at, error
      FROM meta.generation_jobs AS j
      WHERE j.source = catalog.source
        AND j.source_item_id = catalog.source_item_id
        AND j.job_type IS NOT NULL
      ORDER BY j.created_at DESC
      LIMIT 1
    ) AS latest_job ON TRUE
    LEFT JOIN LATERAL (
      SELECT job_id, config_hash, status FROM meta.label_analysis_reviews AS r
      WHERE r.source = catalog.source AND r.source_item_id = catalog.source_item_id
      ORDER BY r.revision DESC LIMIT 1
    ) AS latest_analysis_review ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, revision, status FROM meta.catalog_identity_reviews AS r
      WHERE r.source = catalog.source AND r.source_item_id = catalog.source_item_id
      ORDER BY r.revision DESC LIMIT 1
    ) AS latest_catalog_identity ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_agg(DISTINCT tag.value ORDER BY tag.value), '[]'::jsonb) AS tags
      FROM meta.annotation_meta AS annotation_meta
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(annotation_meta.tags, '[]'::jsonb)) AS tag(value)
      WHERE annotation_meta.source = catalog.source
        AND annotation_meta.source_item_id = catalog.source_item_id
        AND annotation_meta.target_type = 'item'
        AND annotation_meta.target_id IS NULL
        AND annotation_meta.deleted_at IS NULL
        AND (
          (annotation_meta.tags ? 'recognition-list' AND tag.value <> 'recognition-list')
          OR tag.value = 'multipackage'
        )
    ) AS recognition_tag_summary ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(jsonb_build_object(
          'id', progress.id, 'ordinal', progress.ordinal, 'name', progress.name, 'status', progress.track_status,
          'previewBbox', progress.preview_bbox,
          'progress', jsonb_build_object(
            'completedStages', progress.completed_stages, 'totalStages', 11,
            'nextStage', progress.next_stage, 'status', progress.progress_status,
            'executionActor', jsonb_build_object('type', progress.execution_actor_type, 'sources', progress.execution_actor_sources),
            'automation', jsonb_build_object(
              'mode', progress.automation_mode, 'autoStages', progress.auto_stages,
              'manualStages', progress.manual_stages, 'mixedStages', progress.mixed_stages,
              'classifiedStages', progress.classified_stages,
              'automationRate', CASE WHEN progress.classified_stages > 0 THEN round(progress.auto_stages::numeric / progress.classified_stages, 3) ELSE NULL END,
              'stages', progress.automation_stages
            )
          )
        ) ORDER BY progress.ordinal) AS items,
        CASE
          WHEN COUNT(*) FILTER (WHERE progress.progress_status <> 'not-started') = 0 THEN 'not-started'
          WHEN BOOL_AND(progress.progress_status = 'complete') THEN 'complete'
          ELSE 'in-progress'
        END AS workflow_status,
        CASE
          WHEN BOOL_OR(progress.execution_actor_type = 'hybrid')
            OR (BOOL_OR(progress.execution_actor_type = 'human') AND BOOL_OR(progress.execution_actor_type = 'ml-agent')) THEN 'hybrid'
          WHEN BOOL_OR(progress.execution_actor_type = 'ml-agent') THEN 'ml-agent'
          WHEN BOOL_OR(progress.execution_actor_type = 'human') THEN 'human'
          ELSE NULL
        END AS workflow_actor_type,
        COALESCE(SUM(progress.auto_stages), 0)::int AS workflow_auto_stages,
        COALESCE(SUM(progress.manual_stages), 0)::int AS workflow_manual_stages,
        COALESCE(SUM(progress.mixed_stages), 0)::int AS workflow_mixed_stages,
        COALESCE(SUM(progress.classified_stages), 0)::int AS workflow_classified_stages,
        CASE
          WHEN COALESCE(SUM(progress.classified_stages), 0) = 0 THEN NULL
          WHEN SUM(progress.classified_stages) < SUM(progress.completed_stages) THEN NULL
          WHEN SUM(progress.auto_stages) = SUM(progress.classified_stages) THEN 'auto'
          WHEN SUM(progress.manual_stages) = SUM(progress.classified_stages) THEN 'manual'
          ELSE 'mixed'
        END AS workflow_automation_mode
      FROM (
        SELECT stages.*,
          (stages.package_done::int + stages.label_done::int + stages.bottle_done::int + stages.ocr_done::int
            + stages.mask_done::int + stages.morphology_done::int + stages.components_done::int
            + stages.elements_done::int + stages.contours_done::int + stages.palette_done::int + stages.summary_done::int) AS completed_stages,
          CASE
            WHEN NOT stages.package_done THEN 'package'
            WHEN NOT stages.label_done THEN 'label'
            WHEN NOT stages.bottle_done THEN 'bottle'
            WHEN NOT stages.ocr_done THEN 'ocr'
            WHEN NOT stages.mask_done THEN 'mask'
            WHEN NOT stages.morphology_done THEN 'morphology'
            WHEN NOT stages.components_done THEN 'components'
            WHEN NOT stages.elements_done THEN 'elements'
            WHEN NOT stages.contours_done THEN 'contours'
            WHEN NOT stages.palette_done THEN 'palette'
            WHEN NOT stages.summary_done THEN 'summary'
            ELSE NULL
          END AS next_stage,
          CASE
            WHEN NOT stages.has_activity THEN 'not-started'
            WHEN stages.package_done AND stages.label_done AND stages.bottle_done AND stages.ocr_done
              AND stages.mask_done AND stages.morphology_done AND stages.components_done AND stages.elements_done
              AND stages.contours_done AND stages.palette_done AND stages.summary_done THEN 'complete'
            ELSE 'in-progress'
          END AS progress_status,
          CASE
            WHEN stages.classified_stages = 0 THEN NULL
            WHEN stages.classified_stages < (stages.package_done::int + stages.label_done::int + stages.bottle_done::int + stages.ocr_done::int
              + stages.mask_done::int + stages.morphology_done::int + stages.components_done::int + stages.elements_done::int
              + stages.contours_done::int + stages.palette_done::int + stages.summary_done::int) THEN NULL
            WHEN stages.auto_stages = stages.classified_stages THEN 'auto'
            WHEN stages.manual_stages = stages.classified_stages THEN 'manual'
            ELSE 'mixed'
          END AS automation_mode
        FROM (
          SELECT facts.*,
            facts.package_count > 0 AS package_done,
            facts.label_count > 0 AND facts.reviewed_label_count = facts.label_count AS label_done,
            facts.package_count > 0 AND facts.reviewed_object_count = facts.package_count AS bottle_done,
            facts.label_count > 0 AND facts.ocr_complete_count = facts.label_count AS ocr_done,
            facts.label_count > 0 AND facts.mask_complete_count = facts.label_count AS mask_done,
            facts.label_count > 0 AND facts.morphology_complete_count = facts.label_count AS morphology_done,
            facts.label_count > 0 AND facts.components_complete_count = facts.label_count AS components_done,
            facts.label_count > 0 AND facts.elements_complete_count = facts.label_count AS elements_done,
            facts.label_count > 0 AND facts.contours_complete_count = facts.label_count AS contours_done,
            facts.label_count > 0 AND facts.palette_complete_count = facts.label_count AS palette_done,
            (facts.track_status = 'reviewed' OR facts.summary_reviewed) AS summary_done,
            facts.package_count > 0 AS has_activity
          FROM (
            SELECT track.id, track.ordinal, track.name, track.status AS track_status,
              track.execution_actor_type, track.execution_actor_sources,
              automation.stage_modes AS automation_stages,
              automation.auto_stages, automation.manual_stages, automation.mixed_stages, automation.classified_stages,
              (SELECT annotation.bbox FROM meta.image_annotations annotation
                WHERE annotation.annotation_track_id = track.id AND annotation.annotation_type = 'label-bbox'
                ORDER BY annotation.revision DESC, annotation.updated_at DESC LIMIT 1) AS preview_bbox,
              COUNT(DISTINCT package.id)::int AS package_count,
              COUNT(DISTINCT package.id) FILTER (WHERE package.object_status = 'reviewed')::int AS reviewed_object_count,
              COUNT(DISTINCT label.id)::int AS label_count,
              COUNT(DISTINCT label.id) FILTER (WHERE label.status = 'reviewed' AND label.geometry_review_status = 'reviewed')::int AS reviewed_label_count,
              COUNT(DISTINCT label.id) FILTER (WHERE EXISTS (SELECT 1 FROM meta.annotation_ocr ocr WHERE ocr.label_id=label.id AND ocr.deleted_at IS NULL)
                OR EXISTS (SELECT 1 FROM meta.annotation_operations operation WHERE operation.scope_type='label' AND operation.scope_id=label.id AND operation.operation_type='run_ocr' AND operation.operation_status='reviewed'))::int AS ocr_complete_count,
              COUNT(DISTINCT label.id) FILTER (WHERE label.cv_job #>> '{workflow,checkpoints,mask,status}' IN ('valid','saved'))::int AS mask_complete_count,
              COUNT(DISTINCT label.id) FILTER (WHERE label.cv_job #>> '{workflow,checkpoints,morphology,status}' IN ('valid','saved'))::int AS morphology_complete_count,
              COUNT(DISTINCT label.id) FILTER (WHERE label.cv_job #>> '{workflow,checkpoints,components,status}' IN ('valid','saved'))::int AS components_complete_count,
              COUNT(DISTINCT label.id) FILTER (WHERE label.cv_job #>> '{workflow,checkpoints,elements,status}' IN ('valid','saved'))::int AS elements_complete_count,
              COUNT(DISTINCT label.id) FILTER (WHERE label.cv_job #>> '{workflow,checkpoints,contours,status}' IN ('valid','saved'))::int AS contours_complete_count,
              COUNT(DISTINCT label.id) FILTER (WHERE label.cv_job #>> '{workflow,checkpoints,palette,status}' IN ('valid','saved'))::int AS palette_complete_count,
              EXISTS (SELECT 1 FROM meta.wizard_stage_executions execution WHERE execution.annotation_track_id=track.id AND execution.stage='summary' AND execution.status='reviewed') AS summary_reviewed
            FROM meta.annotation_tracks track
            LEFT JOIN meta.annotation_packages package ON package.legacy_annotation_track_id=track.id AND package.deleted_at IS NULL
            LEFT JOIN meta.annotation_labels label ON label.package_id=package.id AND label.deleted_at IS NULL
            LEFT JOIN LATERAL (
              SELECT
                COALESCE(jsonb_object_agg(latest.stage, latest.mode), '{}'::jsonb) AS stage_modes,
                COUNT(*) FILTER (WHERE latest.mode = 'auto')::int AS auto_stages,
                COUNT(*) FILTER (WHERE latest.mode = 'manual')::int AS manual_stages,
                COUNT(*) FILTER (WHERE latest.mode = 'mixed')::int AS mixed_stages,
                COUNT(*)::int AS classified_stages
              FROM (
                SELECT DISTINCT ON (execution.stage) execution.stage,
                  CASE
                    WHEN execution.review_mode = 'accepted' THEN 'auto'
                    WHEN execution.review_mode = 'manual' THEN 'manual'
                    WHEN execution.review_mode = 'corrected' THEN 'mixed'
                    ELSE NULL
                  END AS mode
                FROM meta.wizard_stage_executions execution
                WHERE execution.annotation_track_id = track.id
                  AND execution.status = 'reviewed'
                  AND execution.review_mode IS NOT NULL
                ORDER BY execution.stage, execution.revision DESC
              ) latest
            ) automation ON TRUE
            WHERE track.source=catalog.source AND track.source_item_id=catalog.source_item_id AND track.status <> 'archived'
            GROUP BY track.id, automation.stage_modes, automation.auto_stages, automation.manual_stages, automation.mixed_stages, automation.classified_stages
          ) facts
        ) stages
      ) progress
    ) AS track_summary ON TRUE
    ${whereSql}
  `;

  const perInitialLimit = Math.max(1, Math.min(params.perInitialLimit ?? 3, 100));
  const count = params.firstPerInitial
    ? await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM (
         SELECT ROW_NUMBER() OVER (
           PARTITION BY COALESCE(NULLIF(upper(substr(btrim(COALESCE(catalog.title, '')), 1, 1)), ''), '#')
           ORDER BY lower(COALESCE(catalog.title, '')), catalog.source, catalog.source_item_id
         ) AS initial_rank
         ${fromSql}
       ) AS ranked_inventory
       WHERE initial_rank <= $${values.length + 1}`,
      [...values, perInitialLimit],
    )
    : await pool.query(`SELECT COUNT(*)::int AS total ${fromSql}`, values);
  let initialLimitParameter: number | null = null;
  if (params.firstPerInitial) {
    values.push(perInitialLimit);
    initialLimitParameter = values.length;
  }
  values.push(params.limit, params.offset);
  const rows = await pool.query(
    `
    WITH inventory_rows AS (
      SELECT
        catalog.*,
        m.id AS metadata_id,
        m.status AS metadata_status,
        jsonb_array_length(COALESCE(m.aliases, '[]'::jsonb)) AS aliases_count,
        jsonb_array_length(COALESCE(m.normalized_tokens, '[]'::jsonb)) AS normalized_tokens_count,
        (m.visual_features->'cvMeta' IS NOT NULL) AS has_cv_meta,
        m.generation_version,
        m.source_hash,
        m.updated_at AS metadata_updated_at,
        COALESCE(
          CASE
            WHEN latest_annotation.status = 'reviewed' THEN 'reviewed'
            WHEN latest_annotation.status = 'no-object' THEN 'no-label'
            WHEN latest_annotation.status = 'rejected' THEN 'invalid-image'
            ELSE NULL
          END,
          CASE WHEN latest_proposal.id IS NOT NULL AND latest_annotation.id IS NULL THEN 'needs-review' ELSE NULL END,
          m.annotations->'labelAnnotation'->>'status',
          CASE WHEN m.visual_features->'cvMeta'->'label'->'roi' IS NOT NULL THEN 'needs-review' ELSE NULL END
        ) AS annotation_status,
        (
          latest_proposal.bbox IS NOT NULL
          OR
          (m.annotations->'labelAnnotation'->'prediction'->'roi' IS NOT NULL OR m.annotations->'labelAnnotation'->'generated'->'bbox' IS NOT NULL)
          OR m.visual_features->'cvMeta'->'label'->'roi' IS NOT NULL
        ) AS has_generated_label_roi,
        (
          latest_annotation.bbox IS NOT NULL
          OR m.annotations->'labelAnnotation'->'annotation'->'roi' IS NOT NULL
          OR m.annotations->'labelAnnotation'->'reviewed'->'bbox' IS NOT NULL
        ) AS has_reviewed_label_roi,
        (latest_ocr_run.id IS NOT NULL) AS has_backend_ocr,
        (latest_ocr_review.id IS NOT NULL) AS has_reviewed_ocr_text,
        latest_catalog_identity.status AS catalog_identity_status,
        latest_catalog_identity.revision AS catalog_identity_revision,
        latest_job.id AS latest_job_id,
        latest_job.job_type AS latest_job_type,
        latest_job.status AS latest_job_status,
        latest_job.created_at AS latest_job_created_at,
        latest_job.completed_at AS latest_job_completed_at,
        latest_job.error AS latest_job_error,
        COALESCE(track_summary.items, '[]'::jsonb) AS annotation_tracks
        ,COALESCE(recognition_tag_summary.tags, '[]'::jsonb) AS recognition_tags
        ,COALESCE(track_summary.workflow_status, 'not-started') AS annotation_workflow_status
        ,track_summary.workflow_actor_type AS annotation_workflow_actor_type
        ,track_summary.workflow_automation_mode AS annotation_workflow_automation_mode
        ,track_summary.workflow_auto_stages AS annotation_workflow_auto_stages
        ,track_summary.workflow_manual_stages AS annotation_workflow_manual_stages
        ,track_summary.workflow_mixed_stages AS annotation_workflow_mixed_stages
        ,track_summary.workflow_classified_stages AS annotation_workflow_classified_stages
      ${fromSql}
    ), ranked_inventory AS (
      SELECT inventory_rows.*,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(NULLIF(upper(substr(btrim(COALESCE(inventory_rows.title, '')), 1, 1)), ''), '#')
          ORDER BY lower(COALESCE(inventory_rows.title, '')), inventory_rows.source, inventory_rows.source_item_id
        ) AS initial_rank
      FROM inventory_rows
    )
    SELECT * FROM ranked_inventory
    ${initialLimitParameter ? `WHERE initial_rank <= $${initialLimitParameter}` : ""}
    ORDER BY COALESCE(NULLIF(upper(substr(btrim(COALESCE(title, '')), 1, 1)), ''), '#'), lower(COALESCE(title, '')), source, source_item_id
    LIMIT $${values.length - 1} OFFSET $${values.length}
    `,
    values,
  );

  return { rows: rows.rows.map(rowToInventoryItem), total: Number(count.rows[0]?.total ?? 0) };
}

export async function getAnnotationSummary(source: InventorySource): Promise<AnnotationSummaryRow> {
  const values: unknown[] = [];
  const where: string[] = [];
  if (source !== "all") {
    values.push(source);
    where.push(`catalog.source = $${values.length}`);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const result = await pool.query(
    `
    WITH annotated AS (
      SELECT
        catalog.source,
        latest_annotation.id AS annotation_id,
        latest_annotation.bbox AS annotation_bbox,
        latest_proposal.id AS proposal_id,
        (
          latest_proposal.bbox IS NOT NULL
          OR m.annotations->'labelAnnotation'->'prediction'->'roi' IS NOT NULL
          OR m.annotations->'labelAnnotation'->'generated'->'bbox' IS NOT NULL
          OR m.visual_features->'cvMeta'->'label'->'roi' IS NOT NULL
        ) AS has_generated_label_roi,
        (
          latest_annotation.bbox IS NOT NULL
          OR m.annotations->'labelAnnotation'->'annotation'->'roi' IS NOT NULL
          OR m.annotations->'labelAnnotation'->'reviewed'->'bbox' IS NOT NULL
        ) AS has_reviewed_label_roi,
        (latest_ocr_run.id IS NOT NULL) AS has_backend_ocr,
        (latest_ocr_review.id IS NOT NULL) AS has_reviewed_ocr_text,
        (m.visual_features->'labelAnalysis' IS NOT NULL) AS has_label_analysis,
        CASE
          WHEN latest_analysis_review.job_id::text = m.visual_features->'labelAnalysis'->>'jobId'
           AND latest_analysis_review.config_hash = m.visual_features->'labelAnalysis'->'provenance'->>'configHash'
          THEN latest_analysis_review.status
          ELSE NULL
        END AS label_analysis_review_status,
        latest_catalog_identity.status AS catalog_identity_status,
        COALESCE(
          CASE
            WHEN latest_annotation.status = 'reviewed' THEN 'reviewed'
            WHEN latest_annotation.status = 'no-object' THEN 'no-label'
            WHEN latest_annotation.status = 'rejected' THEN 'invalid-image'
            ELSE NULL
          END,
          CASE WHEN latest_proposal.id IS NOT NULL AND latest_annotation.id IS NULL THEN 'needs-review' ELSE NULL END,
          m.annotations->'labelAnnotation'->>'status',
          CASE WHEN m.visual_features->'cvMeta'->'label'->'roi' IS NOT NULL THEN 'needs-review' ELSE NULL END,
          'missing'
        ) AS annotation_status
      FROM (${inventoryCatalogSql()}) AS catalog
      LEFT JOIN meta.items AS m
        ON m.source = catalog.source
       AND m.source_item_id = catalog.source_item_id
      LEFT JOIN LATERAL (
        SELECT id, bbox, status, updated_at
        FROM meta.image_annotations AS a
        WHERE a.source = catalog.source
          AND a.source_item_id = catalog.source_item_id
          AND a.annotation_type = 'label-bbox'
        ORDER BY a.updated_at DESC
        LIMIT 1
      ) AS latest_annotation ON TRUE
      LEFT JOIN LATERAL (
        SELECT id, bbox, created_at
        FROM meta.detection_proposals AS p
        WHERE p.source = catalog.source
          AND p.source_item_id = catalog.source_item_id
        ORDER BY p.created_at DESC
        LIMIT 1
      ) AS latest_proposal ON TRUE
      LEFT JOIN LATERAL (
        SELECT id, status, created_at
        FROM meta.ocr_runs AS r
        WHERE r.source = catalog.source
          AND r.source_item_id = catalog.source_item_id
        ORDER BY r.created_at DESC
        LIMIT 1
      ) AS latest_ocr_run ON TRUE
      LEFT JOIN LATERAL (
        SELECT id, status, updated_at
        FROM meta.ocr_text_annotations AS r
        WHERE r.source = catalog.source
          AND r.source_item_id = catalog.source_item_id
        ORDER BY r.updated_at DESC
        LIMIT 1
      ) AS latest_ocr_review ON TRUE
      LEFT JOIN LATERAL (
        SELECT job_id, config_hash, status
        FROM meta.label_analysis_reviews AS r
        WHERE r.source = catalog.source AND r.source_item_id = catalog.source_item_id
        ORDER BY r.revision DESC LIMIT 1
      ) AS latest_analysis_review ON TRUE
      LEFT JOIN LATERAL (
        SELECT status
        FROM meta.catalog_identity_reviews AS r
        WHERE r.source = catalog.source AND r.source_item_id = catalog.source_item_id
        ORDER BY r.revision DESC LIMIT 1
      ) AS latest_catalog_identity ON TRUE
      ${whereSql}
    )
    SELECT
      COUNT(*)::int AS total_items,
      COUNT(*) FILTER (WHERE has_generated_label_roi)::int AS with_proposal,
      COUNT(*) FILTER (WHERE NOT has_generated_label_roi)::int AS missing_proposal,
      COUNT(*) FILTER (WHERE annotation_status = 'needs-review')::int AS needs_review,
      COUNT(*) FILTER (WHERE annotation_status = 'reviewed')::int AS reviewed,
      COUNT(*) FILTER (WHERE annotation_status = 'reviewed' AND has_reviewed_label_roi)::int AS reviewed_bbox,
      COUNT(*) FILTER (WHERE annotation_status = 'no-label')::int AS no_label,
      COUNT(*) FILTER (WHERE annotation_status = 'invalid-image')::int AS invalid_image,
      COUNT(*) FILTER (WHERE annotation_status = 'missing')::int AS no_annotation,
      COUNT(*) FILTER (WHERE annotation_status = 'reviewed' AND has_reviewed_label_roi)::int AS ready_for_export,
      COUNT(*) FILTER (WHERE has_backend_ocr)::int AS with_backend_ocr,
      COUNT(*) FILTER (WHERE has_reviewed_ocr_text)::int AS with_reviewed_ocr_text,
      COUNT(*) FILTER (WHERE annotation_status = 'reviewed' AND has_reviewed_label_roi AND NOT has_backend_ocr)::int AS needs_ocr,
      COUNT(*) FILTER (WHERE annotation_status = 'reviewed' AND has_reviewed_label_roi AND has_backend_ocr AND NOT has_reviewed_ocr_text)::int AS needs_ocr_review,
      COUNT(*) FILTER (WHERE annotation_status = 'reviewed' AND has_reviewed_label_roi AND has_reviewed_ocr_text)::int AS text_ready_for_export
      ,COUNT(*) FILTER (WHERE has_label_analysis)::int AS with_label_analysis
      ,COUNT(*) FILTER (WHERE has_label_analysis AND label_analysis_review_status IS NULL)::int AS needs_label_analysis_review
      ,COUNT(*) FILTER (WHERE label_analysis_review_status = 'accepted')::int AS label_analysis_accepted
      ,COUNT(*) FILTER (WHERE label_analysis_review_status = 'needs-tuning')::int AS label_analysis_needs_tuning
      ,COUNT(*) FILTER (WHERE label_analysis_review_status = 'rejected')::int AS label_analysis_rejected
      ,COUNT(*) FILTER (WHERE catalog_identity_status IS NOT NULL)::int AS with_catalog_identity
      ,COUNT(*) FILTER (WHERE has_label_analysis AND catalog_identity_status IS NULL)::int AS needs_catalog_identity
      ,COUNT(*) FILTER (WHERE catalog_identity_status = 'confirmed')::int AS catalog_identity_confirmed
      ,COUNT(*) FILTER (WHERE catalog_identity_status = 'corrected')::int AS catalog_identity_corrected
      ,COUNT(*) FILTER (WHERE catalog_identity_status = 'no-match')::int AS catalog_identity_no_match
      ,COUNT(*) FILTER (WHERE catalog_identity_status = 'ambiguous')::int AS catalog_identity_ambiguous
    FROM annotated
    `,
    values,
  );

  const row = result.rows[0] ?? {};
  return {
    source,
    totalItems: Number(row.total_items ?? 0),
    withProposal: Number(row.with_proposal ?? 0),
    missingProposal: Number(row.missing_proposal ?? 0),
    needsReview: Number(row.needs_review ?? 0),
    reviewed: Number(row.reviewed ?? 0),
    reviewedBbox: Number(row.reviewed_bbox ?? 0),
    noLabel: Number(row.no_label ?? 0),
    invalidImage: Number(row.invalid_image ?? 0),
    noAnnotation: Number(row.no_annotation ?? 0),
    readyForExport: Number(row.ready_for_export ?? 0),
    withBackendOcr: Number(row.with_backend_ocr ?? 0),
    withReviewedOcrText: Number(row.with_reviewed_ocr_text ?? 0),
    needsOcr: Number(row.needs_ocr ?? 0),
    needsOcrReview: Number(row.needs_ocr_review ?? 0),
    textReadyForExport: Number(row.text_ready_for_export ?? 0),
    withLabelAnalysis: Number(row.with_label_analysis ?? 0),
    needsLabelAnalysisReview: Number(row.needs_label_analysis_review ?? 0),
    labelAnalysisAccepted: Number(row.label_analysis_accepted ?? 0),
    labelAnalysisNeedsTuning: Number(row.label_analysis_needs_tuning ?? 0),
    labelAnalysisRejected: Number(row.label_analysis_rejected ?? 0),
    withCatalogIdentity: Number(row.with_catalog_identity ?? 0),
    needsCatalogIdentity: Number(row.needs_catalog_identity ?? 0),
    catalogIdentityConfirmed: Number(row.catalog_identity_confirmed ?? 0),
    catalogIdentityCorrected: Number(row.catalog_identity_corrected ?? 0),
    catalogIdentityNoMatch: Number(row.catalog_identity_no_match ?? 0),
    catalogIdentityAmbiguous: Number(row.catalog_identity_ambiguous ?? 0),
  };
}

async function listSourceItemsInternal(
  source: SourceName,
  limit: number,
  options: { missingCvMeta?: boolean; pipelineVersion?: string; force?: boolean },
): Promise<SourceItem[]> {
  if (source === "svoe_vino") {
    const metaFilter = buildMetaFilter(options, 2);
    const result = await pool.query(
      `
      SELECT
        COALESCE(w.external_id, w.slug, w.id::text) AS source_item_id,
        w.title,
        w.manufacturer_name,
        w.category_name,
        w.region_name,
        NULLIF(substring(COALESCE(w.title, '') from '(?:19|20)[0-9]{2}'), '')::int AS year,
        NULL::text AS barcode,
        w.color,
        w.description,
        COALESCE(
          jsonb_agg(i.local_path ORDER BY i.id) FILTER (WHERE i.local_path IS NOT NULL AND i.local_path <> ''),
          '[]'::jsonb
        ) AS image_urls
      FROM contest.effective_wines AS w
      LEFT JOIN svoe_vino.wine_images AS i ON i.wine_id = w.id
      LEFT JOIN meta.items AS m
        ON m.source = 'svoe_vino'
       AND m.source_item_id = COALESCE(w.external_id, w.slug, w.id::text)
      ${metaFilter.sql}
      GROUP BY w.id,w.external_id,w.slug,w.title,w.manufacturer_name,
      w.category_name,w.region_name,w.color,w.description
      ORDER BY lower(COALESCE(w.title, ''))
      LIMIT $1
      `,
      [limit, ...metaFilter.values],
    );
    return result.rows.map(rowToSvoeVinoItem);
  }

  const metaFilter = buildMetaFilter(options, 2);
  const result = await pool.query(
    `
    SELECT
      p.rskrf_product_id AS source_item_id,
      COALESCE(p.title, p.list_name) AS title,
      p.manufacturer,
      p.category_name,
      NULL::text AS region_name,
      NULLIF(substring(COALESCE(p.title, p.list_name, '') from '(?:19|20)[0-9]{2}'), '')::int AS year,
      p.barcode,
      NULL::text AS color,
      p.description,
      CASE
        WHEN p.image_local_path IS NULL OR p.image_local_path = '' THEN '[]'::jsonb
        ELSE jsonb_build_array(p.image_local_path)
      END AS image_urls
    FROM roskachestvo.products AS p
    LEFT JOIN meta.items AS m
      ON m.source = 'roskachestvo'
     AND m.source_item_id = p.rskrf_product_id
    ${metaFilter.sql}
    ORDER BY lower(COALESCE(p.title, p.list_name, ''))
    LIMIT $1
    `,
    [limit, ...metaFilter.values],
  );
  return result.rows.map(rowToRoskachestvoItem);
}

async function readSvoeVinoItem(sourceItemId: string): Promise<SourceItem | null> {
  const result = await pool.query(
    `
    SELECT
      COALESCE(w.external_id, w.slug, w.id::text) AS source_item_id,
      w.title,
      w.manufacturer_name,
      w.category_name,
      w.region_name,
      NULLIF(substring(COALESCE(w.title, '') from '(?:19|20)[0-9]{2}'), '')::int AS year,
      NULL::text AS barcode,
      w.color,
      w.description,
      COALESCE(
        jsonb_agg(i.local_path ORDER BY i.id) FILTER (WHERE i.local_path IS NOT NULL AND i.local_path <> ''),
        '[]'::jsonb
      ) AS image_urls
    FROM contest.effective_wines AS w
    LEFT JOIN svoe_vino.wine_images AS i ON i.wine_id = w.id
    WHERE w.external_id = $1
       OR w.slug = $1
       OR w.id::text = $1
    GROUP BY w.id,w.external_id,w.slug,w.title,w.manufacturer_name,
      w.category_name,w.region_name,w.color,w.description
    `,
    [sourceItemId],
  );
  return result.rows[0] ? rowToSvoeVinoItem(result.rows[0]) : null;
}

async function readRoskachestvoItem(sourceItemId: string): Promise<SourceItem | null> {
  const result = await pool.query(
    `
    SELECT
      p.rskrf_product_id AS source_item_id,
      COALESCE(p.title, p.list_name) AS title,
      p.manufacturer,
      p.category_name,
      NULL::text AS region_name,
      NULLIF(substring(COALESCE(p.title, p.list_name, '') from '(?:19|20)[0-9]{2}'), '')::int AS year,
      p.barcode,
      NULL::text AS color,
      p.description,
      CASE
        WHEN p.image_local_path IS NULL OR p.image_local_path = '' THEN '[]'::jsonb
        ELSE jsonb_build_array(p.image_local_path)
      END AS image_urls
    FROM roskachestvo.products AS p
    WHERE p.rskrf_product_id = $1
    `,
    [sourceItemId],
  );
  return result.rows[0] ? rowToRoskachestvoItem(result.rows[0]) : null;
}

function rowToSvoeVinoItem(row: Record<string, unknown>): SourceItem {
  return {
    source: "svoe_vino",
    sourceItemId: String(row.source_item_id),
    title: String(row.title ?? ""),
    manufacturer: nullableString(row.manufacturer_name),
    category: nullableString(row.category_name),
    region: nullableString(row.region_name),
    year: nullableNumber(row.year),
    barcode: nullableString(row.barcode),
    color: nullableString(row.color),
    description: nullableString(row.description),
    imageUrls: normalizeImageUrls(row.image_urls),
  };
}

function rowToRoskachestvoItem(row: Record<string, unknown>): SourceItem {
  return {
    source: "roskachestvo",
    sourceItemId: String(row.source_item_id),
    title: String(row.title ?? ""),
    manufacturer: nullableString(row.manufacturer),
    category: nullableString(row.category_name),
    region: null,
    year: nullableNumber(row.year),
    barcode: nullableString(row.barcode),
    color: nullableString(row.color),
    description: nullableString(row.description),
    imageUrls: normalizeImageUrls(row.image_urls),
  };
}

function rowToCatalogSourceItem(row: Record<string, unknown>): SourceItem {
  return {
    source: row.source === "roskachestvo" ? "roskachestvo" : "svoe_vino",
    sourceItemId: String(row.source_item_id),
    title: String(row.title ?? ""),
    manufacturer: nullableString(row.manufacturer),
    category: nullableString(row.category_name),
    region: nullableString(row.region_name),
    year: nullableNumber(row.year),
    barcode: nullableString(row.barcode),
    color: nullableString(row.color),
    description: nullableString(row.description),
    imageUrls: normalizeImageUrls(row.image_urls),
  };
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function normalizeImageUrls(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function rowToInventoryItem(row: Record<string, unknown>): InventoryItemRow {
  const sourceItem = row.source === "svoe_vino" ? rowToSvoeVinoItem(row) : rowToRoskachestvoItem(row);
  return {
    ...sourceItem,
    recognitionTags: stringArray(row.recognition_tags),
    annotationTracks: Array.isArray(row.annotation_tracks) ? row.annotation_tracks.map((value) => {
      const track = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const progress = track.progress && typeof track.progress === "object" ? track.progress as Record<string, unknown> : {};
      const executionActor = objectRecord(progress.executionActor);
      const automation = objectRecord(progress.automation);
      return { id: String(track.id ?? ""), ordinal: Number(track.ordinal ?? 0), name: String(track.name ?? "Annotation"),
        status: String(track.status ?? "draft"), previewBbox: track.previewBbox && typeof track.previewBbox === "object" ? track.previewBbox as Record<string, unknown> : null,
        progress: { completedStages: Number(progress.completedStages ?? 0), totalStages: 11 as const,
          nextStage: nullableString(progress.nextStage) as AnnotationTrackProgress["nextStage"],
          status: (nullableString(progress.status) ?? "not-started") as AnnotationTrackProgress["status"],
          executionActor: { type: nullableString(executionActor.type) as AnnotationExecutionActor["type"], sources: stringArray(executionActor.sources) },
          automation: automationSummary(automation) },
      };
    }).filter((track) => track.id) : [],
    annotationWorkflow: {
      status: (nullableString(row.annotation_workflow_status) ?? "not-started") as InventoryItemRow["annotationWorkflow"]["status"],
      executionActor: { type: nullableString(row.annotation_workflow_actor_type) as AnnotationExecutionActor["type"], sources: [] },
      automation: automationSummary({
        mode: row.annotation_workflow_automation_mode,
        autoStages: row.annotation_workflow_auto_stages,
        manualStages: row.annotation_workflow_manual_stages,
        mixedStages: row.annotation_workflow_mixed_stages,
        classifiedStages: row.annotation_workflow_classified_stages,
      }),
    },
    metadata: row.metadata_id
      ? {
          id: String(row.metadata_id),
          status: String(row.metadata_status),
          aliasesCount: Number(row.aliases_count ?? 0),
          normalizedTokensCount: Number(row.normalized_tokens_count ?? 0),
          hasCvMeta: row.has_cv_meta === true,
          generationVersion: nullableString(row.generation_version),
          sourceHash: nullableString(row.source_hash),
          updatedAt: row.metadata_updated_at instanceof Date ? row.metadata_updated_at : null,
          annotationStatus: nullableString(row.annotation_status),
          hasGeneratedLabelRoi: row.has_generated_label_roi === true,
          hasReviewedLabelRoi: row.has_reviewed_label_roi === true,
          hasBackendOcr: row.has_backend_ocr === true,
          hasReviewedOcrText: row.has_reviewed_ocr_text === true,
          catalogIdentityStatus: nullableString(row.catalog_identity_status),
          catalogIdentityRevision: row.catalog_identity_revision == null ? null : Number(row.catalog_identity_revision),
        }
      : null,
    latestJob: row.latest_job_id
      ? {
          id: String(row.latest_job_id),
          type: nullableString(row.latest_job_type),
          status: String(row.latest_job_status),
          createdAt: row.latest_job_created_at as Date,
          completedAt: row.latest_job_completed_at instanceof Date ? row.latest_job_completed_at : null,
          error: nullableString(row.latest_job_error),
        }
      : null,
  };
}

function automationSummary(value: Record<string, unknown>): AnnotationAutomationSummary {
  const classifiedStages = Number(value.classifiedStages ?? 0);
  const autoStages = Number(value.autoStages ?? 0);
  return {
    mode: nullableString(value.mode) as AnnotationAutomationMode,
    autoStages,
    manualStages: Number(value.manualStages ?? 0),
    mixedStages: Number(value.mixedStages ?? 0),
    classifiedStages,
    automationRate: typeof value.automationRate === "number" ? value.automationRate : classifiedStages > 0 ? Math.round((autoStages / classifiedStages) * 1000) / 1000 : null,
    stages: objectRecord(value.stages) as AnnotationAutomationSummary["stages"],
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function inventoryCatalogSql() {
  return `
    SELECT
      'svoe_vino'::text AS source,
      COALESCE(w.external_id, w.slug, w.id::text) AS source_item_id,
      w.title,
      w.manufacturer_name AS manufacturer,
      w.category_name,
      w.region_name,
      NULLIF(substring(COALESCE(w.title, '') from '(?:19|20)[0-9]{2}'), '')::int AS year,
      NULL::text AS barcode,
      w.color,
      w.description,
      COALESCE(
        jsonb_agg(i.local_path ORDER BY i.id) FILTER (WHERE i.local_path IS NOT NULL AND i.local_path <> ''),
        '[]'::jsonb
      ) AS image_urls
    FROM contest.effective_wines AS w
    LEFT JOIN svoe_vino.wine_images AS i ON i.wine_id = w.id
    GROUP BY w.id,w.external_id,w.slug,w.title,w.manufacturer_name,
      w.category_name,w.region_name,w.color,w.description

    UNION ALL

    SELECT
      'roskachestvo'::text AS source,
      p.rskrf_product_id AS source_item_id,
      COALESCE(p.title, p.list_name) AS title,
      p.manufacturer,
      p.category_name,
      NULL::text AS region_name,
      NULLIF(substring(COALESCE(p.title, p.list_name, '') from '(?:19|20)[0-9]{2}'), '')::int AS year,
      p.barcode,
      NULL::text AS color,
      p.description,
      CASE
        WHEN p.image_local_path IS NULL OR p.image_local_path = '' THEN '[]'::jsonb
        ELSE jsonb_build_array(p.image_local_path)
      END AS image_urls
    FROM roskachestvo.products AS p
  `;
}

function buildMetaFilter(
  options: { missingCvMeta?: boolean; pipelineVersion?: string; force?: boolean },
  firstParamIndex: number,
) {
  if (options.force || !options.missingCvMeta) {
    return { sql: "", values: [] as unknown[] };
  }

  const values: unknown[] = [options.pipelineVersion ?? "cv-meta-v2-debug-layers"];
  return {
    sql: `
      WHERE (
        m.id IS NULL
        OR m.visual_features->'cvMeta' IS NULL
        OR COALESCE(m.generation_version, '') <> $${firstParamIndex}
      )
    `,
    values,
  };
}
