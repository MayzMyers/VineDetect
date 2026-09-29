import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./pool.js";
import { createAnnotationTrack } from "./annotation-track.repository.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import type {
  AnnotationEntityType,
  AnnotationGraph,
  AnnotationOperation,
  AnnotationOperationType,
  AutoHelperRunInput,
  GraphMetaAnnotation,
  GraphOcrAnnotation,
  OcrCoordinateSpace,
  RegionGeometry,
  RoiReviewGraph,
  VisualRegionKind,
} from "../shared/annotationGraphContract.js";
import type { QuadGeometry } from "../shared/quadGeometry.js";
import type { SourceName } from "../shared/types.js";
import { normalizeLabelRectification, type LabelRectificationValue } from "../shared/labelRectificationContract.js";
import { planLabelCandidateMerges } from "../shared/labelCandidateMerge.js";
import { buildLabelCandidateRoiReviewGraph, buildLabelEditRoiReviewGraph, buildManualLabelRoiReviewGraph, readRoiReviewGraph } from "../shared/roiReviewGraph.js";
import type { EditOperationActor } from "../shared/editStageContract.js";

type OperationInput = AutoHelperRunInput & {
  operationType: AnnotationOperationType;
  parentType?: "item" | AnnotationEntityType;
  parentId?: string | null;
  resultType: AnnotationEntityType;
  resultId: string;
  previous?: Record<string, unknown> | null;
  resulting?: Record<string, unknown> | null;
  helperOutput?: Record<string, unknown> | null;
};

export async function getAnnotationGraph(source: SourceName, sourceItemId: string): Promise<AnnotationGraph> {
  return loadAnnotationGraph(pool, source, sourceItemId);
}

export async function getAnnotationGraphWithClient(client: Pick<PoolClient, "query">, source: SourceName, sourceItemId: string): Promise<AnnotationGraph> {
  return loadAnnotationGraph(client, source, sourceItemId);
}

export async function getGraphLabelCvState(source: SourceName, sourceItemId: string, annotationTrackId: string, labelId: string) {
  const result = await pool.query(`SELECT label.*,package.source_asset_ref,package.legacy_annotation_track_id
    FROM meta.annotation_labels label JOIN meta.annotation_packages package ON package.id=label.package_id
    WHERE label.id=$1 AND package.source=$2 AND package.source_item_id=$3 AND package.legacy_annotation_track_id=$4
      AND label.deleted_at IS NULL AND package.deleted_at IS NULL`, [labelId, source, sourceItemId, annotationTrackId]);
  if (!result.rows[0]) throw new NotFoundError("Canonical Label is not part of the selected Package track");
  const row = result.rows[0] as Record<string, unknown>;
  return {
    id: String(row.id), packageId: String(row.package_id), revision: Number(row.revision ?? 1),
    geometry: row.geometry as RegionGeometry, rectification: normalizeLabelRectification(row.rectification),
    sourceAssetRef: nullableString(row.source_asset_ref), crop: nullableObject(row.cv_crop), job: objectValue(row.cv_job),
  };
}

export async function putGraphLabelCvState(source: SourceName, sourceItemId: string, annotationTrackId: string, labelId: string, input: {
  crop?: Record<string, unknown> | null; job?: Record<string, unknown>;
}) {
  const current = await getGraphLabelCvState(source, sourceItemId, annotationTrackId, labelId);
  const result = await pool.query(`UPDATE meta.annotation_labels SET
    cv_crop=CASE WHEN $2 THEN $3::jsonb ELSE cv_crop END,
    cv_job=CASE WHEN $4 THEN $5::jsonb ELSE cv_job END,updated_at=now()
    WHERE id=$1 AND revision=$6 RETURNING *`, [labelId, input.crop !== undefined, input.crop === undefined ? null : JSON.stringify(input.crop), input.job !== undefined, input.job === undefined ? null : JSON.stringify(input.job), current.revision]);
  if (!result.rows[0]) throw new ConflictError("Label geometry changed while its CV state was being saved");
  return getGraphLabelCvState(source, sourceItemId, annotationTrackId, labelId);
}

async function loadAnnotationGraph(db: Pick<PoolClient, "query">, source: SourceName, sourceItemId: string): Promise<AnnotationGraph> {
  const [packagesResult, labelsResult, ocrResult, compositionResult, metaResult, operationsResult, legacyOperationsResult] = await Promise.all([
    db.query(`SELECT * FROM meta.annotation_packages WHERE source=$1 AND source_item_id=$2 AND deleted_at IS NULL ORDER BY created_at,id`, [source, sourceItemId]),
    db.query(`SELECT label.*,
      (package.legacy_annotation_track_id IS NOT NULL AND label.id=meta.deterministic_uuid('label-track:' || package.legacy_annotation_track_id::text)) legacy_managed
      FROM meta.annotation_labels label JOIN meta.annotation_packages package ON package.id=label.package_id
      WHERE package.source=$1 AND package.source_item_id=$2 AND package.deleted_at IS NULL AND label.deleted_at IS NULL ORDER BY label.created_at,label.id`, [source, sourceItemId]),
    db.query(`SELECT ocr.* FROM meta.annotation_ocr ocr JOIN meta.annotation_packages package ON package.id=ocr.package_id
      WHERE package.source=$1 AND package.source_item_id=$2 AND package.deleted_at IS NULL AND ocr.deleted_at IS NULL ORDER BY ocr.created_at,ocr.id`, [source, sourceItemId]),
    db.query(`SELECT composition.* FROM meta.annotation_ocr_compositions composition
      JOIN meta.annotation_packages package ON package.id=composition.package_id
      WHERE package.source=$1 AND package.source_item_id=$2 AND package.deleted_at IS NULL AND composition.deleted_at IS NULL
      ORDER BY composition.sort_order,composition.created_at,composition.id`, [source, sourceItemId]),
    db.query(`SELECT * FROM meta.annotation_meta WHERE source=$1 AND source_item_id=$2 AND deleted_at IS NULL ORDER BY created_at,id`, [source, sourceItemId]),
    db.query(`SELECT operation.*,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',candidate.candidate_key,'payload',candidate.payload,'score',candidate.score,'sortOrder',candidate.sort_order)
        ORDER BY candidate.sort_order,candidate.id) FROM meta.annotation_candidates candidate WHERE candidate.operation_id=operation.id),'[]'::jsonb) candidates,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('type',result.entity_type,'id',result.entity_id,'deletedAt',result.deleted_at) ORDER BY result.created_at,result.entity_id)
        FROM meta.annotation_operation_results result WHERE result.operation_id=operation.id),'[]'::jsonb) results,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('candidateId',review.candidate_key,'state',review.state,'resultEntityId',review.result_entity_id,'resultEntityIds',review.result_entity_ids,
        'finalPackageId',review.final_package_id,'finalLabelId',review.final_label_id,'reviewedGeometry',review.reviewed_geometry,
        'reviewedTranscription',review.reviewed_transcription,'reviewedRegionStatus',review.reviewed_region_status,
        'reviewedTranscriptionStatus',review.reviewed_transcription_status,'reviewedLayout',review.reviewed_layout,
        'reviewedRectification',review.reviewed_rectification) ORDER BY review.created_at,review.candidate_key)
        FROM meta.annotation_candidate_reviews review WHERE review.operation_id=operation.id),'[]'::jsonb) candidate_reviews
      FROM meta.annotation_operations operation WHERE source=$1 AND source_item_id=$2
        AND operation.created_at >= COALESCE((SELECT version.operation_since FROM meta.annotation_versions version
          JOIN meta.annotation_version_pointers pointer ON pointer.active_version_id=version.id
          WHERE pointer.source=$1 AND pointer.source_item_id=$2), '-infinity'::timestamptz)
      ORDER BY created_at,id`, [source, sourceItemId]),
    db.query(`SELECT execution.* FROM meta.wizard_stage_execution_records execution
      WHERE execution.source=$1 AND execution.source_item_id=$2 AND execution.stage IN ('label','bottle','ocr')
        AND execution.started_at >= COALESCE((SELECT version.operation_since FROM meta.annotation_versions version
          JOIN meta.annotation_version_pointers pointer ON pointer.active_version_id=version.id
          WHERE pointer.source=$1 AND pointer.source_item_id=$2), '-infinity'::timestamptz)
      ORDER BY execution.started_at,execution.revision,execution.id`, [source, sourceItemId]),
  ]);
  const meta = metaResult.rows.map(toMeta);
  const ocr = ocrResult.rows.map(toOcr).map((entry) => ({ ...entry, meta: meta.filter((item) => item.targetType === "ocr" && item.targetId === entry.id) }));
  const ocrCompositions = compositionResult.rows.map((row) => ({
    id: String(row.id), labelId: String(row.label_id), memberIds: Array.isArray(row.member_ids) ? row.member_ids.map(String) : [],
    text: nullableString(row.transcription), transcriptionStatus: transcriptionStatusValue(row.transcription_status),
    sortOrder: Number(row.sort_order ?? 0), origin: (row.origin ?? "legacy") as "human" | "llm" | "legacy",
    sourceOperationId: nullableString(row.source_operation_id), createdAt: dateValue(row.created_at)!,
  }));
  const labels = labelsResult.rows.map((row) => ({
    id: String(row.id), legacyManaged: Boolean(row.legacy_managed),
    origin: String(row.origin ?? (row.legacy_managed ? "legacy" : "human")) as "human" | "helper" | "legacy" | "migrated_from_direct_ocr",
    geometryReviewStatus: String(row.geometry_review_status ?? (row.status === "reviewed" ? "reviewed" : "suggested")) as "suggested" | "reviewed" | "rejected",
    visualRegionKind: { value: String(row.visual_region_kind ?? "unknown") as VisualRegionKind, status: String(row.visual_region_kind_status ?? "unreviewed") as "unreviewed" | "reviewed" },
    geometry: row.geometry as RegionGeometry, rectification: normalizeLabelRectification(row.rectification), revision: Number(row.revision ?? 1), status: row.status as "draft" | "reviewed",
    cv: { crop: nullableObject(row.cv_crop), job: nullableObject(row.cv_job) },
    packageId: String(row.package_id),
    ocr: ocr.filter((entry) => entry.labelId === String(row.id)),
    ocrCompositions: ocrCompositions.filter((entry) => entry.labelId === String(row.id)),
    meta: meta.filter((entry) => entry.targetType === "label" && entry.targetId === String(row.id)),
  }));
  const packages = packagesResult.rows.map((row) => ({
    ...packageDto(row),
    labels: labels.filter((label) => label.packageId === String(row.id)).map(({ packageId: _, ...label }) => label),
    ocr: ocr.filter((entry) => entry.packageId === String(row.id) && entry.labelId === null),
    meta: meta.filter((entry) => entry.targetType === "package" && entry.targetId === String(row.id)),
  }));
  const canonicalOperations = operationsResult.rows.map(toOperation);
  const legacyOperations = legacyOperationsResult.rows.map((row) => adaptLegacyOperation(row, packages));
  const unresolvedIdentityConflicts = canonicalOperations.filter((operation) => operation.status === "draft")
    .reduce((count, operation) => count + operation.candidates.filter((candidate) => {
      const duplicateAnalysis = nullableObject(candidate.payload.duplicateAnalysis);
      return Array.isArray(duplicateAnalysis?.matches) && duplicateAnalysis.matches.length > 0;
    }).length, 0);
  const suggestedParentRelations = ocr.filter((entry) => entry.parentRelation.status === "suggested").length;
  return {
    schemaVersion: 9,
    item: { source, sourceItemId },
    packages,
    meta: meta.filter((entry) => entry.targetType === "item"),
    operations: [...canonicalOperations, ...legacyOperations].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    validation: { unresolvedIdentityConflicts, suggestedParentRelations, readyForCanonicalExport: unresolvedIdentityConflicts === 0 },
  };
}

