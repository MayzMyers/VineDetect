> Organizer-truth policy, 2026-09-25: the eight DQ2 reference replacements, 603
> identity correction and 2079 metadata overlay below are historical and superseded.
> Active reference inputs retain only out-of-scope 1399/1681; 603 replay is disabled,
> and the metadata override manifest is empty. See [rollback audit](../docs/DATABASE_ROLLBACK_20260925.md).

# Official LCT/RSHB catalog (Phases 1 and 2A)

`official CSV -> contest_raw.catalog_rows -> contest.catalog_items -> contest.item_links -> svoe_vino.wines`

Migration **013_contest_catalog.sql** adds only `contest` and `contest_raw`
objects, plus a restrictive foreign key pointing to existing `svoe_vino.wines`.
The active `meta.*` annotation graph is independent of these tables.

## Storage and invariants

| Table | Responsibility |
| --- | --- |
| `contest.import_runs` | Unique caller-supplied version, source filename, SHA-256, exact original CSV bytes, parser version/settings/header order, counts/conflicts, timestamps and status. |
| `contest_raw.catalog_rows` | Every CSV data record, including duplicates, with its 1-based logical record number, physical ending line, all original fields as JSON, derived official slug and deterministic SHA-256 of canonical JSON serialization. Row hashes are deliberately not unique. |
| `contest.catalog_items` | One item per `(import_run_id, official_slug)`, retaining official title, category, color, region, grapes, description, winery and photo name verbatim. A composite foreign key ties its chosen row to the same import and slug. |
| `contest.reference_assets` | Separate official image metadata: item, original filename, local path unique per item, SHA-256, optional perceptual hash, dimensions, byte size and image MIME type. No image files are copied by Phase 1. |
| `contest.item_links` | One current decision per official item, nullable historical wine ID, method, optional confidence, JSON provenance and timestamps. Multiple official items may link to one historical wine. |

Different catalog items may reference the same physical path and SHA-256; only
`(catalog_item_id, local_path)` is unique. The validated organizer catalog has
2,103 canonical slugs and 2,090 unique photo names: 13 images each serve two items.

The evaluation key is **the official slug within an explicitly selected import
version**. Numeric item IDs are database keys, not evaluation or annotation IDs.
All raw rows for an item are available by joining on `(import_run_id, official_slug)`.
The first source record wins when a slug repeats; conflicting canonical fields
are reported in `import_runs.metadata.conflicting_slugs`. Later conflicting rows
remain fully available in the raw layer. No stripping, case folding, Unicode
normalization, grape splitting, or field merging occurs.

The original byte stream preserves BOM, encoding, quotes, column order and line
endings. JSON represents decoded field values, not the original CSV syntax.
Duplicate/blank headers, missing required columns, malformed records, NUL values,
empty input and blank slugs/titles fail explicitly before database writes. Empty
optional values are retained as empty strings; all nine mapped columns are required.

Imports are atomic. Failure rolls back the run and all its rows; a failed run is
not retained. Successful versions are immutable through the importer. A retry
with identical bytes, filename and parser settings returns the existing run
without changing any records, links or assets. Reusing a version for other input
raises `ImportVersionConflict`; use a new version. The unique version constraint
serializes concurrent imports under PostgreSQL's default READ COMMITTED isolation.
For stronger caller-selected isolation, retry serialization failures externally.
If called inside an existing transaction, `import_catalog` uses a savepoint and
the caller controls the final commit. The CLI commits before returning success.

Initial linking uses literal equality with `svoe_vino.wines.slug` only. A match
records `exact_slug`, confidence `1` (rule certainty, not a semantic probability),
and importer/slug/rule evidence. All other items get `unmatched`, null `wine_id`
and null confidence. Missing an exact match does **not** prove a wine is new.
The schema also accepts `re_slug`, `same_asset`, `metadata_match`, `manual`, and
`new_official_item`; Phase 1 does not infer those decisions. Null wine IDs are
allowed only for `unmatched`/`new_official_item`. Confirmed links require a valid
wine ID, and deletion of a linked historical wine is restricted.

Reconciliation must update only the contest link with decision evidence and an
updated timestamp. In particular, keep `svoe_vino.wines.id`, `external_id`, `slug`
and the annotation contract `source="svoe_vino"` / existing `source_item_id`
unchanged. The current identity resolver uses `COALESCE(external_id, slug,
id::text)`. An official re-slug therefore stays in `contest.catalog_items` and
links to the existing wine. Future materialization can populate `wine_id` after
creating a new historical catalog row under the existing annotation contract;
it is intentionally not implemented here.

## Apply and import

