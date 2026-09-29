# vinedetect_dev

Status: active local-development monorepo

Last verified against code: 2026-08-09

Monorepo for the local VineDetect stack:

- `vinedetect_api` - Python/FastAPI catalog API and database import/crawler tools.
- `recognize-service` - Node/Fastify metadata generation and recognition worker service.
- `annotation_controller` - isolated local controller runtime consuming VisionContext/overlay assets and returning correction plans.
- `vinedetect_web` - Next.js scanner/admin UI.
- `asset-store` - local image asset root. This folder is ignored by git.
- `.basedata` - local dataset archives and restore staging. This folder is ignored by git.

Current documentation map:

```text
docs/README.md
```

## Implementation Status

- **Implemented:** Python catalog/import API and CLI; unified read-only catalog over Svoe Vino and Roskachestvo; Fastify recognition metadata/jobs/CV/annotation APIs; Next.js admin UI; manual label ROI; revision-bound OpenCV analysis of a reviewed ROI crop with persisted debug metadata and per-item config snapshot; backend OCR snapshots; OCR word regions; reviewed OCR text; immutable annotation datasets; registered dataset artifacts; and the training/evaluation/model registry contracts.
- **Partially implemented / WIP:** the unified annotation pipeline joins manual ROI review, per-item/batch OpenCV regeneration and immutable human review (`accepted`, `needs-tuning`, `rejected`) in one UI. Analysis readiness totals and filters are implemented; a single durable job spanning OpenCV, OCR, source matching and aliases remains planned. Root Docker Compose now reproduces the restored-dataset runtime profile, but a fresh migration-only full-stack bootstrap, scanner-to-backend recognition, CV preset lifecycle and automated tests for `recognize-service` and `vinedetect_web` remain incomplete.
- **Planned:** actual training workers, trained detector inference, model-backed proposal jobs, client-bundle publication, batch/preset-driven OCR source matching, production scan scoring/final results, and TensorFlow-specific dataset conversion/training. Item-level reviewed OCR source associations are implemented.
- **Deprecated / superseded:** `public.roskachestvo_wines`, the legacy Roskachestvo CLI, and treating generated proposals or `visualFeatures.cvMeta.label.roi` as human ground truth.

## Local Defaults

| Service | URL | Notes |
| --- | --- | --- |
| PostgreSQL | `localhost:5432/wines` | default user `postgres`, default password `admin` in local scripts |
| Python API | `http://127.0.0.1:8000` | FastAPI catalog/admin auth API |
| Recognize service | `http://127.0.0.1:4001` | internal metadata/job service |
| Annotation controller | `http://127.0.0.1:9000` | reference local-ML HTTP boundary; deterministic planner by default |
| LLM controller | `http://127.0.0.1:9100` | provider-selectable OpenAI/Qwen Node.js adapter; requires the selected provider credentials |
| Wizard Swagger UI | `http://127.0.0.1:4001/documentation/` | ordered Label-to-Summary input/output contracts |
| Next.js web | `http://127.0.0.1:3000` | admin and scanner UI |
| Admin UI | `http://127.0.0.1:3000/admin` | JWT login through Python API |

## Required Tools

- Recommended shared runtime: Docker Engine with Docker Compose v2.
- Native Windows workflow: PowerShell, Python 3.11+, Node.js/npm, PostgreSQL 16 client/server tools and `tar`.
- Linux dataset restore additionally uses the standard `bash`, `tar`, `sha256sum` and `realpath` commands. PostgreSQL client tools run inside the container.

PostgreSQL tools can be in `PATH`, or installed in one of the usual Windows locations checked by `scripts/restore_dataset.ps1`.

## Docker Compose

The root `compose.yaml` is the recommended reproducible runtime for Linux and for keeping both development machines on the same service versions. It builds and starts PostgreSQL 16, FastAPI, Recognize Service, its one-shot `meta.*` migrator, the isolated annotation controller and the Next.js BFF/UI.

The full Compose stack intentionally requires the restored dataset shape. On a new machine, place the agreed archive in `.basedata` and run:

