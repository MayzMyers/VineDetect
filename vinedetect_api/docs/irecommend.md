# Offline IRecommend parsing

Run from the repository root with the API Python environment:

```python
from pathlib import Path
from app.irecommend import parse_product_page, parse_review_page

samples = Path("data/irecommend/samples")
product = parse_product_page((samples / "product.html").read_text(encoding="utf-8"))
review = parse_review_page((samples / "review.html").read_text(encoding="utf-8"))
print(review.review_id, review.publication_date, review.vintage_candidates)
for image in review.images:
    print(image.image_key, image.preferred_url, image.url_variants)
```

Ensure `vinedetect_api` is on `PYTHONPATH` (or the API package is installed).
Both parsers accept HTML text and return frozen dataclasses. External IDs are
strings; publication dates are `datetime.date`. They perform no file, HTTP,
browser, JavaScript, image download, or database operations. They use the
standard library `html.parser`, with no additional dependencies, and target the
browser-saved layouts represented by the fixtures.

## Product pages

`parse_product_page` returns `IRecommendProduct` with its metadata and a list of
`IRecommendReviewTeaser` objects.

Only `reviews-list-item` teasers in the main `view-referenced-nodes` /
`list-comments` container are parsed, in document order. Recommendations such
as “Смотрите также” are outside this scope. Every teaser's `data-product-id`
must equal the product ID; a mismatch or missing required field raises
`ValueError`. An absent main list is an error, while an empty list returns no
reviews. Missing brand, beverage type, or product image returns `None`.

Preview URLs prefer `data-original` over remote `src`; saved local paths are
ignored. Root-relative and protocol-relative remote URLs are resolved without
fetching them. The product image uses the full-image `contentUrl` link.
`photos_count` comes from the teaser attribute and is independent of the number
of previews present. No full-size review URLs or additional photos are inferred.

## Review pages

`parse_review_page` returns `IRecommendReview`: `review_id`, `canonical_url`,
`product_id`, `product_title`, `title`, `author`, `publication_date`,
`full_text`, `year_candidates`, `vintage_candidates` and `images`.

The main `reviewBlock` must be a direct child of `review-node`, with its
`review-summary` URL matching the canonical link in the document head.
The review ID comes from the JSON value of `Drupal.settings.site.nid` in the
head, where `site.type` must be `review`. This reads data without executing
JavaScript. Product IDs come only from the main node's product heading/header;
conflicting IDs raise `ValueError`, and absent IDs return `None`.
Required fields and the main review must be unambiguous.

Only the main `itemprop="reviewBody"` supplies full text. Paragraphs, list items
and line breaks are separated, whitespace is normalized, and inline punctuation
is preserved. Scripts, styles, noscript duplicates, SVG and the quote-expansion
button are excluded; the quotation itself remains. Links written by the author
inside the body remain as text. Adjacent verdicts, comments, sidebar blocks and
recommendations are not part of the text.

`app.matching.extract_years` receives only the product title, review title and
normalized body. Its result is a set of candidate year strings, not an asserted
vintage. Publication metadata is parsed separately from `datePublished`.
The supplied review yields `{"2016"}`, with publication date `2018-05-05`.

Images are collected only from galleries inside the main reviewBody with
`data-gallery="gallery_node<review_id>field_imgf<N>"`. Other reviews by the same
author are excluded too. Ungrouped images, product photos and avatars are not
treated as review photos. Each `IRecommendReviewImage` contains:

- `image_key`: `user-images/<user_id>/<filename>`, independent of host/cache;
- `filename`;
- `preferred_url`;
- `url_variants`: distinct observed remote URLs, in discovery order.

Within a gallery, anchor `href`/`data-src` and image `data-original`/`src`
provide variants. Local saved paths and data URLs are ignored. Root-relative
URLs are resolved to IRecommend. Preference is CDN `copyright1`, CDN `copyright`, IRecommend `copyright1`,
other observed variants, then `200i`; ties retain discovery order.
The parser never removes `imagecache` to invent an original URL.
The fixture yields eight unique photos and three variants for each.

## Fixtures and checks

`tests/fixtures/irecommend/product.html` and `review.html` are exact copies of
the corresponding saved files in `data/irecommend/samples/`, including
recommendations. They are kept outside the ignored `data/` directory so tests
work in a fresh checkout. No companion image directory is needed.
IRecommend tests block socket connections.

From the repository root:

```bash
PYTHONPATH=vinedetect_api vinedetect_api/.venv/bin/python -m pytest -q vinedetect_api/tests/test_irecommend.py vinedetect_api/tests/test_http.py vinedetect_api/tests/test_matching.py vinedetect_api/tests/test_crawler_index.py vinedetect_api/tests/test_crawler_details.py
vinedetect_api/.venv/bin/ruff check vinedetect_api/app/irecommend.py vinedetect_api/tests/test_irecommend.py
```


