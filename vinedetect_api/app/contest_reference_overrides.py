"""Human-confirmed, replayable overrides for contest official reference assets."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.contest_media import json_bytes
from app.contest_reference_assets import FORMATS, safe_path, validate_file
from app.contest_reference_plan import digest, index_unique, relative_name

SCHEMA = "contest-reference-overrides/1"
PROJECT_DATA_ROOT = (
    Path(__file__).resolve().parents[1]
    / "data"
    / "contest_reference_overrides"
)
DEFAULT_MANIFEST = PROJECT_DATA_ROOT / "lct-rshb-2026-09-15.json"
STATUSES = {
    "pending_review",
    "confirmed_bad",
    "replacement_confirmed",
    "false_positive",
    "unresolved",
}
EXPECTED_FIELDS = {
    "reference_asset_id",
    "path",
    "sha256",
    "width",
    "height",
    "provenance",
}
REPLACEMENT_FIELDS = {
    "source_authority",
    "source_path",
    "sha256",
    "width",
    "height",
    "byte_size",
    "mime_type",
}
WINE_METADATA_FIELDS = {
    "wine_id",
    "expected",
    "replacement",
    "reviewer_note",
}
WINE_METADATA_EXPECTED_FIELDS = {
    "slug",
    "title",
    "manufacturer_name",
    "category_name",
    "source",
    "external_id",
}
WINE_METADATA_REPLACEMENT_FIELDS = {"title"}
WINE_METADATA_COLUMNS = (
    "id",
    "slug",
    "title",
    "manufacturer_name",
    "category_name",
    "source",
    "external_id",
)
WRITE_COLUMNS = (
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


def validate_manifest(manifest):
    if manifest.get("schema_version") != SCHEMA:
        raise ValueError("Unsupported override manifest schema")
    version = manifest.get("contest_version")
    if not isinstance(version, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]*", version):
        raise ValueError("Invalid contest version")
    approval_sha = manifest.get("approval_manifest_sha256")
    if approval_sha is not None and not re.fullmatch(r"[0-9a-f]{64}", approval_sha):
        raise ValueError("Invalid approval manifest SHA-256")
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise ValueError("Override entries must be a list")
    index_unique(entries, "catalog_item_id", "Overrides")
    index_unique(entries, "official_slug", "Overrides")
    metadata_wine_ids = set()
    for entry in entries:
        if type(entry["catalog_item_id"]) is not int or entry["catalog_item_id"] <= 0:
            raise ValueError("Invalid override catalog_item_id")
        if not isinstance(entry["official_slug"], str) or not entry["official_slug"]:
            raise ValueError("Invalid override official_slug")
        wine_id = entry.get("wine_id")
        if wine_id is not None and (type(wine_id) is not int or wine_id <= 0):
            raise ValueError("Invalid override wine_id")
        if entry.get("status") not in STATUSES:
            raise ValueError(f"Invalid override status: {entry.get('status')}")
        expected = entry.get("expected_current")
        if not isinstance(expected, dict) or not EXPECTED_FIELDS <= set(expected):
            raise ValueError("Override requires complete expected_current")
        relative_name(expected["path"])
        if not expected["path"].startswith("contest/"):
            raise ValueError("Expected reference must use the contest asset namespace")
        if (
            type(expected["reference_asset_id"]) is not int
            or expected["reference_asset_id"] <= 0
            or not re.fullmatch(r"[0-9a-f]{64}", expected["sha256"])
            or any(
                type(expected[field]) is not int or expected[field] <= 0
                for field in ("width", "height")
            )
            or not isinstance(expected["provenance"], dict)
        ):
            raise ValueError("Invalid expected_current metadata")
        replacement = entry.get("replacement")
        if entry["status"] == "replacement_confirmed":
            if not isinstance(replacement, dict) or not REPLACEMENT_FIELDS <= set(
                replacement
            ):
                raise ValueError(
                    "Confirmed replacement requires explicit source metadata"
                )
            relative_name(replacement["source_path"])
            if (
                not isinstance(replacement["source_authority"], str)
                or not replacement["source_authority"].strip()
                or not re.fullmatch(r"[0-9a-f]{64}", replacement["sha256"])
                or replacement["mime_type"] not in FORMATS
                or any(
                    type(replacement[field]) is not int or replacement[field] <= 0
                    for field in ("width", "height", "byte_size")
                )
            ):
                raise ValueError("Invalid confirmed replacement metadata")
        elif replacement is not None:
            raise ValueError(
                "Only replacement_confirmed may contain replacement metadata"
            )
        metadata = entry.get("wine_metadata")
        if metadata is not None:
            if entry["status"] != "replacement_confirmed":
                raise ValueError(
                    "Only replacement_confirmed may contain wine_metadata"
                )
            if not isinstance(metadata, dict) or set(metadata) != WINE_METADATA_FIELDS:
                raise ValueError("Invalid wine_metadata fields")
            wine_id = metadata["wine_id"]
            expected_metadata = metadata["expected"]
            replacement_metadata = metadata["replacement"]
            if type(wine_id) is not int or wine_id <= 0 or wine_id in metadata_wine_ids:
                raise ValueError("Duplicate or invalid wine_metadata wine_id")
            if entry.get("wine_id") is not None and entry["wine_id"] != wine_id:
                raise ValueError("wine_metadata wine_id differs from override wine_id")
            if (
                not isinstance(expected_metadata, dict)
                or set(expected_metadata) != WINE_METADATA_EXPECTED_FIELDS
                or not all(
                    value is None or isinstance(value, str)
                    for value in expected_metadata.values()
                )
                or not isinstance(expected_metadata["slug"], str)
                or not expected_metadata["slug"]
                or not isinstance(expected_metadata["title"], str)
                or not expected_metadata["title"]
            ):
                raise ValueError("Invalid expected wine_metadata")
            if (
                not isinstance(replacement_metadata, dict)
                or set(replacement_metadata) != WINE_METADATA_REPLACEMENT_FIELDS
                or not isinstance(replacement_metadata["title"], str)
                or not replacement_metadata["title"].strip()
                or not isinstance(metadata["reviewer_note"], str)
                or not metadata["reviewer_note"].strip()
            ):
                raise ValueError("Invalid replacement wine_metadata")
            metadata_wine_ids.add(wine_id)
    return sorted(entries, key=lambda row: row["catalog_item_id"])


def load_manifest(path=DEFAULT_MANIFEST):
    path = Path(path)
    try:
        manifest = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"Override manifest not found: {path}") from exc
    validate_manifest(manifest)
    return manifest


def confirmed_entries(manifest):
    return [
        entry
        for entry in validate_manifest(manifest)
        if entry["status"] == "replacement_confirmed"
    ]


def override_version(manifest):
    return f"{manifest['contest_version']}-reference-overrides-v1"


def managed_path(manifest, replacement):
    extension = FORMATS[replacement["mime_type"]][1]
    sha = replacement["sha256"]
    return f"contest/{override_version(manifest)}/sha256/{sha[:2]}/{sha}{extension}"


def _file_row(replacement):
    return {
        "sha256": replacement["sha256"],
        "width": replacement["width"],
        "height": replacement["height"],
        "bytes": replacement["byte_size"],
        "mime_type": replacement["mime_type"],
    }


def validate_sources(manifest, source_root):
    root = Path(source_root).resolve(strict=True)
    validated = {}
    for entry in confirmed_entries(manifest):
        replacement = entry["replacement"]
        path = safe_path(root, replacement["source_path"])
        validate_file(path, _file_row(replacement))
        validated[entry["catalog_item_id"]] = path
    return validated


def materialize(manifest, source_root, asset_root):
    sources = validate_sources(manifest, source_root)
    asset_root = Path(asset_root).resolve()
    source_root = Path(source_root).resolve(strict=True)
    if (
        source_root == asset_root
        or source_root in asset_root.parents
        or asset_root in source_root.parents
    ):
        raise ValueError("Source and application asset roots must be separate trees")
    asset_root.mkdir(parents=True, exist_ok=True)
    created = reused = 0
    published = {}
    for entry in confirmed_entries(manifest):
        replacement = entry["replacement"]
        local = managed_path(manifest, replacement)
        destination = safe_path(asset_root, local)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            validate_file(destination, _file_row(replacement))
            reused += 1
            published[entry["catalog_item_id"]] = local
            continue
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=destination.parent,
                prefix=".contest-override-",
                suffix=destination.suffix,
                delete=False,
            ) as stream:
                temporary = Path(stream.name)
                with sources[entry["catalog_item_id"]].open("rb") as source:
                    shutil.copyfileobj(source, stream, length=1024 * 1024)
                stream.flush()
                os.fsync(stream.fileno())
            validate_file(temporary, _file_row(replacement))
            temporary.chmod(0o644)
            try:
                os.link(temporary, destination)
                created += 1
            except FileExistsError:
                validate_file(destination, _file_row(replacement))
                reused += 1
            validate_file(destination, _file_row(replacement))
            published[entry["catalog_item_id"]] = local
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return {
        "manifest_sha256": digest(manifest),
        "confirmed_replacements": len(sources),
        "created_files": created,
        "reused_files": reused,
        "published_paths": published,
    }


def replacement_record(manifest, entry):
    replacement = entry["replacement"]
    reviewer_note = (
        replacement.get("reviewer_note")
        or entry.get("reason")
        or "Human-confirmed official reference replacement"
    )
    provenance = {
        "schema_version": "contest-reference-override-evidence/1",
        "override_manifest_sha256": manifest.get(
            "approval_manifest_sha256", digest(manifest)
        ),
        "contest_version": manifest["contest_version"],
        "catalog_item_id": entry["catalog_item_id"],
        "official_slug": entry["official_slug"],
        "source_authority": replacement["source_authority"],
        "source_relative_path": replacement["source_path"],
        "source_asset": {
            "original_filename": Path(replacement["source_path"]).name,
            "sha256": replacement["sha256"],
            "mime_type": replacement["mime_type"],
            "width": replacement["width"],
            "height": replacement["height"],
            "byte_size": replacement["byte_size"],
            "reviewer_note": reviewer_note,
        },
        "replaced_reference": entry["expected_current"],
    }
    return {
        "original_filename": Path(replacement["source_path"]).name,
        "local_path": managed_path(manifest, replacement),
        "sha256": replacement["sha256"],
        "width": replacement["width"],
        "height": replacement["height"],
        "byte_size": replacement["byte_size"],
        "mime_type": replacement["mime_type"],
        "resolution_method": "confirmed_visual",
        "provenance": provenance,
        "review_note": reviewer_note,
    }


def _expected_matches(row, expected):
    return (
        row["id"] == expected["reference_asset_id"]
        and row["local_path"] == expected["path"]
        and row["sha256"] == expected["sha256"]
        and row["width"] == expected["width"]
        and row["height"] == expected["height"]
        and row["provenance"] == expected["provenance"]
    )


def _replacement_matches(row, record):
    return all(row[column] == record[column] for column in WRITE_COLUMNS)


def integrity_counts(connection):
    return {
        "contest.catalog_items": connection.execute(
            "SELECT count(*) AS n FROM contest.catalog_items"
        ).fetchone()["n"],
        "contest.item_links": connection.execute(
            "SELECT count(*) AS n FROM contest.item_links"
        ).fetchone()["n"],
        "contest.item_links_resolved": connection.execute(
            "SELECT count(*) AS n FROM contest.item_links WHERE wine_id IS NOT NULL"
        ).fetchone()["n"],
        "contest.reference_assets": connection.execute(
            "SELECT count(*) AS n FROM contest.reference_assets"
        ).fetchone()["n"],
    }


def write_overrides(
    connection,
    manifest,
    asset_root,
    *,
    dry_run,
    expected_count=2103,
    expected_resolved_count=None,
):
    entries = confirmed_entries(manifest)
    metadata_entries = [entry for entry in entries if entry.get("wine_metadata")]
    records = {
        entry["catalog_item_id"]: replacement_record(manifest, entry)
        for entry in entries
    }
    root = Path(asset_root).resolve(strict=True)
    for entry in entries:
        replacement = entry["replacement"]
        validate_file(
            safe_path(root, managed_path(manifest, replacement)),
            _file_row(replacement),
        )
    with connection.transaction():
        if not dry_run:
            connection.execute("LOCK TABLE contest.catalog_items IN SHARE MODE")
            connection.execute("LOCK TABLE contest.item_links IN SHARE MODE")
            connection.execute(
                "LOCK TABLE contest.reference_assets IN SHARE ROW EXCLUSIVE MODE"
            )
            if metadata_entries:
                connection.execute(
                    "LOCK TABLE svoe_vino.wines IN ROW EXCLUSIVE MODE"
                )
        before_counts = integrity_counts(connection)
        if expected_resolved_count is None:
            expected_resolved_count = expected_count
        expected_counts = {
            "contest.catalog_items": expected_count,
            "contest.item_links": expected_count,
            "contest.item_links_resolved": expected_resolved_count,
            "contest.reference_assets": expected_count,
        }
        if before_counts != expected_counts:
            raise ValueError(f"Unexpected contest integrity counts: {before_counts}")
        ids = [entry["catalog_item_id"] for entry in entries]
        catalog = (
            connection.execute(
                "SELECT id,official_slug FROM contest.catalog_items "
                "WHERE id=ANY(%s) ORDER BY id",
                (ids,),
            ).fetchall()
            if ids
            else []
        )
        catalog_by_id = {row["id"]: row for row in catalog}
        identity_entries = [entry for entry in entries if entry.get("wine_id")]
        identity_catalog_ids = [entry["catalog_item_id"] for entry in identity_entries]
        identity_links = (
            connection.execute(
                "SELECT catalog_item_id,wine_id FROM contest.item_links "
                "WHERE catalog_item_id=ANY(%s) ORDER BY catalog_item_id",
                (identity_catalog_ids,),
            ).fetchall()
            if identity_entries
            else []
        )
        if len(identity_links) != len(identity_entries):
            raise ValueError("Override target link is missing")
        identity_links_by_catalog_id = {
            row["catalog_item_id"]: row for row in identity_links
        }
        references = (
            connection.execute(
                "SELECT * FROM contest.reference_assets "
                "WHERE catalog_item_id=ANY(%s) ORDER BY catalog_item_id",
                (ids,),
            ).fetchall()
            if ids
            else []
        )
        references_by_id = {row["catalog_item_id"]: row for row in references}
        if len(catalog) != len(entries) or len(references) != len(entries):
            raise ValueError("Override target is missing from catalog/reference assets")
        all_before = connection.execute(
            "SELECT catalog_item_id,id,local_path,sha256,width,height,provenance "
            "FROM contest.reference_assets ORDER BY catalog_item_id"
        ).fetchall()

        metadata_catalog_ids = [
            entry["catalog_item_id"] for entry in metadata_entries
        ]
        metadata_wine_ids = [
            entry["wine_metadata"]["wine_id"] for entry in metadata_entries
        ]
        metadata_links = (
            connection.execute(
                "SELECT catalog_item_id,wine_id FROM contest.item_links "
                "WHERE catalog_item_id=ANY(%s) ORDER BY catalog_item_id",
                (metadata_catalog_ids,),
            ).fetchall()
            if metadata_entries
            else []
        )
        wines = (
            connection.execute(
                "SELECT "
                + ",".join(WINE_METADATA_COLUMNS)
                + " FROM svoe_vino.wines WHERE id=ANY(%s) ORDER BY id",
                (metadata_wine_ids,),
            ).fetchall()
            if metadata_entries
            else []
        )
        if len(metadata_links) != len(metadata_entries) or len(wines) != len(
            metadata_entries
        ):
            raise ValueError("Metadata override target is missing")
        links_by_catalog_id = {
            row["catalog_item_id"]: row for row in metadata_links
        }
        wines_by_id = {row["id"]: row for row in wines}
        all_wines_before = (
            connection.execute(
                "SELECT "
                + ",".join(WINE_METADATA_COLUMNS)
                + " FROM svoe_vino.wines ORDER BY id"
            ).fetchall()
            if metadata_entries
            else []
        )

        pending, reused, diffs = [], 0, []
        for entry in entries:
            catalog_id = entry["catalog_item_id"]
            if catalog_by_id[catalog_id]["official_slug"] != entry["official_slug"]:
                raise ValueError(f"Override catalog identity mismatch: {catalog_id}")
            if entry.get("wine_id") is not None and (
                identity_links_by_catalog_id[catalog_id]["wine_id"]
                != entry["wine_id"]
            ):
                raise ValueError(f"Override wine identity mismatch: {catalog_id}")
            current = references_by_id[catalog_id]
            record = records[catalog_id]
            if _replacement_matches(current, record):
                reused += 1
                state = "already_applied"
            elif _expected_matches(current, entry["expected_current"]):
                pending.append((current, record))
                state = "would_update" if dry_run else "updated"
            else:
                raise ValueError(
                    f"Current reference differs from reviewed override: {catalog_id}"
                )
            diffs.append(
                {
                    "catalog_item_id": catalog_id,
                    "official_slug": entry["official_slug"],
                    "state": state,
                    "old": {
                        "reference_asset_id": current["id"],
                        "path": current["local_path"],
                        "sha256": current["sha256"],
                        "width": current["width"],
                        "height": current["height"],
                        "provenance": current["provenance"],
                    },
                    "new": {
                        "reference_asset_id": current["id"],
                        "path": record["local_path"],
                        "sha256": record["sha256"],
                        "width": record["width"],
                        "height": record["height"],
                        "provenance": record["provenance"],
                    },
                }
            )

        metadata_pending, metadata_reused, metadata_diffs = [], 0, []
        for entry in metadata_entries:
            catalog_id = entry["catalog_item_id"]
            metadata = entry["wine_metadata"]
            wine_id = metadata["wine_id"]
            if links_by_catalog_id[catalog_id]["wine_id"] != wine_id:
                raise ValueError(
                    f"Metadata override wine identity mismatch: {catalog_id}"
                )
            current = wines_by_id[wine_id]
            expected = metadata["expected"]
            changed = metadata["replacement"]
            stable_fields = WINE_METADATA_EXPECTED_FIELDS - {"title"}
            if any(current[field] != expected[field] for field in stable_fields):
                raise ValueError(
                    f"Current wine identity differs from metadata override: {wine_id}"
                )
            if current["title"] == changed["title"]:
                metadata_reused += 1
                state = "already_applied"
            elif current["title"] == expected["title"]:
                metadata_pending.append((current, metadata))
                state = "would_update" if dry_run else "updated"
            else:
                raise ValueError(
                    f"Current wine title differs from metadata override: {wine_id}"
                )
            metadata_diffs.append(
                {
                    "catalog_item_id": catalog_id,
                    "wine_id": wine_id,
                    "state": state,
                    "old": {
                        "slug": current["slug"],
                        "title": current["title"],
                    },
                    "new": {
                        "slug": current["slug"],
                        "title": changed["title"],
                    },
                    "reviewer_note": metadata["reviewer_note"],
                }
            )

        if not dry_run:
            for current, record in pending:
                updated = connection.execute(
                    "UPDATE contest.reference_assets SET "
                    + ", ".join(f"{column}=%s" for column in WRITE_COLUMNS)
                    + " WHERE id=%s AND catalog_item_id=%s",
                    (
                        *[
                            Jsonb(record[column])
                            if column == "provenance"
                            else record[column]
                            for column in WRITE_COLUMNS
                        ],
                        current["id"],
                        current["catalog_item_id"],
                    ),
                ).rowcount
                if updated != 1:
                    raise ValueError("Reference changed during override apply")
            for current, metadata in metadata_pending:
                updated = connection.execute(
                    "UPDATE svoe_vino.wines SET title=%s "
                    "WHERE id=%s AND slug=%s AND title=%s",
                    (
                        metadata["replacement"]["title"],
                        current["id"],
                        current["slug"],
                        metadata["expected"]["title"],
                    ),
                ).rowcount
                if updated != 1:
                    raise ValueError("Wine metadata changed during override apply")

        after_counts = integrity_counts(connection)
        if after_counts != before_counts:
            raise RuntimeError(
                "Contest integrity counts changed during reference override"
            )
        all_after = connection.execute(
            "SELECT catalog_item_id,id,local_path,sha256,width,height,provenance "
            "FROM contest.reference_assets ORDER BY catalog_item_id"
        ).fetchall()
        target_ids = set(ids)
        before_non_target = [
            row for row in all_before if row["catalog_item_id"] not in target_ids
        ]
        after_non_target = [
            row for row in all_after if row["catalog_item_id"] not in target_ids
        ]
        if before_non_target != after_non_target:
            raise RuntimeError("Non-target reference changed during override")

        if metadata_entries:
            all_wines_after = connection.execute(
                "SELECT "
                + ",".join(WINE_METADATA_COLUMNS)
                + " FROM svoe_vino.wines ORDER BY id"
            ).fetchall()
            target_wine_ids = set(metadata_wine_ids)
            if [
                row for row in all_wines_before if row["id"] not in target_wine_ids
            ] != [
                row for row in all_wines_after if row["id"] not in target_wine_ids
            ]:
                raise RuntimeError("Non-target wine metadata changed during override")
            before_by_id = {row["id"]: row for row in all_wines_before}
            after_by_id = {row["id"]: row for row in all_wines_after}
            for entry in metadata_entries:
                metadata = entry["wine_metadata"]
                wine_id = metadata["wine_id"]
                expected_after = dict(before_by_id[wine_id])
                if not dry_run:
                    expected_after["title"] = metadata["replacement"]["title"]
                if after_by_id[wine_id] != expected_after:
                    raise RuntimeError(
                        f"Unexpected target wine metadata change: {wine_id}"
                    )
        return {
            "dry_run": dry_run,
            "manifest_sha256": digest(manifest),
            "confirmed_replacements": len(entries),
            "would_update": len(pending) if dry_run else 0,
            "updated": 0 if dry_run else len(pending),
            "already_applied": reused,
            "changed_sha_catalog_item_ids": sorted(
                entry["catalog_item_id"]
                for entry in entries
                if entry["expected_current"]["sha256"]
                != entry["replacement"]["sha256"]
            ),
            "before_counts": before_counts,
            "after_counts": after_counts,
            "non_target_references_unchanged": True,
            "metadata_would_update": (
                len(metadata_pending) if dry_run else 0
            ),
            "metadata_updated": (
                0 if dry_run else len(metadata_pending)
            ),
            "metadata_already_applied": metadata_reused,
            "non_target_wines_unchanged": True,
            "metadata_diffs": metadata_diffs,
            "diffs": diffs,
        }


def run_database(database_url, manifest, asset_root, *, dry_run):
    with psycopg.connect(
        database_url,
        row_factory=dict_row,
        options="-c default_transaction_read_only=on" if dry_run else "",
    ) as connection:
        connection.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        return write_overrides(connection, manifest, asset_root, dry_run=dry_run)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    materialize_parser = commands.add_parser("materialize")
    materialize_parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    materialize_parser.add_argument("--source-root", type=Path)
    materialize_parser.add_argument("--asset-root", type=Path, required=True)
    materialize_parser.add_argument("--report", type=Path)
    for name in ("dry-run", "apply"):
        command = commands.add_parser(name)
        command.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
        command.add_argument("--asset-root", type=Path, required=True)
        command.add_argument("--report", type=Path)
        if name == "apply":
            command.add_argument("--apply", action="store_true", required=True)
    args = parser.parse_args(argv)
    manifest = load_manifest(args.manifest)
    if args.command == "materialize":
        source_root = args.source_root or args.manifest.parent
        result = materialize(manifest, source_root, args.asset_root)
    else:
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            parser.error("DATABASE_URL is required")
        result = run_database(
            database_url, manifest, args.asset_root, dry_run=args.command == "dry-run"
        )
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_bytes(json_bytes(result))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
