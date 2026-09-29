import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import { listOfficialReferences } from "../../db/official-reference.repository.js";
import {
  createOfficialDraftWithClient,
  verifyOfficialBytes,
  officialTargetForTrack,
} from "../../db/official-draft.repository.js";
import {
  assertReferenceMatches,
  type OfficialReference,
  type OfficialTarget,
} from "../../shared/officialReference.js";
import { ConflictError } from "../../shared/errors.js";

export type OfficialJobType =
  | "GENERATE_DETECTION_PROPOSAL"
  | "ANNOTATION_HELPER_PIPELINE"
  | "ANNOTATION_LLM_PIPELINE";
export function officialPreflightPlan(items: OfficialReference[]) {
  const targets = items.map((item) => ({
    ...item,
    annotationTrackId: null,
    packageId: null,
    annotationVersionId: null,
    draftPolicy: "separate-empty-draft",
  }));
  return {
    mode: "contest-official",
    total: items.length,
    methods: items.reduce<Record<string, number>>(
      (counts, r) => ({ ...counts, [r.method]: (counts[r.method] ?? 0) + 1 }),
      {},
    ),
    planSha256: createHash("sha256")
      .update(JSON.stringify(targets))
      .digest("hex"),
    targets,
  };
}
export async function officialPreflight() {
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const items = await listOfficialReferences(db);
    for (const item of items) await verifyOfficialBytes(item);
    const result = {
      ...officialPreflightPlan(items),
      runnerProtocolVersion: 1,
      readOnly: true,
      verifiedAssets: items.length,
      jobsCreated: 0,
    };
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
export async function validateOfficialJobTarget(job: Record<string, unknown>) {
  const target = job.target as OfficialTarget;
  if (!target?.catalogItemId) return null;
  const bound = await officialTargetForTrack(
    target.source,
    target.sourceItemId,
    target.annotationTrackId,
  );
  if (!bound) throw new ConflictError("Official job has no bound draft");
  assertReferenceMatches(target, bound);
  for (const key of [
    "annotationTrackId",
    "packageId",
    "annotationVersionId",
  ] as const)
    if (target[key] !== bound[key])
      throw new ConflictError(`Official job ${key} changed`);
  if (
    job.source !== target.source ||
    job.source_item_id !== target.sourceItemId ||
    job.annotation_track_id !== target.annotationTrackId ||
    job.annotation_version_id !== target.annotationVersionId
  )
    throw new ConflictError(
      "Official job identity does not match frozen target",
    );
  await verifyOfficialBytes(bound);
  return bound;
}
export async function insertOfficialJob(
  db: PoolClient,
  target: OfficialTarget,
  type: OfficialJobType,
  options: Record<string, unknown>,
  parentId: string | null,
) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO meta.generation_jobs(id,source,source_item_id,annotation_track_id,annotation_version_id,parent_job_id,mode,job_type,status,target,options,pipeline_version,total_items)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7,'queued',$8::jsonb,$9::jsonb,'contest-official-v1',1)`,
    [
      id,
      target.source,
      target.sourceItemId,
      target.annotationTrackId,
      target.annotationVersionId,
      parentId,
      type,
      JSON.stringify(target),
      JSON.stringify({
        ...options,
        annotationTrackId: target.annotationTrackId,
        annotationVersionId: target.annotationVersionId,
        annotationVersionPublishPolicy: "review",
        officialReference: target,
      }),
    ],
  );
  return id;
}
export async function queueOfficialBatch(input: {
  runnerRequestId?: string;
  expectedPlanSha256: string;
  catalogItemIds: string[];
  type: OfficialJobType;
  options?: Record<string, unknown>;
}) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    // Transaction-level serialization makes retries safe even after a lost HTTP
    // response or terminal/deleted jobs. The key lives in existing job JSON.
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          plan: input.expectedPlanSha256,
          ids: [...input.catalogItemIds].sort(),
          type: input.type,
          options: input.options ?? {},
        }),
      )
      .digest("hex");
    if (input.runnerRequestId) {
      if (
        input.type !== "GENERATE_DETECTION_PROPOSAL" ||
        Object.keys(input.options ?? {}).length
      )
        throw new ConflictError(
          "Controlled runner supports detection only, with no pipeline options",
        );
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "contest-runner:" + input.runnerRequestId,
      ]);
      const existing = await db.query(
        "SELECT id,status,target FROM meta.generation_jobs WHERE parent_job_id IS NULL AND target->>'runnerRequestId'=$1",
        [input.runnerRequestId],
      );
      if (existing.rows.length > 1)
        throw new ConflictError("Duplicate runner request evidence");
      if (existing.rows.length) {
        const parent = existing.rows[0];
        if (parent.target.runnerRequestHash !== requestHash)
          throw new ConflictError(
            "Runner request key reused with a different payload",
          );
        const children = await db.query(
          "SELECT id,target FROM meta.generation_jobs WHERE parent_job_id=$1 ORDER BY (target->>'catalogItemId')::bigint",
          [parent.id],
        );
        if (children.rows.length !== parent.target.items.length)
          throw new ConflictError("Runner request children are incomplete");
        await db.query("COMMIT");
        return {
          jobId: parent.id as string,
          status: parent.status as string,
          queuedChildren: children.rows.length,
          childJobIds: children.rows.map((r) => String(r.id)),
          targets: parent.target.items as OfficialTarget[],
        };
      }
    }
    await db.query(
      "LOCK TABLE contest.catalog_items,contest.item_links,contest.reference_assets,svoe_vino.wines IN SHARE MODE",
    );
    const items = await listOfficialReferences(db);
    const plan = officialPreflightPlan(items);
    if (plan.planSha256 !== input.expectedPlanSha256)
      throw new ConflictError(
        "Official preflight changed; run preflight again",
      );
    const ids = new Set(input.catalogItemIds);
    if (ids.size !== input.catalogItemIds.length || !ids.size)
      throw new ConflictError("Select unique official catalog assignments");
    const selected = items.filter((r) => ids.has(r.catalogItemId));
    if (selected.length !== ids.size)
      throw new ConflictError("Unknown official catalog assignment");
    if (input.runnerRequestId) {
      for (const item of selected)
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "contest-runner-assignment:" + item.catalogItemId,
        ]);
      const prior = await db.query(
        `SELECT target->>'catalogItemId' AS id FROM meta.generation_jobs
        WHERE target->>'catalogItemId'=ANY($1::text[]) AND job_type='GENERATE_DETECTION_PROPOSAL'
        AND status <> 'failed'`,
        [input.catalogItemIds],
      );
      if (prior.rows.length)
        throw new ConflictError(
          "Assignments already have non-failed detection jobs; resume their checkpoint instead of creating new drafts: " +
            prior.rows.map((r) => r.id).join(","),
        );
    }
    for (const item of selected) await verifyOfficialBytes(item);
    const targets: OfficialTarget[] = [];
    for (const item of selected)
      targets.push(await createOfficialDraftWithClient(db, item));
    const parentId = randomUUID();
    await db.query(
      `INSERT INTO meta.generation_jobs(id,source,mode,job_type,status,target,options,pipeline_version,total_items)
      VALUES($1,'svoe_vino',$2,$2,'queued',$3::jsonb,$4::jsonb,'contest-official-v1',$5)`,
      [
        parentId,
        input.type,
        JSON.stringify({
          runnerRequestId: input.runnerRequestId ?? null,
          runnerRequestHash: input.runnerRequestId ? requestHash : null,
          mode: "contest-official",
          planSha256: plan.planSha256,
          items: targets,
        }),
        JSON.stringify(input.options ?? {}),
        targets.length,
      ],
    );
    const childJobIds: string[] = [];
    for (const target of targets)
      childJobIds.push(
        await insertOfficialJob(
          db,
          target,
          input.type,
          input.options ?? {},
          parentId,
        ),
      );
    await db.query("COMMIT");
    return {
      jobId: parentId,
      status: "queued",
      queuedChildren: targets.length,
      childJobIds,
      targets,
    };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