## Offline contest catalog matching

`app.irecommend_matching` is independent of Roskachestvo scoring and has no I/O.
Pass an `IRecommendProduct` or mapping with `title`, `brand` and
`beverage_type`, plus in-memory catalog mappings containing `id`,
`official_slug`, `title`, `winery`, `category` and `grapes`:

```python
from app.irecommend_matching import find_irecommend_matches

result = find_irecommend_matches(
    product,
    catalog_rows,  # already loaded Python mappings
    year_candidates=review.vintage_candidates,  # optional, from a related review
    top_k=5,
)
print(result.status)
for candidate in result.candidates:
    print(candidate.catalog_item_id, candidate.score, candidate.status)
    print(candidate.evidence)
```

The caller must pass years from a review of the same product. No publication
dates, review prose, descriptions or surrounding HTML enter the scorer.
`score_irecommend_to_catalog` scores a single pair; its `matched` status is
provisional until `find_irecommend_matches` checks the complete candidate pool.

Normalization reuses generic helpers from `app.matching`, adds deterministic
Cyrillic transliteration and explicit brand/grape/style aliases, and preserves
single-letter identifiers such as `f`. Winery, generic wine/style/grape words
and numeric tokens are excluded from discriminative identity. Catalog title and
slug supply identity; declared grapes also help remove generic grape words.
Unrecognized aliases can reduce recall; this is a conservative heuristic,
not a calibrated probability or a general transliteration resolver.

Score components: discriminative overlap 55%, normalized title similarity 15%,
title/slug token overlap 10%, winery 10%, grape overlap 5%, style agreement 5%.
Year overlap adds at most 0.03 and only for exact nonempty identity.
A disjoint year set subtracts 0.12; explicit style conflict subtracts 0.20.
Missing or disjoint product identity caps score at 0.49; partial identity
caps it at 0.79. Winery, grape or style conflicts cap at 0.49.
Unconfirmed winery or a year conflict caps at 0.79.
Evidence records components, years, missing/conflicting discriminative tokens,
caps and the final score.

Statuses use fixed thresholds: `matched >= 0.85`, `needs_review >= 0.55`,
otherwise `unmatched`. Only top-1 may be matched, and its lead over top-2 must
be at least 0.08. All candidates are scored before applying `top_k`, so
`top_k=1` cannot hide ambiguity. Ties use ascending catalog ID. Weak candidates
are retained for diagnostics, never promoted merely for ranking first.
An empty pool or `top_k=0` returns `unmatched` with no candidates; invalid
limits and duplicate catalog IDs raise `ValueError`.

The matching tests use four minimal in-memory rows (199, 919, 469, 472), verified
against the local backup
`backups/lct/vinedetect_wines_autodetect_handoff_20260916_221620.dump`.
Only `pg_restore --data-only --table=catalog_items --file=-` was used to read
those values; no database connection or database fixture is required by tests.

The additional `tests/fixtures/irecommend/product_cru_lermont_merlo.html`
exactly matches the local sample, with SHA-256
`efd1bb967f7139d6f55d210e3004187906e38523bb3c38a96e02abbad16b22c3`.

Observed results against these four rows:

| Source | Candidate | Score | Status |
| --- | --- | ---: | --- |
| Cru Lermont Merlo | 199 | 1.0000 | matched |
| F-Style Merlo | 199 | 0.2500 | unmatched |
| F-Style Merlo + 2016 | 199 | 0.2500 | unmatched |
| F-Style Merlo + 2016 | 919 | 0.1200 | unmatched |
| F-Style Merlo + 2016 | 469 / 472 | 0.0000 | unmatched |

Positive identity tokens are `cru, lermont`, with discriminative score 1 and
no caps. For F-Style against 199, missing tokens are `f, style`, conflicting
tokens are `cru, lermont`, discriminative score is 0 and
`conflicting_product_identity` applies despite winery/grape/style scores of 1.
Against 469/472, year score is 1 but year bonus is 0; identity, grape and style
conflicts prevent matching.

Run matching tests alongside the parser and regression checks:

```bash
PYTHONPATH=vinedetect_api vinedetect_api/.venv/bin/python -m pytest -q vinedetect_api/tests/test_irecommend.py vinedetect_api/tests/test_irecommend_matching.py vinedetect_api/tests/test_matching.py vinedetect_api/tests/test_http.py vinedetect_api/tests/test_crawler_index.py vinedetect_api/tests/test_crawler_details.py
vinedetect_api/.venv/bin/ruff check vinedetect_api/app/irecommend.py vinedetect_api/app/irecommend_matching.py vinedetect_api/tests/test_irecommend.py vinedetect_api/tests/test_irecommend_matching.py
vinedetect_api/.venv/bin/ruff format --check vinedetect_api/app/irecommend.py vinedetect_api/app/irecommend_matching.py vinedetect_api/tests/test_irecommend.py vinedetect_api/tests/test_irecommend_matching.py
```


