# Vinedetect Wine Catalog Service

Status: implemented Python service; documentation verified 2026-08-07

Python backend for the Vinedetect wine catalog. The project contains the existing crawler/import CLI, PostgreSQL repository layer, SQL migrations, Roskachestvo matching utilities, barcode links, image metadata processing, and a FastAPI HTTP catalog API.

## Architecture

- `app.main` remains the CLI entrypoint for crawling, imports, image jobs, matching, and stats.
- `app.repositories.WineRepository` is the shared synchronous psycopg repository used by both CLI and HTTP API.
- `app.api.application:app` exposes the FastAPI application and OpenAPI schema.
- `app.api.routes` contains public health/catalog routes and protected admin mutations.
- `migrations/001` through `011` are the schema history. `010` adds `roskachestvo.products`; `011` drops the superseded `public.roskachestvo_wines` table.
- The package-local Docker Compose runs PostgreSQL, a one-shot migration service, and the API service. The repository-root `compose.yaml` is the separate full-stack restored-dataset runtime.

The service has two read surfaces:

- `/api/v1/wines` is CRUD for the local `wines` table;
- `/api/v1/catalog` is a read-only provider-neutral union of Svoe Vino and `roskachestvo.products` using `source`, `external_id` and `recognitionKey`.

## Prerequisites

- Python 3.11 or newer
- Docker and Docker Compose 2.30.0 or newer for containerized local runs
- PostgreSQL 16 for manual local DB runs

## Environment

Create a local `.env` from the example:

```bash
cp .env.example .env
```

Generate a JWT secret:

```bash
openssl rand -hex 32
```

Generate an Argon2 admin password hash:

```bash
python -c "from pwdlib import PasswordHash; print(PasswordHash.recommended().hash('your-password'))"
```

Set the generated values and API settings in `.env`. `.env.example` is only a template; do not put real secrets there:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=<argon2-hash>
ANNOTATOR_USERNAME=annotator
ANNOTATOR_PASSWORD_HASH=<argon2-hash>
ML_SERVICE_USERNAME=ml-service
ML_SERVICE_PASSWORD_HASH=<argon2-hash>
JWT_SECRET=<hex-secret>
JWT_ALGORITHM=HS256
JWT_EXPIRE_MINUTES=60
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
API_HOST=0.0.0.0
API_PORT=8000
```

Docker Compose reads the complete API configuration from the raw env file
selected by `API_ENV_FILE` (`.env` by default): `ADMIN_USERNAME`,
`ADMIN_PASSWORD_HASH`, optional role-account overrides, `JWT_SECRET`, `JWT_ALGORITHM`, `JWT_EXPIRE_MINUTES`,
`CORS_ORIGINS`, `API_HOST`, and `API_PORT`. `ADMIN_USERNAME`,
`ADMIN_PASSWORD_HASH`, and `JWT_SECRET` are required and the API fails fast when
they are missing. Only `HS256` is supported for `JWT_ALGORITHM` today.

The raw env file format requires Docker Compose 2.30.0 or newer and preserves
`$` inside Argon2 password hashes without escaping. To use another complete API
env file, set `API_ENV_FILE` when running Compose:

    API_ENV_FILE=.env.local docker compose up --build -d

Never commit `.env`, `.env.local`, other real env files, Docker volumes,
database dumps, downloaded images, or runtime logs. These files are also
excluded from the Docker image build context.

## Local API Run

Install the project and dev tools:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e '.[dev]'
```

Apply migrations to your PostgreSQL database, then run:

```bash
uvicorn app.api.application:app --host 0.0.0.0 --port 8000
```

Swagger UI is available at:

```text
http://localhost:8000/docs
```

OpenAPI JSON is available at:

```text
http://localhost:8000/openapi.json
```

## Docker Compose

Start the stack:

```bash
docker compose up --build -d
```

Compose services:

| Service | Purpose |
| --- | --- |
| `postgres` | PostgreSQL 16 with named volume `postgres-data` |
| `migrate` | One-shot migration runner for all numbered migrations (`001` through `011` currently) |
| `api` | FastAPI app served by Uvicorn on `${API_PORT:-8000}` |