export async function syncLegacyLabelEntity(source: SourceName, sourceItemId: string, annotationTrackId: string, state: {
  status: string; annotation?: { geometry?: QuadGeometry; roi?: Record<string, unknown>; rectification?: LabelRectificationValue | null } | null;
}) {
  const packageResult = await pool.query(`SELECT * FROM meta.annotation_packages WHERE legacy_annotation_track_id=$1 AND deleted_at IS NULL`, [annotationTrackId]);
  const packageRow = packageResult.rows[0];
  if (!packageRow) throw new NotFoundError("Legacy annotation package not found");
  const idResult = await pool.query(`SELECT meta.deterministic_uuid('label-track:' || $1::text) id`, [annotationTrackId]);
  const id = String(idResult.rows[0].id);
  if (state.status !== "reviewed" || !state.annotation?.geometry) {
    await pool.query(`UPDATE meta.annotation_labels SET deleted_at=now(),updated_at=now() WHERE id=$1`, [id]);
    return null;
  }
  const result = await pool.query(`INSERT INTO meta.annotation_labels (id,package_id,geometry,rectification,status,origin,geometry_review_status)
    VALUES($1,$2,$3::jsonb,$4::jsonb,'reviewed','legacy','reviewed') ON CONFLICT(id) DO UPDATE SET geometry=excluded.geometry,rectification=excluded.rectification,status='reviewed',origin='legacy',geometry_review_status='reviewed',deleted_at=NULL,updated_at=now() RETURNING *`,
    [id, packageRow.id, JSON.stringify(state.annotation.geometry), state.annotation.rectification ? JSON.stringify(normalizeLabelRectification(state.annotation.rectification)) : null]);
  return labelDto(result.rows[0]);
}

export async function syncLegacyPackageObjectContext(source: SourceName, sourceItemId: string, annotationTrackId: string, bottleDetection: Record<string, unknown>) {
  const packageResult = await pool.query(`SELECT * FROM meta.annotation_packages WHERE source=$1 AND source_item_id=$2 AND legacy_annotation_track_id=$3 AND deleted_at IS NULL`, [source, sourceItemId, annotationTrackId]);
  const packageRow = packageResult.rows[0];
  if (!packageRow) throw new NotFoundError("Legacy annotation package not found");
  const annotation = nullableObject(bottleDetection.annotation);
  const annotationStatus = String(annotation?.status ?? "missing");
  const geometry = annotationStatus === "verified" ? polygonGeometry(annotation) ?? polygonGeometry(bottleDetection) : null;
  const objectStatus = annotationStatus === "verified" ? "reviewed" : annotationStatus === "skipped" ? "rejected" : geometry ? "suggested" : "missing";
  const annotationSource = String(annotation?.source ?? "");
  const objectSource = annotationSource === "auto-confirmed" ? "auto" : annotationStatus === "verified" ? "human" : null;
  const result = await pool.query(`UPDATE meta.annotation_packages SET
    object_geometry=$2::jsonb,object_status=$3,object_source=$4,
    object_reviewed_at=CASE WHEN $3 IN ('reviewed','rejected') THEN now() ELSE NULL END,updated_at=now()
    WHERE id=$1 RETURNING *`, [packageRow.id, geometry ? JSON.stringify(geometry) : null, objectStatus, objectSource]);
  return packageDto(result.rows[0]);
}

export async function syncLegacyOcrEntities(source: SourceName, sourceItemId: string, annotationTrackId: string, review: {
  regions: Array<{ id: string; geometry: QuadGeometry; level?: string; textDirection?: string; glyphOrientation?: string; layout?: GraphOcrAnnotation["layout"]; rectification?: GraphOcrAnnotation["rectification"]; annotation: { geometry: QuadGeometry; text: string | null; transcriptionStatus: "verified" | "partial" | "unreadable" }; status: string; prediction?: { confidence?: number | null } | null }>;
  compositions?: Array<{ id: string; memberIds: string[]; text: string | null; transcriptionStatus: "verified" | "partial" | "unreadable"; sortOrder: number }>;
}) {
  return transaction(async (client) => {
    const packageRow = (await client.query(`SELECT * FROM meta.annotation_packages WHERE source=$1 AND source_item_id=$2 AND legacy_annotation_track_id=$3 AND deleted_at IS NULL`, [source, sourceItemId, annotationTrackId])).rows[0];
    if (!packageRow) throw new NotFoundError("Legacy annotation package not found");
    const labelRow = (await client.query(`SELECT * FROM meta.annotation_labels
      WHERE package_id=$1 AND id=meta.deterministic_uuid('label-track:' || $2::text) AND deleted_at IS NULL`, [packageRow.id, annotationTrackId])).rows[0] ?? null;
    if (labelRow) await client.query(`UPDATE meta.annotation_ocr SET deleted_at=now(),updated_at=now() WHERE label_id=$1 AND legacy_ocr_region_id IS NOT NULL AND deleted_at IS NULL`, [labelRow.id]);
    const cropRow = (await client.query(`SELECT annotation_revision,width,height FROM meta.label_crops
      WHERE annotation_track_id=$1 ORDER BY created_at DESC LIMIT 1`, [annotationTrackId])).rows[0] ?? null;
    const output: GraphOcrAnnotation[] = [];
    const canonicalIdByReviewedRegionId = new Map<string, string>();
    for (const region of review.regions) {
      const idResult = await client.query(`SELECT meta.deterministic_uuid('ocr-review:' || $1::text) id`, [region.id]);
      const id = String(idResult.rows[0].id);
      const regionStatus = region.status === "rejected" ? "rejected" : "reviewed";
      const transcriptionStatus = region.annotation.transcriptionStatus;
      const transcription = transcriptionStatus === "unreadable" ? null : region.annotation.text;
      const legacyStatus = regionStatus === "rejected" ? "rejected" : transcriptionStatus === "verified" ? "verified" : transcriptionStatus === "unreadable" ? "unreadable" : "no_transcription";
      if (!labelRow) throw new ConflictError("Reviewed OCR requires a canonical Label/VisualRegion");
      const coordinateSpace: OcrCoordinateSpace = {
        type: "label-rectified", units: "normalized", labelId: String(labelRow.id),
        cropRevision: cropRow?.annotation_revision == null ? null : Number(cropRow.annotation_revision),
        width: cropRow?.width == null ? null : Number(cropRow.width), height: cropRow?.height == null ? null : Number(cropRow.height),
      };
      const layout = region.layout ?? legacyLayout(region.level, region.textDirection, region.glyphOrientation);
      const result = await client.query(`INSERT INTO meta.annotation_ocr
        (id,package_id,label_id,geometry,coordinate_space,transcription,status,region_status,transcription_status,layout_type,text_direction,glyph_orientation,
         layout_flow,baseline_angle_deg,layout_baseline,character_orientation,rectification,confidence,legacy_ocr_region_id)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18,$19)
        ON CONFLICT(id) DO UPDATE SET geometry=excluded.geometry,transcription=excluded.transcription,status=excluded.status,
          region_status=excluded.region_status,transcription_status=excluded.transcription_status,layout_type=excluded.layout_type,
          text_direction=excluded.text_direction,glyph_orientation=excluded.glyph_orientation,
          layout_flow=excluded.layout_flow,baseline_angle_deg=excluded.baseline_angle_deg,layout_baseline=excluded.layout_baseline,
          character_orientation=excluded.character_orientation,rectification=excluded.rectification,
          coordinate_space=excluded.coordinate_space,confidence=excluded.confidence,legacy_ocr_region_id=excluded.legacy_ocr_region_id,
          deleted_at=NULL,updated_at=now() RETURNING *`,
        [id, packageRow.id, labelRow.id, JSON.stringify(region.annotation.geometry ?? region.geometry), JSON.stringify(coordinateSpace), transcription, legacyStatus,
          regionStatus, transcriptionStatus, layout.type, legacyDirection(layout), legacyOrientation(layout), layout.flow, layout.baselineAngleDeg,
          layout.baseline ? JSON.stringify(layout.baseline) : null, layout.characterOrientation, region.rectification ? JSON.stringify(region.rectification) : null,
          region.prediction?.confidence ?? null, region.id]);
      output.push(toOcr(result.rows[0]));
      canonicalIdByReviewedRegionId.set(region.id, id);
    }
    if (labelRow) {
      await client.query(`UPDATE meta.annotation_ocr_compositions SET deleted_at=now(),updated_at=now()
        WHERE label_id=$1 AND origin='human' AND deleted_at IS NULL`, [labelRow.id]);
      for (const composition of review.compositions ?? []) {
        const memberIds = composition.memberIds.map((memberId) => canonicalIdByReviewedRegionId.get(memberId));
        if (memberIds.some((memberId) => !memberId) || new Set(memberIds).size < 2) throw new ConflictError("OCR string composition must reference at least two distinct reviewed regions");
        await client.query(`INSERT INTO meta.annotation_ocr_compositions
          (id,package_id,label_id,member_ids,transcription,transcription_status,sort_order,origin,source_operation_id)
          VALUES(meta.deterministic_uuid('ocr-review-composition:' || $1),$2,$3,$4::uuid[],$5,$6,$7,'human',$8)
          ON CONFLICT(id) DO UPDATE SET member_ids=excluded.member_ids,transcription=excluded.transcription,
            transcription_status=excluded.transcription_status,sort_order=excluded.sort_order,origin='human',source_operation_id=excluded.source_operation_id,
            deleted_at=NULL,updated_at=now()`, [composition.id, packageRow.id, labelRow.id, memberIds,
          composition.transcriptionStatus === "unreadable" ? null : composition.text, composition.transcriptionStatus,
          composition.sortOrder, `manual-review:${composition.id}`]);
      }
    }
    return output;
  });
}