## Minimal manifest and controlled download pipeline

The builder is entirely offline. It uses the existing parsers and deterministic
matcher with a JSON snapshot of official `contest.catalog_items`; no database or
official gallery is modified. From the repository root (WSL):

```bash
PYTHONPATH=vinedetect_api vinedetect_api/.venv/bin/python -m app.irecommend_manifest build
```

Defaults discover `product*.html` and `review*.html` in
`data/irecommend/samples/`, read `data/irecommend/catalog_items.json` and the
optional `data/irecommend/review_verifications.jsonl`, and replace all three outputs:

- `data/irecommend/manifest.jsonl`: 21 records on current samples;
- `data/irecommend/manifest.confirmed.jsonl`: 13 human-confirmed records;
- `data/irecommend/manifest.training.jsonl`: 6 explicitly kept training records.

Use `--samples-dir`, `--catalog`, `--verifications`, `--output`, and
`--confirmed-output` to change paths. Explicit `--product`/`--review` lists are
also supported. An explicitly supplied missing verification file is an error.
Without a verification file, all rows remain `auto` and the confirmed export
is empty. No dates/timestamps are introduced into generated JSONL: repeated
builds with the same inputs produce identical bytes.

`build_manifest(product_paths, review_paths, catalog_items,
review_verifications=...)` is the Python entry point. Catalog rows contain
`id`, `official_slug`, `title`, `winery`, `category`, `grapes`; use a complete
snapshot to preserve ambiguity checks. Source product IDs and normalized titles
must agree across review/product pages. Conflicting snapshots or one image
identity appearing in multiple reviews fail explicitly.

Each row represents a unique `user-images/<user_id>/<filename>` identity, not a
URL variant. Product photos, avatars and recommendation images are excluded.
Rows preserve product/review/image IDs, source URLs, all observed image URL
variants, raw `year_candidates`, contextual `vintage_candidates`, and matcher
evidence. Provenance records HTML paths and byte SHA-256, metadata/publication
date, parser/matcher versions, and image filename. `match_evidence` retains
candidate scores, ambiguity, caps, thresholds and the catalog fingerprint.
Only `vintage_candidates` are passed as review year evidence to matching;
publication, bottling and award years remain diagnostics, never vintage labels.

Review decisions are maintained separately from generated manifests:

```jsonl
{"source_review_id":"4532995","catalog_item_id":199,"verification_status":"human_confirmed"}
{"source_review_id":"9140838","catalog_item_id":199,"verification_status":"human_confirmed"}
```

These two decisions were explicitly supplied by the user for the exact SKU.
The builder accepts `auto`, `human_confirmed`, `human_rejected`, validates the
catalog ID against the official snapshot and the resolved match, and records
the applied decision plus its SHA-256 in provenance. Mismatches/conflicting
decisions fail. Overrides set verification only: matcher status, score and
evidence are retained. Weak/ambiguous matches cannot become training positives
just by setting a verification flag. Unknown review IDs may remain in the
registry when building a subset. Do not manually edit generated manifests.

`confirmed_manifest(rows)` exports only `matched + human_confirmed` with an
exact catalog identity. F-Style review 4726974 contributes 8 unmatched records
and no confirmed records. Review 4532995 contributes 4 confirmed photos and no
vintage; review 9140838 contributes 9 confirmed photos with vintage candidate
2019 (2022 is the bottling year). Auto matches never enter the confirmed export.
The generic field names/filter also permit a future UGC source without a
framework. Standalone export remains available with `confirmed --input ...`.

### Explicit image quality decisions

Build also reads the optional `data/irecommend/image_quality_overrides.jsonl`
(or `--quality-overrides PATH`). Each JSONL record specifies `image_identity`
and `quality_status`: `keep`, `keep_hard`, `drop`, or `unknown`. The provided
current decisions contain 6 kept images and 7 drops. Missing overrides produce
`quality_status="unknown"`, never automatic inclusion in training.

The builder retains every image in the main manifest, including drops, and
records the complete quality decision plus its SHA-256 in provenance.
`training_manifest(rows)` selects only `matched + human_confirmed` with quality
`keep` or `keep_hard`; confirmed export still has all 13 exact-confirmed images.
Build writes `manifest.training.jsonl` alongside the other two outputs;
`--training-output` changes that path. Repeated builds are deterministic.
No files are deleted, no downloads are repeated, and download results remain
untouched. Existing local paths/SHA can be joined by `image_identity`.

### Controlled image download (explicit next step)

The following command performs real HTTP requests. It is **not** run by build
or tests:

