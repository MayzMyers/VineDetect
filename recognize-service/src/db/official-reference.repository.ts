import type { PoolClient } from "pg";
import { pool } from "./pool.js";
import {
  OFFICIAL_CONTEST_VERSION,
  assertReferenceMatches,
  type OfficialReference,
} from "../shared/officialReference.js";

type Reader = Pick<PoolClient, "query">;
// One assignment per catalog item. Never DISTINCT by wine ID or physical SHA.
export const OFFICIAL_REFERENCE_SQL = `SELECT c.id::text AS "catalogItemId", c.official_slug AS "officialSlug",
  w.id::text AS "wineId", 'svoe_vino' AS source, COALESCE(w.external_id,w.slug,w.id::text) AS "sourceItemId",
  a.id::text AS "referenceAssetId", a.local_path AS "referencePath", a.sha256 AS "referenceSha256",
  a.width,a.height,l.method,l.provenance
  FROM contest.catalog_items c
  JOIN contest.import_runs run ON run.id=c.import_run_id AND run.status='completed'
  JOIN contest.item_links l ON l.catalog_item_id=c.id
  JOIN contest.reference_assets a ON a.catalog_item_id=c.id
  JOIN svoe_vino.wines w ON w.id=l.wine_id
  WHERE run.version=$1`;
export async function listOfficialReferences(
  db: Reader = pool,
): Promise<OfficialReference[]> {
  const result = await db.query(
    OFFICIAL_REFERENCE_SQL + " ORDER BY c.id,a.id",
    [OFFICIAL_CONTEST_VERSION],
  );
  const rows = result.rows as OfficialReference[];
  if (
    rows.length !== 2103 ||
    new Set(rows.map((r) => r.catalogItemId)).size !== 2103
  )
    throw new Error(
      "Expected exactly 2103 official assignments with one reference each",
    );
  for (const row of rows) assertReferenceMatches(row, row);
  return rows;
}
export async function getOfficialReference(
  catalogItemId: string,
  db: Reader = pool,
): Promise<OfficialReference> {
  const result = await db.query(
    OFFICIAL_REFERENCE_SQL + " AND c.id=$2 ORDER BY a.id",
    [OFFICIAL_CONTEST_VERSION, catalogItemId],
  );
  if (result.rows.length !== 1)
    throw new Error(
      "Official assignment must have exactly one resolved reference",
    );
  const reference = result.rows[0] as OfficialReference;
  assertReferenceMatches(reference, reference);
  return reference;
}