```bash
cp .env.example .env
bash ./scripts/restore_dataset.sh \
  ./.basedata/vinedetect_dataset_20260729_235903.tar.gz \
  --yes \
  --start
```

The local environment has three roles: `admin`, `annotator` and `ml-service`. `.env.example` uses the development password `admin` for all three only as a zero-setup fallback; set distinct Argon2 hashes, the JWT secret and internal API key outside local development. `admin` owns catalog mutations, `annotator` identifies interactive annotation work, and `ml-service` identifies unattended annotation API work. If the Linux account is not UID/GID `1000:1000`, set `HOST_UID` and `HOST_GID` in `.env` to the output of `id -u` and `id -g`; this lets Recognize Service write generated crops into the host `asset-store` without creating root-owned files.

For an already restored Compose volume:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
```

For active development with source mounts and hot reload, use the development override in the foreground:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

This runs `uvicorn --reload` for the catalog API, `node --watch` for annotation controllers, `tsx watch` for Recognize and `next dev` for Web. The base Compose file remains the production-like reproducibility check using compiled Recognize and Next standalone artifacts. Stop the native PowerShell stack and host PostgreSQL first if they already occupy ports `3000`, `4001`, `8000` or `5432`.

Stop containers without deleting database data:

```bash
docker compose down
```

Do not add `-v` unless deleting the Compose PostgreSQL volume is intentional. `asset-store` is a host bind mount and is not removed by `docker compose down`.

The one-shot `dataset-check` service refuses to start API/Recognize/Web when `svoe_vino.wines`, `svoe_vino.wine_images` or `roskachestvo.products` is missing. The nested `vinedetect_api/docker-compose.yml` remains the separate Python-only migration profile; it is not a bootstrap for the full recognition stack.

## First Setup

Install Python dependencies:

```powershell
cd .\vinedetect_api
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .[dev]
Copy-Item .env.example .env
```

Edit `vinedetect_api\.env` for your local PostgreSQL password and admin settings. Current local scripts assume:

```text
DATABASE_URL=postgresql://postgres:admin@localhost:5432/wines
ADMIN_USERNAME=admin
API_PORT=8000
```

Install frontend dependencies:

```powershell
cd ..\vinedetect_web
cmd /c npm install
```

Install recognize-service dependencies:

```powershell
cd ..\recognize-service
cmd /c npm install
Copy-Item .env.example .env
```

Default `recognize-service\.env`:

```text
DATABASE_URL=postgresql://postgres:admin@localhost:5432/wines
PORT=4001
NEXT_BFF_ORIGIN=http://localhost:3000
INTERNAL_API_KEY=development-secret
ASSET_ROOT=../asset-store
DATASET_EXPORT_ROOT=../exports
WORKER_ENABLED=true
WORKER_POLL_INTERVAL_MS=1000
WORKER_CONCURRENCY=2
```

Optional local-ML controller integration:

```text
LOCAL_ML_CONTROLLER_URL=http://annotation-controller:9000/annotation/plan
LOCAL_ML_CONTROLLER_TOKEN=<optional bearer token>
LOCAL_ML_CONTROLLER_TIMEOUT_MS=60000
LOCAL_ML_CONTROLLER_MAX_RESPONSE_BYTES=2097152
LLM_WIZARD_CONTROLLER_URL=http://llm-controller:9100/annotation/plan
LLM_WIZARD_CONTROLLER_TOKEN=<optional bearer token>
LLM_WIZARD_CONTROLLER_TIMEOUT_MS=150000
LLM_WIZARD_CONTROLLER_MAX_RESPONSE_BYTES=2097152
LLM_CONTROLLER_BACKEND=openai
OPENAI_API_KEY=<OpenAI Platform API key; never a ChatGPT session token>
OPENAI_MODEL=gpt-5.6-terra
OPENAI_REASONING_EFFORT=medium
OPENAI_MAX_OUTPUT_TOKENS=12000
OPENAI_TIMEOUT_SECONDS=120
OPENAI_MAX_RETRIES=2
QWEN_API_KEY=<Model Studio API key; required only when LLM_CONTROLLER_BACKEND=qwen>
QWEN_BASE_URL=<workspace/region OpenAI-compatible base URL ending in /v1>
QWEN_MODEL=qwen3.7-flash
QWEN_MAX_OUTPUT_TOKENS=4000
```

Inside Compose, `annotation-controller` is the deterministic local-ML reference runtime and `llm-controller` is the provider-selectable multimodal runtime. The LLM path reviews Label, Object Context, OCR and Label-owned CV helper outputs through `StageObservation -> StageLLMDecision`; it cannot emit arbitrary Wizard commands. Recognize runs the helper, builds a bounded visual observation, validates the returned candidate ID, and only then creates an unapplied correction plan. Package stays human-owned and Summary is advisory. `human_required` and provider failures leave the regular human workflow available. Provider keys exist only in `llm-controller`; Recognize and the browser never receive them.

Create a project API key in the OpenAI Platform and place it only in the ignored root `.env`. Never put a real key in `.env.example`. A ChatGPT login cookie/session token is not supported, and ChatGPT subscription billing does not fund API usage; API billing must be configured separately. Without `OPENAI_API_KEY`, the regular stack can still run, but `llm-controller` is marked unhealthy and an LLM planning request returns `503` with an explicit configuration error.

Controller routes:

- `POST /management/items/{source}/{sourceItemId}/annotations/{annotationId}/controllers/local-ml/plan`
- `POST /management/items/{source}/{sourceItemId}/annotations/{annotationId}/controllers/llm/plan`
- `POST /management/items/{source}/{sourceItemId}/annotations/{annotationId}/correction-plans/{planId}/apply`
- `PUT /management/items/{source}/{sourceItemId}/annotations/{annotationId}/correction-plans/{planId}/review`

Planning, applying and human evaluation are deliberately separate calls. The returned `executor` and `interactionMode` become compact StageSample proposal provenance. The review call records `finalEditor` and an explicit LLM verdict without exporting the intermediate LLM annotation as a third training state.

## Dataset Restore

Current status: **implemented for the restored-dataset development profile**. `scripts/restore_dataset.ps1` recreates the local database, restores source-data/assets and configures the expected search path.

Dataset archives in `.basedata` are the current operational handoff mechanism between the two development machines. The shared database state is not reconstructed from repository fixtures: after catalog or `meta.*` rows change and the second developer needs those changes, create a fresh snapshot, transfer the archive, and restore it on the other machine. `.basedata` remains local/ignored and archives are exchanged outside Git.

Dataset archives live in `.basedata`. Restore both database dump and images into the project asset store:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore_dataset.ps1 `
  -ArchivePath .\.basedata\vinedetect_dataset_20260727_010201.tar.gz `
  -DatabaseName wines `
  -UserName postgres `
  -Password admin
```