On a database already migrated through **012**, apply the new file once using
the deployment's migration ledger and transaction convention. Direct SQL example
(from `vinedetect_api`, with `DATABASE_URL` set):

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -f migrations/013_contest_catalog.sql
```

This direct command does not register the migration in a deployment ledger.
The existing package-local Compose runner has a pre-existing bootstrap issue:
it creates `schema_migrations` in `public`, while migration 012 drops `public`.
That tracked bootstrap cannot reach 013 until the ledger is moved out of `public`
and its queries qualified. No migration history or runner is rewritten in this
phase. The new database tests apply SQL files 001-013 directly on an empty,
isolated database; they do not claim to validate that Compose runner.

### Validated organizer snapshot

The official CSV has been validated; the following snapshot details were confirmed
in the Phase 1 review:

| Property | Value |
| --- | --- |
| File | `strapi_output0709.csv` |
| Size | `2952669` bytes |
| SHA-256 | `12a1b0b620db7a2264b094446861e83940a927708d65a1b7ccffda7ec3aeffee` |
| Raw rows | `4147` |
| Canonical unique slugs | `2103` |
| Duplicate slug rows | `2044` |
| Conflicting duplicate slugs | `0` |

The checked-in [official column mapping](config/lct_rshb_2026_columns.json) maps
`Slug`, `Название вина`, `Категория`, `Цвет`, `Регион`, `Сорт винограда`,
`Описание`, `Винодельня` and `Название фото` to the canonical fields. Unknown
source columns remain in raw JSON. Encoding and delimiter are explicit; no
guessed dialect or header aliases are used. From `vinedetect_api`:

```sh
# No database connection or writes; compare the output with the snapshot above.
python -m app.contest_import /path/to/strapi_output0709.csv \
  --version lct-rshb-2026-v1 \
  --column-map config/lct_rshb_2026_columns.json --dry-run

# Uses the explicitly supplied DATABASE_URL environment variable.
python -m app.contest_import /path/to/strapi_output0709.csv \
  --version lct-rshb-2026-v1 \
  --column-map config/lct_rshb_2026_columns.json
```

Use `--encoding` (default `utf-8-sig`) and `--delimiter` (default comma) when needed.
No download, production import, historical catalog materialization, API endpoint,
recognition, annotation, frontend, or retention operation runs implicitly.

## Verification

From the repository root, using the API virtual environment:

```sh
# Pure parser/CLI tests run without PostgreSQL; integration tests skip without URL.
python -m pytest -q vinedetect_api/tests/test_contest_import.py

# Dedicated EMPTY database only; database name must end in _test.
CONTEST_TEST_DATABASE_URL=postgresql://USER@HOST/contest_test \
  python -m pytest -q vinedetect_api/tests/test_contest_import.py
```

Integration fixtures check that the database is empty, apply the real numbered
migration chain in a transaction, and roll back schema and data after each test.
They use a separate variable from the older repository suite's destructive
`TEST_DATABASE_URL` fixtures. Coverage includes raw preservation, canonical
provenance/conflicts, retries/version collisions, failed-import rollback,
re-slug and nullable links, shared image paths/SHA-256 across items, the official
header mapping through parser/CLI, stable historical identity/images, and integrity
constraints. No production database or media assets are needed.


## Phase 2A: read-only media manifest and resolver

`app.contest_media` inventories the full extracted uploads tree, then resolves
only the selected catalog version's photo names. It creates no recognition index
and performs no database or media writes. Database reads use a REPEATABLE READ,
READ ONLY transaction with `default_transaction_read_only=on` from connection
startup. An exported canonical JSON list can be used instead.

The manifest contains every regular file, including non-raster files. SHA-256 is
streamed in 1 MiB chunks. Raster extensions are inspected with Pillow's
`open()/verify()`; no `load()` or pixel conversion is performed. Status
`header_only` means available header/container checks passed, **not** a full
pixel decode. Some Pillow plugins cannot detect corrupt pixel data this way.
Actual format/MIME and extension mismatches are recorded.

Pillow decompression-bomb warnings and errors remain enabled. The inspection
also enforces 89,478,485 pixels and a 64 MiB compressed-file limit. Oversized
PNG/JPEG dimensions use bounded header parsing; these files retain an
`oversized` status. Symlinks are represented without following them. Corrupt,
unsupported, non-raster and inspection-limit entries are excluded from resolver
candidates. An identified oversized raster may resolve, with its safety status
retained for review; none of the actual resolved references is oversized.

Primary resolution rules (`strapi-filename/1`); Phase 2A.1 below adds evidence
refinement after this baseline:

1. Prefer a literal filename match; duplicate basenames are ambiguous.
2. Otherwise compare filename stems and extensions after NFKC, casefolding,
   fixed Russian transliteration, and removal of separator/punctuation characters.
   The observed transliteration includes `й→j`, `х→h`, `ц→cz` and `щ→shh`.
   Archive names have both full and terminal `_10hex`-stripped comparison keys.
   Organizer names retain their suffixes, including 10-digit timestamps.
   Extensions remain significant; thumbnail/size prefixes are never removed.
3. Select only a unique path. Multiple candidate paths remain ambiguous even
   when their SHA-256 values are identical. There is no fuzzy scoring.
4. Multiple items selecting one path become `shared_reference`. Each retains its
   original `match_basis`, slug and catalog item ID. Sharing inferred from
   normalized names is visible for review, not a semantic identity merge.

`resolved_exactly` and `resolved_normalized_unique` include shared items and sum
to resolved items. The baseline's five `match_classes` are mutually exclusive; Phase 2A.1 adds three
evidence classes while retaining the original primary classifications.
“Unused” means not uniquely selected, so it includes ambiguous candidates.
Duplicate SHA groups cover all regular archive files, including non-raster files.

### Real snapshot dry run

From `vinedetect_api` with the existing local `DATABASE_URL` exported:

```sh
python -m app.contest_media \
  --media-root /home/mayz/datasets/lct2026/media-official-staging/prod-svoe-vino-strapi/prod-svoe-vino/strapi/uploads \
  --import-version lct-rshb-2026-09-15 \
  --output-dir ../.dev_logs/lct-media-phase2a-final