export async function createGraphPackage(source: SourceName, sourceItemId: string, input: {
  geometry?: RegionGeometry | null; sourceAssetRef?: string;
  packageType?: { value: "bottle" | "tube" | "box" | "other" | "unknown"; status: "unreviewed" | "reviewed"; source: "human" | "auto" };
  operation: AutoHelperRunInput;
}) {
  const track = await createAnnotationTrack(source, sourceItemId, {
    sourceAssetRef: input.sourceAssetRef,
    targetRegion: input.geometry as unknown as Record<string, unknown> | undefined,
  });
  const packageResult = await pool.query(`SELECT * FROM meta.annotation_packages WHERE legacy_annotation_track_id=$1`, [track.id]);
  let row = packageResult.rows[0];
  if (input.packageType) row = (await pool.query(`UPDATE meta.annotation_packages SET package_type=$2,package_type_status=$3,package_type_source=$4,
    package_type_reviewed_at=CASE WHEN $3='reviewed' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *`,
    [row.id, input.packageType.value, input.packageType.status, input.packageType.source])).rows[0];
  await withOperation(source, sourceItemId, {
    ...input.operation, operationType: "add_package", parentType: "item", parentId: null,
    resultType: "package", resultId: String(row.id), resulting: entitySnapshot(row),
  });
  const packageCount = Number((await pool.query(`SELECT count(*)::int count FROM meta.annotation_packages WHERE source=$1 AND source_item_id=$2 AND deleted_at IS NULL`, [source, sourceItemId])).rows[0]?.count ?? 0);
  if (packageCount >= 2) await setItemPackageMultiplicity(source, sourceItemId, "multiple", {
    helperId: "canonical-package-count", helperVersion: "v1", initialConfig: {}, finalConfig: {},
    reviewMode: input.operation.reviewMode === "manual" ? "manual" : "accepted",
  }, input.operation.reviewMode === "manual" ? "human" : "auto", `Derived from canonical Package count: ${packageCount}.`);
  return { package: packageDto(row), annotationTrack: track };
}

export async function createGraphLabel(source: SourceName, sourceItemId: string, packageId: string, input: {
  geometry: RegionGeometry; rectification?: LabelRectificationValue | null; operation: AutoHelperRunInput; operationActor?: EditOperationActor;
}) {
  return transaction(async (client) => {
    await requirePackage(client, source, sourceItemId, packageId);
    const id = randomUUID();
    const result = await client.query(`INSERT INTO meta.annotation_labels (id,package_id,geometry,rectification,status,origin,geometry_review_status) VALUES($1,$2,$3::jsonb,$4::jsonb,'reviewed','human','reviewed') RETURNING *`,
      [id, packageId, JSON.stringify(input.geometry), input.rectification ? JSON.stringify(normalizeLabelRectification(input.rectification)) : null]);
    const row = result.rows[0];
    await insertOperation(client, source, sourceItemId, {
      ...input.operation, operationType: "add_label", parentType: "package", parentId: packageId,
      resultType: "label", resultId: id, resulting: entitySnapshot(row),
      helperOutput: { roiReviewGraph: buildManualLabelRoiReviewGraph(id, input.geometry, input.operationActor) },
    });
    return { ...labelDto(row), parentRefinementSuggestions: [] };
  });
}

export async function reviewGraphLabelCandidates(source: SourceName, sourceItemId: string, packageId: string, input: {
  operation: Omit<AutoHelperRunInput, "selectedCandidateId" | "reviewMode"> & { reviewMode: "accepted" | "edited" };
  reviews: Array<{ candidateId: string; state: "accepted" | "edited" | "rejected" | "merged"; geometry?: RegionGeometry; resultEntityId?: string | null; mergeGroupId?: string }>;
  mergeReviews?: Array<{ candidateIds: string[]; geometry: RegionGeometry }>;
  operationActor?: EditOperationActor;
  approvalActor?: EditOperationActor;
}) {
  return transaction(async (client) => {
    await requirePackage(client, source, sourceItemId, packageId);
    const operationId = randomUUID();
    const mergePlan = planLabelCandidateMerges(input.reviews.flatMap((review) =>
      (review.state === "accepted" || review.state === "edited") && review.geometry
        ? [{ candidateId: review.candidateId, geometry: review.geometry, mergeGroupId: review.mergeGroupId }]
        : []));
    const mergeGroupByCandidate = new Map(mergePlan.flatMap((group) => group.candidateIds.map((candidateId) => [candidateId, group] as const)));
    const mergeReviewByGroupKey = new Map((input.mergeReviews ?? []).map((review) => [candidateSetKey(review.candidateIds), review.geometry] as const));
    for (const key of mergeReviewByGroupKey.keys()) {
      if (!mergePlan.some((group) => group.candidateIds.length > 1 && candidateSetKey(group.candidateIds) === key)) {
        throw new ConflictError("Reviewed merged Label geometry must reference one exact merge group");
      }
    }
    const manuallyMerged = mergePlan.some((group) => group.candidateIds.length > 1 && (group.mode === "manual" || group.mode === "mixed"));
    const mergedGeometryEdited = mergePlan.some((group) => {
      const reviewed = mergeReviewByGroupKey.get(candidateSetKey(group.candidateIds));
      return reviewed && JSON.stringify(reviewed) !== JSON.stringify(group.geometry);
    });
    const reviewStatus = input.reviews.some((review) => review.state === "edited") || manuallyMerged || mergedGeometryEdited ? "edited" : input.operation.reviewMode;
    await client.query(`INSERT INTO meta.annotation_operations
      (id,source,source_item_id,operation_type,parent_entity_type,parent_entity_id,result_entity_type,result_entity_id,
       helper_id,helper_version,initial_config,final_config,selected_candidate_id,review_status,scope_type,scope_id,helper_output,operation_status)
      VALUES($1,$2,$3,'add_label','package',$4,'label',NULL,$5,$6,$7::jsonb,$8::jsonb,NULL,$9,'package',$4,$10::jsonb,'reviewed')`,
      [operationId, source, sourceItemId, packageId, input.operation.helperId, input.operation.helperVersion ?? null,
       JSON.stringify(input.operation.initialConfig ?? {}), JSON.stringify(input.operation.finalConfig ?? input.operation.initialConfig ?? {}),
       reviewStatus, JSON.stringify({ resultEntityIds: [] })]);
    for (const [index, candidate] of (input.operation.candidates ?? []).entries()) {
      await client.query(`INSERT INTO meta.annotation_candidates (id,operation_id,candidate_key,payload,score,sort_order)
        VALUES($1,$2,$3,$4::jsonb,$5,$6)`, [randomUUID(), operationId, candidate.id, JSON.stringify(candidate.payload), candidate.score ?? null, index]);
    }
    const resultEntityIds: string[] = [];
    const resultEntityByCandidate = new Map<string, string>();
    const createdLabelByGroup = new Map<ReturnType<typeof planLabelCandidateMerges>[number], string>();
    for (const review of input.reviews) {
      let labelId: string | null = null;
      if (review.state === "accepted" || review.state === "edited") {
        const group = mergeGroupByCandidate.get(review.candidateId);
        if (!group) throw new ConflictError("Accepted Label candidate is missing merge-plan geometry");
        labelId = createdLabelByGroup.get(group) ?? randomUUID();
        if (!createdLabelByGroup.has(group)) {
          const reviewedGroupGeometry = group.candidateIds.length > 1 ? mergeReviewByGroupKey.get(candidateSetKey(group.candidateIds)) : null;
          await client.query(`INSERT INTO meta.annotation_labels
            (id,package_id,geometry,status,origin,geometry_review_status) VALUES($1,$2,$3::jsonb,'reviewed','helper','reviewed')`,
            [labelId, packageId, JSON.stringify(reviewedGroupGeometry ?? group.geometry)]);
          createdLabelByGroup.set(group, labelId);
        }
      } else if (review.state === "merged") {
        const existing = await requireLabel(client, source, sourceItemId, String(review.resultEntityId));
        if (String(existing.package_id) !== packageId) throw new ConflictError("Merged Label candidate must target a Label in the same Package");
        labelId = String(existing.id);
      }
      if (labelId) {
        resultEntityByCandidate.set(review.candidateId, labelId);
        if (!resultEntityIds.includes(labelId)) resultEntityIds.push(labelId);
        await client.query(`INSERT INTO meta.annotation_operation_results (operation_id,entity_type,entity_id)
          VALUES($1,'label',$2) ON CONFLICT DO NOTHING`, [operationId, labelId]);
      }
      await client.query(`INSERT INTO meta.annotation_candidate_reviews
        (operation_id,candidate_key,state,final_package_id,final_label_id,reviewed_geometry)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [operationId, review.candidateId, review.state, packageId, labelId, review.geometry ? JSON.stringify(review.geometry) : null]);
    }
    const labelMergeGroups = mergePlan.filter((group) => group.candidateIds.length > 1 && group.mode !== "none").map((group) => ({
      resultEntityId: createdLabelByGroup.get(group) ?? null,
      candidateIds: group.candidateIds,
      mode: group.mode as "automatic" | "manual" | "mixed",
      mergeGeometry: group.geometry,
      geometry: mergeReviewByGroupKey.get(candidateSetKey(group.candidateIds)) ?? group.geometry,
    }));
    const roiReviewGraph = buildLabelCandidateRoiReviewGraph({
      candidates: input.operation.candidates ?? [],
      reviews: input.reviews,
      mergeGroups: labelMergeGroups.map((group) => ({ ...group, geometry: group.mergeGeometry, reviewedGeometry: group.geometry })),
      resultEntityByCandidate,
      actor: input.operationActor,
      approvalActor: input.approvalActor,
    });
    await client.query(`UPDATE meta.annotation_operations SET helper_output=$2::jsonb,
      resulting_entity_snapshot=$3::jsonb WHERE id=$1`,
      [operationId, JSON.stringify({ resultEntityIds, labelMergeGroups, roiReviewGraph }), JSON.stringify({ resultEntityIds, labelMergeGroups })]);
    return { operationId, status: "reviewed" as const, resultEntityIds, labelMergeGroups, roiReviewGraph, reviews: input.reviews };
  });
}

export async function createGraphOcr(source: SourceName, sourceItemId: string, parent: { type: "label"; id: string }, input: {
  geometry: QuadGeometry; transcription: GraphOcrAnnotation["transcription"]; layout: GraphOcrAnnotation["layout"];
  rectification: GraphOcrAnnotation["rectification"]; coordinateSpace: OcrCoordinateSpace; regionStatus: GraphOcrAnnotation["regionStatus"]; confidence?: number | null; operation: AutoHelperRunInput;
}) {
  return transaction(async (client) => {
    const packageId = (await requireLabel(client, source, sourceItemId, parent.id)).package_id;
    const labelId = parent.id;
    assertCoordinateSpace(parent, input.coordinateSpace);
    const id = randomUUID();
    const result = await client.query(`INSERT INTO meta.annotation_ocr
      (id,package_id,label_id,geometry,coordinate_space,transcription,status,region_status,transcription_status,layout_type,text_direction,glyph_orientation,
       layout_flow,baseline_angle_deg,layout_baseline,character_orientation,rectification,confidence)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18) RETURNING *`,
      [id, packageId, labelId, JSON.stringify(input.geometry), JSON.stringify(input.coordinateSpace), input.transcription.text,
        legacyOcrStatus(input.regionStatus, input.transcription.status), input.regionStatus, input.transcription.status,
        input.layout.type, legacyDirection(input.layout), legacyOrientation(input.layout), input.layout.flow, input.layout.baselineAngleDeg,
        input.layout.baseline ? JSON.stringify(input.layout.baseline) : null, input.layout.characterOrientation,
        input.rectification ? JSON.stringify(input.rectification) : null, input.confidence ?? null]);
    const row = result.rows[0];
    await insertOperation(client, source, sourceItemId, {
      ...input.operation, operationType: "add_ocr", parentType: parent.type, parentId: parent.id,
      resultType: "ocr", resultId: id, resulting: entitySnapshot(row),
    });
    return toOcr(row);
  });
}

export async function createGraphMeta(source: SourceName, sourceItemId: string, input: {
  targetType: "item" | AnnotationEntityType; targetId?: string | null; note: string; tags?: string[]; source?: "human" | "auto"; operation: AutoHelperRunInput;
}) {
  return transaction(async (client) => {
    await requireMetaTarget(client, source, sourceItemId, input.targetType, input.targetId ?? null);
    const id = randomUUID();
    const result = await client.query(`INSERT INTO meta.annotation_meta
      (id,source,source_item_id,target_type,target_id,note,tags,provenance_source) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,
      [id, source, sourceItemId, input.targetType, input.targetId ?? null, input.note, JSON.stringify(input.tags ?? []), input.source ?? "human"]);
    const row = result.rows[0];
    await insertOperation(client, source, sourceItemId, {
      ...input.operation, operationType: "add_meta", parentType: input.targetType, parentId: input.targetId ?? null,
      resultType: "meta", resultId: id, resulting: entitySnapshot(row),
    });
    return toMeta(row);
  });
}