The restore script:

- stops the dev stack if it is running;
- recreates the target database;
- restores `db/wines.dump`;
- ensures the migration ledger exists;
- copies image files into `asset-store`;
- prints table/image counts.

The Docker/Linux equivalent uses PostgreSQL tools inside the container:

```bash
bash ./scripts/restore_dataset.sh ./.basedata/<archive>.tar.gz --yes
docker compose up -d --build
```

Pass `--start` to perform the second command automatically. The Linux restore overlays archive files onto `asset-store` instead of deleting unrelated existing media, verifies a neighboring `.sha256` file when present, rejects unsafe archive paths, recreates the Compose database, sets `search_path`, records the Python migration ledger and applies all Recognize Service migrations.

It restores a dump rather than rebuilding the database from repository migrations. It then sets the database `search_path` to `svoe_vino, public` and records all Python migration filenames in `public.schema_migrations` without executing those SQL files. Treat this as a dataset-specific bootstrap path, not as proof that a fresh migration-only database has the same shape.

Data and schema changes have different handoff rules:

- New/updated catalog rows, `meta.items`, proposals, reviewed annotations, OCR runs/regions/reviews and other shared database content require a new dataset snapshot when they must appear on the second machine.
- As of 2026-08-08 the local baseline was restored from `vinedetect_dataset_20260729_235903.tar.gz`: source-data comes from that archive, migrations `001`-`015` provide the current `meta` schema, and operational pipeline tables remain empty until manual or semi-automatic annotation begins.
- Schema changes still require committed SQL migrations. A new dump may already contain the resulting schema, but the migration files remain the reproducible schema history for other/future databases.
- After restoring an older dump against newer code, apply the current Recognize Service migrations and run any required idempotent backfill before creating or consuming new metadata.