```

This command is inherently a dry run: only report files are written. The current
CLI writes the three JSON artifacts and an additional `media-review.md` audit.
Output must be outside the media root. The generated artifacts are ignored by
Git; no archive inventory is checked into the application catalog.

- [media-manifest.json](../.dev_logs/lct-media-phase2a-final/media-manifest.json):
  every file's metadata, status, relative path and hash.
- [catalog-items.json](../.dev_logs/lct-media-phase2a-final/catalog-items.json):
  read-only canonical export with import version and CSV checksum.
- [media-resolution.json](../.dev_logs/lct-media-phase2a-final/media-resolution.json):
  all item resolutions, candidates, shared groups, unused paths, duplicate hashes,
  extension mismatches, failures and oversized files.

Offline replay requires neither the database nor the extracted media:

```sh
python -m app.contest_media \
  --manifest-json ../.dev_logs/lct-media-phase2a-final/media-manifest.json \
  --catalog-json ../.dev_logs/lct-media-phase2a-final/catalog-items.json \
  --output-dir ../.dev_logs/lct-media-phase2a-replay
```

Serialization and collection ordering are deterministic, without timestamps or
absolute archive paths. The manifest records the Pillow version and safety
policy; use the same decoder environment to reproduce inspection results.
Reports include SHA-256 of their canonical manifest and catalog exports.

### Actual organizer results (2026-09-15)

Import `lct-rshb-2026-09-15` has the validated CSV checksum recorded above.

| Measure | Result |
| --- | ---: |
| Canonical items / unique photo names | 2,103 / 2,090 |
| Exact filename resolutions | 0 |
| Normalized unique resolutions, including shared items | 2,021 |
| Exclusive normalized_unique class / shared_reference class | 2,009 / 12 |
| Selected physical paths / shared-reference groups | 2,015 / 6 |
| Ambiguous / missing items | 75 / 7 |
| Total archive files / bytes | 15,803 / 2,251,314,429 |
| Raster candidates / successful header inspections | 15,770 / 15,767 |
| Non-raster / oversized / unidentified | 33 / 2 / 1 |
| Extension mismatches | 31 |
| Unused archive files | 13,788 |
| Duplicate SHA-256 groups / paths in those groups | 867 / 1,874 |

Only six of the 13 repeated-photo-name groups resolve uniquely; the other seven
remain represented among unresolved items. The full report contains every slug
and candidate path; no uncertain choice has been promoted to a reference asset.

Oversized: `Kommunalka_webp_e394ce9279.png` (27,797 × 8,556) and
`Derbent_Vino_szhat_webp_cb05d3331f.jpg` (26,387 × 9,479).
Unidentified: `Letnie_bezalkogolnye_koktejli_webp_c2e6143f8d.png`.

Two independent scans produced byte-identical manifests with SHA-256
`dad36f8cbad0f7d166fe7489ff9082d4fabbf2b8978a1c5221b194b3f46c3f5d`.
Tests cover normalization, all match classes, non-raster exclusion, duplicate
hashes, bounded inspection, Pillow warning/error handling, deterministic output
and CLI replay. Run `python -m pytest -q tests/test_contest_media.py`.


## Phase 2A.1: deterministic evidence refinement

The current CLI adds `contest-resolution/2` reports and exports title, winery,
linked wine ID and historical `wine_images` URL/path metadata in the same
read-only transaction. Offline replay uses this enriched `catalog-items.json`.
Older exports still work, but cannot provide historical evidence.

Only baseline ambiguous items are refined, in this order:

1. `sha_equivalent`: **all** candidate hashes are identical and valid SHA-256.
   Select the lexicographically smallest relative path and retain every
   `equivalent_candidate_paths` entry. Partial hash agreement is insufficient.
2. `historical_asset_exact`: exactly one existing candidate basename matches
   any URL/path basename from the linked wine's historical images. URL query
   strings are removed and percent-encoded names decoded. Multiple conflicting
   exact matches remain ambiguous; weaker evidence cannot override them.
3. `historical_asset_normalized`: exactly one existing candidate matches the
   historical basename under the existing normalization, **retaining its hash**.
   Evidence rank 1 is lower than exact basename rank 2; SHA identity has rank 3.
   These ranks indicate the rule strength, not calibrated probabilities.

No title/winery inference, image similarity, file copying or database updates
occur. Evidence records identify the historical image row and URL/path field.
All original candidate paths remain in each resolution record.

Before/after counts are mutually exclusive. Original `shared_reference` classes
are retained; newly resolved rows keep their evidence class even when they share
content. `baseline_shared_reference_groups` preserves the six original groups.
The compatibility `shared_reference_groups` field also denotes those baseline
groups. The separate `shared_physical_asset_groups` audit groups all selected
items by `sha256:...` content identity, without merging catalog identities.

### Run and replay

From `vinedetect_api`, with the existing local `DATABASE_URL` exported:

```sh
python -m app.contest_media \
  --manifest-json ../.dev_logs/lct-media-phase2a-final/media-manifest.json \
  --import-version lct-rshb-2026-09-15 \
  --output-dir ../.dev_logs/lct-media-phase2a1

python -m app.contest_media \
  --manifest-json ../.dev_logs/lct-media-phase2a1/media-manifest.json \
  --catalog-json ../.dev_logs/lct-media-phase2a1/catalog-items.json \
  --output-dir ../.dev_logs/lct-media-phase2a1-replay