```bash
PYTHONPATH=vinedetect_api vinedetect_api/.venv/bin/python -m app.irecommend_download \
  --manifest data/irecommend/manifest.confirmed.jsonl \
  --output-dir data/irecommend/images \
  --results data/irecommend/download_results.jsonl
```

The downloader validates the entire input before requests: every record must
be `matched + human_confirmed` and reference an observed HTTPS user-image URL
on `irecommend.ru` or `cdn-irec.r-99.com`. It fetches only `preferred_url`, with
one synchronous client, no redirects or HTML-page requests. On 5xx it may
advance once through the saved same-identity variants in priority order.
It never falls back to `200i` when a copyright/copyright1 variant exists.
Requests (including retries) are separated by a 2-5 second random pause.
Defaults: 30-second timeout, two retries for transport errors; 5xx advances to the next
known variant without repeating the variant list. `--timeout` and `--max-retries` are configurable, retries capped at 3.
403/429 checkpoint a `blocked` result and stop the entire run immediately with
a nonzero exit; no retry or protection bypass. Other errors are recorded as
`failed`; unattempted rows remain `pending`.

Successful responses must decode fully through Pillow and have positive
width/height. HTML/error pages or corrupt images are not saved. There is no
blur, composition, lighting or quality filter. Valid bytes are saved atomically
under `images/<official_slug>/<review_id>__<filename>`. The separate result JSONL
copies all manifest provenance and adds `local_path`, `sha256`, `byte_size`,
`width`, `height`, `http_status`, `download_url` (actual attempted URL),
and `download_status`. It never replaces the
source manifest. Each completed image is checkpointed. On rerun, a recorded
file with a matching SHA-256 that still decodes is reused without HTTP; missing
or corrupt files are downloaded again. Use the same result/output paths to
resume. Review errors in the results before manually rerunning a blocked job.

Tests use the two real Cru Lermont HTML fixtures (byte-for-byte copies of local
samples) and mock HTTP; no real download is necessary. Run all relevant checks:

```bash
PYTHONPATH=vinedetect_api vinedetect_api/.venv/bin/python -m pytest -q \
  vinedetect_api/tests/test_irecommend*.py \
  vinedetect_api/tests/test_http.py vinedetect_api/tests/test_matching.py \
  vinedetect_api/tests/test_crawler_index.py vinedetect_api/tests/test_crawler_details.py \
  vinedetect_api/tests/test_image_downloader.py
vinedetect_api/.venv/bin/ruff check vinedetect_api/app/irecommend*.py vinedetect_api/tests/test_irecommend*.py
vinedetect_api/.venv/bin/ruff format --check vinedetect_api/app/irecommend*.py vinedetect_api/tests/test_irecommend*.py
```

The local `catalog_items.json` contains all 2103 rows extracted read-only from
`backups/lct/vinedetect_wines_autodetect_handoff_20260916_221620.dump` with
`pg_restore --data-only --table=catalog_items --file=-`. It is a pinned offline
snapshot, not a live catalog refresh. Matching-fields SHA-256:
`f8e4a2ab9e2bd55ffad6f8614bd434c5e25792307d8868f8b744e27a85f127d6`.
Local data, generated manifests and verification registry remain under the
repository's already ignored `data/`; fixtures/tests are outside that directory.

## Offline discovery of product links

```bash
PYTHONPATH=vinedetect_api vinedetect_api/.venv/bin/python -m app.irecommend_discovery
```

Reads only `data/irecommend/samples/*.html` and the local
`data/irecommend/catalog_items.json`. Writes deterministic
`data/irecommend/discovery_candidates.jsonl`; `--samples-dir`, `--catalog` and
`--output` override these paths. The CLI prints unique URL/status counts and up
to 30 strong candidates, ordered by score then URL.

Only links within explicit `productName`, `product-name`, `productTitle` or
`product-title` elements are considered (the saved recommendation blocks use
`.seealso-block-content .productName a`). Review-title/snippet/summary links,
known local review canonical URLs, unrelated anchors and external hosts are
excluded. URL queries/fragments and trailing slashes are normalized for dedup.
All source HTML paths, canonical page URLs and byte SHA-256 values are kept in
`discovered_from`; alternate observed titles are retained in evidence.

Ranking reuses the deterministic catalog matcher. A producer name is only a
hypothesis inferred when its catalog tokens explicitly occur in the title.
Strong candidates require an unambiguous matcher result with exact nonempty
distinctive identity and grape tokens; conflicting observed titles cannot be
strong. Winery/grape alone is insufficient. No new catalog identities are
created. Scores are heuristics, not probabilities.

All results are discovery predictions only. The fields `best_catalog_item_id`
and `best_official_slug` do not grant human confirmation or training eligibility.
The product page must subsequently be saved, parsed and matched independently.
No network, database, crawler, downloader or changes to UGC manifests occur.
