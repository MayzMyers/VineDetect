"""Canonical downstream category/color overlays; never rewrite imported metadata.

Dry-run is read-only, including before migration 016. Apply requires its plan hash,
installs the additive migration if absent, and inserts only exact reviewed records.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.contest_identity_state import capture, digest, read_rows
from app.contest_media import json_bytes

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "data/contest_metadata_overrides/lct-rshb-2026-09-15.json"
MIGRATION = ROOT / "migrations/016_contest_metadata_overrides.sql"
FIELDS = {"category", "color"}
ENTRY_FIELDS = {
    "catalog_item_id",
    "official_slug",
    "wine_id",
    "expected_catalog",
    "expected_wine",
    "replacement",
    "provenance",
}


def validate_manifest(manifest):
    if (
        set(manifest) != {"schema_version", "contest_version", "entries"}
        or manifest["schema_version"] != "contest-metadata-overrides/1"
        or not isinstance(manifest["contest_version"], str)
        or not manifest["contest_version"].strip()
        or not isinstance(manifest["entries"], list)
    ):
        raise ValueError("Invalid metadata override manifest")
    seen, wines = set(), set()
    for entry in manifest["entries"]:
        if set(entry) != ENTRY_FIELDS:
            raise ValueError("Invalid metadata override fields")
        for key, used in (("catalog_item_id", seen), ("wine_id", wines)):
            value = entry[key]
            if type(value) is not int or value <= 0 or value in used:
                raise ValueError("Duplicate or invalid override identity")
            used.add(value)
        if not isinstance(entry["official_slug"], str) or not entry["official_slug"]:
            raise ValueError("Invalid official slug")
        for key, keys in (
            ("expected_catalog", {"title", "winery", "grapes", *FIELDS}),
            ("expected_wine", {"slug", "category_name", "color"}),
            ("replacement", FIELDS),
            ("provenance", {"reason", "verification", "reviewer_note"}),
        ):
            value = entry[key]
            if (
                not isinstance(value, dict)
                or set(value) != keys
                or not all(isinstance(v, str) and v.strip() for v in value.values())
            ):
                raise ValueError(f"Invalid {key}")
        if entry["provenance"]["reason"] != "upstream_source_inconsistency" or (
            entry["provenance"]["verification"] != "human_verified_against_producer"
        ):
            raise ValueError("Missing reviewed provenance")
        if entry["replacement"] == {k: entry["expected_catalog"][k] for k in FIELDS}:
            raise ValueError("Override must correct source values")
    return sorted(manifest["entries"], key=lambda e: e["catalog_item_id"])


def load_manifest(path=DEFAULT_MANIFEST):
    manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    validate_manifest(manifest)
    return manifest


def protected_state(db):
    return {
        **capture(db),
        "raw_catalog_rows": read_rows(db, "contest_raw.catalog_rows"),
        "import_runs": read_rows(db, "contest.import_runs"),
    }


def has_layer(db):
    return db.execute(
        "SELECT to_regclass('contest.metadata_overrides') IS NOT NULL AS present"
    ).fetchone()["present"]


def records(manifest):
    return [
        {
            **entry,
            "contest_version": manifest["contest_version"],
            "manifest_sha256": digest(manifest),
        }
        for entry in validate_manifest(manifest)
    ]


def write_overrides(
    db, manifest, *, dry_run, expected_plan_sha256=None, expected_count=2103
):
    wanted = records(manifest)
    with db.transaction():
        if not dry_run:
            # Serialize bootstrap/writers and preserve the reviewed source state.
            db.execute(
                "SELECT pg_advisory_xact_lock(hashtext('contest-metadata-overrides'))"
            )
            db.execute(
                "LOCK TABLE contest.catalog_items,contest.item_links,"
                "contest.import_runs,"
                "svoe_vino.wines IN SHARE MODE"
            )
            if has_layer(db):
                db.execute(
                    "LOCK TABLE contest.metadata_overrides IN SHARE ROW EXCLUSIVE MODE"
                )
        before = protected_state(db)
        catalog = {r["id"]: r for r in before["catalog_items"]}
        wines = {r["id"]: r for r in before["wines"]}
        links = {r["catalog_item_id"]: r for r in before["item_links"]}
        runs = {r["id"]: r for r in before["import_runs"]}
        counts = {
            k: len(before[k])
            for k in ("catalog_items", "reference_assets", "item_links")
        }
        counts["resolved_links"] = sum(r["wine_id"] in wines for r in links.values())
        if set(counts.values()) != {expected_count}:
            raise ValueError(f"Unexpected contest coverage: {counts}")
        installed = has_layer(db)
        existing = read_rows(db, "contest.metadata_overrides") if installed else []
        by_id = {r["catalog_item_id"]: r for r in existing}
        pending, diffs = [], []
        for record in wanted:
            key, wine_id = record["catalog_item_id"], record["wine_id"]
            c, w, link = catalog.get(key), wines.get(wine_id), links.get(key)
            if not c or not w or not link:
                raise ValueError("Missing reviewed identity")
            run = runs[c["import_run_id"]]
            if (
                c["official_slug"] != record["official_slug"]
                or link["wine_id"] != wine_id
                or run["version"] != record["contest_version"]
                or run["status"] != "completed"
                or any(c[k] != v for k, v in record["expected_catalog"].items())
                or any(w[k] != v for k, v in record["expected_wine"].items())
                or any(
                    r["wine_id"] == wine_id and r["catalog_item_id"] != key
                    for r in links.values()
                )
            ):
                raise ValueError(
                    "Reviewed source/identity changed or wine has another catalog link"
                )
            if key in by_id:
                if by_id[key] != record:
                    raise ValueError("Conflicting applied metadata override")
            else:
                if any(r["wine_id"] == wine_id for r in existing):
                    raise ValueError("Conflicting override wine identity")
                pending.append(record)
            diffs.append(
                {
                    "catalog_item_id": key,
                    "wine_id": wine_id,
                    "raw": {k: c[k] for k in sorted(FIELDS)},
                    "corrected": record["replacement"],
                    "state": ("would_insert" if dry_run else "inserted")
                    if key not in by_id
                    else "already_applied",
                }
            )
        # Stable across replay: source tables and canonical decision never change.
        plan_hash = digest(
            {
                "manifest": manifest,
                "protected_state_sha256": digest(before),
                "migration_sha256": digest(MIGRATION.read_text(encoding="utf-8")),
            }
        )
        if not dry_run and expected_plan_sha256 != plan_hash:
            raise ValueError("Apply requires the matching clean dry-run plan SHA-256")
        if not dry_run:
            if not installed:
                db.execute(MIGRATION.read_text(encoding="utf-8"))
            for record in pending:
                db.execute(
                    "INSERT INTO contest.metadata_overrides "
                    "(catalog_item_id,contest_version,official_slug,wine_id,expected_catalog,"
                    "expected_wine,replacement,provenance,manifest_sha256) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    tuple(
                        Jsonb(record[k]) if isinstance(record[k], dict) else record[k]
                        for k in (
                            "catalog_item_id",
                            "contest_version",
                            "official_slug",
                            "wine_id",
                            "expected_catalog",
                            "expected_wine",
                            "replacement",
                            "provenance",
                            "manifest_sha256",
                        )
                    ),
                )
            after_overrides = read_rows(db, "contest.metadata_overrides")
            if sorted(after_overrides, key=lambda r: r["catalog_item_id"]) != sorted(
                existing + pending, key=lambda r: r["catalog_item_id"]
            ):
                raise ValueError("Unexpected override changes")
            active = {
                r["catalog_item_id"]: r
                for r in read_rows(db, "contest.active_metadata_overrides")
            }
            if any(active.get(r["catalog_item_id"]) != r for r in wanted):
                raise ValueError("Correction not active in downstream views")
        if protected_state(db) != before:
            raise ValueError("Source, identity, references or historical data changed")
        return {
            "schema_version": "contest-metadata-override-report/1",
            "plan_sha256": plan_hash,
            "manifest_sha256": digest(manifest),
            "dry_run": dry_run,
            "would_insert": len(pending) if dry_run else 0,
            "inserted": len(pending) if not dry_run else 0,
            "already_applied": len(wanted) - len(pending),
            "changed_catalog_item_ids": [r["catalog_item_id"] for r in pending],
            "changed_fields": sorted(FIELDS) if pending else [],
            "diffs": diffs,
            "counts": counts,
            "raw_and_historical_state_unchanged": True,
        }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--expected-plan-sha256")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.apply and not args.expected_plan_sha256:
        parser.error("Apply requires --expected-plan-sha256 from a clean dry-run")
    if args.report.exists() or args.report.resolve() == args.manifest.resolve():
        parser.error("Report must be a new artifact, never an input or previous report")
    manifest = load_manifest(args.manifest)
    with psycopg.connect(
        os.environ["DATABASE_URL"],
        row_factory=dict_row,
        options="-c default_transaction_read_only=on" if args.dry_run else "",
    ) as db:
        db.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        report = write_overrides(
            db,
            manifest,
            dry_run=args.dry_run,
            expected_plan_sha256=args.expected_plan_sha256,
        )
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_bytes(json_bytes(report))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
