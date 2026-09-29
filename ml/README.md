# Frozen SigLIP2 retrieval baseline

This isolated package builds a **2,103-target official gallery** and a conservative **proxy_same_source** historical-image query set. It uses a frozen `google/siglip2-so400m-patch16-naflex` encoder, official `Siglip2Processor` / `Siglip2ImageProcessor`, `model.get_image_features`, float32 L2 normalization, and exact matrix cosine search. Every official catalog identity remains a separate target, including shared images and shared wine IDs.

No AutoDetect imports or crops, training, OCR, database writes, pgvector, FAISS, or prediction endpoint are used. All PostgreSQL connections used by the manifest builder explicitly enforce read-only transactions.

## Isolated CPU setup

Run these commands from the repository root in WSL/Linux:

```sh
python3 -m venv ml/.venv
ml/.venv/bin/pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu
ml/.venv/bin/pip install -r ml/requirements-cpu.lock
ml/.venv/bin/pip install --no-deps -e ml
```

Direct dependencies are pinned in `pyproject.toml`; `requirements-cpu.lock` records the tested Python 3.12 CPU environment, including transitive dependencies and test tools. Existing API and Node environments are untouched. Model downloads use the Git-ignored `ml/.cache/huggingface/hub`; output and checkpoints use the ignored `backups/lct/siglip_phase4a/` directory. No model weights belong in Git.

The default model revision is pinned to `cc24074f717b612951c2dead130904ab9b65a81e`. `--revision` can select another revision; the loader resolves it to a commit before loading processor and weights from that same commit. `trust_remote_code=False` is always used.

The CPU wheel deliberately provides no accelerator runtime. If an already-supported PyTorch accelerator environment is available on another machine, install the package there using a compatible PyTorch 2.9.1 build rather than this CPU-specific lock. The same code works with `--device auto` or `--device cuda`; CUDA API naming does not imply NVIDIA because ROCm PyTorch also uses it. This package never installs drivers, ROCm system packages, or kernel components.

## Runtime inspection and safe defaults

```sh
ml/.venv/bin/python -m vinedetect_retrieval env --device auto
```

This does not download/load the model. It reports PyTorch/Transformers versions, `torch.cuda.is_available()`, CUDA/HIP runtime versions, selected device, device name, and accelerator memory when available. `auto` uses a detected compatible accelerator or falls back to CPU. An explicit unavailable `cuda` request fails clearly.

Defaults are `--device auto --dtype float32 --max-num-patches 256 --batch-size 1 --threads 6`. Float32 is the supported CPU baseline. Explicit `float16`/`bfloat16` require an accelerator; unsupported BF16 or failed runtime/model operations produce errors instead of silently changing precision. No image is skipped after OOM; reduce batch size or patch count, then rerun. Such config changes invalidate incompatible cached vectors.

The original image is decoded to RGB, without an external crop/resize or square conversion. The official NaFlex image processor handles aspect ratio and patching. Its slow image implementation is selected explicitly for reproducibility, independently of whether torchvision happens to be installed. The bundled fast tokenizer lets the official combined processor load without optional SentencePiece; no text embedding or OCR is performed.

## Read-only manifests

Set `DATABASE_URL` to the local database DSN without storing credentials in source:

```sh
ml/.venv/bin/python -m vinedetect_retrieval manifests
```

This validates counts, canonical source identities, file existence/readability, SHA-256, dimensions, and MIME. Gallery rows are ordered by integer catalog ID. Gallery metadata includes official title, winery, region, color/category, grapes/description, historical manufacturer, canonical source ID, link provenance, and complete official-reference provenance.

Output in `backups/lct/siglip_phase4a/manifests/`:

- `gallery-manifest.json`: exactly 2,103 assignments, 2,074 physical SHA identities.
- `proxy-query-manifest.json`: 1,839 usable historical image queries from `exact_slug` links in the validated snapshot; unusable images are explicitly listed if encountered.
- `ambiguity-manifest.json`: 29 connected evidence groups: 28 duplicate-SHA groups and one additional singleton organizer-source inconsistency. Shared paths, `shared_reference`, `source_preserving_shared`, recorded flags, and known source inconsistencies remain visible. This is an evidence inventory, not a claim that a model discovers every possible semantic look-alike.

The proxy set is labeled **proxy_same_source** everywhere. It is a sanity benchmark, not expected contest, shelf-photo, or field-photo accuracy. Byte identity is recorded separately (zero byte-identical historical/official pairs in the current snapshot); different bytes can still depict the same source photo.

## Tiny local smoke test