```

[Full readable audit](../.dev_logs/lct-media-phase2a1/media-review.md) and
[machine-readable report](../.dev_logs/lct-media-phase2a1/media-resolution.json)
contain every unresolved item, candidate path, missing-item investigation,
all six baseline shared groups and all 13 duplicate-photo-name groups.

### Actual before / after

| Class | Before | After |
| --- | ---: | ---: |
| exact_filename | 0 | 0 |
| normalized_unique | 2,009 | 2,009 |
| shared_reference | 12 | 12 |
| sha_equivalent | 0 | 23 |
| historical_asset_exact | 0 | 21 |
| historical_asset_normalized | 0 | 0 |
| ambiguous | 75 | 31 |
| missing | 7 | 7 |

Resolved items increased from **2,021 to 2,065**. The 31 remaining ambiguous
items all lack historical wine links. Selected media has 2,056 relative paths
and 2,037 distinct SHA-256 identities; 27 content groups serve multiple items.
This content-level audit is distinct from duplicate photo-name accounting.

**Duplicate-name accounting:** 2,103 items = 2,090 distinct photo names + 13
additional occurrences. Exactly 13 names occur twice (26 items). Previously six
groups resolved and seven were ambiguous. Now nine groups resolve to shared
content (the original six plus three SHA-equivalent groups); two groups are
partially resolved, and two remain entirely ambiguous. No duplicate-name group
is missing. The full audit records each slug and its before/after classification.

**Missing investigation:** all seven remain unselected. Six have linked
historical image basenames found exactly in the archive. The seventh,
`uva-vallis-shardone`, has no historical link and a deterministic filename-prefix
candidate with a PNG-to-WebP naming difference. Every missing entry includes
title, winery, official photo name, normalized key, historical basenames,
historical archive matches and the closest filename-prefix candidates.

Prefix suggestions are diagnostic only: exact normalized stems, complete
stem-prefix relationships with at least eight characters, or a common prefix
of at least 12 characters qualify. Longest prefix wins; ties prefer exact stems
then complete-stem prefixes. All equally ranked paths are reported, never
automatically selected. These checks use filenames only.

## Phase 2A.2: missing-case investigation and human review

`app.contest_media_review` generates a read-only review package from the complete
manifest, canonical catalog and saved Phase 2A.1 baseline. Database exports now
include historical wine slugs. Database reads retain PostgreSQL-enforced read-only,
repeatable-read transactions. Export replay needs no database connection.

Normalization version `strapi-filename/2` adds two generic rules:

- Remove `№` immediately before a numeric identifier **before NFKC** can expand
  it to `No`. Keep the digits, actual `No` text and vintage years.
- An inspected WebP named `<complete-stem>_<source-extension>_<10hex>.webp`
  supplies an alias for `<complete-stem>.<source-extension>`. Recognized embedded
  extensions are PNG, JPG/JPEG, TIF/TIFF, BMP and GIF. Both the full stem and the
  embedded original extension must match; the actual image format must be WebP.
  This is a complete filename pattern, not a partial-prefix match.

Both rules feed the existing candidate set. Literal filenames retain precedence;
multiple distinct candidates still require the existing deterministic evidence.
No per-item mappings or historical-only replacement selections were added.

### Actual results

| Class | Phase 2A.1 | Phase 2A.2 |
| --- | ---: | ---: |
| exact_filename | 0 | 0 |
| normalized_unique | 2,009 | 2,011 |
| shared_reference | 12 | 12 |
| sha_equivalent | 23 | 23 |
| historical_asset_exact | 21 | 21 |
| historical_asset_normalized | 0 | 0 |
| ambiguous | 31 | 31 |
| missing | 7 | 5 |
| **Total resolved** | **2,065** | **2,067** |

Only two item resolutions changed:

- `millstream-cellar-rezerv-blend-4`: numero punctuation rule.
- `uva-vallis-shardone`: embedded PNG-extension alias in the WebP archive name.

Of the six missing cases with historical archive images, only Millstream had a
safe generic normalization correction. Four have unrelated opaque/camera asset
names. LETO's official filename includes `2021`, which the historical archive
filename omits. Dropping the year would discard identity information.

The five remaining missing slugs are:

- `fanagoriya-fanagoriya-hey-bey-shardone-beloe-suhoe-13`
- `katharon-mezenka-risling-polusuhoe`
- `katharon-mezenka-risling-suhoe`
- `leto-kaberne-fran-2021-suhoe-krasnoe`
- `vinodelnya-vedernikov-vedernikov-tsimlyanskiy-chyornyy-tsimlyanskiy-chernyy-krasnoe-suhoe-14`

There are **31 ambiguous items for candidate review**, plus **5 missing items
requiring further source evidence**: 36 unresolved in total. All 31 ambiguous
items still lack historical links. The duplicate-name audit remains 13 groups:
9 fully shared, 2 partially resolved, 2 ambiguous. The accounting is unchanged:
2,103 catalog items = 2,090 unique photo names + 13 additional occurrences.

### Generate / replay the review package

From `vinedetect_api`, with the existing local `DATABASE_URL` exported, use a new
or empty output directory:

```sh
python -m app.contest_media_review \
  --manifest-json ../.dev_logs/lct-media-phase2a1/media-manifest.json \
  --baseline-json ../.dev_logs/lct-media-phase2a1/media-resolution.json \
  --import-version lct-rshb-2026-09-15 \
  --media-root /home/mayz/datasets/lct2026/media-official-staging/prod-svoe-vino-strapi/prod-svoe-vino/strapi/uploads \
  --font /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
  --output-dir ../.dev_logs/lct-media-phase2a2-final