The migration service creates `schema_migrations` and records each applied migration. Repeated Compose starts skip migrations already recorded and stop on the first SQL error.

Do not run `docker compose down -v` unless you intentionally want to destroy local PostgreSQL data.

## Recognition Database Foundation (Superseded / Unused By Active UI)

Migration `009_recognition_schema_foundation.sql` adds a schema-only foundation for future recognition work. It does not create recognition data automatically, does not normalize text or aliases, does not run OCR or visual processing, does not add API endpoints, and does not integrate with the frontend. The current catalog data is test-oriented; the final recognition dataset may use a different source shape and can be imported later through the stable wine identifiers.

The current Fastify/Next.js recognition implementation does **not** use these `recognition_*`, `ocr_observations`, `visual_features` or `asset_processing_jobs` tables. It uses the separate `meta.*` schema owned by `recognize-service`. There is no bridge between the two models, so migration `009` is historical foundation rather than the active recognition architecture.

The recognition schema uses a stable envelope plus flexible JSONB payloads. Stable fields such as identifiers, foreign keys, type, status, source, processor names and versions, schema versions, confidence, weight, and timestamps are typed columns. Evolving content stays in JSONB payload columns so OCR output, crops, polygons, visual descriptors, processing input, and processing output can change without forcing premature table redesign. `schema_version` records the format of each JSON payload and allows future migrations or rebuilds to distinguish payload shapes. Required stable type, version, source, and processor text fields reject empty or whitespace-only values.

`wine_images` remains the catalog of source image metadata used by crawler and downloader flows. `recognition_assets` stores recognition-specific assets, such as processing inputs, prepared copies, label crops, logo crops, user samples, and test samples. A recognition asset may reference a `wine_images` row, but the source image and recognition asset must belong to the same wine. Migration `009` adds only a supporting unique index on `wine_images (id, wine_id)` for that composite foreign key; it does not change `wine_images` columns or data. Deleting a source image only clears `recognition_assets.wine_image_id`; it does not delete the recognition asset or change `recognition_assets.wine_id`.

Parent and child recognition assets must also belong to the same wine, and annotations with an `asset_id` must match the asset wine. Direct self-parent links are rejected by the schema. Multi-asset cycles, such as A pointing to B while B points back to A, are left to future processing/application logic; recursive cycle enforcement is intentionally outside this schema-only PR. Derived recognition metadata is rebuildable and may be regenerated when source data, processing logic, or datasets change.

New recognition tables:

| Table | Purpose |
| --- | --- |
| `recognition_assets` | Recognition-specific image or crop assets tied to a wine, optionally linked to a source `wine_images` row or parent asset. |
| `recognition_profiles` | Versioned recognition profiles for a wine, with profile content in `profile_data`. |
| `recognition_aliases` | Candidate wine aliases and labels, allowing nullable `normalized_value` until normalization rules exist. |
| `recognition_annotations` | Manual or generated markup for an asset, with boxes, polygons, text, labels, and review data in `annotation_data`. |
| `ocr_observations` | OCR engine observations for an asset, with raw engine output, text, regions, and tokens in `observation_data`. |
| `visual_features` | Visual extractor output for an asset, with descriptors, colors, contours, tokens, or future vectors in `feature_data`. |
| `asset_processing_jobs` | Durable processing job state for recognition assets, with input and output details in JSONB. |

The schema intentionally does not use PostgreSQL ENUMs, `pgvector`, vector columns, JSON GIN indexes, workers, queues, processing commands, or hardcoded assumptions about any specific catalog source.

## HTTP Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | public | API and database health |
| `POST` | `/api/v1/auth/token` | public | Account login; returns a role-bearing JWT |
| `GET` | `/api/v1/auth/me` | JWT | Current username, role and annotation actor type |
| `GET` | `/api/v1/catalog` | public | Unified read-only catalog; `source=all|svoe_vino|roskachestvo` |
| `GET` | `/api/v1/wines` | public | List wines with pagination, search, and filters |
| `GET` | `/api/v1/wines/{wine_id}` | public | Full wine card by ID |
| `GET` | `/api/v1/wines/by-barcode/{barcode}` | public | Full wine card by barcode |
| `POST` | `/api/v1/wines` | bearer | Create a wine card |
| `PATCH` | `/api/v1/wines/{wine_id}` | bearer | Partially update a wine card |
| `DELETE` | `/api/v1/wines/{wine_id}` | bearer | Delete a wine card |