Expected asset layout after restore:

```text
asset-store/
  svoe-vino/
  roskachestvo/
```

Do not commit `asset-store` or `.basedata`.

## Recognize Migrations

After restoring a dump, apply recognize-service migrations:

```powershell
cd .\recognize-service
cmd /c npm run migrate
```

This creates/updates the `meta` schema used by recognition metadata, generation jobs, detection proposals, reviewed image annotations, OCR crops/runs/word regions, reviewed OCR text/regions/source associations and reviewed aliases. The current migrator runs every SQL file idempotently and does not keep its own migration ledger.

After applying migrations to an existing dump, backfill annotation entities from legacy metadata:

```powershell
cd .\recognize-service
cmd /c npm run backfill:annotations
```

The backfill is idempotent: it skips items that already have proposal or annotation rows.

No additional migration is required to generate reviewed-ROI analysis. `ANALYZE_LABEL` stores its job options/results and `labelAnalysis` snapshot in existing JSONB columns, while crop artifacts are written under `asset-store/label-analysis/`. Migration `015` adds the separate immutable human-review table. Running analysis or saving reviews creates operational metadata and therefore requires a later dataset snapshot only when those rows/artifacts must be handed to the second development machine.

## Annotation Dataset Export

Manual label annotation workflow:

```text
docs/label_annotation_workflow_ru.md
```

Export reviewed label bounding boxes, OCR text/regions/source associations/aliases, and generated OCR word boxes:

```powershell
cd .\recognize-service
cmd /c npm run export:annotation-dataset -- --name annotation-dataset-v1 --source all
```

Output:

```text
exports/
  annotation-dataset-v1/
    manifest.json
    annotations.jsonl
    splits.json
```

The old `export:label-dataset` command is still available as an alias.

The annotation queue can also store fixed cohorts and immutable DB dataset versions. A frozen version snapshots reviewed layers in a repeatable-read transaction, records item hashes and fixes deterministic train/validation/test membership. `Export artifact` writes that exact stored version to `exports/<dataset-version>/` as `manifest.json`, `annotations.jsonl` and `splits.json`; it records the JSONL SHA-256, registers the artifact in `meta.dataset_artifacts` and refuses to overwrite an existing artifact.

The Training admin page registers externally executed runs against one registered dataset artifact, enforces run status transitions, stores split metrics and model artifact checksums, and gates model validation/promotion on a model-linked validation result. It is a registry and control-plane contract only: no trainer, worker, model inference or client publication runtime is implemented.

The export uses only `meta.image_annotations` rows with `annotation_type = label-bbox` and `status = reviewed` as label ROI ground truth. If available, it also attaches the latest OCR text revision, generated word boxes, reviewed OCR-region revision, its matching reviewed OCR-to-source association revision, and the reviewed alias revision bound to those associations. Generated candidates/word boxes, detection proposals and raw OCR text are not reviewed training ground truth.

Probe current annotation/OCR workflow counts:

```powershell
cd .\recognize-service
cmd /c npm run probe:annotation-workflow -- --source all --samples 3
```

## Database Profiles

The repository currently contains two database assumptions that are not interchangeable:

- The Python migrations create unqualified catalog tables in the active schema (normally `public`). Python repository SQL also uses unqualified names such as `wines` and `wine_images`.
- The restored local dataset sets `search_path=svoe_vino,public`; Recognize Service explicitly reads `svoe_vino.wines` and `svoe_vino.wine_images` plus `roskachestvo.products`.

