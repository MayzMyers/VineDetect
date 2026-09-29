#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/compose.yaml"
ASSET_ROOT="$REPO_ROOT/asset-store"

archive_path=""
assume_yes=false
keep_staging=false
start_stack=false
stage_dir=""

usage() {
  cat <<'EOF'
Usage: ./scripts/restore_dataset.sh [archive.tar.gz] --yes [--start] [--keep-staging]

Restores the PostgreSQL dump and image files from a Vinedetect dataset archive
into the root Docker Compose stack. If archive.tar.gz is omitted, the newest
.basedata/vinedetect_dataset_*.tar.gz archive is selected.

Options:
  --yes           Confirm destructive database recreation.
  --start         Build and start the full stack after restore.
  --keep-staging  Keep extracted archive files under .basedata for inspection.
  -h, --help      Show this help.
EOF
}

while (($# > 0)); do
  case "$1" in
    --yes)
      assume_yes=true
      ;;
    --start)
      start_stack=true
      ;;
    --keep-staging)
      keep_staging=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -* )
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$archive_path" ]]; then
        echo "Only one dataset archive may be specified." >&2
        exit 2
      fi
      archive_path="$1"
      ;;
  esac
  shift
done

for command_name in docker tar sha256sum realpath; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is missing: $command_name" >&2
    exit 1
  fi
done

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  echo "Root .env is missing. Copy .env.example to .env and review its values." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required (docker compose)." >&2
  exit 1
fi

if [[ -z "$archive_path" ]]; then
  archive_path="$({
    find "$REPO_ROOT/.basedata" -maxdepth 1 -type f \
      -name 'vinedetect_dataset_*.tar.gz' -printf '%T@ %p\n' 2>/dev/null || true
  } | sort -nr | head -n 1 | cut -d' ' -f2-)"
fi

if [[ -z "$archive_path" || ! -f "$archive_path" ]]; then
  echo "Dataset archive not found: ${archive_path:-<none>}" >&2
  exit 1
fi

archive_path="$(realpath "$archive_path")"

if [[ "$assume_yes" != true ]]; then
  echo "This will stop application containers and recreate the Compose database."
  echo "Archive: $archive_path"
  echo "Re-run with --yes to continue."
  exit 2
fi

if tar -tzf "$archive_path" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Archive contains an unsafe absolute or parent-relative path." >&2
  exit 1
fi

checksum_path="$archive_path.sha256"
if [[ -f "$checksum_path" ]]; then
  expected_checksum="$(awk 'NR == 1 { print $1 }' "$checksum_path")"
  actual_checksum="$(sha256sum "$archive_path" | awk '{ print $1 }')"
  if [[ -z "$expected_checksum" || "$expected_checksum" != "$actual_checksum" ]]; then
    echo "Dataset archive checksum mismatch." >&2
    exit 1
  fi
  echo "Archive checksum verified."
fi

mkdir -p "$REPO_ROOT/.basedata"
stage_dir="$(mktemp -d "$REPO_ROOT/.basedata/.restore.XXXXXX")"

cleanup() {
  if [[ "$keep_staging" == true || -z "$stage_dir" ]]; then
    return
  fi
  case "$stage_dir" in
    "$REPO_ROOT/.basedata/.restore."*) rm -rf -- "$stage_dir" ;;
    *) echo "Refusing to remove unexpected staging path: $stage_dir" >&2 ;;
  esac
}
trap cleanup EXIT

echo "Extracting dataset into $stage_dir"
tar -xzf "$archive_path" -C "$stage_dir"

dump_path="$(find "$stage_dir/db" -maxdepth 1 -type f -name '*.dump' -print -quit 2>/dev/null || true)"
if [[ -z "$dump_path" ]]; then
  echo "PostgreSQL custom dump not found under db/*.dump." >&2
  exit 1
fi

compose() {
  docker compose --project-directory "$REPO_ROOT" -f "$COMPOSE_FILE" "$@"
}

echo "Starting PostgreSQL container..."
compose up -d postgres

echo "Waiting for PostgreSQL..."
for _ in {1..30}; do
  if compose exec -T postgres pg_isready >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! compose exec -T postgres pg_isready >/dev/null 2>&1; then
  echo "PostgreSQL did not become ready." >&2
  exit 1
fi

