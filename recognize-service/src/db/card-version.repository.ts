import { randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import type { SourceName } from "../shared/types.js";

type JsonObject = Record<string, unknown>;

export async function ensureAnnotationVersion(source: SourceName, sourceItemId: string, snapshot: JsonObject, origin = "bootstrap") {
  const existing = await getAnnotationVersionPointers(source, sourceItemId);
  if (existing) return existing;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${source}:${sourceItemId}:annotation-version`]);
    const again = await client.query(`SELECT * FROM meta.annotation_version_pointers WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId]);
    if (again.rows[0]) { await client.query("COMMIT"); return annotationPointers(again.rows[0]); }
    const track = await client.query(`SELECT id FROM meta.annotation_tracks WHERE source=$1 AND source_item_id=$2 AND status<>'archived' ORDER BY ordinal LIMIT 1`, [source, sourceItemId]);
    const id = randomUUID();
    await client.query(`INSERT INTO meta.annotation_versions(id,source,source_item_id,revision,status,snapshot,annotation_track_id,origin)
      VALUES($1,$2,$3,1,'draft',$4::jsonb,$5,$6)`, [id, source, sourceItemId, JSON.stringify(snapshot), track.rows[0]?.id ?? null, origin]);
    await client.query(`INSERT INTO meta.annotation_version_pointers(source,source_item_id,active_version_id,default_version_id)
      VALUES($1,$2,$3,NULL)`, [source, sourceItemId, id]);
    await client.query("COMMIT");
    return { activeVersionId: id, defaultVersionId: null };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function getAnnotationVersionPointers(source: SourceName, sourceItemId: string) {
  const result = await pool.query(`SELECT * FROM meta.annotation_version_pointers WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId]);
  return result.rows[0] ? annotationPointers(result.rows[0]) : null;
}

export async function listAnnotationVersions(source: SourceName, sourceItemId: string) {
  const pointers = await getAnnotationVersionPointers(source, sourceItemId);
  const rows = await pool.query(`SELECT id,revision,status,annotation_track_id,parent_version_id,source_job_id,origin,created_at,updated_at,approved_at
    FROM meta.annotation_versions WHERE source=$1 AND source_item_id=$2 ORDER BY revision DESC`, [source, sourceItemId]);
  return {
    activeVersionId: pointers?.activeVersionId ?? null,
    defaultVersionId: pointers?.defaultVersionId ?? null,
    items: rows.rows.map((row) => annotationVersionDto(row, pointers)),
  };
}

export async function getAnnotationVersion(source: SourceName, sourceItemId: string, versionId: string) {
  const pointers = await getAnnotationVersionPointers(source, sourceItemId);
  const result = await pool.query(`SELECT * FROM meta.annotation_versions WHERE id=$1 AND source=$2 AND source_item_id=$3`, [versionId, source, sourceItemId]);
  if (!result.rows[0]) throw new NotFoundError("Annotation version not found");
  return { ...annotationVersionDto(result.rows[0], pointers), snapshot: objectValue(result.rows[0].snapshot) };
}

export async function deleteAnnotationVersion(source: SourceName, sourceItemId: string, versionId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${source}:${sourceItemId}:annotation-version`]);
    const pointer = (await client.query(`SELECT * FROM meta.annotation_version_pointers
      WHERE source=$1 AND source_item_id=$2 FOR UPDATE`, [source, sourceItemId])).rows[0];
    const version = (await client.query(`SELECT id,status FROM meta.annotation_versions
      WHERE id=$1 AND source=$2 AND source_item_id=$3 FOR UPDATE`, [versionId, source, sourceItemId])).rows[0];
    if (!version) throw new NotFoundError("Annotation version not found");
    if (!pointer) throw new ConflictError("Annotation version pointers are unavailable");
    if (String(pointer.active_version_id) === versionId) throw new ConflictError("Active annotation version cannot be deleted; create or edit another version first");
    if (version.status === "processing") throw new ConflictError("A processing annotation version cannot be deleted; cancel its job first");
    const count = Number((await client.query(`SELECT COUNT(*)::int count FROM meta.annotation_versions
      WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId])).rows[0].count);
    if (count <= 1) throw new ConflictError("The only annotation version cannot be deleted");
    const deletedDefault = String(pointer.default_version_id) === versionId;
    if (deletedDefault) {
      await client.query(`UPDATE meta.annotation_version_pointers SET default_version_id=NULL,updated_at=now()
        WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId]);
    }
    await client.query(`DELETE FROM meta.annotation_versions WHERE id=$1`, [versionId]);
    await client.query("COMMIT");
    return { deleted: true as const, versionId, activeVersionId: String(pointer.active_version_id), defaultVersionId: deletedDefault ? null : nullableString(pointer.default_version_id) };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function captureActiveAnnotationVersion(source: SourceName, sourceItemId: string, snapshot: JsonObject) {
  const pointers = await getAnnotationVersionPointers(source, sourceItemId) ?? await ensureAnnotationVersion(source, sourceItemId, snapshot);
  await pool.query(`UPDATE meta.annotation_versions SET snapshot=$2::jsonb,updated_at=now()
    WHERE id=$1 AND status IN ('draft','processing','review_required')`, [pointers.activeVersionId, JSON.stringify(snapshot)]);
  return pointers.activeVersionId;
}