export async function setItemPackageMultiplicity(
  source: SourceName,
  sourceItemId: string,
  value: "single" | "multiple",
  operation: AutoHelperRunInput,
  provenanceSource: "human" | "auto" = "auto",
  note = value === "multiple" ? "Multiple physical packages detected." : "One physical package confirmed.",
) {
  return transaction(async (client) => {
    const existing = (await client.query(`SELECT * FROM meta.annotation_meta
      WHERE source=$1 AND source_item_id=$2 AND target_type='item' AND target_id IS NULL
        AND deleted_at IS NULL AND tags ? 'package-multiplicity'
      ORDER BY updated_at DESC LIMIT 1`, [source, sourceItemId])).rows[0] as Record<string, unknown> | undefined;
    const tags = ["package-multiplicity", value === "multiple" ? "multipackage" : "single-package"];
    let row: Record<string, unknown>;
    if (existing) {
      row = (await client.query(`UPDATE meta.annotation_meta SET note=$2,tags=$3::jsonb,provenance_source=$4,updated_at=now() WHERE id=$1 RETURNING *`,
        [existing.id, note, JSON.stringify(tags), provenanceSource])).rows[0];
      await insertOperation(client, source, sourceItemId, {
        ...operation, operationType: "edit_meta", parentType: "item", parentId: null,
        resultType: "meta", resultId: String(row.id), previous: entitySnapshot(existing), resulting: entitySnapshot(row),
      });
    } else {
      const id = randomUUID();
      row = (await client.query(`INSERT INTO meta.annotation_meta
        (id,source,source_item_id,target_type,target_id,note,tags,provenance_source)
        VALUES($1,$2,$3,'item',NULL,$4,$5::jsonb,$6) RETURNING *`,
        [id, source, sourceItemId, note, JSON.stringify(tags), provenanceSource])).rows[0];
      await insertOperation(client, source, sourceItemId, {
        ...operation, operationType: "add_meta", parentType: "item", parentId: null,
        resultType: "meta", resultId: id, resulting: entitySnapshot(row),
      });
    }
    return toMeta(row);
  });
}