Therefore the current full three-service stack is verified against the restored dataset profile. A fresh Docker/migration-only database is sufficient for the Python API, but is not yet a documented or verified bootstrap for Recognize Service.

## Start Full Dev Stack

Recommended cross-platform/container command after dataset restore:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

The native Windows launcher remains available for fast local iteration without Docker.

Windows command:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev_stack.ps1 -Action run -CleanPorts
```

This starts:

- Python API on `8000`;
- Recognize service on `4001`;
- Next.js web on `3000`;
- worker loop for recognition jobs;
- terminal log streaming until `Ctrl+C`.

Useful variants:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev_stack.ps1 -Action start -CleanPorts
powershell -ExecutionPolicy Bypass -File .\scripts\dev_stack.ps1 -Action status
powershell -ExecutionPolicy Bypass -File .\scripts\dev_stack.ps1 -Action tail
powershell -ExecutionPolicy Bypass -File .\scripts\dev_stack.ps1 -Action stop
powershell -ExecutionPolicy Bypass -File .\scripts\dev_stack.ps1 -Action restart -CleanPorts
```

Logs are written to:

```text
.dev_logs/current/
  stack.log
  api.out.log
  api.err.log
  recognize.out.log
  recognize.err.log
  web.out.log
  web.err.log
  state.json
```

### UI activity and request tracing

Every native `start`, `restart` or `run` creates a separate structured trace:

```text
.dev_logs/activity/ui-activity-<timestamp>-<launcher-pid>.jsonl
```

The active path and session id are recorded in `.dev_logs/current/state.json`. Browser events (`click`, `change`, canvas pointer start/end, submit, navigation and supported hotkeys) and every browser `fetch` start/finish/error are printed as `[activity]` lines to the Web CLI/stdout and appended to that JSONL file. JSON request bodies are included so CV config changes are auditable; password/token/authorization/secret/cookie fields are redacted, text inputs record length rather than content, and binary uploads record metadata rather than bytes.

Use the normal foreground launcher to see the combined service and activity stream:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev_stack.ps1 -Action run -CleanPorts
```

Or inspect the latest saved trace together with service logs:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev_stack.ps1 -Action tail
```

Docker Web builds enable the same collector and write per-container-start traces under `.dev_logs/activity/`; `docker compose logs -f web recognize api` shows the live request/activity stream. Set `DEV_ACTIVITY_LOG_ENABLED=false` to disable it in a production-like run.

## Manual Start

Python API:

```powershell
cd .\vinedetect_api
.\.venv\Scripts\python.exe -m uvicorn app.api.application:app --host 127.0.0.1 --port 8000
```

Recognize service:

```powershell
cd .\recognize-service
$env:DATABASE_URL="postgresql://postgres:admin@localhost:5432/wines"
$env:PORT="4001"
$env:INTERNAL_API_KEY="development-secret"
$env:ASSET_ROOT="..\asset-store"
$env:WORKER_ENABLED="true"
cmd /c npm run dev
```

Next.js web:

```powershell
cd .\vinedetect_web
$env:NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:8000"
$env:RECOGNIZE_SERVICE_URL="http://127.0.0.1:4001"
$env:RECOGNIZE_INTERNAL_API_KEY="development-secret"
cmd /c npm run dev -- --hostname 127.0.0.1 --port 3000
```

Use `cmd /c npm ...` on Windows if PowerShell blocks `npm.ps1` via execution policy.

## Admin UI

Open:

```text
http://127.0.0.1:3000/admin
```

Main pages:

- `/admin` - catalog list from Python API.
- `/admin/recognition` - source item inventory with metadata state, raster state, latest job, checkboxes and group actions.
- `/admin/recognition/annotations` - label annotation queue for generated proposals and reviewed ROIs.
- `/admin/recognition/jobs` - unified recognition job journal, batch generation, child jobs, cancel/retry.
- `/admin/recognition/[source]/[sourceItemId]` - one item card with catalog data, saved metadata, CV Lab and Label Annotation sections.

Login uses `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH` from `vinedetect_api\.env`.

## Images

