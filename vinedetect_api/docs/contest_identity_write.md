# Phase 3B2 controlled identity allocation

The command merges the frozen 1/215/48 identity plan with 48 final human decisions
(15 re-slugs and 33 new wines). It requires exactly **16 re-slugs, 248 new wines,
264 allocations, and zero unresolved allocations**. The known mappings are
validation expectations; allocations are read from the input artifacts.

Phase 3B2 stops at live dry-run. No live apply or migration 015 was executed while
preparing this implementation. The two decisions remain `re_slug` and `true_new`.

## Preconditions and migration

Use the local `wines` database. Set `DATABASE_URL` to its authenticated connection
URL; host-side WSL commands use `localhost:5432`. Run the commands below from the
repository root. The implementation does not contain database credentials.

Migration `015_contest_materialized_identity.sql` is required before apply. It adds
`materialized_official` to the allowed link methods. The existing NULL constraint
already requires this method to have a wine ID. `new_official_item` continues to
mean an unresolved proposal and still requires NULL. Migrations 013 and 014 are
unchanged. Apply 015 through the normal catalog migration process in a separately
authorized operation; do not apply recognize-service migrations for this step.

A successful dry-run can report `validation_passed: true` with
`ready_for_apply: false` and migration 015 listed. Missing migration is a deployment
prerequisite, not a failed identity allocation. `--apply` refuses to proceed until
that migration is present.

## Prepare and inspect the immutable allocation

```bash
PYTHONPATH=vinedetect_api vinedetect_api/.venv/bin/python \
  -m app.contest_identity_write --dry-run \
  --identity-plan-json backups/lct/contest_identity_phase3b1/identity-plan.json \
  --decisions-json backups/lct/contest_identity_phase3b1/manual-review-decisions-final.json \
  --snapshot-json backups/lct/contest_identity_phase3b1/input-snapshot.json \
  --output-dir backups/lct/contest_identity_phase3b2
```

Outputs include `final-allocation-plan.json`, `dry-run.json`,
`proposed-new-wines.json`, `proposed-link-updates.json`, and `validation.json`.
The allocation and proposal files are immutable: a different rerun refuses to
replace them. The report files describe the latest attempt. Input byte hashes,
source fingerprints, schema details, and all protected meta-table fingerprints
are retained in the allocation. The existing review-package validator was also
run against the final human decisions before the live preflight.

The reviewed plan hash is:

```text
1557bc0ca116b3689f1b536e8037068594f7b0e60ff9e94b1d0ab8ab20e28676
```

Recheck that same allocation without rebuilding it:

```bash
PYTHONPATH=vinedetect_api vinedetect_api/.venv/bin/python \
  -m app.contest_identity_write --dry-run \
  --final-plan-json backups/lct/contest_identity_phase3b2/final-allocation-plan.json \
  --expected-plan-sha256 1557bc0ca116b3689f1b536e8037068594f7b0e60ff9e94b1d0ab8ab20e28676 \
  --output-dir backups/lct/contest_identity_phase3b2
```

## Later apply command — not executed in Phase 3B2 preparation

After migration 015 and a fresh successful preflight, the exact command is:

```bash
PYTHONPATH=vinedetect_api vinedetect_api/.venv/bin/python \
  -m app.contest_identity_write --apply \
  --final-plan-json backups/lct/contest_identity_phase3b2/final-allocation-plan.json \
  --expected-plan-sha256 1557bc0ca116b3689f1b536e8037068594f7b0e60ff9e94b1d0ab8ab20e28676 \
  --output-dir backups/lct/contest_identity_phase3b2
```

The reviewed hash is mandatory for apply. Stale catalog data, historical wine
identities, images, grape mappings, exact links, meta state, sequence state, or
schema cause a failure before materialization. Do not edit the frozen baseline to
bypass a failure; regenerate and review in a new artifact directory.

Only a successful command exit confirms commit. Reports are written inside the
transaction so an output error rolls back database changes; a later commit error
can leave a report describing uncommitted work. Database validation, including an
exact replay, is authoritative after an interrupted or failed command.

## Transaction and identity behavior

Dry-run opens a PostgreSQL `REPEATABLE READ READ ONLY` transaction, including the
connection-level read-only default. It neither locks allocation tables for writing
nor consumes sequence values. Apply uses a single `READ COMMITTED` transaction
with relevant catalog tables locked before state is read. SHARE locks protect meta
tables for the duration of apply. A 15-second lock timeout rolls back on contention.

The canonical annotation key remains
`("svoe_vino", COALESCE(external_id, slug, id::text))`. Re-slugs only update their
existing `contest.item_links` rows. The 1,866 historical wine rows and 1,839 exact
links must retain their full fingerprints. No code inserts into `wine_images`,
creates annotation identities, starts generation jobs, or changes meta records.

The allocation checks external IDs, slugs, and numeric ID aliases across existing
and proposed rows. It also rejects numeric source keys that could shadow a future
ID. The inspected sequence allocates IDs **3733 through 3980**, not 1867 through
2114; the final row count is nevertheless 2,114. Sequence movement invalidates this
allocation instead of silently changing its IDs.

After collision validation, apply takes a sequence lock, rechecks its state,
reserves the range with transactional `ALTER SEQUENCE ... RESTART`, and inserts
explicit IDs. No `nextval` or `setval` is used. PostgreSQL documents that RESTART
is transactional and blocks concurrent sequence allocation:
[PostgreSQL 16 ALTER SEQUENCE](https://www.postgresql.org/docs/16/sql-altersequence.html).
Rollback tests verify that the sequence is restored together with all rows.

New wines use only the canonical organizer fields and retain the verbatim official
record in `raw_detail_json.organizer_catalog`. Missing information remains NULL.
There are no invented image or remote URLs. Image authority remains
`contest.reference_assets`.

Grape normalization uses Unicode normalization, case folding, and whitespace
normalization. Only a single matching existing dictionary entry creates a
relation. Unknown or ambiguous tokens remain in the raw record and the enrichment
report; they do not block the identity write. No grape dictionary entries are
created. The live proposal has 415 relations and five unresolved optional tokens.

The complete applied state is verified before commit: 2,103 catalog items,
2,103 reference assets, 2,103 resolved links, zero unmatched links, 2,114 wines,
and 1,866 historical images. This is link coverage, not a claim of 2,103 distinct
wine IDs. Exact replay requires all 264 allocations, their provenance, materialized
row hashes, grape relations, and IDs to agree; it inserts and updates zero rows.
Partial or conflicting state is rejected rather than overwritten.

## Tests

Use separate databases for the transactional contest fixtures and the destructive
repository fixtures. Both names must end in `_test`. The contest database must be
empty; its real migrations and fixtures are rolled back after each test. The
repository database must have catalog migrations applied and may be truncated.
Never point either test variable at live `wines`.

Run from the repository root (some existing tests use root-relative file paths):

```bash
PYTHONPATH=vinedetect_api vinedetect_api/.venv/bin/python -m pytest \
  vinedetect_api/tests/test_contest_identity_write.py -q
PYTHONPATH=vinedetect_api vinedetect_api/.venv/bin/python -m pytest \
  vinedetect_api/tests -q
```

Set `CONTEST_TEST_DATABASE_URL` and `TEST_DATABASE_URL` to the isolated fixture
databases first. Tests cover all required counts with a full-size synthetic
catalog, merge validation, stale state, numeric alias collisions, optional grapes,
rollback including sequence state, exact replay, unchanged exact links/images/meta,
and migration 015 NULL semantics.