export async function updateGraphEntity(source: SourceName, sourceItemId: string, entityType: AnnotationEntityType, id: string, input: {
  geometry?: RegionGeometry | null; sourceAssetRef?: string | null;
  packageType?: { value: "bottle" | "tube" | "box" | "other" | "unknown"; status: "unreviewed" | "reviewed"; source: "human" | "auto" };
  visualRegionKind?: { value: VisualRegionKind; status: "unreviewed" | "reviewed" };
  status?: "draft" | "reviewed"; regionStatus?: GraphOcrAnnotation["regionStatus"];
  transcription?: GraphOcrAnnotation["transcription"]; layout?: GraphOcrAnnotation["layout"];
  rectification?: GraphOcrAnnotation["rectification"] | LabelRectificationValue;
  confidence?: number | null; note?: string; tags?: string[];
  operation: AutoHelperRunInput;
}, operationActor: EditOperationActor = "human") {
  return transaction(async (client) => {
    const previous = await requireEntity(client, source, sourceItemId, entityType, id);
    let row: Record<string, unknown>;
    let invalidatedOcrIds: string[] = [];
    if (entityType === "package") {
      if (String(previous.source_asset_ref ?? "").startsWith("contest/") && input.sourceAssetRef !== undefined && input.sourceAssetRef !== previous.source_asset_ref) throw new ConflictError("Official Package asset binding is immutable");
      if (input.status && input.status !== "draft" && input.status !== "reviewed") throw new ConflictError("Package status must be draft or reviewed");
      const result = await client.query(`UPDATE meta.annotation_packages SET
        geometry=CASE WHEN $2 THEN $3::jsonb ELSE geometry END,
        scope_geometry=CASE WHEN $2 THEN $3::jsonb ELSE scope_geometry END,
        scope_source=CASE WHEN $2 THEN $4 ELSE scope_source END,
        source_asset_ref=CASE WHEN $5 THEN $6 ELSE source_asset_ref END,
        status=COALESCE($7,status),
        package_type=COALESCE($8,package_type),package_type_status=COALESCE($9,package_type_status),
        package_type_source=COALESCE($10,package_type_source),
        package_type_reviewed_at=CASE WHEN $9='reviewed' THEN now() WHEN $9='unreviewed' THEN NULL ELSE package_type_reviewed_at END,
        updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.geometry !== undefined, input.geometry === undefined ? null : JSON.stringify(input.geometry),
          input.geometry === null ? "default-full-image" : input.operation.reviewMode === "accepted" ? "auto" : "human",
          input.sourceAssetRef !== undefined, input.sourceAssetRef ?? null, input.status ?? null,
          input.packageType?.value ?? null, input.packageType?.status ?? null, input.packageType?.source ?? null]);
      row = result.rows[0];
      if (row.legacy_annotation_track_id) {
        await client.query(`UPDATE meta.annotation_tracks SET
          target_region=CASE WHEN $2 THEN $3::jsonb ELSE target_region END,
          source_asset_ref=CASE WHEN $4 THEN $5 ELSE source_asset_ref END,updated_at=now() WHERE id=$1`,
          [row.legacy_annotation_track_id, input.geometry !== undefined, input.geometry === undefined ? null : JSON.stringify(input.geometry),
            input.sourceAssetRef !== undefined, input.sourceAssetRef ?? null]);
      }
    } else if (entityType === "label") {
      if (input.geometry === null) throw new ConflictError("Label geometry cannot be null");
      if (input.status && input.status !== "draft" && input.status !== "reviewed") throw new ConflictError("Label status must be draft or reviewed");
      row = (await client.query(`UPDATE meta.annotation_labels SET geometry=COALESCE($2::jsonb,geometry),rectification=CASE WHEN $3 THEN $4::jsonb ELSE rectification END,status=COALESCE($5,status),
        visual_region_kind=COALESCE($6,visual_region_kind),visual_region_kind_status=COALESCE($7,visual_region_kind_status),
        geometry_review_status=CASE WHEN $2::jsonb IS NOT NULL OR $3 OR $5='reviewed' THEN 'reviewed' ELSE geometry_review_status END,
        revision=CASE WHEN $2::jsonb IS NOT NULL OR $3 THEN revision+1 ELSE revision END,
        cv_crop=CASE WHEN $2::jsonb IS NOT NULL OR $3 THEN NULL ELSE cv_crop END,
        cv_job=CASE WHEN $2::jsonb IS NOT NULL OR $3 THEN '{}'::jsonb ELSE cv_job END,
        updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.geometry === undefined ? null : JSON.stringify(input.geometry), input.rectification !== undefined, input.rectification ? JSON.stringify(normalizeLabelRectification(input.rectification)) : null, input.status ?? null,
          input.visualRegionKind?.value ?? null, input.visualRegionKind?.status ?? null])).rows[0];
      if (input.geometry !== undefined || input.rectification !== undefined) {
        const invalidatedAt = new Date().toISOString();
        invalidatedOcrIds = (await client.query(`SELECT id FROM meta.annotation_ocr WHERE label_id=$1 AND deleted_at IS NULL`, [id])).rows.map((item) => String(item.id));
        const invalidatedMetaIds = invalidatedOcrIds.length
          ? (await client.query(`SELECT id FROM meta.annotation_meta WHERE target_type='ocr' AND target_id=ANY($1::uuid[]) AND deleted_at IS NULL`, [invalidatedOcrIds])).rows.map((item) => String(item.id))
          : [];
        await client.query(`UPDATE meta.annotation_ocr SET deleted_at=$2,updated_at=$2 WHERE label_id=$1 AND deleted_at IS NULL`, [id, invalidatedAt]);
        await client.query(`UPDATE meta.annotation_ocr_compositions SET deleted_at=$2,updated_at=$2 WHERE label_id=$1 AND deleted_at IS NULL`, [id, invalidatedAt]);
        if (invalidatedMetaIds.length) await client.query(`UPDATE meta.annotation_meta SET deleted_at=$2,updated_at=$2 WHERE id=ANY($1::uuid[])`, [invalidatedMetaIds, invalidatedAt]);
        if (invalidatedOcrIds.length) {
          await client.query(`UPDATE meta.annotation_operations SET result_deleted_at=$2 WHERE result_entity_type='ocr' AND result_entity_id=ANY($1::uuid[]) AND result_deleted_at IS NULL`, [invalidatedOcrIds, invalidatedAt]);
          await client.query(`UPDATE meta.annotation_operation_results SET deleted_at=$2 WHERE entity_type='ocr' AND entity_id=ANY($1::uuid[]) AND deleted_at IS NULL`, [invalidatedOcrIds, invalidatedAt]);
        }
        if (invalidatedMetaIds.length) {
          await client.query(`UPDATE meta.annotation_operations SET result_deleted_at=$2 WHERE result_entity_type='meta' AND result_entity_id=ANY($1::uuid[]) AND result_deleted_at IS NULL`, [invalidatedMetaIds, invalidatedAt]);
          await client.query(`UPDATE meta.annotation_operation_results SET deleted_at=$2 WHERE entity_type='meta' AND entity_id=ANY($1::uuid[]) AND deleted_at IS NULL`, [invalidatedMetaIds, invalidatedAt]);
        }
      }
    } else if (entityType === "ocr") {
      if (input.geometry?.type === "polygon") throw new ConflictError("OCR geometry must be a quad");
      const mergedRegionStatus = input.regionStatus ?? String(previous.region_status) as GraphOcrAnnotation["regionStatus"];
      const mergedTranscription = input.transcription ?? { text: nullableString(previous.transcription), status: String(previous.transcription_status) as GraphOcrAnnotation["transcription"]["status"] };
      const mergedLayout = input.layout ?? layoutFromRow(previous);
      const mergedRectification = input.rectification !== undefined ? input.rectification : rectificationValue(previous.rectification);
      row = (await client.query(`UPDATE meta.annotation_ocr SET
        geometry=COALESCE($2::jsonb,geometry),transcription=$3,status=$4,region_status=$5,transcription_status=$6,
        layout_type=$7,text_direction=$8,glyph_orientation=$9,layout_flow=$10,baseline_angle_deg=$11,layout_baseline=$12::jsonb,
        character_orientation=$13,rectification=$14::jsonb,
        confidence=CASE WHEN $15 THEN $16 ELSE confidence END,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.geometry === undefined ? null : JSON.stringify(input.geometry), mergedTranscription.text,
          legacyOcrStatus(mergedRegionStatus, mergedTranscription.status), mergedRegionStatus, mergedTranscription.status,
          mergedLayout.type, legacyDirection(mergedLayout), legacyOrientation(mergedLayout), mergedLayout.flow, mergedLayout.baselineAngleDeg,
          mergedLayout.baseline ? JSON.stringify(mergedLayout.baseline) : null, mergedLayout.characterOrientation,
          mergedRectification ? JSON.stringify(mergedRectification) : null, input.confidence !== undefined, input.confidence ?? null])).rows[0];
    } else {
      row = (await client.query(`UPDATE meta.annotation_meta SET note=COALESCE($2,note),tags=COALESCE($3::jsonb,tags),updated_at=now() WHERE id=$1 RETURNING *`,
        [id, input.note ?? null, input.tags === undefined ? null : JSON.stringify(input.tags)])).rows[0];
    }
    const roiReviewGraph = entityType === "label" && input.geometry !== undefined
      ? buildLabelEditRoiReviewGraph(id, previous.geometry as RegionGeometry, row.geometry as RegionGeometry, operationActor)
      : null;
    await insertOperation(client, source, sourceItemId, {
      ...input.operation, operationType: `edit_${entityType}` as AnnotationOperationType,
      parentType: parentTypeForRow(entityType, row), parentId: parentIdForRow(entityType, row),
      resultType: entityType, resultId: id, previous: entitySnapshot(previous), resulting: entitySnapshot(row),
      helperOutput: roiReviewGraph || invalidatedOcrIds.length ? { ...(roiReviewGraph ? { roiReviewGraph } : {}), ...(invalidatedOcrIds.length ? { invalidatedOcrIds, invalidationReason: "label-normalization-revision-changed" } : {}) } : null,
    });
    return entityDto(entityType, row);
  });
}

export async function reparentGraphOcr(source: SourceName, sourceItemId: string, id: string, target: {
  type: "label"; id: string; operation: AutoHelperRunInput;
}) {
  return transaction(async (client) => {
    const previous = await requireEntity(client, source, sourceItemId, "ocr", id);
    const packageId = String(previous.package_id);
    const label = await requireLabel(client, source, sourceItemId, target.id);
    if (String(label.package_id) !== packageId) throw new ConflictError("Target Label must belong to the OCR Package");
    if (label.geometry?.type !== "quad") throw new ConflictError("OCR reparent requires a quad Label geometry");
    const labelId = target.id;

    const sourceGeometry = await ocrGeometryInSource(client, previous);
    const geometry = mapSourceQuadToLabel(sourceGeometry, label.geometry as QuadGeometry);
    const size = rectifiedSize(label.geometry as QuadGeometry);
    const coordinateSpace: OcrCoordinateSpace = { type: "label-rectified", units: "normalized", labelId, cropRevision: Number(label.revision ?? 1), width: size.width, height: size.height };
    const row = (await client.query(`UPDATE meta.annotation_ocr SET label_id=$2,geometry=$3::jsonb,coordinate_space=$4::jsonb,
      parent_relation_source='human',parent_relation_status='reviewed',parent_relation_suggested_label_id=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
      [id, labelId, JSON.stringify(geometry), JSON.stringify(coordinateSpace)])).rows[0];
    await client.query(`UPDATE meta.annotation_ocr_compositions SET deleted_at=now(),updated_at=now()
      WHERE $1=ANY(member_ids) AND deleted_at IS NULL`, [id]);
    await insertOperation(client, source, sourceItemId, {
      ...target.operation, operationType: "reparent_ocr", parentType: target.type, parentId: target.id,
      resultType: "ocr", resultId: id, previous: entitySnapshot(previous), resulting: entitySnapshot(row),
    });
    return toOcr(row);
  });
}

