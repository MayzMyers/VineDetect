import type { PoolClient } from "pg";
import { pool } from "../../db/pool.js";
import type { Evidence, Row } from "./autodetect.validation.js";
export async function readOnly<T>(
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const value = await fn(db);
    await db.query("COMMIT");
    return value;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}
export async function jobEvidence(job: Row, db: PoolClient): Promise<Evidence> {
  const t = job.target;
  const one = async (sql: string, args: unknown[]) =>
    (await db.query(sql, args)).rows[0] ?? null;
  return {
    job,
    track: await one("SELECT * FROM meta.annotation_tracks WHERE id=$1", [
      t.annotationTrackId,
    ]),
    package: await one("SELECT * FROM meta.annotation_packages WHERE id=$1", [
      t.packageId,
    ]),
    version: await one("SELECT * FROM meta.annotation_versions WHERE id=$1", [
      t.annotationVersionId,
    ]),
    proposals: (
      await db.query(
        "SELECT * FROM meta.detection_proposals WHERE annotation_track_id=$1 ORDER BY created_at,id",
        [t.annotationTrackId],
      )
    ).rows,
    pointers: (
      await db.query(
        "SELECT * FROM meta.annotation_version_pointers WHERE active_version_id=$1 OR default_version_id=$1",
        [t.annotationVersionId],
      )
    ).rows,
    resolutionMethod:
      (
        await one(
          "SELECT resolution_method FROM contest.reference_assets WHERE id=$1",
          [t.referenceAssetId],
        )
      )?.resolution_method ?? null,
  };
}
export async function readBatch(requestId: string) {
  return readOnly(async (db) => {
    const parents = (
      await db.query(
        "SELECT * FROM meta.generation_jobs WHERE parent_job_id IS NULL AND target->>'runnerRequestId'=$1",
        [requestId],
      )
    ).rows;
    if (parents.length > 1) throw new Error("Duplicate runner request parents");
    if (!parents.length) return null;
    const parent = parents[0]!;
    const children = (
      await db.query(
        "SELECT * FROM meta.generation_jobs WHERE parent_job_id=$1 ORDER BY (target->>'catalogItemId')::bigint,id",
        [parent.id],
      )
    ).rows;
    const evidence: Evidence[] = [];
    for (const job of children) evidence.push(await jobEvidence(job, db));
    return { parent, children: evidence };
  });
}
export async function readPilotEvidence(ids: string[]) {
  return readOnly(async (db) => {
    const jobs = (
      await db.query(
        "SELECT * FROM meta.generation_jobs WHERE target->>'catalogItemId'=ANY($1::text[]) AND job_type='GENERATE_DETECTION_PROPOSAL' ORDER BY created_at,id",
        [ids],
      )
    ).rows;
    const evidence: Evidence[] = [];
    for (const job of jobs) evidence.push(await jobEvidence(job, db));
    return evidence;
  });
}