```

For offline replay, replace `--import-version` with
`--catalog-json ../.dev_logs/lct-media-phase2a2-final/catalog-items.json` and select
a fresh output such as `../.dev_logs/lct-media-phase2a2-replay`. Keep the baseline,
manifest, source image bytes, font, Pillow and WebP codec versions identical.

Generated artifacts (ignored under `.dev_logs`):

- [Grouped human review](../.dev_logs/lct-media-phase2a2-final/review.md): all
  ambiguous candidates, seven original missing investigations, final missing
  list, all 13 duplicate-name groups and the original six shared groups.
- [Full evidence JSON](../.dev_logs/lct-media-phase2a2-final/review-data.json):
  every legacy/current normalization stage, historical wine ID/slug, image
  basenames, exact archive paths, reasons, candidate metadata and duplicate SHA
  relations. Before/after counts compare against the saved Phase 2A.1 report.
- [Blank decisions](../.dev_logs/lct-media-phase2a2-final/review-decisions.json):
  31 entries, all decision/path/note fields null. Reviewers may record decisions
  here; this utility does not apply them to the resolver or database.
- [Contact sheets](../.dev_logs/lct-media-phase2a2-final/previews/): 34 PNG sheets
  with official slug/title and item-local candidate ID/filename. Of 92 candidate
  occurrences, 90 have rendered previews; two exceed the 20-million-pixel
  preview cap and have labeled placeholders. Full metadata remains available.
- `media-resolution.json`, `media-manifest.json` and `catalog-items.json`:
  complete current resolution and replay inputs.

Previews verify source SHA-256, dimensions and bounded compressed size before
pixel decoding; they keep Pillow bomb protection enabled. Output is isolated
from the extracted snapshot. Preview generation performs no visual matching.
PNG bytes have no timestamps or random identifiers; provenance records the
font SHA-256 and Pillow/WebP versions. Replay compares all JSON, Markdown and PNG
files byte for byte.

## Phase 2B preflight: complete reference plan

`app.contest_reference_plan` merges the 2,067 deterministic selections with the
36 supplied manual decisions and validates every selected source file. It reads
exported JSON and the extracted snapshot only; no database connection, ingestion,
file copying or reconciliation is performed.

The supplied `lct-media-manual-review-final.json` was validated and copied
byte-for-byte to the requested config name:
[`config/lct_rshb_2026_media_review.json`](config/lct_rshb_2026_media_review.json).
Its 31 ambiguous recommendations and five missing-item recommendations retain
their original classes, notes and confidence labels.

### Selection and validation rules

- Preserve deterministic selections. Reject missing, duplicate or extra catalog
  assignments and any manual attempt to override a resolved item.
- Resolve manual basenames only among that item's `review-data.json` candidates.
  Ambiguous items use `ambiguous_items[].candidates`. Missing items use their
  `remaining_missing[]` historical archive matches and diagnostic candidates.
  A historical fallback additionally requires that item's linked wine ID and
  a matching historical archive candidate.
- A basename must identify exactly one distinct candidate path, even if another
  matching basename exists at the snapshot root. A complete relative path must
  also belong to that item's set. There is no global basename fallback.
- Check catalog/manifest provenance hashes, item identities, candidate metadata,
  file presence and safe relative paths. Re-hash each selected file and inspect
  raster headers with existing Pillow safety limits. Compare SHA-256, dimensions,
  bytes, filename, MIME type and image format against the manifest.
- Validate each distinct selected path once. Shared files and byte-identical
  files remain allowed, with path-level and SHA-level groups reported separately.
- Require exactly 2,103 catalog rows and 2,103 assignments before writing a plan.
  Output goes to a new or empty directory outside the media snapshot.

### Validated result

| Provenance class | Assignments |
| --- | ---: |
| normalized_unique | 2,011 |
| shared_reference | 12 |
| sha_equivalent | 23 |
| historical_asset_exact | 21 |
| confirmed_visual | 20 |
| manual_equivalent | 10 |
| manual_historical_fallback | 5 |
| source_preserving_shared | 1 |
| **Total** | **2,103** |

`exact_filename` and `historical_asset_normalized` each have zero assignments.
Coverage is **2,103/2,103**, with **0 unresolved and 0 validation failures**.
All **2,093 selected file paths** passed presence, raster-header and manifest
checks. They represent **2,074 distinct SHA-256 content identities**:

- 10 groups share the same selected relative path across catalog items.
- 18 groups contain multiple selected paths with identical SHA-256.
- 28 total content groups serve multiple catalog items.

`zhemchuzhnaya-9-czitron-shardone` retains the organizer's shared Aligote/Citron
image, the `source_preserving_shared` class and the review note. Its assignment
has the `organizer_photo_title_inconsistency` flag, with an explicit related-item
record under `source_data_inconsistencies`. No replacement image was invented.

### Reproduce the preflight

From `vinedetect_api`:

```sh
python -m app.contest_reference_plan \
  --manifest-json ../.dev_logs/lct-media-phase2a2-final/media-manifest.json \
  --catalog-json ../.dev_logs/lct-media-phase2a2-final/catalog-items.json \
  --resolution-json ../.dev_logs/lct-media-phase2a2-final/media-resolution.json \
  --review-json ../.dev_logs/lct-media-phase2a2-final/review-data.json \
  --manual-json config/lct_rshb_2026_media_review.json \
  --media-root /home/mayz/datasets/lct2026/media-official-staging/prod-svoe-vino-strapi/prod-svoe-vino/strapi/uploads \
  --output-dir ../.dev_logs/lct-reference-phase2b-preflight
