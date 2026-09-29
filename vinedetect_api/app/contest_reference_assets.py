"""Content-addressed official assets and transactional selected-reference import."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import tempfile
from collections import Counter
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.contest_media import inspect_file, json_bytes
from app.contest_reference_plan import (
    DETERMINISTIC_METHODS,
    INCONSISTENT_SLUG,
    MANUAL_METHODS,
    RELATED_SLUG,
    digest,
    index_unique,
    relative_name,
)

FORMATS = {
    "image/webp": ("WEBP", ".webp"),
    "image/png": ("PNG", ".png"),
    "image/jpeg": ("JPEG", ".jpg"),
    "image/gif": ("GIF", ".gif"),
    "image/tiff": ("TIFF", ".tiff"),
    "image/bmp": ("BMP", ".bmp"),
    "image/avif": ("AVIF", ".avif"),
}
COLUMNS = (
    "catalog_item_id",
    "original_filename",
    "local_path",
    "sha256",
    "width",
    "height",
    "byte_size",
    "mime_type",
    "resolution_method",
    "provenance",
    "review_note",
)
MIGRATION_COLUMNS = {"resolution_method", "provenance", "review_note"}


def validate_plan(plan, *, expected_items=2103, expected_contents=2074):
    if plan.get("schema_version") != "contest-reference-plan/1":
        raise ValueError("Unsupported reference plan schema")
    rows = sorted(plan["assignments"], key=lambda row: row["official_slug"])
    index_unique(rows, "catalog_item_id", "Plan")
    index_unique(rows, "official_slug", "Plan")
    if len(rows) != expected_items:
        raise ValueError(f"Plan requires exactly {expected_items} assignments")
    version = plan["import_run"]["version"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", version):
        raise ValueError("Unsafe import version")
    hashes = {}
    for row in rows:
        if type(row["catalog_item_id"]) is not int or row["catalog_item_id"] <= 0:
            raise ValueError("Invalid catalog item ID")
        if (
            not isinstance(row["official_slug"], str)
            or not row["official_slug"].strip()
        ):
            raise ValueError("Blank official slug")
        relative_name(row["relative_path"])
        if Path(row["relative_path"]).name != row["source_filename"]:
            raise ValueError("Source filename does not match relative path")
        if not isinstance(row["photo_name"], str):
            raise ValueError("Invalid official photo name")
        if row["resolution_method"] not in DETERMINISTIC_METHODS | MANUAL_METHODS:
            raise ValueError("Invalid resolution provenance method")
        if row["review_note"] is not None and (
            not isinstance(row["review_note"], str) or not row["review_note"].strip()
        ):
            raise ValueError("Review note must be non-blank text or null")
        if row["mime_type"] not in FORMATS:
            raise ValueError(f"Unsupported actual image MIME: {row['mime_type']}")
        if not re.fullmatch(r"[0-9a-f]{64}", row["sha256"]):
            raise ValueError("Invalid SHA-256")
        if any(
            type(row[k]) is not int or row[k] <= 0 for k in ("width", "height", "bytes")
        ):
            raise ValueError("Invalid dimensions/byte size")
        identity = tuple(row[k] for k in ("width", "height", "bytes", "mime_type"))
        if row["sha256"] in hashes and hashes[row["sha256"]] != identity:
            raise ValueError("Identical SHA has conflicting plan metadata")
        hashes[row["sha256"]] = identity
    if len(hashes) != expected_contents:
        raise ValueError(f"Plan requires exactly {expected_contents} distinct contents")
    summary = plan["summary"]
    if (
        summary["catalog_items"] != expected_items
        or summary["selected_reference_assignments"] != expected_items
        or summary["unresolved"] != 0
        or summary["validation_failures"]
        or summary["unique_sha256_content"] != len(hashes)
    ):
        raise ValueError("Plan summary does not agree with validated assignments")
    by_slug = {row["official_slug"]: row for row in rows}
    if INCONSISTENT_SLUG in by_slug:
        row, related = by_slug[INCONSISTENT_SLUG], by_slug.get(RELATED_SLUG)
        if (
            related is None
            or related["sha256"] != row["sha256"]
            or related["photo_name"] != row["photo_name"]
            or row["resolution_method"] != "source_preserving_shared"
            or "organizer_photo_title_inconsistency" not in row["flags"]
            or not any(
                issue["official_slug"] == INCONSISTENT_SLUG
                for issue in plan["source_data_inconsistencies"]
            )
        ):
            raise ValueError("Known organizer source inconsistency was not preserved")
    return rows


def managed_path(version, row):
    extension = FORMATS[row["mime_type"]][1]
    sha = row["sha256"]
    return f"contest/{version}/sha256/{sha[:2]}/{sha}{extension}"


def safe_path(root, relative):
    relative_name(relative)
    path = root / relative
    if root not in path.resolve().parents:
        raise ValueError(f"Asset path escapes root: {relative}")
    for part in (path, *path.parents):
        if part == root:
            break
        if part.is_symlink():
            raise ValueError(f"Symlink asset path is not allowed: {relative}")
    return path


def validate_file(path, row):
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"Missing or non-regular asset: {path.name}")
    actual = inspect_file(path, path.name)
    if not actual["is_raster"] or actual["decode_status"] not in {
        "header_only",
        "oversized",
    }:
        raise ValueError(f"Asset is not header-readable: {path.name}")
    for source, target in (
        ("sha256", "sha256"),
        ("width", "width"),
        ("height", "height"),
        ("byte_size", "bytes"),
        ("mime_type", "mime_type"),
    ):
        if actual[source] != row[target]:
            raise ValueError(f"Asset {source} mismatch: {path.name}")
    if actual["format"] != FORMATS[row["mime_type"]][0]:
        raise ValueError(f"Asset actual format mismatch: {path.name}")


def materialize(
    plan, source_root, asset_root, *, expected_items=2103, expected_contents=2074
):
    rows = validate_plan(
        plan, expected_items=expected_items, expected_contents=expected_contents
    )
    source_root, asset_root = (
        Path(source_root).resolve(strict=True),
        Path(asset_root).resolve(),
    )
    if (
        source_root == asset_root
        or source_root in asset_root.parents
        or asset_root in source_root.parents
    ):
        raise ValueError("Source and application asset roots must be separate trees")
    # Validate every selected source before publishing any new content.
    sources, contents = {}, {}
    for row in rows:
        if row["relative_path"] not in sources:
            path = safe_path(source_root, row["relative_path"])
            validate_file(path, row)
            sources[row["relative_path"]] = path
        current = contents.get(row["sha256"])
        if current is None or row["relative_path"] < current["relative_path"]:
            contents[row["sha256"]] = row
    asset_root.mkdir(parents=True, exist_ok=True)
    created = reused = 0
    version = plan["import_run"]["version"]
    for _sha, row in sorted(contents.items()):
        local = managed_path(version, row)
        destination = safe_path(asset_root, local)
        if destination.exists():
            validate_file(destination, row)
            reused += 1
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            # Same-filesystem staging. Hard-link publication is atomic and refuses
            # to replace an existing destination, including a concurrent winner.
            with tempfile.NamedTemporaryFile(
                dir=destination.parent,
                prefix=".contest-",
                suffix=destination.suffix,
                delete=False,
            ) as stream:
                temporary = Path(stream.name)
                with sources[row["relative_path"]].open("rb") as source:
                    shutil.copyfileobj(source, stream, length=1024 * 1024)
                stream.flush()
                os.fsync(stream.fileno())
            validate_file(temporary, row)
            temporary.chmod(0o644)
            try:
                os.link(temporary, destination)
                created += 1
            except FileExistsError:
                validate_file(destination, row)
                reused += 1
            validate_file(destination, row)
            if hasattr(os, "O_DIRECTORY"):
                descriptor = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return {
        "plan_sha256": digest(plan),
        "assignments": len(rows),
        "distinct_sha256": len(contents),
        "materialized_files": created + reused,
        "created_files": created,
        "reused_files": reused,
        "layout": f"contest/{version}/sha256/<prefix>/<sha256>.<actual-extension>",
    }


def expected_records(plan, asset_root, *, expected_items=2103, expected_contents=2074):
    rows = validate_plan(
        plan, expected_items=expected_items, expected_contents=expected_contents
    )
    root, version = Path(asset_root).resolve(strict=True), plan["import_run"]["version"]
    validated, records = set(), []
    plan_sha = digest(plan)
    for row in rows:
        local = managed_path(version, row)
        if local not in validated:
            validate_file(safe_path(root, local), row)
            validated.add(local)
        provenance = {
            "schema_version": "contest-reference-evidence/1",
            "plan_sha256": plan_sha,
            "input_provenance": plan["provenance"],
            "official_slug": row["official_slug"],
            "photo_name": row["photo_name"],
            "source_relative_path": row["relative_path"],
            "review_confidence": row.get("review_confidence"),
            "manual_recommendation": row.get("manual_recommendation"),
            "flags": row.get("flags", []),
            "source_data_inconsistencies": [
                issue
                for issue in plan["source_data_inconsistencies"]
                if issue["official_slug"] == row["official_slug"]
            ],
        }
        records.append(
            {
                "catalog_item_id": row["catalog_item_id"],
                "original_filename": row["source_filename"],
                "local_path": local,
                "sha256": row["sha256"],
                "width": row["width"],
                "height": row["height"],
                "byte_size": row["bytes"],
                "mime_type": row["mime_type"],
                "resolution_method": row["resolution_method"],
                "provenance": provenance,
                "review_note": row["review_note"],
            }
        )
    return records


def write_references(
    connection,
    plan,
    asset_root,
    *,
    dry_run=False,
    expected_items=2103,
    expected_contents=2074,
):
    """Use one transaction/savepoint; compare every existing row before insertion."""
    records = expected_records(
        plan,
        asset_root,
        expected_items=expected_items,
        expected_contents=expected_contents,
    )
    with connection.transaction():
        if not dry_run:
            # Serialize writers, including writers that do not use this service.
            # SHARE also prevents catalog identity changes during validation.
            connection.execute("LOCK TABLE contest.catalog_items IN SHARE MODE")
            connection.execute(
                "LOCK TABLE contest.reference_assets IN SHARE ROW EXCLUSIVE MODE"
            )
        run = connection.execute(
            "SELECT id, version, source_sha256, status FROM contest.import_runs "
            "WHERE version = %s",
            (plan["import_run"]["version"],),
        ).fetchone()
        if (
            run is None
            or run["status"] != "completed"
            or any(
                run[key] != plan["import_run"][key]
                for key in ("id", "version", "source_sha256")
            )
        ):
            raise ValueError("Plan/import-run identity mismatch")
        items = connection.execute(
            "SELECT id, official_slug, photo_name FROM contest.catalog_items "
            "WHERE import_run_id = %s",
            (run["id"],),
        ).fetchall()
        actual = {row["id"]: (row["official_slug"], row["photo_name"]) for row in items}
        intended = {
            row["catalog_item_id"]: (row["official_slug"], row["photo_name"])
            for row in plan["assignments"]
        }
        if actual != intended:
            raise ValueError(
                "Plan/catalog correspondence mismatch: missing item, slug or photo"
            )
        columns = {
            row["column_name"]
            for row in connection.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'contest' AND table_name = 'reference_assets'"
            ).fetchall()
        }
        missing_columns = sorted(MIGRATION_COLUMNS - columns)
        if missing_columns and set(missing_columns) != MIGRATION_COLUMNS:
            raise ValueError("Partial provenance schema; inspect migration 014")
        if missing_columns and not dry_run:
            raise ValueError("Migration 014 is required before import")
        existing = connection.execute(
            "SELECT * FROM contest.reference_assets "
            "WHERE catalog_item_id = ANY(%s) ORDER BY id",
            (sorted(intended),),
        ).fetchall()
        by_item = index_unique(existing, "catalog_item_id", "Existing references")
        pending, reused = [], 0
        for record in records:
            old = by_item.get(record["catalog_item_id"])
            if old is None:
                pending.append(record)
            elif any(old.get(key) != record[key] for key in COLUMNS):
                raise ValueError(
                    f"Conflicting existing reference: {record['catalog_item_id']}"
                )
            else:
                reused += 1
        if not dry_run:
            with connection.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO contest.reference_assets ("
                    + ", ".join(COLUMNS)
                    + ") VALUES ("
                    + ", ".join(["%s"] * len(COLUMNS))
                    + ")",
                    [
                        tuple(
                            Jsonb(record[key]) if key == "provenance" else record[key]
                            for key in COLUMNS
                        )
                        for record in pending
                    ],
                )
        return {
            "dry_run": dry_run,
            "plan_sha256": digest(plan),
            "expected_rows": len(records),
            "distinct_sha256": len({r["sha256"] for r in records}),
            "intended_inserts": len(pending),
            "existing_identical_rows": reused,
            "inserted_rows": 0 if dry_run else len(pending),
            "required_migrations": ["014_contest_reference_provenance.sql"]
            if missing_columns
            else [],
            "ready_for_import": not missing_columns,
            "validated_catalog_items": len(items),
            "validated_asset_files": len({r["local_path"] for r in records}),
            "resolution_methods": dict(
                sorted(Counter(r["resolution_method"] for r in records).items())
            ),
        }


def import_database(database_url, plan, asset_root, *, dry_run=False):
    with psycopg.connect(
        database_url,
        row_factory=dict_row,
        options="-c default_transaction_read_only=on" if dry_run else "",
    ) as connection:
        connection.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        return write_references(connection, plan, asset_root, dry_run=dry_run)


def main(argv=None):
    import json

    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("materialize", "import"):
        command = commands.add_parser(name)
        command.add_argument("--plan-json", type=Path, required=True)
        command.add_argument("--asset-root", type=Path, required=True)
        command.add_argument("--report-json", type=Path)
        if name == "materialize":
            command.add_argument("--source-root", type=Path, required=True)
        else:
            mode = command.add_mutually_exclusive_group(required=True)
            mode.add_argument("--dry-run", action="store_true")
            mode.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    if args.report_json:
        report_path = args.report_json.resolve()
        roots = [args.asset_root.resolve()]
        if args.command == "materialize":
            roots.append(args.source_root.resolve())
        if (
            args.report_json.is_symlink()
            or report_path == args.plan_json.resolve()
            or any(report_path == root or root in report_path.parents for root in roots)
        ):
            parser.error("Report must not overwrite the plan or source/asset files")
    plan = json.loads(args.plan_json.read_text(encoding="utf-8-sig"))
    if args.command == "materialize":
        report = materialize(plan, args.source_root, args.asset_root)
    else:
        url = os.environ.get("DATABASE_URL")
        if not url:
            parser.error("DATABASE_URL is required")
        report = import_database(url, plan, args.asset_root, dry_run=args.dry_run)
    if args.report_json:
        args.report_json.parent.mkdir(parents=True, exist_ok=True)
        args.report_json.write_bytes(json_bytes(report))
    print(json_bytes(report).decode(), end="")


if __name__ == "__main__":
    main()