db_user="$(compose exec -T postgres sh -c 'printf %s "$POSTGRES_USER"' | tr -d '\r')"
db_name="$(compose exec -T postgres sh -c 'printf %s "$POSTGRES_DB"' | tr -d '\r')"
if [[ ! "$db_user" =~ ^[A-Za-z_][A-Za-z0-9_]*$ || ! "$db_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "Unsafe PostgreSQL user or database identifier from container environment." >&2
  exit 1
fi

echo "Stopping application containers..."
compose stop api recognize web >/dev/null 2>&1 || true

echo "Recreating database $db_name..."
compose exec -T postgres dropdb --if-exists --force -U "$db_user" "$db_name"
compose exec -T postgres createdb -U "$db_user" -O "$db_user" "$db_name"

echo "Restoring $dump_path..."
compose exec -T postgres pg_restore \
  --exit-on-error \
  --no-owner \
  --no-privileges \
  -U "$db_user" \
  -d "$db_name" < "$dump_path"

compose exec -T postgres psql \
  -v ON_ERROR_STOP=1 \
  -U "$db_user" \
  -d postgres \
  -c "ALTER DATABASE \"$db_name\" SET search_path TO svoe_vino, public;"

compose exec -T postgres psql \
  -v ON_ERROR_STOP=1 \
  -U "$db_user" \
  -d "$db_name" \
  -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());"

for migration_path in "$REPO_ROOT"/vinedetect_api/migrations/[0-9][0-9][0-9]_*.sql; do
  migration_version="$(basename "$migration_path" .sql)"
  compose exec -T postgres psql \
    -v ON_ERROR_STOP=1 \
    -U "$db_user" \
    -d "$db_name" \
    -c "INSERT INTO public.schema_migrations (version) VALUES ('$migration_version') ON CONFLICT (version) DO NOTHING;" \
    >/dev/null
done

copy_asset_tree() {
  local source_path="$1"
  local destination_path="$2"
  if [[ ! -d "$source_path" ]]; then
    return
  fi
  mkdir -p "$destination_path"
  cp -a "$source_path/." "$destination_path/"
  echo "Assets restored: ${source_path#$stage_dir/} -> ${destination_path#$REPO_ROOT/}"
}

echo "Restoring assets without deleting existing local files..."
mkdir -p "$ASSET_ROOT/label-analysis"
copy_asset_tree "$stage_dir/files/svoe_vino" "$ASSET_ROOT/svoe-vino"
copy_asset_tree "$stage_dir/files/svoe-vino" "$ASSET_ROOT/svoe-vino"
copy_asset_tree "$stage_dir/files/storage/roskachestvo" "$ASSET_ROOT/roskachestvo"
copy_asset_tree "$stage_dir/files/roskachestvo" "$ASSET_ROOT/roskachestvo"
copy_asset_tree "$stage_dir/files/label-analysis" "$ASSET_ROOT/label-analysis"

echo "Applying Recognize Service migrations..."
compose run --rm dataset-check
compose build recognize-migrate
compose run --rm --no-deps recognize-migrate

echo "Dataset counts:"
compose exec -T postgres psql -U "$db_user" -d "$db_name" -tA -c \
  "SELECT 'svoe_vino.wines=' || COUNT(*) FROM svoe_vino.wines;"
compose exec -T postgres psql -U "$db_user" -d "$db_name" -tA -c \
  "SELECT 'svoe_vino.wine_images=' || COUNT(*) FROM svoe_vino.wine_images;"
compose exec -T postgres psql -U "$db_user" -d "$db_name" -tA -c \
  "SELECT 'roskachestvo.products=' || COUNT(*) FROM roskachestvo.products;"

missing_manifest="$stage_dir/manifest/missing_images.tsv"
if [[ -f "$missing_manifest" ]]; then
  echo "archive_missing_images=$(wc -l < "$missing_manifest" | tr -d ' ')"
fi

if [[ "$start_stack" == true ]]; then
  echo "Building and starting the full stack..."
  compose up -d --build
fi

echo "Restore complete."
echo "Start command: docker compose up -d --build"
echo "Admin: ${WEB_ORIGIN:-http://127.0.0.1:3000}/admin"
if [[ "$keep_staging" == true ]]; then
  echo "Extracted files kept at: $stage_dir"
fi