```sh
ml/.venv/bin/python -m vinedetect_retrieval smoke --device cpu --dtype float32 --max-num-patches 256 --batch-size 1
```

This processes only eight official rows plus two historical proxy queries. It intentionally includes duplicate-reference assignments, validates NaFlex input shapes and 1,152-dimensional unit vectors, writes matrices/mappings/metadata/checkpoints, audits gallery self retrieval, and evaluates the two proxy queries against the **eight-row sample gallery**. Those sample metrics are not the full 2,103-way baseline.

`smoke-cpu-256/benchmarks/2103-way-timing.json` separately times an exact 2,103-column matrix and ranking using repeated smoke vectors. It is labeled **synthetic_2103_way_timing_only** and reports no accuracy. Real full-gallery retrieval latency is measured by `evaluate` after all gallery vectors exist. Add `--offline` once the pinned model has downloaded.

## Full runs: commands for later execution

Implementation runs only the tiny smoke. The following commands explicitly start the long jobs.

Full 256-patch official gallery:

```sh
ml/.venv/bin/python -m vinedetect_retrieval embed \
  --manifest backups/lct/siglip_phase4a/manifests/gallery-manifest.json \
  --output backups/lct/siglip_phase4a/embeddings/gallery-256 \
  --device cpu --dtype float32 --max-num-patches 256 --batch-size 1
```

512-patch gallery experiment (separate output and incompatible cache namespace):

```sh
ml/.venv/bin/python -m vinedetect_retrieval embed \
  --manifest backups/lct/siglip_phase4a/manifests/gallery-manifest.json \
  --output backups/lct/siglip_phase4a/embeddings/gallery-512 \
  --device cpu --dtype float32 --max-num-patches 512 --batch-size 1
```

Embed historical queries with exactly the same encoder settings as the gallery, then evaluate proxy retrieval:

```sh
ml/.venv/bin/python -m vinedetect_retrieval embed \
  --manifest backups/lct/siglip_phase4a/manifests/proxy-query-manifest.json \
  --output backups/lct/siglip_phase4a/embeddings/proxy-256 \
  --device cpu --dtype float32 --max-num-patches 256 --batch-size 1

ml/.venv/bin/python -m vinedetect_retrieval evaluate \
  --gallery backups/lct/siglip_phase4a/embeddings/gallery-256 \
  --queries backups/lct/siglip_phase4a/embeddings/proxy-256 \
  --output backups/lct/siglip_phase4a/evaluations/proxy-256.json
```

Audit the full gallery against itself:

```sh
ml/.venv/bin/python -m vinedetect_retrieval evaluate \
  --gallery backups/lct/siglip_phase4a/embeddings/gallery-256 \
  --queries backups/lct/siglip_phase4a/embeddings/gallery-256 \
  --self-check --output backups/lct/siglip_phase4a/evaluations/self-256.json
```

Use matching 512-patch query embeddings for the 512 experiment. No command silently embeds missing gallery/query matrices during evaluation.

## Resume, determinism, and interpretation

Each assignment has a durable atomic NPZ checkpoint keyed by catalog identity (or historical query identity), input SHA/dimensions, and full encoder configuration. This includes resolved model revision, processor settings, runtime/library versions, device/dtype, batch size, and thread count. A successful row is fsynced before progress advances. Ctrl+C/terminal close/reboot releases OS locks; rerunning the same command finds finished row files even if the progress index was interrupted. Corrupt checkpoints fail explicitly; only the affected entry needs removal/recomputation. Cache hits still recheck source bytes and dimensions.

Outputs are `embeddings.npy`, `rows.json`, `metadata.json`, and `benchmark.json`. Completion metadata is written last. Loading rejects incomplete bundles and matrix/mapping checksum or normalization mismatches. Final full-gallery output is exactly 2,103 rows in manifest order. A smoke bundle is always marked `sample_only`.

Inference is frozen/eval-only, with deterministic algorithms, seed zero, math SDPA and TF32 disabled. Ranking is exact `query_embeddings @ gallery_embeddings.T`, descending cosine, then ascending catalog ID for exact score ties. Floating-point differences across hardware/runtime versions remain possible; no bitwise CPU/GPU equivalence is promised. Those config changes do not share caches.

Evaluation reports strict Top-1/3/5/10, MRR, and mean rank. It additionally reports strict metrics excluding targets in multi-identity identical-SHA groups, and **diagnostic_visual_equivalence** metrics where only identical reference SHA is equivalent. Diagnostics never replace strict Top-1. Self retrieval reports unexplained competitors as failures; identical-reference ties must be documented by the ambiguity manifest. Numerical tolerance is only for explaining self-check ties, never for changing ranking.