Database rows store paths, not binary data. The boundary is:

- API says which image belongs to an item.
- Static route returns image bytes.
- Next.js does not keep a second copy of images.

Current local serving is done by Next.js:

```text
/api/admin/assets/[...path]
```

Path mapping:

- `svoe_vino/...` and legacy `data/...` -> `asset-store/svoe-vino/...`
- `roskachestvo/...` and legacy `storage/...` -> `asset-store/roskachestvo/...`

Recognize service reads files directly from `ASSET_ROOT`.

The Recognize service publishes the live Label Annotation wizard contract at
`http://127.0.0.1:4001/documentation/`; raw OpenAPI JSON is available at
`http://127.0.0.1:4001/documentation/json`. The document lists the direct
`/management/*` route and its Next.js BFF mirror for every operation. Swagger
`Try it out` calls the internal service directly and therefore requires the
configured `x-internal-api-key` (the local default is `development-secret`).

## Recognition Workflow

1. Restore dataset and assets.
2. Run recognize migrations.
3. Start full stack.
4. Open `/admin/recognition`.
5. Select rows with checkboxes.
6. Click `Generate missing`, `Regenerate` or `Generate proposal`.
7. Watch `/admin/recognition/jobs`.
8. Open an item detail page to inspect source data, JSON metadata, raster features, CV Lab preview or Label Annotation.

Current generated metadata includes aliases, normalized tokens, structured visual fields, `cvMeta`, `dHash`, color zones and warnings. Detection proposal jobs create candidate label ROIs in `meta.detection_proposals`. Human-reviewed label ROIs are stored separately in `meta.image_annotations`.

Backend OCR is implemented as a direct management request, not as a recognition job. It crops the current reviewed/proposed bbox, runs `tesseract.js`, and persists `meta.label_crops`, `meta.ocr_runs` and generated word boxes in `meta.ocr_regions`. Human-reviewed OCR text is stored separately in `meta.ocr_text_annotations`; reviewed word/line/string layouts are immutable revisions in `meta.ocr_region_annotation_sets` and `meta.ocr_region_annotations`.

Core annotation rule:

```text
generated proposal != reviewed annotation
```

Dataset export uses reviewed annotations only.

For the current architecture and manual annotation workflow, see:

```text
docs/current_architecture.md
docs/item_card_ui_tabs_ru.md
docs/label_annotation_workflow_ru.md
docs/README.md
```

For CV preset tuning and sweep-based parameter selection, see `docs/cv_lab_readme_ru.md` and `docs/cv_pipeline_tuning_guide_ru.md`.

### Preview, Sweep And Jobs

The admin UI separates exploratory CV runs from persisted generation jobs.

`Run preview` is a direct HTTP request:

```text
Frontend -> Next BFF /api/admin/cv/playground/run
         -> Recognize /management/cv/playground/run
         -> extractCvMetaFromFile(...)
         -> response with cvMeta and metrics
         -> UI overlay
```

Preview does not create a row in `meta.generation_jobs`, does not update `meta.items`, and does not persist `visualFeatures`. Its result exists only in the current page state.

`Run HTTP sweep` is also direct HTTP:

```text
Frontend -> Next BFF /api/admin/cv/playground/sweep
         -> Recognize /management/cv/playground/sweep
         -> multiple extractCvMetaFromFile(...) runs with changed config
         -> response with variants, cvMeta and metrics
         -> UI comparison gallery
```

Sweep is for parameter comparison. It does not create jobs, does not write metadata, and does not appear in job history.

`Run full pipeline`, `Regenerate with preset` and `Generate proposal` create queued recognition jobs:

```text
Frontend -> Next BFF /api/admin/recognition/jobs
         -> Recognize /management/jobs
         -> INSERT meta.generation_jobs
         -> worker claims queued job
         -> generate metadata or proposal
         -> UPDATE meta.items or INSERT meta.detection_proposals
         -> UPDATE meta.generation_jobs status/result
         -> frontend polls job status
         -> frontend reloads saved metadata/proposals
```

