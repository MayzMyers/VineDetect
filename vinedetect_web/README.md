# VineDetect Web

Status: partially implemented / uncommitted WIP

Last verified against code: 2026-08-08

Next.js 16 admin and browser-scanner frontend for the local VineDetect stack.

## Implemented

- Role-bearing JWT login against the Python API; the token is kept in browser `localStorage`.
- Unified catalog admin list from `GET /api/v1/catalog`.
- Recognition inventory, annotation queue and job journal through Next.js BFF routes; the UI gates them on a stored admin token.
- Item card sections: Label Annotation, Catalog, CV Lab, Saved Metadata, Text Metadata and Jobs.
- Manual label bbox review, browser OCR, direct backend OCR, generated OCR word overlays, reviewed OCR text/region/source-association revisions and generated/manual reviewed alias revisions.
- The Label Annotation section can run/re-run OpenCV against the exact reviewed ROI revision, inspect the persisted crop and existing mask/component/contour debug stages, restore the run's per-item config snapshot, and tune/re-run that item without changing a global preset.
- CV preview/sweep, shared server-side label ROI presets/revisions and proposal creation.
- Preset-backed label proposal batches for checked items, one source or the global inventory with estimate-then-run controls.
- Annotation queue cohort creation and immutable reviewed-layer dataset version freeze controls.
- Frozen dataset version export controls producing non-overwriting manifest/JSONL/splits artifacts.
- Training registry page for dataset-artifact-bound runs, explicit lifecycle updates, split metrics, model artifacts and validation-gated model promotion.
- Static asset streaming with path traversal checks. The BFF prefers the shared `asset-store` and falls back to the Python `storage/images` layout; both `svoe-vino` and dump-native `svoe_vino` directory names are accepted.
- Camera scanner prototype with frame quality/stability, multi-pass Tesseract OCR and Fuse.js matching.

## Partially Implemented

- The scanner sends an explicitly captured native-size frame or original uploaded photo to the Next.js recognition BFF, then displays the exact server-selected wine card. The separate legacy search-index and mock console remain available for development.
- `/api/scan` accepts the multipart request but only returns `finalResults: []`; uploads/results are not persisted.
- The preset registry and selection/source/global application controls have a working `label-roi` vertical slice. Reviewed OCR regions have storage/API/editor support, but OCR/source/alias generation presets and visual sample validation remain planned. Training metrics/model promotion UI exists as a registry for external runs; it does not execute training or deploy models into proposal/client inference.
- Reviewed-ROI OpenCV analysis supports one item or a checked-item batch. The UI saves immutable `accepted`, `needs-tuning` or `rejected` review revisions; the annotation queue exposes matching filters and readiness totals. A combined backend OCR/source matching/alias generation job remains planned. Contours are inspection overlays; correction uses item config and re-run, not vertex editing.
- Recognition BFF routes verify the HS256 JWT signature, expiry and the `admin | annotator | ml-service` role before using the internal Recognize key. The verified role also determines annotation provenance (`human` or `ml-agent`). The asset route remains unauthenticated for media delivery.
- Frontend verification includes workflow unit tests, reference API proxy/client contract tests, ESLint, TypeScript, and production build generation.

## Runtime Dependencies

- Python API: `NEXT_PUBLIC_API_BASE_URL`, default `http://127.0.0.1:8000`.
- Recognize Service: server-only `RECOGNIZE_SERVICE_URL`, default `http://127.0.0.1:4001`.
- Internal Recognize key: `RECOGNIZE_INTERNAL_API_KEY`, default `development-secret`.
- Assets: `NEXT_ADMIN_ASSET_ROOT` is the optional highest-priority root. Root Compose sets it to the shared `/data/assets` bind mount. Native zero-config fallbacks discover `asset-store` and `vinedetect_api/storage/images` whether Next starts from the package or repository directory.

The full local launcher at the monorepo root supplies the service URLs and key.

## Commands

```powershell
cmd /c npm install
cmd /c npm run dev -- --hostname 127.0.0.1 --port 3000
cmd /c npm run lint -- --format stylish
cmd /c npm run build
```

## Main Routes