Benchmarks record model-load time, selected device/dtype, processor/model devices, patch count, batch size, per-image mean/p50/p95 latency, throughput, retrieval latency, peak process RSS, and accelerator peaks where available. Batched latency is batch duration divided by batch size. Timing artifacts naturally vary between runs; deterministic manifests, mapping, and encoder configuration do not contain timestamps.

## Validation

```sh
ml/.venv/bin/pytest ml/tests -q
ml/.venv/bin/ruff check ml/src ml/tests
ml/.venv/bin/ruff format --check ml/src ml/tests
ml/.venv/bin/python -m compileall -q ml/src
```

Unit tests use fixtures and tiny randomly initialized SigLIP2 models for 256/512 patch API coverage; they do not download production weights. Set `SIGLIP_READ_ONLY_TEST_DATABASE_URL` to enable the optional real-asset integration test. It builds manifests twice and compares before/after fingerprints for all `contest`, `svoe_vino`, and `meta` tables using SELECT-only connections. No separate static type checker is configured.

The implementation's CPU smoke measured about 1.16 seconds/image at 256 patches, roughly 41 minutes extrapolated for the gallery alone, with about 2.62 GiB peak RSS. This is a small-sample estimate, not a full-run measurement; allow operating-system/load and image-size variation. Running the first frozen baseline locally on CPU is practical. A validated accelerator is useful for repeated experiments, but no GPU setup is needed to start this baseline.

