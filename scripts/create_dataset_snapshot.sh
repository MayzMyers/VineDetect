#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_ROOT/backups}"
DB_NAME="${DB_NAME:-wines}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
SNAPSHOT_NAME="${SNAPSHOT_NAME:-vinedetect_dataset_$(date +%Y%m%d_%H%M%S)}"

# Colon-separated roots where DB-relative image paths may exist.
# Examples:
# - data/images/bottle/... usually lives under a project root
# - roskachestvo/products/... usually lives under a storage root
IMAGE_ROOTS="${IMAGE_ROOTS:-$PROJECT_ROOT/asset-store:$PROJECT_ROOT/vinedetect_web/.asset-store:$PROJECT_ROOT:$PROJECT_ROOT/storage:$PROJECT_ROOT/storage/images:$PROJECT_ROOT/vinedetect_api:$PROJECT_ROOT/vinedetect_api/storage:$PROJECT_ROOT/vinedetect_api/storage/images:$HOME/projects/wine_crawler:$HOME/projects/wine_crawler/storage:$HOME/projects/wine_crawler/storage/images}"

STAGE_DIR="$BACKUP_DIR/.stage_$SNAPSHOT_NAME"
ARCHIVE_PATH="$BACKUP_DIR/$SNAPSHOT_NAME.tar.gz"
SHA_PATH="$ARCHIVE_PATH.sha256"

mkdir -p "$BACKUP_DIR"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/db" "$STAGE_DIR/manifest" "$STAGE_DIR/files"

echo "Creating dataset snapshot: $SNAPSHOT_NAME"
echo "Project root: $PROJECT_ROOT"
echo "Backup dir: $BACKUP_DIR"
echo "DB: $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"
echo "Image roots:"
echo "$IMAGE_ROOTS" | tr ':' '\n' | sed 's/^/  - /'

echo
echo "Dumping database..."

PGPASSWORD="${PGPASSWORD:-postgres}" pg_dump \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --format=custom \
  --file="$STAGE_DIR/db/$DB_NAME.dump"

PGPASSWORD="${PGPASSWORD:-postgres}" pg_dump \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --format=plain \
  --file="$STAGE_DIR/db/$DB_NAME.sql"

echo
echo "Collecting release snapshot..."

if command -v python >/dev/null 2>&1; then
  python -m app.main release-snapshot > "$STAGE_DIR/manifest/release_snapshot.txt" || true
fi

echo
echo "Collecting expected image paths from DB..."

PGPASSWORD="${PGPASSWORD:-postgres}" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -At \
  -F $'\t' \
  -c "
SELECT 'svoe_vino' AS source, local_path
FROM svoe_vino.wine_images
WHERE local_path IS NOT NULL
  AND btrim(local_path) <> ''
UNION ALL
SELECT 'roskachestvo' AS source, image_local_path
FROM roskachestvo.products
WHERE image_local_path IS NOT NULL
  AND btrim(image_local_path) <> ''
ORDER BY source, local_path;
" > "$STAGE_DIR/manifest/expected_images.tsv"

: > "$STAGE_DIR/manifest/copied_images.tsv"
: > "$STAGE_DIR/manifest/missing_images.tsv"

expected_count="$(wc -l < "$STAGE_DIR/manifest/expected_images.tsv" | tr -d ' ')"
copied_count=0
missing_count=0

echo "Expected image paths: $expected_count"

while IFS=$'\t' read -r source rel_path; do
  [ -n "${rel_path:-}" ] || continue

  found=""
  IFS=':' read -ra roots <<< "$IMAGE_ROOTS"

  for root in "${roots[@]}"; do
    [ -n "$root" ] || continue

    # Direct DB-relative path under root.
    candidate="$root/$rel_path"
    if [ -f "$candidate" ]; then
      found="$candidate"
      break
    fi

    # Roskachestvo DB path is often relative to storage root.
    candidate="$root/storage/$rel_path"
    if [ -f "$candidate" ]; then
      found="$candidate"
      break
    fi

    if [[ "$rel_path" == svoe_vino/* ]]; then
      candidate="$root/svoe-vino/${rel_path#svoe_vino/}"
      if [ -f "$candidate" ]; then
        found="$candidate"
        break
      fi
    fi
  done

  if [ -n "$found" ]; then
    if [[ "$rel_path" == roskachestvo/* ]]; then
      dest="$STAGE_DIR/files/storage/$rel_path"
    else
      dest="$STAGE_DIR/files/$rel_path"
    fi

    mkdir -p "$(dirname "$dest")"
    cp -p "$found" "$dest"
    printf "%s\t%s\t%s\n" "$source" "$rel_path" "$found" >> "$STAGE_DIR/manifest/copied_images.tsv"
    copied_count=$((copied_count + 1))
  else
    printf "%s\t%s\n" "$source" "$rel_path" >> "$STAGE_DIR/manifest/missing_images.tsv"
    missing_count=$((missing_count + 1))
  fi
done < "$STAGE_DIR/manifest/expected_images.tsv"

echo "Copied images: $copied_count"
echo "Missing images: $missing_count"

cat > "$STAGE_DIR/README.md" <<EOF
# Vinedetect dataset snapshot

Snapshot name: $SNAPSHOT_NAME

## Contents

- db/$DB_NAME.dump - PostgreSQL custom dump
- db/$DB_NAME.sql - PostgreSQL plain SQL dump
- files/ - copied image files
- manifest/release_snapshot.txt - application release snapshot
- manifest/expected_images.tsv - DB image paths expected
- manifest/copied_images.tsv - copied files with source locations
- manifest/missing_images.tsv - DB image paths not found on disk

## Counts

Expected image paths: $expected_count
Copied images: $copied_count
Missing images: $missing_count

## Restore DB example

createdb -h localhost -U postgres wines_restored
pg_restore -h localhost -U postgres -d wines_restored db/$DB_NAME.dump

## Notes

If Missing images > 0, the archive is not a full image snapshot.
EOF

echo
echo "Creating archive..."

tar -C "$STAGE_DIR" -czf "$ARCHIVE_PATH" .

sha256sum "$ARCHIVE_PATH" > "$SHA_PATH"

echo
echo "Archive created:"
ls -lh "$ARCHIVE_PATH" "$SHA_PATH"

echo
echo "Archive SHA256:"
cat "$SHA_PATH"

echo
echo "Final image counts:"
echo "  expected: $expected_count"
echo "  copied:   $copied_count"
echo "  missing:  $missing_count"

if [ "$missing_count" -gt 0 ]; then
  echo
  echo "WARNING: Some image files are missing. See:"
  echo "  $STAGE_DIR/manifest/missing_images.tsv"
  echo
  echo "The archive was created, but it is not a complete image snapshot."
fi