```text
/admin
/admin/recognition
/admin/recognition/annotations
/admin/recognition/jobs
/admin/recognition/[source]/[sourceItemId]
/scan
```

Use the monorepo [README](../README.md) for dataset setup and the [documentation map](../docs/README.md) for architecture and workflow contracts.

## Recognition reference keywords

`loadRecognitionReferences()` in `lib/recognition/references.ts` reads
`GET /api/recognition/references` on the Next.js origin. The BFF forwards this to
FastAPI `GET /api/v1/recognition/references` and validates the `references/1`
contract: `{ schemaVersion: "references/1", items: [{ slug, keywords }] }`.
Saved keyword strings and their order are preserved; the client does not derive
aliases, run OCR, or substitute mock data when the API fails.

Set server-only `API_INTERNAL_URL` to the FastAPI base URL. Compose uses
`http://api:8000`; native development falls back to `NEXT_PUBLIC_API_BASE_URL`,
then `http://127.0.0.1:8000`. Browser requests always use the relative BFF path.

The active scanner does not use reference keywords to choose a wine. The
`references/1` client remains available for independent interface hints; its
output cannot replace the frozen runtime's selected slug.

Run the focused proxy/client contract checks with `npm run test:references`.

## Final scanner request path

The remote frontend design from `ef5009252dce691e8aca8151cc1e5172d4b53706`
is integrated with the local authoritative runtime. Recognition starts only
when the user captures a frame or chooses a photo. File uploads preserve the
original bytes. Camera capture encodes one full native-resolution video frame;
it performs no crop, resize, browser OCR, keyword matching, or image filtering.

`predictRecognitionImage()` sends only multipart `image` to existing
`POST /api/recognition/jobs`. The BFF returns `{ slug, product }` synchronously,
where `product.slug` is the exact official slug returned by the frozen runtime.
The client rejects mismatching card identities. Opening the scanner makes no
recognition request. Reset cancels the browser request and ignores stale results;
requests are not automatically retried. Missing runtime confidence is not shown
as a fabricated percentage.

The `/scan/console` mock flow and legacy search helpers are separate development
interfaces, not fallbacks for the active scanner. Use `npm run test:recognition`
for upload/BFF boundary tests, `npm run test:scanner` for the imported flow tests,
and `npm run test:references` for the reference API contract tests. These commands
use the installed TypeScript compiler and work with the Docker Node 20 runtime.
## Local frozen-Core demo

Keep the packaged C4 launcher unchanged. It validates the frozen assets and performs
its existing ten development warmups before becoming ready. No legacy recognition
worker is needed by the scanner.

From WSL at the repository root, start the already configured services:

```sh
sh .generated/final-release-v3-c4/start.sh
python3 .generated/frontend-final-integration/start-backend.py
cd vinedetect_web
API_INTERNAL_URL=http://127.0.0.1:18000 VINEDETECT_CORE_URL=http://127.0.0.1:8765 VINEDETECT_CORE_TIMEOUT_MS=60000 npm run start -- --hostname 0.0.0.0 --port 3000
```

Open `http://localhost:3000/scan` and choose a photo. Backend port 18000 avoids an
unrelated local service on port 8000. The backend launcher reuses the existing
PostgreSQL database and API image with the current source mounted read-only.
It does not apply migrations or reset data. Stop the foreground frontend with
Ctrl-C; stop the demo backend with `docker stop vinedetect-frontend-api-integration`
and Core with `sh .generated/final-release-v3-c4/stop.sh` from the repository root.

The server-only `VINEDETECT_CORE_TIMEOUT_MS` controls the Core fetch (default 60000);
`VINEDETECT_CORE_URL` points at its existing host listener. Compose uses
`http://host.docker.internal:8765`, while native Next uses localhost. These settings
only affect the application BFF. Official HARD10 remains **FAILED**.

The BFF uses `GET /api/v1/wines/by-official-slug/{slug}` to resolve the saved exact
organizer-to-local catalog binding. It does not use keyword search as a fallback.
A null Core result, unknown slug or unavailable upstream is shown as a failure.

The one C001 browser upload and unchanged-source SHA were verified in
`../.generated/frontend-final-integration/verification-summary.json`;
`smoke-card.png` records the rendered card. No evaluation dataset was run.