Official implementation references: [model card](https://huggingface.co/google/siglip2-so400m-patch16-naflex), [pinned Transformers SigLIP2 documentation](https://huggingface.co/docs/transformers/v4.57.3/model_doc/siglip2).

## Phase 4A.2: real-world field review

All commands below run from the repository root. They reuse the existing 2103-row gallery; they never rebuild it or connect to PostgreSQL. New outputs are restricted to `backups/lct/field_phase4a2/`. The `raw/` directory and all Phase 4A.1 artifacts remain immutable.

```sh
# Decode/hash all 322 originals; initialize labels only if absent.
ml/.venv/bin/python -m vinedetect_retrieval field-manifest --expected-count 322

# Explicit full field-only generation; rerun this exact command to resume.
ml/.venv/bin/python -m vinedetect_retrieval embed \
  --manifest backups/lct/field_phase4a2/manifests/field-unlabeled-manifest.json \
  --gallery backups/lct/siglip_phase4a/embeddings/gallery-256 \
  --asset-root backups/lct/field_phase4a2/raw \
  --output backups/lct/field_phase4a2/embeddings/field-256 \
  --checkpoints backups/lct/field_phase4a2/checkpoints \
  --device cpu --dtype float32 --max-num-patches 256 \
  --batch-size 1 --threads 6 --offline

# Exact matrix retrieval against the frozen gallery; no model loading.
ml/.venv/bin/python -m vinedetect_retrieval retrieve
ml/.venv/bin/python -m vinedetect_retrieval field-groups
ml/.venv/bin/python -m vinedetect_retrieval review

# Separate same-source proxy error analysis.
ml/.venv/bin/python -m vinedetect_retrieval proxy-error-report

# Initially reports 0 exact labels and null accuracy; repeat after human review.
ml/.venv/bin/python -m vinedetect_retrieval evaluate-field --mode primary_field
```

Open `backups/lct/field_phase4a2/review/index.html` directly in a browser. It needs no server or external services. The page shows a full-frame field preview with a link to the untouched original, five reference candidates and expandable ranks 6–10. Sort by filename, ascending/descending Top1 or margin; filter by status or search filename/candidate metadata. Click an image for a larger view.

Use **Choose this exact identity** to populate the decision form, inspect the match, then click **Save human decision**. A catalog ID outside Top10 can be entered manually; its official slug is resolved from the complete gallery. Candidate suggestions never populate labels on page load or navigation. Non-exact statuses clear the exact ID/slug; optional candidate IDs, notes and tags remain explicitly human-authored.

Edits persist in browser storage where available. They do not update the annotation JSON on disk. **Export labels JSON** exports saved decisions; unsaved form edits are excluded. Import an exported file into the page to continue reviewing, or explicitly validate and apply it to the portable annotation file:

```sh
# Replace the input path with your human-exported file.
ml/.venv/bin/python -m vinedetect_retrieval import-field-labels \
  --input /path/to/downloaded/field-labels.json
ml/.venv/bin/python -m vinedetect_retrieval evaluate-field --mode primary_field
```

The CLI validates every field identity, status, catalog ID/slug pair, note and tag before writing. It preserves the previous annotation file as a content-addressed `previous-*.json` backup. Regenerating the manifest or review preserves valid existing labels and rejects incompatible snapshots. Export browser edits before changing browser/profile or deleting generated files; rebuilding HTML does not clear existing browser edits for the same manifest.

Artifacts:

- `manifests/field-unlabeled-manifest.json`: path-and-SHA-derived field IDs in relative path order, decoded dimensions/format, duplicate groups. Different paths remain separate assignments even with identical SHA. RGB loading follows the same frozen encoder policy; no external crop/resize/EXIF rotation is introduced for inference.
- `embeddings/field-256/`: normalized matrix, row mapping, frozen config/checksums and measured benchmark. Field embeddings must match the complete gallery config, including resolved weights, libraries and processor. CPU float32/256 patches/1152 dimensions are enforced before inference.
- `retrieval/field-256-top10.json`: deterministic cosine ranking, ties by ascending catalog ID. Margin is Top1 minus Top2; Top5 spread is Top1 minus Top5. Separate gallery assignments remain separate even when references are byte-identical.
- `review/index.html` and `review/assets/`: static local review previews. Source image bytes are never rewritten. Keep the sibling `raw/` directory to retain links to full originals.
- `annotations/field-labels.json`: initial 322 unreviewed rows. Supported statuses: unreviewed, exact_confirmed, family_confirmed, ambiguous, not_in_catalog, unusable, multi_bottle. Predictions never become ground truth automatically.
- `evaluations/field-256.json`: **field_real_world / primary_field** metrics using only exact_confirmed original/standalone rows. All other statuses are counted and excluded. Exact ranks/scores come from the full matrix, including expected targets outside Top10. Contains strict Top1/3/5/10, MRR, mean rank, identical-SHA diagnostic metrics, and full failure evidence with reviewer tags. With no exact labels, accuracy is null, not zero.
- `reports/prelabel-summary.json`: score/margin distributions, low/high margin examples, duplicates, decode failures and measured retrieval latency. **Confidence/margin is diagnostic only and does not measure correctness.**
- `reports/proxy-errors.json` and `.md`: only strict Top1 failures from the existing **proxy_same_source** evaluation, classified by actual expected/predicted reference SHA equality. This is not field accuracy.

Manifests, labels, Top10 results and HTML are deterministic for unchanged inputs. Timing/benchmark fields deliberately live in separate reports and vary across runs. Unit tests use synthetic vectors and image fixtures, never production model downloads. Field tests also prohibit encoder/database calls during retrieval and verify the existing gallery bundle remains byte-identical.


### Source grouping and separate benchmarks

The deterministic sidecar `manifests/field-source-groups.json` derives logical source groups from filenames without editing the original field manifest, raw files, labels, retrieval results, embedding bundles or checkpoints. Within a relative directory, it strips one terminal `_thumb` suffix (case-insensitive), ignores the format extension, and preserves the remaining stem's case. Group IDs hash the source dataset and relative source stem, not image bytes or row order. An original and thumbnail may have different SHA hashes and formats. Multiple files for the same source/variant are rejected for explicit resolution rather than silently merged.

A non-thumb with a counterpart is `original`; an unpaired non-thumb is `standalone`. A `_thumb` file without an original remains `thumb`, excluded from the primary benchmark. The current dataset has **322 files, 171 groups, 151 originals, 163 thumbs, 8 standalone images, 151 paired groups, and 12 orphan-thumb groups**. The primary population is **159 images**.

```sh
# Metadata/review only; no SigLIP inference or embedding command needed.
ml/.venv/bin/python -m vinedetect_retrieval field-groups
ml/.venv/bin/python -m vinedetect_retrieval review
ml/.venv/bin/python -m vinedetect_retrieval evaluate-field --mode primary_field
ml/.venv/bin/python -m vinedetect_retrieval evaluate-field --mode low_resolution_robustness
```

`--mode` is required for CLI evaluation. `primary_field` writes `evaluations/field-256.json` and includes only explicitly `exact_confirmed` original/standalone rows. `low_resolution_robustness` writes `evaluations/field-256-low_resolution_robustness.json` and includes only explicitly `exact_confirmed` thumb rows, including orphan thumbs when labeled. Neither uses family, ambiguous, not_in_catalog, unusable, multi_bottle or unreviewed rows in accuracy. Separate status counts cover the eligible population (`status_counts`) and all files (`all_status_counts`); eligible and evaluated source-group counts and exclusions by variant/status make the denominators explicit. Evaluation schema is now `siglip-field-evaluation/2`. The Python evaluation API defaults safely to primary_field and accepts only these two modes; there is no combined accuracy mode.

The review opens with **Primary only (original + standalone)**. The Images selector can include all images or show thumbs only. Each record shows its variant and source_group_id; paired images link to each other's source file and review record. Opening a pair explicitly switches to all images and clears status/search filters. The Not in catalog shortcut filters that valid human status within the selected image scope. Review progress also uses that scope.

Labels remain per field_image_id. Pairing, browsing, saving one variant, exporting and evaluation never copy ground truth to another variant. Existing labels and browser storage remain compatible because the original manifest and label schema are unchanged. Previously generated all-file score summaries remain retrieval diagnostics, not a primary accuracy denominator.


### DQ2 identity correction (2026-09-18)

Catalog item 603 now has its own materialized official wine identity (3981 in
the current dataset); 605 remains linked to historical wine 791. The current
manifest exporter expects 2,115 wines and link methods 1,839 exact_slug /
15 re_slug / 249 materialized_official. Gallery/reference/link counts remain
2,103, and the exact-slug proxy population remains 1,839.

Historical SQL now includes the actual image owner as historical_wine_id.
Proxy construction requires both exact_slug eligibility and equality between
that owner and the linked wine ID, so wine 791 cannot become a positive query
for 603. The live read-only integration test verifies the 603/605 mapping and
rejects any 603 proxy query.

Use backups/lct/dq2-identity-603-2026-09-18/manifests/ for the refreshed identity
metadata. Previous gallery manifests/bundles are preserved snapshots. No image
embeddings require regeneration because all reference paths, SHA hashes and
dimensions are unchanged.


## DQ2 training relationships and exclusions

`src/vinedetect_retrieval/training_relationships.json` is the reviewed, version-controlled
training policy. It does not merge official identities or alter retrieval/evaluator ranks.
Every dataset export additionally writes `training-dataset.json` and
`training-policy-report.json`; the gallery/proxy/ambiguity manifests retain their existing
inference/evaluation meaning.

`TrainingPolicy` derives identical-reference-SHA groups from the supplied **current effective
gallery** on every build. It blocks intra-group ordinary and hard negatives automatically.
Reviewed vintage/visual, alias/version and packaging relationships also block both kinds;
`non_discriminative_reference_group` blocks hard negatives and remains diagnostic. The
identical-SHA rule takes precedence when such a group also shares reference bytes.
Groups apply pairwise without transitive closure. Counts are unique unordered distinct-ID
pairs; sampling also excludes the anchor itself.

Use `TrainingPolicy.sample_negatives(...)` or `negative_candidates(...)` for sampling,
and `mine_hard_negatives(...)` for cosine-ranked training candidates. Mining masks exclusions
**before** selecting top-k, uses stable score/catalog-ID ordering and rejects embeddings
whose IDs, slugs or reference SHAs differ from the current gallery. Visually similar but
unrelated wines remain eligible. No curated relationship creates cross-identity visual
positives, including different packaging images.

Historical training positives require the current exact-slug owner and gallery reference.
An explicit `historical_image_mismatch: true`, `historical_image_status: "mismatch"`, or
`review_status: "mismatch"` on a historical input row always excludes it. Reviewed per-image
exclusions can also be persisted in the canonical `historical_image_exclusions` array:

```json
{"catalog_item_id": 123, "historical_image_id": 456,
 "reason": "mismatch", "provenance": "human_reviewed_dq2"}
```

The array currently has no additional per-image decisions; this task supplied relationship
groups rather than image IDs. Excluded positives retain their input row and reason in the
training artifact. Heuristic audit suspicions are not silently promoted to human decisions.

Generate training-only artifacts from a freshly exported effective gallery and its proxy
manifest; use a new output directory each time:

```sh
python -m vinedetect_retrieval.training \
  --gallery-manifest /path/to/current/gallery-manifest.json \
  --proxy-manifest /path/to/current/proxy-query-manifest.json \
  --gallery-bundle /path/to/matching/gallery-256-v4 \
  --top-k 10 --output /path/to/new/training-output
```

The optional bundle mines hard negatives without training or regenerating embeddings.
The report records input digests, all current identical-SHA groups, reviewed relationships,
affected IDs, forbidden pairs and all 2,103 inference IDs/slugs. Existing artifacts and
PostgreSQL remain untouched. Run targeted tests with `pytest tests/test_training.py`.