export async function deleteGraphEntity(source: SourceName, sourceItemId: string, entityType: AnnotationEntityType, id: string) {
  return transaction(async (client) => {
    const previous = await requireEntity(client, source, sourceItemId, entityType, id);
    const deletedAt = new Date().toISOString();
    const affected: Record<AnnotationEntityType, string[]> = { package: [], label: [], ocr: [], meta: [] };
    affected[entityType].push(id);
    if (entityType === "package") {
      affected.label = (await client.query(`SELECT id FROM meta.annotation_labels WHERE package_id=$1 AND deleted_at IS NULL`, [id])).rows.map((row) => String(row.id));
      affected.ocr = (await client.query(`SELECT id FROM meta.annotation_ocr WHERE package_id=$1 AND deleted_at IS NULL`, [id])).rows.map((row) => String(row.id));
      affected.meta = (await client.query(`SELECT id FROM meta.annotation_meta WHERE deleted_at IS NULL AND (
        (target_type='package' AND target_id=$1) OR (target_type='label' AND target_id=ANY($2::uuid[])) OR (target_type='ocr' AND target_id=ANY($3::uuid[])))`,
        [id, affected.label, affected.ocr])).rows.map((row) => String(row.id));
      await client.query(`UPDATE meta.annotation_packages SET deleted_at=$2,updated_at=$2 WHERE id=$1`, [id, deletedAt]);
      await client.query(`UPDATE meta.annotation_labels SET deleted_at=$2,updated_at=$2 WHERE package_id=$1 AND deleted_at IS NULL`, [id, deletedAt]);
      await client.query(`UPDATE meta.annotation_ocr SET deleted_at=$2,updated_at=$2 WHERE package_id=$1 AND deleted_at IS NULL`, [id, deletedAt]);
      await client.query(`UPDATE meta.annotation_ocr_compositions SET deleted_at=$2,updated_at=$2 WHERE package_id=$1 AND deleted_at IS NULL`, [id, deletedAt]);
      await client.query(`UPDATE meta.annotation_meta SET deleted_at=$2,updated_at=$2 WHERE id=ANY($1::uuid[])`, [affected.meta, deletedAt]);
      await client.query(`UPDATE meta.annotation_tracks SET status='archived',updated_at=$2 WHERE id=(SELECT legacy_annotation_track_id FROM meta.annotation_packages WHERE id=$1)`, [id, deletedAt]);
      const remainingPackages = Number((await client.query(`SELECT count(*)::int count FROM meta.annotation_packages WHERE source=$1 AND source_item_id=$2 AND deleted_at IS NULL`, [source, sourceItemId])).rows[0]?.count ?? 0);
      if (remainingPackages < 2) await client.query(`UPDATE meta.annotation_meta SET deleted_at=$3,updated_at=$3
        WHERE source=$1 AND source_item_id=$2 AND target_type='item' AND target_id IS NULL AND deleted_at IS NULL
          AND tags ? 'multipackage' AND note LIKE 'Derived from canonical Package count:%'`, [source, sourceItemId, deletedAt]);
    } else if (entityType === "label") {
      affected.ocr = (await client.query(`SELECT id FROM meta.annotation_ocr WHERE label_id=$1 AND deleted_at IS NULL`, [id])).rows.map((row) => String(row.id));
      affected.meta = (await client.query(`SELECT id FROM meta.annotation_meta WHERE deleted_at IS NULL AND (
        (target_type='label' AND target_id=$1) OR (target_type='ocr' AND target_id=ANY($2::uuid[])))`, [id, affected.ocr])).rows.map((row) => String(row.id));
      await client.query(`UPDATE meta.annotation_labels SET deleted_at=$2,updated_at=$2 WHERE id=$1`, [id, deletedAt]);
      await client.query(`UPDATE meta.annotation_ocr SET deleted_at=$2,updated_at=$2 WHERE label_id=$1 AND deleted_at IS NULL`, [id, deletedAt]);
      await client.query(`UPDATE meta.annotation_ocr_compositions SET deleted_at=$2,updated_at=$2 WHERE label_id=$1 AND deleted_at IS NULL`, [id, deletedAt]);
      await client.query(`UPDATE meta.annotation_ocr SET parent_relation_source='human',parent_relation_status='reviewed',
        parent_relation_suggested_label_id=NULL,updated_at=$2 WHERE parent_relation_suggested_label_id=$1 AND deleted_at IS NULL`, [id, deletedAt]);
      await client.query(`UPDATE meta.annotation_meta SET deleted_at=$2,updated_at=$2 WHERE id=ANY($1::uuid[])`, [affected.meta, deletedAt]);
    } else if (entityType === "ocr") {
      affected.meta = (await client.query(`SELECT id FROM meta.annotation_meta WHERE target_type='ocr' AND target_id=$1 AND deleted_at IS NULL`, [id])).rows.map((row) => String(row.id));
      await client.query(`UPDATE meta.annotation_ocr SET deleted_at=$2,updated_at=$2 WHERE id=$1`, [id, deletedAt]);
      await client.query(`UPDATE meta.annotation_ocr_compositions SET deleted_at=$2,updated_at=$2 WHERE $1=ANY(member_ids) AND deleted_at IS NULL`, [id, deletedAt]);
      await client.query(`UPDATE meta.annotation_meta SET deleted_at=$2,updated_at=$2 WHERE id=ANY($1::uuid[])`, [affected.meta, deletedAt]);
    } else {
      await client.query(`UPDATE meta.annotation_meta SET deleted_at=$2,updated_at=$2 WHERE id=$1`, [id, deletedAt]);
    }
    for (const [type, ids] of Object.entries(affected)) if (ids.length > 0) {
      await client.query(`UPDATE meta.annotation_operations SET result_deleted_at=$2
        WHERE result_entity_type=$3 AND result_entity_id=ANY($1::uuid[]) AND result_deleted_at IS NULL`, [ids, deletedAt, type]);
      await client.query(`UPDATE meta.annotation_operation_results SET deleted_at=$2
        WHERE entity_type=$3 AND entity_id=ANY($1::uuid[]) AND deleted_at IS NULL`, [ids, deletedAt, type]);
    }
    await insertOperation(client, source, sourceItemId, {
      helperId: "manual", reviewMode: "manual", operationType: `delete_${entityType}` as AnnotationOperationType,
      resultType: entityType, resultId: id, previous: entitySnapshot(previous), resulting: null,
    });
    return { deleted: true, entityType, id, deletedAt };
  });
}

async function withOperation(source: SourceName, sourceItemId: string, input: OperationInput) {
  return transaction((client) => insertOperation(client, source, sourceItemId, input));
}