export async function createFreshAnnotationVersion(source: SourceName, sourceItemId: string, currentSnapshot: JsonObject, origin: string, parentVersionId?: string | null, sourceAssetRef?: string | null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${source}:${sourceItemId}:annotation-version`]);
    const pointer = (await client.query(`SELECT * FROM meta.annotation_version_pointers WHERE source=$1 AND source_item_id=$2 FOR UPDATE`, [source, sourceItemId])).rows[0];
    const parentId = parentVersionId ?? (pointer?.active_version_id ? String(pointer.active_version_id) : null);
    if (parentVersionId) {
      const parent = await client.query(`SELECT id FROM meta.annotation_versions WHERE id=$1 AND source=$2 AND source_item_id=$3`, [parentVersionId, source, sourceItemId]);
      if (!parent.rows[0]) throw new NotFoundError("Parent annotation version not found");
    }
    if (pointer?.active_version_id) await client.query(
      `UPDATE meta.annotation_versions SET snapshot=$2::jsonb,status=CASE WHEN status IN ('draft','processing','review_required') THEN 'superseded' ELSE status END,updated_at=now() WHERE id=$1`,
      [pointer.active_version_id, JSON.stringify(currentSnapshot)],
    );
    const revision = Number((await client.query(`SELECT COALESCE(MAX(revision),0)::int+1 revision FROM meta.annotation_versions WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId])).rows[0].revision);
    await client.query(`UPDATE meta.annotation_packages SET deleted_at=now(),updated_at=now() WHERE source=$1 AND source_item_id=$2 AND deleted_at IS NULL`, [source, sourceItemId]);
    await client.query(`UPDATE meta.annotation_meta SET deleted_at=now(),updated_at=now() WHERE source=$1 AND source_item_id=$2 AND deleted_at IS NULL`, [source, sourceItemId]);
    await client.query(`UPDATE meta.annotation_tracks SET status='archived',updated_at=now() WHERE source=$1 AND source_item_id=$2 AND status<>'archived'`, [source, sourceItemId]);
    const ordinal = Number((await client.query(`SELECT COALESCE(MAX(ordinal),0)::int+1 ordinal FROM meta.annotation_tracks WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId])).rows[0].ordinal);
    const trackId = randomUUID();
    await client.query(`INSERT INTO meta.annotation_tracks(id,source,source_item_id,ordinal,name,source_asset_ref) VALUES($1,$2,$3,$4,$5,$6)`, [trackId, source, sourceItemId, ordinal, `Version ${revision}`, sourceAssetRef ?? null]);
    await client.query(`INSERT INTO meta.annotation_track_states(annotation_track_id) VALUES($1)`, [trackId]);
    await client.query(`INSERT INTO meta.annotation_packages(id,source,source_item_id,legacy_annotation_track_id,source_asset_ref,scope_source,status)
      VALUES($1,$2,$3,$4,$5,'default-full-image','draft')`, [randomUUID(), source, sourceItemId, trackId, sourceAssetRef ?? null]);
    const id = randomUUID();
    const emptySnapshot = { schemaVersion: 9, item: { source, sourceItemId }, packages: [], meta: [], operations: [], validation: { unresolvedIdentityConflicts: 0, suggestedParentRelations: 0, readyForCanonicalExport: false } };
    await client.query(`INSERT INTO meta.annotation_versions(id,source,source_item_id,revision,status,snapshot,annotation_track_id,parent_version_id,origin,operation_since)
      VALUES($1,$2,$3,$4,'draft',$5::jsonb,$6,$7,$8,now())`, [id, source, sourceItemId, revision, JSON.stringify(emptySnapshot), trackId, parentId, origin]);
    if (pointer) {
      await client.query(`UPDATE meta.annotation_version_pointers SET active_version_id=$3,updated_at=now() WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId, id]);
    } else {
      await client.query(`INSERT INTO meta.annotation_version_pointers(source,source_item_id,active_version_id,default_version_id) VALUES($1,$2,$3,NULL)`, [source, sourceItemId, id]);
    }
    await client.query("COMMIT");
    return { versionId: id, revision, annotationTrackId: trackId, status: "draft" as const };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function forkAnnotationVersionForEditing(source: SourceName, sourceItemId: string, sourceVersionId: string, currentSnapshot: JsonObject, origin = "card-ui-edit") {
  await ensureAnnotationVersion(source, sourceItemId, currentSnapshot);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${source}:${sourceItemId}:annotation-version`]);
    const pointer = (await client.query(`SELECT * FROM meta.annotation_version_pointers WHERE source=$1 AND source_item_id=$2 FOR UPDATE`, [source, sourceItemId])).rows[0];
    const sourceVersion = (await client.query(`SELECT * FROM meta.annotation_versions WHERE id=$1 AND source=$2 AND source_item_id=$3 FOR UPDATE`, [sourceVersionId, source, sourceItemId])).rows[0];
    if (!sourceVersion) throw new NotFoundError("Annotation version not found");
    const sourceIsActive = sourceVersionId === String(pointer.active_version_id);
    if (sourceIsActive && (sourceVersion.status === "draft" || sourceVersion.status === "review_required")) {
      throw new ConflictError("The selected annotation version is already editable");
    }
    if (sourceIsActive && sourceVersion.status === "processing") {
      throw new ConflictError("The selected annotation version has a running job");
    }

    await client.query(`UPDATE meta.annotation_versions SET snapshot=$2::jsonb,status=CASE WHEN status IN ('draft','processing','review_required') THEN 'superseded' ELSE status END,updated_at=now() WHERE id=$1`,
      [pointer.active_version_id, JSON.stringify(currentSnapshot)]);
    await client.query(`UPDATE meta.annotation_packages SET deleted_at=now(),updated_at=now() WHERE source=$1 AND source_item_id=$2 AND deleted_at IS NULL`, [source, sourceItemId]);
    await client.query(`UPDATE meta.annotation_meta SET deleted_at=now(),updated_at=now() WHERE source=$1 AND source_item_id=$2 AND deleted_at IS NULL`, [source, sourceItemId]);
    await client.query(`UPDATE meta.annotation_tracks SET status='archived',updated_at=now() WHERE source=$1 AND source_item_id=$2 AND status<>'archived'`, [source, sourceItemId]);

    const revision = Number((await client.query(`SELECT COALESCE(MAX(revision),0)::int+1 revision FROM meta.annotation_versions WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId])).rows[0].revision);
    let ordinal = Number((await client.query(`SELECT COALESCE(MAX(ordinal),0)::int ordinal FROM meta.annotation_tracks WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId])).rows[0].ordinal);
    const snapshot = sourceIsActive && (sourceVersion.status === "failed" || sourceVersion.status === "cancelled")
      ? currentSnapshot
      : objectValue(sourceVersion.snapshot);
    const snapshotPackages = objectArray(snapshot.packages);
    const packages = snapshotPackages.length ? snapshotPackages : [{ status: "draft", labels: [], ocr: [], meta: [] }];
    const entityIds = new Map<string, string>();
    const packageTracks = new Map<string, string>();
    let primaryTrackId: string | null = null;

    for (const [index, packageSnapshot] of packages.entries()) {
      ordinal += 1;
      const trackId = randomUUID();
      const packageId = randomUUID();
      const oldPackageId = nullableString(packageSnapshot.id);
      const scope = objectValue(packageSnapshot.scope);
      const geometry = scope.geometry ?? packageSnapshot.geometry ?? null;
      const sourceAssetRef = nullableString(packageSnapshot.sourceAssetRef);
      const packageType = objectValue(packageSnapshot.packageType);
      const objectContext = objectValue(packageSnapshot.objectContext);
      if (!primaryTrackId) primaryTrackId = trackId;
      if (oldPackageId) { entityIds.set(oldPackageId, packageId); packageTracks.set(oldPackageId, trackId); }
      await client.query(`INSERT INTO meta.annotation_tracks(id,source,source_item_id,ordinal,name,source_asset_ref,target_region,status)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,'in-progress')`, [trackId, source, sourceItemId, ordinal, `Version ${revision}${packages.length > 1 ? ` / Package ${index + 1}` : ""}`, sourceAssetRef, geometry ? JSON.stringify(geometry) : null]);
      await client.query(`INSERT INTO meta.annotation_track_states(annotation_track_id) VALUES($1)`, [trackId]);
      await client.query(`INSERT INTO meta.annotation_packages
        (id,source,source_item_id,legacy_annotation_track_id,source_asset_ref,geometry,scope_geometry,scope_source,status,
         package_type,package_type_status,package_type_source,package_type_reviewed_at,object_geometry,object_status,object_source,object_reviewed_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`,
        [packageId, source, sourceItemId, trackId, sourceAssetRef, geometry ? JSON.stringify(geometry) : null,
          scopeSource(scope.source, geometry), packageSnapshot.status === "reviewed" ? "reviewed" : "draft",
          packageTypeValue(packageType.value), packageType.status === "reviewed" ? "reviewed" : "unreviewed", provenanceSource(packageType.source), packageType.reviewedAt ?? null,
          objectContext.geometry ? JSON.stringify(objectContext.geometry) : null, objectStatus(objectContext.status), provenanceSource(objectContext.source), objectContext.reviewedAt ?? null]);
    }

    for (const packageSnapshot of packages) {
      const oldPackageId = nullableString(packageSnapshot.id);
      const packageId = oldPackageId ? entityIds.get(oldPackageId) : [...entityIds.values()][0];
      if (!packageId) continue;
      for (const label of objectArray(packageSnapshot.labels)) {
        const oldLabelId = nullableString(label.id); const labelId = randomUUID();
        if (oldLabelId) entityIds.set(oldLabelId, labelId);
        await client.query(`INSERT INTO meta.annotation_labels
          (id,package_id,geometry,rectification,status,revision,cv_crop,cv_job,origin,geometry_review_status,visual_region_kind,visual_region_kind_status)
          VALUES($1,$2,$3::jsonb,$4::jsonb,$5,1,$6::jsonb,$7::jsonb,$8,$9,$10,$11)`,
          [labelId, packageId, JSON.stringify(label.geometry ?? {}), label.rectification ? JSON.stringify(label.rectification) : null,
            label.status === "draft" ? "draft" : "reviewed", objectValue(label.cv).crop ? JSON.stringify(objectValue(label.cv).crop) : null,
            JSON.stringify(objectValue(label.cv).job), labelOrigin(label.origin),
            label.geometryReviewStatus === "suggested" || label.geometryReviewStatus === "rejected" ? label.geometryReviewStatus : "reviewed",
            visualRegionKind(objectValue(label.visualRegionKind).value), objectValue(label.visualRegionKind).status === "reviewed" ? "reviewed" : "unreviewed"]);
      }
    }

    for (const packageSnapshot of packages) for (const label of objectArray(packageSnapshot.labels)) {
      const oldLabelId = nullableString(label.id); const labelId = oldLabelId ? entityIds.get(oldLabelId) : null;
      const oldPackageId = nullableString(packageSnapshot.id); const packageId = oldPackageId ? entityIds.get(oldPackageId) : null;
      if (!labelId || !packageId) continue;
      for (const ocr of objectArray(label.ocr)) {
        const oldOcrId = nullableString(ocr.id); const ocrId = randomUUID();
        if (oldOcrId) entityIds.set(oldOcrId, ocrId);
        const transcription = objectValue(ocr.transcription); const layout = objectValue(ocr.layout);
        const coordinateSpace = { ...objectValue(ocr.coordinateSpace), labelId };
        const parentRelation = objectValue(ocr.parentRelation);
        const suggestedLabelId = nullableString(parentRelation.suggestedLabelId);
        await client.query(`INSERT INTO meta.annotation_ocr
          (id,package_id,label_id,geometry,coordinate_space,transcription,status,region_status,transcription_status,layout_type,text_direction,glyph_orientation,
           layout_flow,baseline_angle_deg,layout_baseline,character_orientation,rectification,confidence,parent_relation_source,parent_relation_status,parent_relation_suggested_label_id)
          VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18,$19,$20,$21)`,
          [ocrId, packageId, labelId, JSON.stringify(ocr.geometry ?? {}), JSON.stringify(coordinateSpace), nullableString(transcription.text),
            legacyOcrStatus(ocr.regionStatus, transcription.status), ocr.regionStatus === "rejected" ? "rejected" : "reviewed", transcriptionStatus(transcription.status),
            layout.type === "word" ? "word" : "string", legacyDirection(layout.baselineAngleDeg), legacyOrientation(layout.characterOrientation),
            layout.flow === "curved" ? "curved" : "linear", finiteNumber(layout.baselineAngleDeg) ?? 0, layout.flow === "curved" && Array.isArray(layout.baseline) ? JSON.stringify(layout.baseline) : null,
            characterOrientation(layout.characterOrientation, layout.flow), ocr.rectification ? JSON.stringify(ocr.rectification) : null, finiteNumber(ocr.confidence),
            parentRelation.source === "auto" ? "auto" : "human", parentRelation.status === "suggested" ? "suggested" : "reviewed", suggestedLabelId ? entityIds.get(suggestedLabelId) ?? null : null]);
      }
    }

    for (const packageSnapshot of packages) for (const label of objectArray(packageSnapshot.labels)) {
      const oldLabelId = nullableString(label.id); const labelId = oldLabelId ? entityIds.get(oldLabelId) : null;
      const oldPackageId = nullableString(packageSnapshot.id); const packageId = oldPackageId ? entityIds.get(oldPackageId) : null;
      if (!labelId || !packageId) continue;
      for (const composition of objectArray(label.ocrCompositions)) {
        const memberIds = Array.isArray(composition.memberIds) ? composition.memberIds.map(String).map((id) => entityIds.get(id)).filter((id): id is string => Boolean(id)) : [];
        if (memberIds.length < 2) continue;
        const status = transcriptionStatus(composition.transcriptionStatus);
        const text = status === "unreadable" ? null : nullableString(composition.text)?.trim() || null;
        if (status !== "unreadable" && !text) continue;
        await client.query(`INSERT INTO meta.annotation_ocr_compositions
          (id,package_id,label_id,member_ids,transcription,transcription_status,sort_order,origin,source_operation_id)
          VALUES($1,$2,$3,$4::uuid[],$5,$6,$7,$8,'version-fork')`,
          [randomUUID(), packageId, labelId, memberIds, text, status, Math.max(0, Math.round(finiteNumber(composition.sortOrder) ?? 0)),
            composition.origin === "llm" || composition.origin === "legacy" ? composition.origin : "human"]);
      }
    }

    const metaSnapshots = [
      ...objectArray(snapshot.meta),
      ...packages.flatMap((entry) => [...objectArray(entry.meta), ...objectArray(entry.labels).flatMap((label) => [...objectArray(label.meta), ...objectArray(label.ocr).flatMap((ocr) => objectArray(ocr.meta))])]),
    ];
    for (const meta of metaSnapshots) {
      const targetType = meta.targetType === "package" || meta.targetType === "label" || meta.targetType === "ocr" ? meta.targetType : "item";
      const oldTargetId = nullableString(meta.targetId); const targetId = targetType === "item" ? null : oldTargetId ? entityIds.get(oldTargetId) ?? null : null;
      if (targetType !== "item" && !targetId) continue;
      await client.query(`INSERT INTO meta.annotation_meta(id,source,source_item_id,target_type,target_id,note,tags,provenance_source)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [randomUUID(), source, sourceItemId, targetType, targetId, String(meta.note ?? ""), JSON.stringify(Array.isArray(meta.tags) ? meta.tags.map(String) : []), meta.source === "auto" ? "auto" : "human"]);
    }

    const versionId = randomUUID();
    await client.query(`INSERT INTO meta.annotation_versions(id,source,source_item_id,revision,status,snapshot,annotation_track_id,parent_version_id,origin,operation_since)
      VALUES($1,$2,$3,$4,'draft',$5::jsonb,$6,$7,$8,now())`, [versionId, source, sourceItemId, revision, JSON.stringify(snapshot), primaryTrackId, sourceVersionId, origin]);
    await client.query(`UPDATE meta.annotation_version_pointers SET active_version_id=$3,updated_at=now() WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId, versionId]);
    await client.query("COMMIT");
    return { versionId, revision, annotationTrackId: primaryTrackId!, status: "draft" as const, parentVersionId: sourceVersionId };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function resetDraftAnnotationVersion(source: SourceName, sourceItemId: string, versionId: string, sourceAssetRef?: string | null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${source}:${sourceItemId}:annotation-version`]);
    const version = (await client.query(`SELECT version.* FROM meta.annotation_versions version
      JOIN meta.annotation_version_pointers pointer ON pointer.source=version.source AND pointer.source_item_id=version.source_item_id
      WHERE version.id=$1 AND version.source=$2 AND version.source_item_id=$3 AND pointer.active_version_id=version.id FOR UPDATE`,
      [versionId, source, sourceItemId])).rows[0];
    if (!version) throw new ConflictError("Only the active annotation version can be initialized");
    if (version.status === "approved") throw new ConflictError("Approved annotation versions are immutable; create a new version first");
    if (version.status === "processing") throw new ConflictError("The selected annotation version already has a running job");

    await client.query(`UPDATE meta.annotation_packages SET deleted_at=now(),updated_at=now()
      WHERE source=$1 AND source_item_id=$2 AND deleted_at IS NULL`, [source, sourceItemId]);
    await client.query(`UPDATE meta.annotation_meta SET deleted_at=now(),updated_at=now()
      WHERE source=$1 AND source_item_id=$2 AND deleted_at IS NULL`, [source, sourceItemId]);
    await client.query(`UPDATE meta.annotation_tracks SET status='archived',updated_at=now()
      WHERE source=$1 AND source_item_id=$2 AND status<>'archived'`, [source, sourceItemId]);
    const ordinal = Number((await client.query(`SELECT COALESCE(MAX(ordinal),0)::int+1 ordinal
      FROM meta.annotation_tracks WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId])).rows[0].ordinal);
    const trackId = randomUUID();
    await client.query(`INSERT INTO meta.annotation_tracks(id,source,source_item_id,ordinal,name,source_asset_ref)
      VALUES($1,$2,$3,$4,$5,$6)`, [trackId, source, sourceItemId, ordinal, `Version ${Number(version.revision)} run`, sourceAssetRef ?? null]);
    await client.query(`INSERT INTO meta.annotation_track_states(annotation_track_id) VALUES($1)`, [trackId]);
    await client.query(`INSERT INTO meta.annotation_packages(id,source,source_item_id,legacy_annotation_track_id,source_asset_ref,scope_source,status)
      VALUES($1,$2,$3,$4,$5,'default-full-image','draft')`, [randomUUID(), source, sourceItemId, trackId, sourceAssetRef ?? null]);
    const emptySnapshot = { schemaVersion: 9, item: { source, sourceItemId }, packages: [], meta: [], operations: [], validation: { unresolvedIdentityConflicts: 0, suggestedParentRelations: 0, readyForCanonicalExport: false } };
    await client.query(`UPDATE meta.annotation_versions SET status='draft',snapshot=$2::jsonb,annotation_track_id=$3,
      source_job_id=NULL,operation_since=now(),updated_at=now() WHERE id=$1`, [versionId, JSON.stringify(emptySnapshot), trackId]);
    await client.query("COMMIT");
    return { versionId, revision: Number(version.revision), annotationTrackId: trackId, status: "draft" as const };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function attachAnnotationVersionJob(versionId: string, jobId: string) {
  await pool.query(`UPDATE meta.annotation_versions SET source_job_id=$2,status='processing',updated_at=now() WHERE id=$1 AND status='draft'`, [versionId, jobId]);
}

export async function setAnnotationVersionStatus(versionId: string, status: "processing" | "review_required" | "failed" | "cancelled") {
  await pool.query(`UPDATE meta.annotation_versions SET status=$2,updated_at=now() WHERE id=$1 AND status<>'approved'`, [versionId, status]);
}

export async function promoteAnnotationVersion(source: SourceName, sourceItemId: string, versionId: string, snapshot: JsonObject) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const version = await client.query(`SELECT id FROM meta.annotation_versions WHERE id=$1 AND source=$2 AND source_item_id=$3 FOR UPDATE`, [versionId, source, sourceItemId]);
    if (!version.rows[0]) throw new NotFoundError("Annotation version not found");
    await client.query(`UPDATE meta.annotation_versions SET status='approved',snapshot=$2::jsonb,approved_at=now(),updated_at=now() WHERE id=$1`, [versionId, JSON.stringify(snapshot)]);
    await client.query(`UPDATE meta.annotation_version_pointers SET active_version_id=$3,default_version_id=$3,updated_at=now() WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId, versionId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function recordMetadataRevision(row: Record<string, unknown>, origin: string, sourceJobId?: string | null) {
  const source = String(row.source); const sourceItemId = String(row.source_item_id);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${source}:${sourceItemId}:metadata-version`]);
    const revision = Number((await client.query(`SELECT COALESCE(MAX(revision),0)::int+1 revision FROM meta.metadata_item_revisions WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId])).rows[0].revision);
    const id = randomUUID();
    const snapshot = {
      aliases: row.aliases ?? [], normalizedTokens: row.normalized_tokens ?? [], visualFeatures: row.visual_features ?? {}, annotations: row.annotations ?? {},
      status: row.status ?? "generated", generationVersion: row.generation_version ?? null, sourceHash: row.source_hash ?? null,
      generatedAt: dateValue(row.generated_at), manuallyEditedAt: dateValue(row.manually_edited_at), updatedAt: dateValue(row.updated_at),
    };
    await client.query(`INSERT INTO meta.metadata_item_revisions(id,source,source_item_id,revision,snapshot,origin,source_job_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [id, source, sourceItemId, revision, JSON.stringify(snapshot), origin, sourceJobId ?? null]);
    await client.query(`INSERT INTO meta.metadata_version_pointers(source,source_item_id,active_revision_id,default_revision_id) VALUES($1,$2,$3,$3)
      ON CONFLICT(source,source_item_id) DO UPDATE SET active_revision_id=$3,default_revision_id=$3,updated_at=now()`, [source, sourceItemId, id]);
    await client.query("COMMIT");
    return id;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function ensureAndListMetadataVersions(source: SourceName, sourceItemId: string, current: Record<string, unknown> | null) {
  let pointers = await pool.query(`SELECT * FROM meta.metadata_version_pointers WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId]);
  if (!pointers.rows[0] && current) { await recordMetadataRevision(current, "bootstrap"); pointers = await pool.query(`SELECT * FROM meta.metadata_version_pointers WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId]); }
  const rows = await pool.query(`SELECT * FROM meta.metadata_item_revisions WHERE source=$1 AND source_item_id=$2 ORDER BY revision DESC`, [source, sourceItemId]);
  const pointer = pointers.rows[0];
  return {
    activeVersionId: pointer ? String(pointer.active_revision_id) : null,
    defaultVersionId: pointer ? String(pointer.default_revision_id) : null,
    items: rows.rows.map((row) => ({ id: String(row.id), revision: Number(row.revision), origin: String(row.origin), sourceJobId: nullableString(row.source_job_id), createdAt: dateValue(row.created_at), snapshot: objectValue(row.snapshot), isActive: String(row.id) === String(pointer?.active_revision_id), isDefault: String(row.id) === String(pointer?.default_revision_id) })),
  };
}

export async function deleteMetadataVersion(source: SourceName, sourceItemId: string, versionId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${source}:${sourceItemId}:metadata-version`]);
    const pointer = (await client.query(`SELECT * FROM meta.metadata_version_pointers
      WHERE source=$1 AND source_item_id=$2 FOR UPDATE`, [source, sourceItemId])).rows[0];
    const version = (await client.query(`SELECT id FROM meta.metadata_item_revisions
      WHERE id=$1 AND source=$2 AND source_item_id=$3 FOR UPDATE`, [versionId, source, sourceItemId])).rows[0];
    if (!version) throw new NotFoundError("Metadata version not found");
    if (!pointer) throw new ConflictError("Metadata version pointers are unavailable");
    if (String(pointer.active_revision_id) === versionId) throw new ConflictError("Active metadata version cannot be deleted; create a newer revision first");
    if (String(pointer.default_revision_id) === versionId) throw new ConflictError("Default metadata version cannot be deleted; select a different default first");
    const count = Number((await client.query(`SELECT COUNT(*)::int count FROM meta.metadata_item_revisions
      WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId])).rows[0].count);
    if (count <= 1) throw new ConflictError("The only metadata version cannot be deleted");
    await client.query(`DELETE FROM meta.metadata_item_revisions WHERE id=$1`, [versionId]);
    await client.query("COMMIT");
    return { deleted: true as const, versionId, activeVersionId: String(pointer.active_revision_id), defaultVersionId: String(pointer.default_revision_id) };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function makeMetadataVersionDefault(source: SourceName, sourceItemId: string, versionId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const revision = await client.query(`SELECT * FROM meta.metadata_item_revisions WHERE id=$1 AND source=$2 AND source_item_id=$3 FOR UPDATE`, [versionId, source, sourceItemId]);
    if (!revision.rows[0]) throw new NotFoundError("Metadata version not found");
    const snapshot = objectValue(revision.rows[0].snapshot);
    const updated = await client.query(`UPDATE meta.items SET aliases=$3::jsonb,normalized_tokens=$4::jsonb,visual_features=$5::jsonb,annotations=$6::jsonb,status=$7,
      generation_version=$8,source_hash=$9,updated_at=now() WHERE source=$1 AND source_item_id=$2 RETURNING *`,
      [source, sourceItemId, JSON.stringify(snapshot.aliases ?? []), JSON.stringify(snapshot.normalizedTokens ?? []), JSON.stringify(snapshot.visualFeatures ?? {}), JSON.stringify(snapshot.annotations ?? {}), snapshot.status ?? "generated", snapshot.generationVersion ?? null, snapshot.sourceHash ?? null]);
    if (!updated.rows[0]) throw new ConflictError("Metadata projection does not exist");
    await client.query(`UPDATE meta.metadata_version_pointers SET default_revision_id=$3,updated_at=now() WHERE source=$1 AND source_item_id=$2`, [source, sourceItemId, versionId]);
    await client.query("COMMIT");
    return { versionId, default: true };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

function annotationPointers(row: Record<string, unknown>) { return { activeVersionId: String(row.active_version_id), defaultVersionId: nullableString(row.default_version_id) }; }
function annotationVersionDto(row: Record<string, unknown>, pointers: Awaited<ReturnType<typeof getAnnotationVersionPointers>>) { return {
  id: String(row.id), revision: Number(row.revision), status: String(row.status), annotationTrackId: nullableString(row.annotation_track_id), parentVersionId: nullableString(row.parent_version_id), sourceJobId: nullableString(row.source_job_id), origin: String(row.origin),
  createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at), approvedAt: dateValue(row.approved_at), isActive: String(row.id) === pointers?.activeVersionId, isDefault: String(row.id) === pointers?.defaultVersionId,
}; }
function objectValue(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function objectArray(value: unknown) { return Array.isArray(value) ? value.map(objectValue) : []; }
function nullableString(value: unknown) { return value == null ? null : String(value); }
function finiteNumber(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function scopeSource(value: unknown, geometry: unknown) { return value === "auto" || value === "human" || value === "legacy-unclassified" ? value : geometry ? "human" : "default-full-image"; }
function provenanceSource(value: unknown) { return value === "auto" || value === "human" ? value : null; }
function packageTypeValue(value: unknown) { return value === "bottle" || value === "tube" || value === "box" || value === "other" ? value : "unknown"; }
function objectStatus(value: unknown) { return value === "suggested" || value === "reviewed" || value === "rejected" ? value : "missing"; }
function labelOrigin(value: unknown) { return value === "helper" || value === "legacy" || value === "migrated_from_direct_ocr" ? value : "human"; }
function visualRegionKind(value: unknown) { return value === "physical-label" || value === "direct-print" || value === "text-only" || value === "graphic-only" || value === "mixed" || value === "other" ? value : "unknown"; }
function transcriptionStatus(value: unknown) { return value === "verified" || value === "partial" ? value : "unreadable"; }
function legacyOcrStatus(regionStatus: unknown, status: unknown) { return regionStatus === "rejected" ? "rejected" : status === "verified" ? "verified" : status === "unreadable" ? "unreadable" : "no_transcription"; }
function legacyDirection(value: unknown) { const angle = finiteNumber(value) ?? 0; return Math.abs(angle) <= 45 ? "right" : angle > 45 && angle < 135 ? "down" : angle <= -45 && angle > -135 ? "up" : "left"; }
function legacyOrientation(value: unknown) { return value === "mixed" ? "mixed" : value === "upright" ? "upright" : "clockwise"; }
function characterOrientation(value: unknown, flow: unknown) { if (flow === "curved") return value === "upright" || value === "mixed" ? value : "tangent-aligned"; return value === "upright" || value === "mixed" ? value : "aligned"; }
function dateValue(value: unknown) { return value instanceof Date ? value.toISOString() : value == null ? null : String(value); }
