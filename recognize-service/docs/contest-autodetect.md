# Controlled official AutoDetect runner

This command processes the 2,096 remaining catalog assignments from `backups/lct/contest_reference_phase3c/full-autodetect-remaining.json`. It verifies the seven existing pilots (1, 2, 152, 193, 976, 1842, 1843) before excluding them. The unit of work is `catalogItemId`; shared wine IDs, canonical source IDs, paths, and image hashes remain separate assignments.

Run from `recognize-service` in WSL/Linux. Configure `DATABASE_URL`, `ASSET_ROOT`, `INTERNAL_API_KEY`, and optionally `RECOGNIZE_BASE_URL` (default `http://127.0.0.1:4001`) for the same running recognition service. Node 20+ is required. The command imports no server or worker startup module.

```sh
npm run autodetect:contest-official -- --state-dir ../backups/lct/contest_reference_phase3d --batch-size 100 --dry-run
```

A dry run verifies the live API and local database/asset preflights, checks all 2,103 official references, validates pilots, reconciles recorded jobs, and writes local review/checkpoint files. It creates no database jobs, drafts, proposals, or annotation state. Read-only transactions are used for evidence and preflight. A session advisory lock prevents simultaneous runner processes and releases automatically on process death.

Deploy the Phase 3D recognition API before submitting work. Its preflight must return `runnerProtocolVersion: 1`. No database migration is required. A Phase 3C API can be inspected by dry-run, but real submission is blocked. Deployment/restart is a separate operator action; implementation validation does not deploy or start generation.

First controlled 100-item batch:

```sh
npm run autodetect:contest-official -- --state-dir ../backups/lct/contest_reference_phase3d --batch-size 100 --max-batches 1
```

Inspect every preview/contact sheet for that batch before allowing more. The command without `--max-batches` continues through eligible assignments (21 batches at size 100 initially). It queues only `GENERATE_DETECTION_PROPOSAL`. It neither invokes OCR/LLM pipelines nor accepts/publishes proposals or changes detector logic.

## Checkpoint and recovery

Each batch gets a UUID request key. The intent is atomically written and fsynced before POST; returned parent and child IDs are saved immediately. The API serializes requests by key, stores a payload hash in parent job JSON, and returns the original job/targets for duplicate requests, including terminal or soft-deleted parents. Reusing a key with different inputs fails. Another key cannot create drafts for assignments with non-failed detection jobs.

On restart, the runner reads PostgreSQL for every recorded batch, revalidates its frozen targets, and reconciles children that completed offline. A lost POST response is recovered using the saved request key. Missing parents/children, changed job identities, reference drift, and changed plan hashes stop execution with the checkpoint retained. Do not remove or edit checkpoints to bypass these guards.

`--max-batches 1` counts an unfinished batch recovered as completed during startup, so resuming it does not submit an additional batch. A subsequent invocation after a fully classified checkpoint may process the next batch.

`--retry-failed` selects only assignments classified `failed`, with a fresh draft/track/Package/version. Successful, pilot, pending, and inconsistent assignments are excluded in this mode. Cancelled jobs, completed jobs without proposals, promoted versions, and structural defects are inconsistent and require manual investigation. Each eligible assignment is attempted at most once per invocation. A failed job with binding/geometry corruption is inconsistent rather than eligible for automatic retry.

## Validation and evidence

A successful assignment requires a completed detection child with null error, exact frozen reference and job identities, matching proposal image/track, matching track and Package assets, and matching persisted version binding and Package snapshot. Active/default version pointers must not reference that official version. Bboxes and four-point convex quads must be finite, nonzero, mutually consistent, and inside the reference image. Both original reference bytes and dimensions are checked before rendering.

Confidence is recorded, never used as a fixed pass/fail threshold. Summaries include min/median/mean/max, p0/p5/p10/p25/p50/p75/p90/p95/p100, ROI bbox-area ratios, width/height ratios, border contact, missing proposals, and structural issues. Low/high confidence sheets use inclusive batch p10/p90; ROI area outliers use Tukey 1.5 IQR. Ties are retained. Structural anomalies are flagged independently of confidence. Structural success is not a claim that the detector found the correct label.

Output under the selected state directory:

- `runner-state.json`: manifest/plan hashes, all assignment statuses, durable batch intents and frozen targets.
- `batches/<request-id>.json`: parent/child IDs and frozen targets for each submitted batch.
- `reports/<request-id>.json` and `.md`: validation evidence, distributions, anomalies, and visual links.
- `review/<request-id>/previews/<catalogItemId>.png`: one original-image preview with bbox/quad and readable identity/metrics.
- `review/<request-id>/{all,low-confidence,high-confidence,roi-size-outliers,border-touch,failed-inconsistent}-NNN.png`: at most six full cards per sheet; an explicit empty sheet for an empty group.
- `reports/pilot-validation.*` and `review/pilot-validation/`: the seven verified existing pilots, produced even by dry-run.
- `dry-run.json` / `last-run.json`: operation summary and deployed API readiness.

Source bytes are never rewritten. JSON/Markdown and PNG output is deterministic for unchanged evidence in the same runtime. Atomic file replacement lets interrupted rendering be safely repeated; assignment success is checkpointed only after artifacts finish. A one-hundred-item batch has 17 primary contact sheets plus its dedicated review groups.

## Tests

The regular `npm test` covers the pure state machine and validators. PostgreSQL/real-reference tests require `CONTEST_OFFICIAL_TEST_DATABASE_URL` equal to `DATABASE_URL`, pointing at an isolated database with an `_test` suffix and a restored migration-058 dataset including the pilots. No worker may connect to that fixture. Database snapshot tests must run serially (`tsx --test --test-concurrency=1 ...`) because they compare whole-table counts/fingerprints. Never point integration tests at the live `wines` database.

Coverage includes crash after POST, completed-parent reconciliation, one-batch recovery limits, failed-only retry, repeated request keys, missing parents, plan drift, separate shared-SHA/wine assignments, asset and geometry mismatches, pointer promotion, deterministic review rendering, and zero database changes from dry-run.