async function insertOperation(client: PoolClient, source: SourceName, sourceItemId: string, input: OperationInput) {
  const id = randomUUID();
  await client.query(`INSERT INTO meta.annotation_operations
    (id,source,source_item_id,operation_type,parent_entity_type,parent_entity_id,result_entity_type,result_entity_id,
     helper_id,helper_version,initial_config,final_config,selected_candidate_id,review_status,previous_entity_snapshot,resulting_entity_snapshot,helper_output)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb)`,
    [id, source, sourceItemId, input.operationType, input.parentType ?? null, input.parentId ?? null,
      input.resultType, input.resultId, input.helperId, input.helperVersion ?? null,
      JSON.stringify(input.initialConfig ?? {}), JSON.stringify(input.finalConfig ?? input.initialConfig ?? {}),
      input.selectedCandidateId ?? null, input.reviewMode,
      input.previous ? JSON.stringify(input.previous) : null, input.resulting ? JSON.stringify(input.resulting) : null,
      input.helperOutput ? JSON.stringify(input.helperOutput) : null]);
  for (const [index, candidate] of (input.candidates ?? []).entries()) {
    await client.query(`INSERT INTO meta.annotation_candidates (id,operation_id,candidate_key,payload,score,sort_order)
      VALUES($1,$2,$3,$4::jsonb,$5,$6)`, [randomUUID(), id, candidate.id, JSON.stringify(candidate.payload), candidate.score ?? null, index]);
  }
  await client.query(`INSERT INTO meta.annotation_operation_results (operation_id,entity_type,entity_id)
    VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [id, input.resultType, input.resultId]);
  return id;
}

async function requireEntity(client: PoolClient, source: SourceName, sourceItemId: string, type: AnnotationEntityType, id: string) {
  if (type === "package") return requirePackage(client, source, sourceItemId, id);
  if (type === "label") return requireLabel(client, source, sourceItemId, id);
  if (type === "ocr") {
    const result = await client.query(`SELECT ocr.* FROM meta.annotation_ocr ocr JOIN meta.annotation_packages package ON package.id=ocr.package_id WHERE ocr.id=$1 AND package.source=$2 AND package.source_item_id=$3`, [id, source, sourceItemId]);
    if (!result.rows[0]) throw new NotFoundError("OCR annotation not found"); return result.rows[0];
  }
  const result = await client.query(`SELECT * FROM meta.annotation_meta WHERE id=$1 AND source=$2 AND source_item_id=$3`, [id, source, sourceItemId]);
  if (!result.rows[0]) throw new NotFoundError("Annotation meta not found"); return result.rows[0];
}

async function requirePackage(client: PoolClient, source: SourceName, sourceItemId: string, id: string) {
  const result = await client.query(`SELECT * FROM meta.annotation_packages WHERE id=$1 AND source=$2 AND source_item_id=$3 AND deleted_at IS NULL`, [id, source, sourceItemId]);
  if (!result.rows[0]) throw new NotFoundError("Annotation package not found"); return result.rows[0];
}

async function requireLabel(client: PoolClient, source: SourceName, sourceItemId: string, id: string) {
  const result = await client.query(`SELECT label.* FROM meta.annotation_labels label JOIN meta.annotation_packages package ON package.id=label.package_id
    WHERE label.id=$1 AND package.source=$2 AND package.source_item_id=$3 AND label.deleted_at IS NULL AND package.deleted_at IS NULL`, [id, source, sourceItemId]);
  if (!result.rows[0]) throw new NotFoundError("Annotation label not found"); return result.rows[0];
}

async function requireMetaTarget(client: PoolClient, source: SourceName, sourceItemId: string, type: string, id: string | null) {
  if (type === "item") return;
  await requireEntity(client, source, sourceItemId, type as AnnotationEntityType, String(id));
}

async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

function toOcr(row: Record<string, unknown>): GraphOcrAnnotation {
  return { id: String(row.id), packageId: String(row.package_id), labelId: String(row.label_id),
    legacyManaged: Boolean(row.legacy_ocr_region_id), geometry: row.geometry as QuadGeometry,
    coordinateSpace: row.coordinate_space as OcrCoordinateSpace,
    regionStatus: row.region_status === "rejected" ? "rejected" : "reviewed",
    transcription: { text: nullableString(row.transcription), status: transcriptionStatusValue(row.transcription_status) },
    layout: layoutFromRow(row), rectification: rectificationValue(row.rectification),
    confidence: numberValue(row.confidence),
    parentRelation: {
      packageId: String(row.package_id), labelId: String(row.label_id),
      source: row.parent_relation_source === "auto" ? "auto" : "human",
      status: row.parent_relation_status === "suggested" ? "suggested" : "reviewed",
      suggestedLabelId: nullableString(row.parent_relation_suggested_label_id),
    }, meta: [] };
}

async function ocrGeometryInSource(client: PoolClient, row: Record<string, unknown>): Promise<QuadGeometry> {
  const geometry = row.geometry as QuadGeometry;
  const label = (await client.query(`SELECT geometry FROM meta.annotation_labels WHERE id=$1 AND deleted_at IS NULL`, [row.label_id])).rows[0];
  if (!label || label.geometry?.type !== "quad") throw new ConflictError("Current OCR Label geometry is unavailable for reparenting");
  return mapLabelQuadToSource(geometry, label.geometry as QuadGeometry);
}

function mapLabelQuadToSource(quad: QuadGeometry, label: QuadGeometry): QuadGeometry {
  return quadFromPoints(quad.points.map((point) => projectPoint(label.points, point.x, point.y)) as QuadGeometry["points"]);
}

function mapSourceQuadToLabel(quad: QuadGeometry, label: QuadGeometry): QuadGeometry {
  return quadFromPoints(quad.points.map((point) => inverseProjectPoint(label.points, point)) as QuadGeometry["points"]);
}

function quadFromPoints(points: QuadGeometry["points"]): QuadGeometry {
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  return { type: "quad", points, bbox: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } };
}

function projectPoint(points: QuadGeometry["points"], u: number, v: number) {
  const [p0,p1,p2,p3]=points,dx1=p1.x-p2.x,dx2=p3.x-p2.x,sx=p0.x-p1.x+p2.x-p3.x,dy1=p1.y-p2.y,dy2=p3.y-p2.y,sy=p0.y-p1.y+p2.y-p3.y,d=dx1*dy2-dx2*dy1;
  const g=Math.abs(d)<1e-9?0:(sx*dy2-dx2*sy)/d,h=Math.abs(d)<1e-9?0:(dx1*sy-sx*dy1)/d,a=p1.x-p0.x+g*p1.x,b=p3.x-p0.x+h*p3.x,e=p1.y-p0.y+g*p1.y,f=p3.y-p0.y+h*p3.y,s=g*u+h*v+1;
  return { x:(a*u+b*v+p0.x)/s, y:(e*u+f*v+p0.y)/s };
}

function inverseProjectPoint(points: QuadGeometry["points"], target: { x: number; y: number }) {
  let u=(target.x-Math.min(...points.map((p)=>p.x)))/Math.max(1,Math.max(...points.map((p)=>p.x))-Math.min(...points.map((p)=>p.x)));
  let v=(target.y-Math.min(...points.map((p)=>p.y)))/Math.max(1,Math.max(...points.map((p)=>p.y))-Math.min(...points.map((p)=>p.y)));
  for(let i=0;i<10;i++){const p=projectPoint(points,u,v),px=projectPoint(points,u+1e-4,v),py=projectPoint(points,u,v+1e-4),a=(px.x-p.x)/1e-4,b=(py.x-p.x)/1e-4,c=(px.y-p.y)/1e-4,d=(py.y-p.y)/1e-4,det=a*d-b*c;if(Math.abs(det)<1e-9)break;const ex=target.x-p.x,ey=target.y-p.y;u+=(ex*d-b*ey)/det;v+=(a*ey-ex*c)/det;}
  return { x: Math.max(0,Math.min(1,u)), y: Math.max(0,Math.min(1,v)) };
}

function rectifiedSize(label: QuadGeometry) {
  const distance=(a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot(b.x-a.x,b.y-a.y);
  return { width: Math.max(1,Math.round((distance(label.points[0],label.points[1])+distance(label.points[3],label.points[2]))/2)), height: Math.max(1,Math.round((distance(label.points[0],label.points[3])+distance(label.points[1],label.points[2]))/2)) };
}

function geometryOverlapScore(a: QuadGeometry, b: RegionGeometry) {
  const intersectionX=Math.max(0,Math.min(a.bbox.x+a.bbox.width,b.bbox.x+b.bbox.width)-Math.max(a.bbox.x,b.bbox.x));
  const intersectionY=Math.max(0,Math.min(a.bbox.y+a.bbox.height,b.bbox.y+b.bbox.height)-Math.max(a.bbox.y,b.bbox.y));
  return (intersectionX*intersectionY)/Math.max(1,a.bbox.width*a.bbox.height);
}

function assertCoordinateSpace(parent: { type: "label"; id: string }, coordinateSpace: OcrCoordinateSpace) {
  if (coordinateSpace.type !== "label-rectified" || coordinateSpace.units !== "normalized" || coordinateSpace.labelId !== parent.id) {
    throw new ConflictError("Label OCR geometry must use label-rectified coordinates for the same Label");
  }
}
function toMeta(row: Record<string, unknown>): GraphMetaAnnotation { return { id: String(row.id), targetType: row.target_type as GraphMetaAnnotation["targetType"], targetId: nullableString(row.target_id), note: String(row.note ?? ""), tags: Array.isArray(row.tags) ? row.tags.map(String) : [], source: row.provenance_source === "auto" ? "auto" : "human" }; }

function legacyOcrStatus(regionStatus: GraphOcrAnnotation["regionStatus"], transcriptionStatus: GraphOcrAnnotation["transcription"]["status"]) {
  return regionStatus === "rejected" ? "rejected" : transcriptionStatus === "verified" ? "verified" : transcriptionStatus === "unreadable" ? "unreadable" : "no_transcription";
}
function transcriptionStatusValue(value: unknown): GraphOcrAnnotation["transcription"]["status"] { return value === "verified" || value === "partial" ? value : "unreadable"; }
function layoutFromRow(row: Record<string, unknown>): GraphOcrAnnotation["layout"] {
  const flow = row.layout_flow === "curved" ? "curved" : "linear";
  const baseline = Array.isArray(row.layout_baseline) ? row.layout_baseline.filter((point): point is { x: number; y: number } => Boolean(point) && typeof point === "object" && Number.isFinite(Number((point as { x?: unknown }).x)) && Number.isFinite(Number((point as { y?: unknown }).y))).map((point) => ({ x: Number(point.x), y: Number(point.y) })) : null;
  const orientation = row.character_orientation === "aligned" || row.character_orientation === "tangent-aligned" || row.character_orientation === "mixed" ? row.character_orientation : "upright";
  return { type: row.layout_type === "word" ? "word" : "string", flow, baselineAngleDeg: normalizeAngle(numberValue(row.baseline_angle_deg) ?? legacyAngle(row.text_direction)), baseline: flow === "curved" ? baseline : null, characterOrientation: orientation };
}
function legacyLayout(level: unknown, direction: unknown, orientation: unknown): GraphOcrAnnotation["layout"] {
  return { type: level === "word" ? "word" : "string", flow: "linear", baselineAngleDeg: legacyAngle(direction), baseline: null,
    characterOrientation: orientation === "mixed" ? "mixed" : orientation === "upright" || orientation == null ? "upright" : "aligned" };
}
function legacyAngle(direction: unknown) { return direction === "down" ? 90 : direction === "left" ? 180 : direction === "up" ? -90 : 0; }
function legacyDirection(layout: GraphOcrAnnotation["layout"]) { const angle=normalizeAngle(layout.baselineAngleDeg); return Math.abs(angle)<=45 ? "right" : angle>45&&angle<135 ? "down" : angle<=-45&&angle>-135 ? "up" : "left"; }
function legacyOrientation(layout: GraphOcrAnnotation["layout"]) { return layout.characterOrientation === "mixed" ? "mixed" : layout.characterOrientation === "upright" ? "upright" : "clockwise"; }
function normalizeAngle(value: number) { let angle=value; while(angle>180)angle-=360; while(angle<=-180)angle+=360; return Math.round(angle*1000)/1000; }
function rectificationValue(value: unknown): GraphOcrAnnotation["rectification"] { return value && typeof value === "object" && !Array.isArray(value) ? value as GraphOcrAnnotation["rectification"] : null; }
function packageDto(row: Record<string, unknown>): Omit<AnnotationGraph["packages"][number], "labels" | "ocr" | "meta"> {
  const scopeGeometry = (row.scope_geometry ?? row.geometry ?? null) as AnnotationGraph["packages"][number]["geometry"];
  return {
    id: String(row.id), legacyAnnotationTrackId: nullableString(row.legacy_annotation_track_id), sourceAssetRef: nullableString(row.source_asset_ref),
    scope: { geometry: scopeGeometry, source: packageScopeSource(row.scope_source, scopeGeometry), trainingRole: "helper-input" as const },
    packageType: { value: packageTypeValue(row.package_type), status: row.package_type_status === "reviewed" ? "reviewed" : "unreviewed", source: provenanceSourceValue(row.package_type_source), reviewedAt: dateValue(row.package_type_reviewed_at) },
    objectContext: { geometry: (row.object_geometry ?? null) as AnnotationGraph["packages"][number]["objectContext"]["geometry"], status: objectStatusValue(row.object_status), source: provenanceSourceValue(row.object_source), reviewedAt: dateValue(row.object_reviewed_at), trainingRole: "segmentation-gt" },
    geometry: scopeGeometry, status: row.status === "reviewed" ? "reviewed" : "draft",
  };
}
function labelDto(row: Record<string, unknown>) { return { id: String(row.id), packageId: String(row.package_id), legacyManaged: Boolean(row.legacy_managed), origin: String(row.origin ?? "human"), geometryReviewStatus: String(row.geometry_review_status ?? (row.status === "reviewed" ? "reviewed" : "suggested")), visualRegionKind: { value: String(row.visual_region_kind ?? "unknown") as VisualRegionKind, status: String(row.visual_region_kind_status ?? "unreviewed") as "unreviewed" | "reviewed" }, geometry: row.geometry, rectification: normalizeLabelRectification(row.rectification), revision: Number(row.revision ?? 1), status: row.status, cv: { crop: nullableObject(row.cv_crop), job: nullableObject(row.cv_job) } }; }
function entityDto(type: AnnotationEntityType, row: Record<string, unknown>) {
  if (type === "package") return packageDto(row);
  if (type === "label") return labelDto(row);
  if (type === "ocr") return toOcr(row);
  return toMeta(row);
}
function parentTypeForRow(type: AnnotationEntityType, row: Record<string, unknown>): "item" | AnnotationEntityType {
  if (type === "package") return "item";
  if (type === "label") return "package";
  if (type === "ocr") return row.label_id ? "label" : "package";
  return row.target_type as "item" | AnnotationEntityType;
}
function parentIdForRow(type: AnnotationEntityType, row: Record<string, unknown>) {
  if (type === "package") return null;
  if (type === "label") return String(row.package_id);
  if (type === "ocr") return String(row.label_id ?? row.package_id);
  return nullableString(row.target_id);
}
function toOperation(row: Record<string, unknown>): AnnotationOperation {
  const helperOutput = nullableObject(row.helper_output);
  const candidates = Array.isArray(row.candidates) ? row.candidates as AnnotationOperation["candidates"] : [];
  const candidateReviews = Array.isArray(row.candidate_reviews) ? row.candidate_reviews.map((value) => {
    const review = objectValue(value);
    const resultEntityId = nullableString(review.resultEntityId);
    return {
      ...review,
      resultEntityId,
      resultEntityIds: Array.isArray(review.resultEntityIds)
        ? review.resultEntityIds.map(String)
        : resultEntityId ? [resultEntityId] : [],
    } as AnnotationOperation["candidateReviews"][number];
  }) : [];
  return {
  id: String(row.id), operationType: row.operation_type as AnnotationOperation["operationType"],
  parent: row.parent_entity_type ? { type: row.parent_entity_type as NonNullable<AnnotationOperation["parent"]>["type"], id: nullableString(row.parent_entity_id) } : null,
  result: row.result_entity_type && row.result_entity_id ? { type: row.result_entity_type as AnnotationEntityType, id: String(row.result_entity_id) } : null,
  results: Array.isArray(row.results) ? row.results as AnnotationOperation["results"] : [],
  scope: row.scope_type && row.scope_id ? { type: row.scope_type as "package" | "label", id: String(row.scope_id) } : null,
  helper: { id: String(row.helper_id), version: nullableString(row.helper_version) },
  initialConfig: objectValue(row.initial_config), finalConfig: objectValue(row.final_config),
  candidates, selectedCandidateId: nullableString(row.selected_candidate_id),
  candidateReviews,
  reviewOperations: labelMergeReviewOperations(helperOutput),
  roiReviewGraph: operationRoiReviewGraph(row, helperOutput, candidates, candidateReviews),
  status: (row.operation_status ?? "reviewed") as AnnotationOperation["status"],
  helperOutput,
  reviewMode: row.review_status as AnnotationOperation["reviewMode"], previousEntitySnapshot: nullableObject(row.previous_entity_snapshot),
  resultingEntitySnapshot: nullableObject(row.resulting_entity_snapshot), resultDeletedAt: dateValue(row.result_deleted_at), createdAt: dateValue(row.created_at)!,
  };
}
function adaptLegacyOperation(row: Record<string, unknown>, packages: AnnotationGraph["packages"]): AnnotationOperation {
  const stage = String(row.stage); const revision = Number(row.revision ?? 1);
  const packageRow = packages.find((entry) => entry.legacyAnnotationTrackId === String(row.annotation_track_id));
  const entityType = stage === "bottle" ? "package" : stage === "label" ? "label" : "ocr";
  const resultId = entityType === "package" ? packageRow?.id : entityType === "label" ? packageRow?.labels[0]?.id : null;
  const helperRuns = Array.isArray(row.helper_runs) ? row.helper_runs.map(nullableObject).filter(Boolean) as Array<Record<string, unknown>> : [];
  const candidates = helperRuns.flatMap((run) => (Array.isArray(run.candidates) ? run.candidates : []).map((candidate, index) => {
    const record = objectValue(candidate); return { id: String(record.id ?? `${run.id ?? "run"}:${index}`), payload: record, score: numberValue(record.score), sortOrder: index };
  }));
  const reviewMode = row.review_mode === "corrected" ? "edited" : row.review_mode === "accepted" ? "accepted" : "manual";
  return {
    id: String(row.id), operationType: `${revision === 1 ? "add" : "edit"}_${entityType}` as AnnotationOperation["operationType"],
    parent: entityType === "package" ? { type: "item", id: null } : packageRow ? { type: "package", id: packageRow.id } : null,
    result: resultId ? { type: entityType, id: resultId } : null,
    results: resultId ? [{ type: entityType, id: resultId }] : [],
    scope: packageRow ? (stage === "ocr" && packageRow.labels[0]
      ? { type: "label", id: packageRow.labels[0].id }
      : { type: "package", id: packageRow.id }) : null,
    helper: { id: String(row.helper_id), version: nullableString(row.algorithm_version) },
    initialConfig: objectValue(row.initial_params), finalConfig: objectValue(row.final_params), candidates,
    selectedCandidateId: nullableString(row.selected_candidate_id), candidateReviews: [], reviewOperations: [], roiReviewGraph: null, status: "reviewed", helperOutput: null, reviewMode,
    previousEntitySnapshot: null, resultingEntitySnapshot: nullableObject(row.reviewed_output), resultDeletedAt: null,
    createdAt: dateValue(row.reviewed_at ?? row.updated_at ?? row.started_at)!,
  };
}
function labelMergeReviewOperations(helperOutput: Record<string, unknown> | null): AnnotationOperation["reviewOperations"] {
  return labelMergeGroups(helperOutput).flatMap((group) => group.resultEntityId
    ? [{ type: "merge" as const, inputCandidateIds: group.candidateIds, outputEntity: { type: "label" as const, id: group.resultEntityId }, outputGeometry: group.reviewedGeometry ?? group.geometry, mode: group.mode }]
    : []);
}
function operationRoiReviewGraph(row: Record<string, unknown>, helperOutput: Record<string, unknown> | null,
  candidates: AnnotationOperation["candidates"], candidateReviews: AnnotationOperation["candidateReviews"]): RoiReviewGraph | null {
  const persisted = readRoiReviewGraph(helperOutput?.roiReviewGraph);
  if (persisted) return persisted;
  if (row.operation_type === "add_label" && candidates.length > 0) {
    const resultEntityByCandidate = new Map(candidateReviews.flatMap((review) => review.finalLabelId ? [[review.candidateId, review.finalLabelId] as const] : []));
    const graph = buildLabelCandidateRoiReviewGraph({
      candidates,
      reviews: candidateReviews.map((review) => ({
        candidateId: review.candidateId,
        state: review.state,
        geometry: review.reviewedGeometry ?? undefined,
      })),
      mergeGroups: labelMergeGroups(helperOutput),
      resultEntityByCandidate,
    });
    return graph.nodes.length > 0 ? graph : null;
  }
  const resultEntityId = nullableString(row.result_entity_id);
  const previous = nullableObject(row.previous_entity_snapshot);
  const resulting = nullableObject(row.resulting_entity_snapshot);
  const previousGeometry = nullableObject(previous?.geometry) as RegionGeometry | null;
  const resultingGeometry = nullableObject(resulting?.geometry) as RegionGeometry | null;
  if (row.operation_type === "edit_label" && resultEntityId && previousGeometry && resultingGeometry) {
    return buildLabelEditRoiReviewGraph(resultEntityId, previousGeometry, resultingGeometry);
  }
  if (row.operation_type === "add_label" && resultEntityId && resultingGeometry) {
    return buildManualLabelRoiReviewGraph(resultEntityId, resultingGeometry);
  }
  return null;
}
function labelMergeGroups(helperOutput: Record<string, unknown> | null): Array<{
  candidateIds: string[];
  resultEntityId: string | null;
  geometry: RegionGeometry;
  reviewedGeometry?: RegionGeometry;
  mode: "automatic" | "manual" | "mixed";
}> {
  if (!helperOutput || !Array.isArray(helperOutput.labelMergeGroups)) return [];
  return helperOutput.labelMergeGroups.flatMap((value) => {
    const group = nullableObject(value);
    const candidateIds = Array.isArray(group?.candidateIds) ? group.candidateIds.filter((candidateId): candidateId is string => typeof candidateId === "string") : [];
    const resultEntityId = nullableString(group?.resultEntityId);
    const reviewedGeometry = nullableObject(group?.geometry) as RegionGeometry | null;
    const geometry = (nullableObject(group?.mergeGeometry) ?? reviewedGeometry) as RegionGeometry | null;
    const mode = group?.mode;
    return candidateIds.length > 1 && geometry && (mode === "automatic" || mode === "manual" || mode === "mixed")
      ? [{ candidateIds, resultEntityId, geometry, reviewedGeometry: reviewedGeometry ?? undefined, mode: mode as "automatic" | "manual" | "mixed" }]
      : [];
  });
}
function candidateSetKey(candidateIds: string[]) { return [...candidateIds].sort().join("\u001f"); }
function entitySnapshot(row: Record<string, unknown>) { return Object.fromEntries(Object.entries(row).map(([key,value]) => [key, value instanceof Date ? value.toISOString() : value])); }
function polygonGeometry(value: Record<string, unknown> | null) {
  if (!value) return null;
  const candidate = Array.isArray(value.shape) ? value.shape
    : Array.isArray(value.rawContour) ? value.rawContour
      : Array.isArray(value.simplifiedContour) ? value.simplifiedContour
        : Array.isArray(value.contour) ? value.contour : Array.isArray(value.polygon) ? value.polygon : null;
  if (!candidate || candidate.length < 3) return null;
  const points: Array<{ x: number; y: number }> = [];
  for (const point of candidate) {
    const record = Array.isArray(point) ? { x: point[0], y: point[1] } : nullableObject(point);
    if (!record) continue;
    const x = Number(record.x), y = Number(record.y);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }
  if (points.length < 3) return null;
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  return { type: "polygon" as const, points, bbox: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } };
}
function nullableString(value: unknown) { return value === null || value === undefined ? null : String(value); }
function packageScopeSource(value: unknown, geometry: unknown): AnnotationGraph["packages"][number]["scope"]["source"] {
  return value === "auto" || value === "human" || value === "legacy-unclassified" ? value : geometry ? "legacy-unclassified" : "default-full-image";
}
function packageTypeValue(value: unknown): AnnotationGraph["packages"][number]["packageType"]["value"] {
  return value === "bottle" || value === "tube" || value === "box" || value === "other" ? value : "unknown";
}
function provenanceSourceValue(value: unknown): "human" | "auto" | null { return value === "human" || value === "auto" ? value : null; }
function objectStatusValue(value: unknown): AnnotationGraph["packages"][number]["objectContext"]["status"] {
  return value === "suggested" || value === "reviewed" || value === "rejected" ? value : "missing";
}
function nullableObject(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function objectValue(value: unknown) { return nullableObject(value) ?? {}; }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function dateValue(value: unknown) { return value instanceof Date ? value.toISOString() : value ? String(value) : null; }
