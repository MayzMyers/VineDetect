import { getAnnotationGraph } from "./annotation-graph.repository.js";
import type { AnnotationGraph } from "../shared/annotationGraphContract.js";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { pool } from "./pool.js";
import { getSourceItem } from "./source.repository.js";
import { getOfficialReference } from "./official-reference.repository.js";
import {
  assertReferenceMatches,
  type OfficialReference,
  type OfficialTarget,
} from "../shared/officialReference.js";
import { resolveLocalAssetPath } from "../modules/recognize-node/assets.js";
import { ConflictError } from "../shared/errors.js";
import type { SourceName } from "../shared/types.js";

type Reader = Pick<PoolClient, "query">;
export async function verifyOfficialBytes(reference: OfficialReference) {
  const path = resolveLocalAssetPath(reference.referencePath);
  if (
    !path ||
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex") !== reference.referenceSha256
  )
    throw new ConflictError(
      "Official reference bytes do not match frozen SHA-256",
    );
}
export async function officialTargetForTrack(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
  db: Reader = pool,
): Promise<OfficialTarget | null> {
  const result = await db.query(
    `SELECT t.source_asset_ref,t.status,p.id package_id,p.source_asset_ref package_asset_ref,
    v.id version_id,v.snapshot->'officialReference' binding
    FROM meta.annotation_tracks t JOIN meta.annotation_packages p ON p.legacy_annotation_track_id=t.id AND p.deleted_at IS NULL
    LEFT JOIN meta.annotation_versions v ON v.annotation_track_id=t.id AND v.origin='contest-official'
    WHERE t.id=$1 AND t.source=$2 AND t.source_item_id=$3`,
    [trackId, source, sourceItemId],
  );
  const row = result.rows[0];
  if (!row) throw new ConflictError("Selected Package/track is unavailable");
  if (!row.binding) {
    if (
      String(row.source_asset_ref ?? "").startsWith("contest/") ||
      String(row.package_asset_ref ?? "").startsWith("contest/")
    )
      throw new ConflictError(
        "Contest asset requires a frozen official assignment",
      );
    return null;
  }
  const target = row.binding as OfficialTarget;
  const current = await getOfficialReference(target.catalogItemId, db);
  assertReferenceMatches(target, current);
  if (
    target.source !== source ||
    target.sourceItemId !== sourceItemId ||
    target.annotationTrackId !== trackId ||
    target.packageId !== row.package_id ||
    target.annotationVersionId !== row.version_id ||
    row.source_asset_ref !== target.referencePath ||
    row.package_asset_ref !== target.referencePath ||
    row.status === "archived"
  )
    throw new ConflictError("Official Package/track/version binding changed");
  return target;
}
export async function getSourceItemForTrack(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
) {
  const item = await getSourceItem(source, sourceItemId);
  if (!item) return null;
  const target = await officialTargetForTrack(
    source,
    item.sourceItemId,
    trackId,
  );
  if (target) {
    await verifyOfficialBytes(target);
    return {
      ...item,
      sourceAssetRef: target.referencePath,
      officialReference: target,
    };
  }
  const result = await pool.query(
    "SELECT source_asset_ref FROM meta.annotation_tracks WHERE id=$1",
    [trackId],
  );
  return {
    ...item,
    sourceAssetRef: result.rows[0]?.source_asset_ref ?? undefined,
  };
}
// Caller owns transaction. No historical graph rows or published/default pointers are updated.
export async function createOfficialDraftWithClient(
  db: PoolClient,
  reference: OfficialReference,
): Promise<OfficialTarget> {
  assertReferenceMatches(
    reference,
    await getOfficialReference(reference.catalogItemId, db),
  );
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
    reference.source,
    reference.sourceItemId,
  ]);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${reference.source}:${reference.sourceItemId}:annotation-version`,
  ]);
  const ordinal = Number(
    (
      await db.query(
        "SELECT COALESCE(max(ordinal),0)+1 n FROM meta.annotation_tracks WHERE source=$1 AND source_item_id=$2",
        [reference.source, reference.sourceItemId],
      )
    ).rows[0].n,
  );
  const revision = Number(
    (
      await db.query(
        "SELECT COALESCE(max(revision),0)+1 n FROM meta.annotation_versions WHERE source=$1 AND source_item_id=$2",
        [reference.source, reference.sourceItemId],
      )
    ).rows[0].n,
  );
  const target: OfficialTarget = {
    ...reference,
    annotationTrackId: randomUUID(),
    packageId: randomUUID(),
    annotationVersionId: randomUUID(),
  };
  await db.query(
    `INSERT INTO meta.annotation_tracks(id,source,source_item_id,ordinal,name,source_asset_ref,status)
    VALUES($1,$2,$3,$4,$5,$6,'draft')`,
    [
      target.annotationTrackId,
      target.source,
      target.sourceItemId,
      ordinal,
      `Official: ${target.officialSlug}`,
      target.referencePath,
    ],
  );
  await db.query(
    `INSERT INTO meta.annotation_track_states(annotation_track_id,annotations) VALUES($1,$2::jsonb)`,
    [target.annotationTrackId, JSON.stringify({ officialReference: target })],
  );
  await db.query(
    `INSERT INTO meta.annotation_packages(id,source,source_item_id,legacy_annotation_track_id,source_asset_ref,scope_source,status)
    VALUES($1,$2,$3,$4,$5,'default-full-image','draft')`,
    [
      target.packageId,
      target.source,
      target.sourceItemId,
      target.annotationTrackId,
      target.referencePath,
    ],
  );
  await db.query(
    `INSERT INTO meta.annotation_versions(id,source,source_item_id,revision,status,snapshot,annotation_track_id,origin)
    VALUES($1,$2,$3,$4,'draft',$5::jsonb,$6,'contest-official')`,
    [
      target.annotationVersionId,
      target.source,
      target.sourceItemId,
      revision,
      JSON.stringify({
        schemaVersion: 9,
        item: { source: target.source, sourceItemId: target.sourceItemId },
        officialReference: target,
        packages: [
          {
            id: target.packageId,
            legacyAnnotationTrackId: target.annotationTrackId,
            sourceAssetRef: target.referencePath,
            labels: [],
          },
        ],
        meta: [],
        operations: [],
      }),
      target.annotationTrackId,
    ],
  );
  return target;
}
export async function createOfficialDraft(reference: OfficialReference) {
  await verifyOfficialBytes(reference);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const target = await createOfficialDraftWithClient(db, reference);
    await db.query("COMMIT");
    return target;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
export async function captureOfficialDraft(
  target: OfficialTarget,
  graph: AnnotationGraph,
) {
  await officialTargetForTrack(
    target.source,
    target.sourceItemId,
    target.annotationTrackId,
  );
  const scoped = scopeOfficialGraph(graph, target);
  const packages = scoped.packages;
  if (
    packages.length !== 1 ||
    packages[0].sourceAssetRef !== target.referencePath
  )
    throw new ConflictError("Official snapshot Package binding changed");
  await pool.query(
    `UPDATE meta.annotation_versions SET snapshot=$2::jsonb,updated_at=now() WHERE id=$1 AND origin='contest-official' AND status IN ('draft','processing','review_required')`,
    [
      target.annotationVersionId,
      JSON.stringify({ ...scoped, officialReference: target }),
    ],
  );
}

export function scopeOfficialGraph(
  graph: AnnotationGraph,
  target: OfficialTarget,
): AnnotationGraph {
  const packages = graph.packages.filter((p) => p.id === target.packageId);
  const ids = new Set(
    packages.flatMap((p) => [p.id, ...p.labels.map((l) => l.id)]),
  );
  const operations = graph.operations.filter(
    (o) => o.scope && ids.has(o.scope.id),
  );
  const unresolvedIdentityConflicts = operations
    .filter((o) => o.status === "draft")
    .reduce(
      (n, o) =>
        n +
        o.candidates.filter((c) => {
          const analysis = c.payload.duplicateAnalysis as
            | { matches?: unknown[] }
            | undefined;
          return Boolean(analysis?.matches?.length);
        }).length,
      0,
    );
  const suggestedParentRelations = packages
    .flatMap((p) => [...p.ocr, ...p.labels.flatMap((l) => l.ocr)])
    .filter((o) => o.parentRelation.status === "suggested").length;
  return {
    ...graph,
    packages,
    meta: [],
    operations,
    validation: {
      unresolvedIdentityConflicts,
      suggestedParentRelations,
      readyForCanonicalExport: unresolvedIdentityConflicts === 0,
    },
  };
}
export async function getAnnotationGraphForTrack(
  source: SourceName,
  sourceItemId: string,
  trackId: string,
) {
  const target = await officialTargetForTrack(source, sourceItemId, trackId);
  if (target) await verifyOfficialBytes(target);
  const graph = await getAnnotationGraph(source, sourceItemId);
  return target ? scopeOfficialGraph(graph, target) : graph;
}