```

Use a fresh output directory for replay. Both generated JSON files were verified
byte-identical on replay:

- [Final reference plan](../.dev_logs/lct-reference-phase2b-preflight/reference-plan.json)
  contains one `assignments` row per catalog item, all requested asset fields,
  manual provenance, input hashes, sharing groups and the source inconsistency.
- [Validation summary](../.dev_logs/lct-reference-phase2b-preflight/reference-plan-summary.json)
  contains coverage, counts by method, physical-file/content counts and failures.

This plan records validation against the current snapshot. A future ingestion
step must revalidate the selected bytes before database or storage writes.

## Phase 2B: managed assets and transactional reference writer

`app.contest_reference_assets` provides separate `materialize` and `import`
commands. **Current local execution stops after materialization and dry-run**:
migration 014 and the live reference import have not been applied.

### Storage convention and actual materialization

Existing historical paths such as `svoe_vino/bottle/1/1_ab621e8b.webp` are relative
to the application asset root. Compose mounts repository `asset-store/` at
`/data/assets`, and the API mounts that root at `/static/images`. The new writer
preserves this convention:

```text
asset-store/contest/lct-rshb-2026-09-15/sha256/<first-two>/<sha256>.webp
DB local_path: contest/lct-rshb-2026-09-15/sha256/<first-two>/<sha256>.webp
```

No host staging path or `asset-store/` prefix is stored in `local_path`.
Extensions derive from the actual validated MIME/format, not the original
filename suffix. All 2,103 selected assignments in this snapshot are WebP.

Materialization validates every selected source, streams the original bytes to
a temporary file in the destination directory, fsyncs and revalidates it, then
publishes through an atomic no-overwrite hard link and removes the temporary
name. Directory fsync is used where supported. This publication method works on
the local WSL filesystem; unsupported filesystems fail rather than fall back to
an unsafe overwrite. No recompression, resizing or source mutation occurs.

There are **2,074 managed files / 2,074 SHA-256 identities**, serving **2,103
catalog assignments**. Replay reused all 2,074 files and preserved every stored
file's size, modification time and inode. An existing destination must pass the
same SHA, dimensions, byte-size, MIME and format checks; disagreement fails.

A failed materialization can leave earlier verified files available for replay.
The materializer does not remove historical assets or roll back already
published, valid content. Database work is a separate operation.

### Migration 014 and provenance

[014_contest_reference_provenance.sql](migrations/014_contest_reference_provenance.sql)
adds `resolution_method`, structured `provenance` JSONB and optional `review_note`,
with method, JSON-object, non-blank-note and managed-path constraints. A partial
unique index permits only one provenanced assignment per catalog item, while
allowing different items to share the same path and SHA. A method index supports
provenance audits.

Legacy unprovenanced rows remain unchanged; no synthetic provenance is invented
for them. The writer rejects disagreement with **any** existing reference row.
Migration 013 and the package-local migration runner remain unchanged. The
migration-ledger warning in **Apply and import** still applies.

The writer preserves the source filename, plan/input hashes, official slug/photo,
source-relative filename, review confidence/recommendation, review note and
source inconsistency evidence. `zhemchuzhnaya-9-czitron-shardone` retains
`source_preserving_shared` and `organizer_photo_title_inconsistency`.

### Transaction and dry-run behavior

Before inserting, the service validates exactly 2,103 unique assignments and
2,074 content identities, every managed asset and its metadata, the completed
import run, and the entire PostgreSQL catalog ID/slug/photo correspondence.
All existing reference rows are compared before any inserts. Exact replay
reuses rows; any conflicting row aborts without replacement or deletion.

The write runs in one transaction. Catalog and reference-table locks serialize
writers and prevent catalog identity changes during validation. An insertion
failure rolls back the complete batch; unrelated catalog, link and historical
wine data are never written. File validation is repeated for each invocation.

`import --dry-run` opens a PostgreSQL-enforced read-only, repeatable-read
connection. It validates managed bytes and catalog correspondence and reports
intended inserts. It also supports the pre-014 schema: missing provenance
columns are reported as a required migration, without applying DDL. An actual
import requires those columns and an explicit `--apply`.

### Commands

From `vinedetect_api`:

```sh
python -m app.contest_reference_assets materialize \
  --plan-json ../.dev_logs/lct-reference-phase2b-preflight/reference-plan.json \
  --source-root /home/mayz/datasets/lct2026/media-official-staging/prod-svoe-vino-strapi/prod-svoe-vino/strapi/uploads \
  --asset-root ../asset-store \
  --report-json ../.dev_logs/lct-reference-phase2b/materialization.json

# With DATABASE_URL set to the existing local wines database:
python -m app.contest_reference_assets import --dry-run \
  --plan-json ../.dev_logs/lct-reference-phase2b-preflight/reference-plan.json \
  --asset-root ../asset-store \
  --report-json ../.dev_logs/lct-reference-phase2b/dry-run.json
```

**Validated local dry-run:** 2,103 catalog items; 2,074 managed files; 2,103
intended inserts; zero existing reference rows; zero inserted rows.
`ready_for_import=false` because `014_contest_reference_provenance.sql` remains
unapplied, as requested.

Future live execution, after separate authorization, must apply 014 once using
the deployment's ledger and transaction convention, rerun dry-run, then invoke
the same import command with `--apply`. A direct migration command would be:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -f migrations/014_contest_reference_provenance.sql
```