Jobs persist generated metadata/proposals and provenance. Job options should include enough information to reproduce the run, such as `presetId`, `presetRevision`, `pipelineVersion`, `configHash` and `pipelineConfigSnapshot`.

Short version:

```text
Preview = inspect one result now, no persistence.
Sweep = compare parameter variants, no persistence.
Job = generate and save metadata or proposals into the database.
Reviewed annotation = human ground truth saved outside generated metadata.
```

### Recognition Jobs Contract

Recognition jobs use one database table regardless of where they were started:

```text
meta.generation_jobs
```

The Jobs page lists the same journal for:

- batch parent jobs started from `/admin/recognition/jobs`;
- batch child item jobs created by a batch parent;
- single item jobs started from an item card.

Each job response includes a `scope`:

- `batch-parent`
- `batch-child`
- `single-item`

To inspect or reset the journal:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\reset_recognition_jobs.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\reset_recognition_jobs.ps1 -Force
```

The reset script deletes recognition job rows only. It does not delete catalog rows, generated metadata, manual annotations or image assets.

## Probe Run

For a short diagnostic run with logs:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\admin_probe.ps1
```

Probe logs are written to:

```text
.probe_logs/admin_probe_YYYYMMDD_HHMMSS/
```

The probe checks database connection, Python API health, wine endpoint and admin page availability.

## Scanner Status

The `/scan` page is a working browser-side prototype: it opens the camera, ranks frames, performs multi-pass Tesseract OCR and Fuse.js matching, and uploads the selected frame/crop.

The flow is **not a production recognition path**:

- `/api/catalog/search-index` currently serves `mockCatalogIndex`, not the live catalog;
- `/api/scan` only logs request presence and returns `finalResults: []`;
- uploaded images and scan results are not persisted;
- no server-side final scoring or wine-card resolution is implemented.

## Validation Commands

Python API tests:

```powershell
.\vinedetect_api\.venv\Scripts\python.exe -m pytest -q vinedetect_api/tests
```

Run these tests from the monorepo root: a few source-inspection tests use root-relative paths.

Recognize service:

```powershell
cd .\recognize-service
cmd /c npm run typecheck
cmd /c npm run build
```

Next.js:

```powershell
cd .\vinedetect_web
cmd /c npm run lint -- --format stylish
cmd /c npm run build
```

## Export Dataset Snapshot

The export helper is Bash-oriented:

```bash
DB_HOST=localhost DB_PORT=5432 DB_NAME=wines DB_USER=postgres PGPASSWORD=admin \
  bash scripts/create_dataset_snapshot.sh
```

It creates a dataset archive with:

- PostgreSQL custom dump;
- PostgreSQL SQL dump;
- image files;
- manifest files;
- release snapshot.

Create a new archive whenever shared database content has changed and must be handed to the second development machine. Record which archive is current out of band; `.basedata` is ignored and Git cannot establish archive freshness.

## Troubleshooting

Recognize proxy returns `ECONNREFUSED 127.0.0.1:4001`:

- start the full stack with `scripts/dev_stack.ps1 -Action run -CleanPorts`;
- or manually start `recognize-service`;
- check `.dev_logs/current/recognize.err.log`.

Admin page loads but has no content:

- confirm login succeeded;
- run `scripts/dev_stack.ps1 -Action status`;
- check Python API `/api/v1/catalog?source=all&limit=3`;
- check Recognize `/health`.

Images do not load:

- confirm `asset-store/svoe-vino` and `asset-store/roskachestvo` exist;
- re-run `scripts/restore_dataset.ps1`;
- inspect `.dev_logs/current/stack.log` for `web_asset`.

PowerShell blocks `npm.ps1`:

```powershell
cmd /c npm run build
```

PostgreSQL password works in pgAdmin but not in scripts:

- check `vinedetect_api\.env`;
- check `recognize-service\.env`;
- pass `-Password ...` explicitly to `restore_dataset.ps1`;
- remember pgAdmin may cache a different server connection/password than CLI tools.

Ports are stuck:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev_stack.ps1 -Action stop -CleanPorts
```