Public GET endpoints do not require a token. Mutations require `Authorization: Bearer <token>`.

## Curl Examples

Login:

```bash
curl -X POST http://localhost:8000/api/v1/auth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'username=admin&password=your-password'
```

List wines:

```bash
curl 'http://localhost:8000/api/v1/wines?limit=20&offset=0&query=merlot'
```

Get detail:

```bash
curl http://localhost:8000/api/v1/wines/1
```

Create with bearer token:

```bash
curl -X POST http://localhost:8000/api/v1/wines \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"slug":"manual-wine","title":"Manual Wine","source":"manual"}'
```

## PATCH Semantics

- Omitted scalar fields remain unchanged.
- Explicit nullable scalar fields set to `null` are cleared.
- Omitted relation lists (`grapes`, `dishes`, `barcodes`) remain unchanged.
- Empty relation lists replace existing relations with no values.
- Non-empty relation lists replace existing relations with the submitted values.

## Source Metadata

`source` and `external_id` identify the origin of a catalog row. Existing crawler rows are backfilled as:

```text
source = vino-svoe
external_id = slug
```

Manually created API rows default to:

```text
source = manual
```

The `(source, external_id)` pair is unique when both values are present.

The provider-neutral catalog response deliberately emits `source="svoe_vino"` for local wine rows even though migration `008` backfilled the stored source value as `vino-svoe`. Browser/recognition identity is `recognitionKey` (`svoe_vino:<external_id>` or `roskachestvo:<rskrf_product_id>`), not a local integer id.

## Database Profile Caveat

Python SQL uses unqualified `wines` and `wine_images`. Fresh Docker migrations normally create those tables in `public`. The repository-level dataset restore workflow instead sets `search_path=svoe_vino,public`, where those names resolve to restored `svoe_vino` tables. Recognize Service explicitly queries `svoe_vino.wines`, so a fresh Python-only Docker database is not currently a complete bootstrap for the three-service stack.

## Scanner Contract

The Python service has no scan endpoint. A browser-side scanner prototype exists in `vinedetect_web`, but its search index is mock-backed and its Next.js `/api/scan` handler returns an empty `finalResults` array. Production upload persistence, server-side scoring and final catalog-card resolution are planned.

## CLI

Show help:

```bash
python -m app.main --help
```

Crawler and stats commands remain available:

```bash
python -m app.main index
python -m app.main details
python -m app.main all
python -m app.main stats
python -m app.main stats --top-limit 15
python -m app.main collect-images
python -m app.main collect-images --reset
python -m app.main download-images --kind bottle --limit 20
python -m app.main image-stats
python -m app.main extract-rating-snapshots
python -m app.main rating-snapshot-stats
python -m app.main import-roskachestvo-products --limit 20
python -m app.main import-roskachestvo-product-details --limit 20
python -m app.main collect-roskachestvo-product-image-urls --limit 20
python -m app.main download-roskachestvo-product-images --limit 20 --storage-root storage
python -m app.main roskachestvo-product-stats
python -m app.main roskachestvo-product-audit --storage-root storage
python -m app.main release-snapshot
python -m app.main match-roskachestvo --limit 100 --top-k 5 --min-score 0.55 --reset
python -m app.main roskachestvo-match-stats
python -m app.main apply-barcode-matches --dry-run
python -m app.main apply-barcode-matches
python -m app.main barcode-stats
```

## Development Checks

```powershell
.\vinedetect_api\.venv\Scripts\python.exe -m pytest -q vinedetect_api/tests
```

From `vinedetect_api` itself, the remaining checks are:

```bash
ruff check .
docker compose config
git diff --check
python -m app.main --help
```

The source-inspection tests use monorepo-root-relative paths, so the full suite should be launched from the monorepo root. The 2026-08-07 audit result was `221 passed, 11 skipped`.