That direct command does **not** register the migration in a deployment ledger.
Neither the migration command nor `import --apply` was run against local
`wines` during this phase.

### Review artifacts and validation

- [Materialization report](../.dev_logs/lct-reference-phase2b/materialization.json)
- [Idempotent replay report](../.dev_logs/lct-reference-phase2b/materialization-replay.json)
- [Local dry-run](../.dev_logs/lct-reference-phase2b/dry-run.json)
- [Proposed reference rows](../.dev_logs/lct-reference-phase2b/reference-rows.json)
- [Unchanged local DB check](../.dev_logs/lct-reference-phase2b/local-db-unchanged.json)

Tests apply migrations 001-014 in an isolated, empty test database and roll back
schema/data afterward. Coverage includes exact-byte copies, format-derived
extensions, deduplication, shared assets, atomic publication failure/concurrency,
destination conflicts, metadata/catalog mismatches, full transaction rollback,
identical DB replay, existing-row conflicts, provenance and source inconsistency
persistence, and pre-014 dry-run behavior.

## Confirm before media ingestion / reconciliation

- Validate the organizer image archive and record its checksum. Match it to the
  validated CSV snapshot above, including the 13 shared reference images.
- Confirm version naming and duplicate-conflict policy for future snapshots.
  Existing catalog/overlap counts still need reconciliation measurements.
- Choose a separate media root and immutable paths containing import/hash
  components that allow multiple catalog items to share an asset. Confirm
  photo-name matching, missing/multiple images, collision
  handling, MIME/dimension validation and perceptual-hash algorithm/version.
  The asset table separates metadata, but filesystem collision protection must
  be implemented by the future ingestion code before it writes files.
- Agree on evidence, confidence thresholds, reviewer attribution and decision
  history for re-slugs, identical assets and metadata matches. The current table
  stores the latest decision, not an audit history of edits.
- Confirm whether/when genuinely new wines should enter `svoe_vino`, preserving
  the existing source and stable identity rules, and how consumers select an
  official import version. No evaluation integration is included in Phase 1.

## Phase 3B1: read-only historical identity planning

`app.contest_identity_plan` produces proposals only. It accepts a consistent
read-only snapshot containing `catalog_items`, `reference_assets`, `item_links`,
`wines`, `wine_images`, and `wine_grapes` (wine_id/name pairs). The planner has
no database connection or write mode. The local snapshot was exported from
`wines` in a PostgreSQL-enforced REPEATABLE READ, READ ONLY transaction.

From `vinedetect_api`:

```sh
.venv/bin/python -m app.contest_identity_plan \
  --snapshot ../backups/lct/contest_identity_phase3b1/input-snapshot.json \
  --historical-root ../storage/images \
  --output-dir ../backups/lct/contest_identity_phase3b1
```

The default input guard requires exactly 264 unmatched items. `--historical-root`
only reads original image bytes to compute SHA-256; it does not create previews,
re-encode images or download anything. URL/path basename extraction and Strapi
filename normalization reuse `contest_media` helpers. Hash-stripped names are
candidate evidence only. Metadata comparison retains vintage numbers and tests
winery, category, sweetness, region, grape set, color family and description.
Fuzzy title scores can suggest review candidates but never authorize a link.

An automatic `re_slug` needs a unique strong media identity plus compatible
metadata, or exact normalized title and winery with at least two supporting
metadata fields. It preserves wine ID, slug, external ID and all annotation
identities. Competing candidates, conflicting media/metadata, accepted-lookup
alias collisions, source inconsistencies and ambiguous many-to-one mappings go
to `manual_review`. Many-to-one detection includes all 1,839 existing exact links;
only equal organizer metadata and equal reference SHA qualify as documented
legitimate duplicates. Duplicate new organizer identities are also held for review.

A `true_new` proposal uses the official slug for both slug and external_id and
`vino-svoe` for source. It contains only organizer-provided values; grapes and
verbatim organizer fields are retained in raw_detail_json because wines has no
grape/year columns. IDs/timestamps are left to database defaults in a later
write. Every proposed key is checked against historical external_id, slug and
numeric-ID aliases and against the other proposed keys.

The three deterministic outputs are `identity-plan.json`, `identity-summary.json`
and `IDENTITY_REVIEW.md`. The review lists every manual-review slug, candidates,
exact evidence, differences and rejection reasons. The summary includes source
snapshot hash, collision details and many-to-one groups. Replay must produce
identical bytes for all three files; no runtime timestamps are embedded.

Before Phase 3B2 writes: resolve or explicitly exclude all manual-review items,
revalidate the live snapshot and alias namespace, and check newly allocated
numeric-ID aliases inside the write transaction. This plan does not authorize
changes to links, wines, wine_images, annotations, migrations or the Wizard.

## Official reference audit and reviewed overrides

`vinedetect_retrieval.reference_audit` reads the immutable Phase 4A gallery,
proxy embeddings, and proxy evaluation. It adds frozen-model text diagnostics,
historical self-similarity, expected historical rank, dimensions, provenance,
and exact SHA/path sharing evidence. The generated priority is only a review
order; it never changes a reference. The command refuses an output path that
overlaps any Phase 4A input and verifies all protected file hashes again after
writing the ignored audit package.

From `ml`:

