# Reference keywords API

`GET /api/v1/recognition/references` is public and read-only. It performs one
ordered SELECT against a prepared database snapshot. No OCR/ML, inference,
reference-image processing, catalog mutation or recognition scoring occurs.

```json
{"schemaVersion":"references/1","items":[{"slug":"wine-slug","keywords":["2021","cabernet","fanagoria","franc"]}]}
```

The population is `svoe_vino.wines`, identified externally by its unique `slug`.
It is not a new organizer-catalog or GT endpoint. Numeric wine IDs are used only
for the existing internal profile foreign key and never appear in the response.

## Installation and refresh

Apply `migrations/018_reference_keywords.sql` using the normal SQL migration
process. It reuses `svoe_vino.recognition_profiles` from migration 009, creating
that same foundation table if a restored DB has not installed it. It creates a
view and a constraint scoped to profile version `reference-keywords/1`; other
profiles and catalog rows are untouched. Do not replay historical data-changing
migrations to enable this feature.

Then, from `vinedetect_api`, with the intended `DATABASE_URL` configured:

```bash
python -m app.reference_keywords
```

This atomically prepares every wine, including title-only rows with no OCR.
Re-run after importing/changing titles or saved OCR. Repeated refreshes are
idempotent for unchanged inputs. GET never refreshes or writes data. Missing
snapshots or changed titles yield 503 with a refresh instruction rather than
silently returning an incomplete catalog. OCR changes become visible on the
next explicit refresh. A connection failure uses the existing API 503 behavior.

The current development Docker DB is `vinedetect-postgres-1` / `wines`; it is
separate from any native PostgreSQL on WSL/Windows localhost. Use the database
configured for the API deployment. In Compose, the server-to-server DB hostname
is `postgres`; the BFF uses `API_INTERNAL_URL=http://api:8000`.

## Source policy

Only `wines.title` plus existing OCR/reference text is consumed:

- Latest completed `meta.ocr_runs` per wine; exact binding
  `source='svoe_vino' AND source_item_id=wines.slug`, ordered by created_at then
  id descending. Prefer nonblank normalized_text, falling back to raw_text.
- Latest verified, nondeleted `meta.annotation_ocr.transcription` per wine,
  joined through nondeleted annotation_packages with the same source/slug.
- If migration-009 OCR tables exist, latest completed `ocr_observations` per
  active recognition_asset. Explicit payload fields accepted: tokens[] of
  strings, normalized_text, raw_text, text. Unknown metadata is not traversed.
- Explicit saved-token imports by slug, described below. They persist across
  refreshes; an explicit empty array clears only that wine's imported tokens.

No description, grapes, region, manufacturer, category, generic generated alias
sets, embeddings or descriptor payload is used. A word present in the title or
OCR remains eligible even if it also happens to be a grape/region name.

Normalization reuses `app.matching.normalize_match_text` after Unicode NFKC.
Tokens are lowercase, ё becomes е, punctuation separates tokens, blank values
are removed, duplicates removed and the result sorted by Unicode code point.
Cyrillic, Latin, years and single-digit numbers are preserved. The matching
helper's stopword/length filters are deliberately not applied. The helper itself
and recognition algorithms are unchanged. Wines are ordered by slug with C
collation, independently of database locale. Empty inputs yield `[]`.

## Import already-existing reference tokens

Create a UTF-8 JSON file from saved OCR/reference data (no new OCR required):

```json
{"schemaVersion":"reference-tokens/1","items":[{"slug":"wine-slug","tokens":["Fanagoria","CABERNET","2021"]}]}
```

```bash
python -m app.reference_keywords --tokens-json /path/to/saved-reference-tokens.json
```

Unknown or duplicate slugs and non-string token arrays are rejected. Slugs must
match the catalog exactly; they are not normalized or mapped using local IDs.
Imports update only the reserved read-model profile, never OCR observations,
wines, canonical GT, reference images or frozen releases.

## Frontend

Browser GET `/api/recognition/references` -> Next.js BFF -> FastAPI
`/api/v1/recognition/references`. The BFF uses server-only `API_INTERNAL_URL`,
with the existing NEXT_PUBLIC_API_BASE_URL/local development fallback.
Use `loadRecognitionReferences()` from `lib/recognition/references`.
There was no existing reference-keywords JSON consumer to replace. The scanner
uses a richer mock search-index contract; it and the UI are left unchanged.

## Coverage of the inspected database

At implementation time: 2,114 wines; eight completed source OCR runs map to two
wine slugs, so two latest runs are selected. Verified manual OCR covers no wine
in this population. Foundation OCR tables are absent; stored normalized_tokens
in meta.items are empty. Remaining 2,112 wines get title tokens. No missing OCR
is invented, and sealed ML evidence is not imported implicitly.
