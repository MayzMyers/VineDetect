# Official contest reference bridge (Phase 3C)

This bridge keeps annotation source `svoe_vino` and canonical
`COALESCE(w.external_id,w.slug,w.id::text)`. It does not alter catalog identities,
links, or historical images. No migration 059 is needed; migrations 001–058 remain
unchanged.

## Read-only listing and preflight

The shared `official-reference.repository.ts` query joins catalog items, resolved
links, reference assets, import runs, and wines. It requires exactly 2,103 unique
catalog assignments, each with one reference. It does not deduplicate by wine ID
or image SHA. Coverage is 1,839 exact, 16 re-slug, and 248 materialized assignments.

From `recognize-service`, with `DATABASE_URL` configured for the intended database:

```bash
npm run preflight:contest-official -- ../backups/lct/contest_reference_phase3c/preflight.json
```

This command runs `REPEATABLE READ READ ONLY`, verifies every referenced file's
SHA-256, and creates no tracks, versions, jobs, or annotations. API equivalents:

- `GET /management/contest-official/references`
- `GET /management/contest-official/preflight`

Both use the existing `x-internal-api-key` authentication. The admin BFF exposes
these at `/api/admin/recognition/contest-official/{references,preflight}` with the
existing admin-token check.

## Explicit selection and draft binding

Open a `svoe_vino` card and use **Official contest reference** to select the exact
catalog assignment. The preview and **Open separate official draft** action use
that assignment's reference ID/path/SHA. Each selection creates a separate empty
Package, track, and version; it never clones historical reviewed geometry.
Assignments sharing a wine or image still have separate draft contexts.

`POST /management/contest-official/drafts` requires all four fields:

```json
{
  "catalogItemId": "<selected catalog ID>",
  "referenceAssetId": "<selected reference ID>",
  "referencePath": "<managed contest path>",
  "referenceSha256": "<SHA from listing>"
}
```

The exact reference is stored in the version snapshot and track-state JSON. Both
Package and track `source_asset_ref` contain the same managed path. Official
versions use origin `contest-official` and their own track. Creation never updates
historical graph rows, active/default version pointers, or reviewed snapshots.
An official draft is editable by its explicit track even when a historical version
remains the card's active/default version.

Wizard display, detection, source analysis, label analysis, OCR, rectification,
CV previews, and the worker resolve the bound asset explicitly. Official work
fails on missing/inconsistent binding; it cannot fall back to historical
`imageUrls[0]`. Wizard context and saved snapshots are scoped to the official
Package. Generic package editing cannot replace its bound image.

The resolver and admin asset proxy accept only the current managed namespace:
`contest/lct-rshb-2026-09-15/sha256/<2 hex>/<64 hex>.<image extension>`.
The shard must match the SHA prefix. Traversal, malformed paths, and real paths
outside the asset root are rejected. Existing historical path handling remains.

## Controlled pilot and batch targets

The preflight returns `planSha256` and all 2,103 assignments. Its null
track/package/version IDs mean a **new separate empty draft** will be allocated;
they do not authorize reusing a historical graph. POST target creation assigns
and persists actual UUIDs in one transaction with the job rows.

After deploying the updated recognition service and web app, run a fresh
preflight. For a first pilot, explicitly select one catalog ID and POST:

```json
{
  "expectedPlanSha256": "<hash from fresh preflight>",
  "catalogItemIds": ["<one explicitly selected catalog ID>"],
  "type": "GENERATE_DETECTION_PROPOSAL"
}
```

Endpoint: `POST /management/contest-official/batch` (same admin BFF path).
Supported types are `GENERATE_DETECTION_PROPOSAL`,
`ANNOTATION_HELPER_PIPELINE`, and `ANNOTATION_LLM_PIPELINE`. LLM requests may set
`options.llmExecutionMode` to `session-chain` or `one-shot-chain`. The latter two
use the existing Wizard review gates; downstream helpers may wait for reviewed
Label geometry. This is intentional pipeline behavior.

Every child freezes source, canonical source item ID, catalog item ID, reference
asset ID/path/SHA, Package ID, track ID, and version ID. Workers revalidate the
current assignment, binding, and file bytes before execution. Changed references
fail the job. Official versions remain non-default for review; the historical
published/default pointer is never automatically promoted. A single Wizard job
on an official track discovers and freezes the same binding server-side, ignoring
unsafe generic reset/publish options.

Official retries use a separate new draft. Retrying an official batch requires a
fresh preflight and explicit assignment selection. No deduplication by wine or SHA
is performed. A full batch requires explicitly providing all desired catalog IDs.

No pilot or large AutoDetect batch was launched during Phase 3C implementation.
No running service was redeployed. Deployment plus a fresh preflight are the
remaining operational prerequisites. An LLM pilot additionally needs the existing
configured controller/provider; provider execution was not exercised in this phase.

## Validation

Set `DATABASE_URL` and `CONTEST_OFFICIAL_TEST_DATABASE_URL` to the same isolated
migration-058 fixture database ending in `_test`, containing the Phase 3B2 catalog.
The integration test refuses a non-test database. Set `WORKER_ENABLED=false` and
`DATASET_EXPORT_ROOT` to a writable test-only directory. No worker is started by
the tests.

```bash
npm test
npm run typecheck
npm run build
```

Web checks: `npm run test:workflow` on Node 22+, then `next typegen`, TypeScript
`--noEmit`, and `npm run build`. On the local Node 20 environment the same workflow
test files were executed with the recognition project's `tsx --test` runner.

Evidence is under `backups/lct/contest_reference_phase3c/`: preflight, protected
before/after fingerprints, focused/full test output, build output, and the final
report with changed-file manifest. The isolated integration fixture creates test
jobs and drafts but does not execute generation or connect workers to that database.