```sh
.venv/bin/python -m vinedetect_retrieval.reference_audit \
  --media-root /home/mayz/datasets/lct2026/media-official-staging/prod-svoe-vino-strapi/prod-svoe-vino/strapi/uploads \
  --output ../backups/lct/catalog_reference_audit \
  --device cpu --threads 6
```

The output includes deterministic JSON/CSV, a top-80 HTML review, an override
manifest, and gallery-v2 instructions. Existing human decisions in the override
manifest survive audit replay.

`app.contest_reference_overrides` is the only supported write path for a
reviewed correction. Entries with `pending_review`, `confirmed_bad`,
`false_positive`, or `unresolved` are never materialized or written. A
`replacement_confirmed` entry must name an authoritative relative source,
SHA-256, dimensions, bytes, and MIME. Materialization validates source bytes and
publishes them under a new content-addressed override version without removing
the old object. Dry-run verifies the exact catalog ID/slug/current reference,
the managed replacement bytes, all 2,103 integrity counts, and emits the
old/new diff. Apply updates only the existing target reference row and replay
accepts only the exact deterministic result. An optional `wine_metadata` block
may correct only the materialized `svoe_vino.wines.title`; it guards the linked
wine ID, slug, previous title, manufacturer, category, source, and external ID,
and reports that diff separately. Raw `contest.catalog_items` rows remain
immutable. Versioned `-reference-overrides-vN` asset paths are accepted only
under the same contest namespace and content-addressed SHA layout.

The approved production overrides and their exact source bytes live in
`data/contest_reference_overrides/lct-rshb-2026-09-15.json` and the same
directory. This version-controlled manifest is the default for the normal
materialize, dry-run, and apply commands; ignored audit outputs are diagnostic
inputs rather than the canonical definition. From `vinedetect_api`:

```sh
.venv/bin/python -m app.contest_reference_overrides materialize \
  --asset-root ../asset-store \
  --report ../backups/lct/catalog_reference_audit/override-materialize.json

.venv/bin/python -m app.contest_reference_overrides dry-run \
  --asset-root ../asset-store \
  --report ../backups/lct/catalog_reference_audit/override-dry-run.json

# Run only after reviewing the dry-run diff.
.venv/bin/python -m app.contest_reference_overrides apply --apply \
  --asset-root ../asset-store \
  --report ../backups/lct/catalog_reference_audit/override-apply.json
```

`--manifest` remains available for a different reviewed contest manifest. For
`materialize`, its source root defaults to the manifest directory; use
`--source-root` only when an explicitly supplied manifest references a separate
local archive. Missing or mismatched source bytes fail before any database write.

No schema migration is required: migration 014 already represents a
`confirmed_visual` selection with structured override provenance. A corrected
embedding bundle must use a new `gallery-256-v2` output. Existing checkpoint
keys include model config, catalog row, SHA-256, and dimensions, so unchanged
rows are reused and only changed SHA rows require inference.


## Reviewed identity correction for catalog item 603

The 2026-09-18 human/producer review supersedes the original Phase 3B2
603 → 791 re-slug decision. Item 603 is Silvaner Barrel Fermented 2022;
item 605 is Vermentino–Viognier Barrel Fermented 2022. Their shared source
filename was not valid product-identity evidence.

The canonical decision is
data/contest_identity_corrections/lct-rshb-2026-09-15-603.json.
app.contest_identity_corrections is a separate, guarded correction step after the
original 248-item materialization. It reuses new_wine_data, WINE_FIELDS,
grape_relations, check_aliases, table locks, and transactional sequence
allocation. It does not rewrite the frozen original Phase 3B2 plan.

Run from vinedetect_api with DATABASE_URL configured:

```sh
.venv/bin/python -m app.contest_identity_corrections --dry-run \
  --plan ../backups/lct/dq2-identity-603-2026-09-18/plan.json \
  --report ../backups/lct/dq2-identity-603-2026-09-18/dry-run.json

# Use the plan_sha256 emitted by the clean dry-run.
.venv/bin/python -m app.contest_identity_corrections --apply \
  --plan ../backups/lct/dq2-identity-603-2026-09-18/plan.json \
  --expected-plan-sha256 <reviewed-plan-sha256> \
  --report ../backups/lct/dq2-identity-603-2026-09-18/apply.json
```

Repeat apply with the same plan/hash and a new report path to verify replay.
A saved plan freezes the existing link, official data, protected state and
next wine ID; drift or alias collisions fail before writes. Both the insertion
and sequence restart roll back on failure. The new wine uses the official slug
for slug/external_id and vino-svoe for source, with no invented alcohol value.
Only the 603 link changes. Its provenance retains the reviewed decision and
complete previous link. The 605 link, wine 791, all reference rows and historical
images remain intact. Existing migration 015 already supports the link method;
no new schema migration is needed. The canonical decision ships in the API image.

Current coverage after this correction: 2,103 catalog/reference/link rows,
2,103 resolved links, 2,115 wines, 1,839 exact_slug links, 15 re_slug links,
249 materialized_official links, and 1,866 historical image rows.

ML manifests now expect these counts and validate historical_wine_id against
the linked wine before accepting a proxy query. Only exact_slug items are proxy
eligible: wine 791 remains a positive query for 605, never 603. Refreshed manifests
are in backups/lct/dq2-identity-603-2026-09-18/manifests/. Previous manifests remain
historical artifacts; use the refreshed mappings for current identity metadata.
Reference pixels did not change, so no new image inference is needed.
