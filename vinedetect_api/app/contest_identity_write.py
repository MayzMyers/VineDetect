"""Controlled Phase 3B2 allocation writer; CLI dry-run is read-only/repeatable-read."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.contest_identity_allocation import (
    PROTECTED_KEYS,
    WINE_FIELDS,
    build_allocation,
    check_aliases,
    grape_relations,
    new_wine_data,
    validate_final_plan,
)
from app.contest_identity_state import (
    TABLES,
    capture,
    digest,
    fingerprint,
    meta_tables,
    read_rows,
    sequence_state,
)
from app.contest_media import json_bytes

MIGRATION = "015_contest_materialized_identity.sql"


def validate_schema(plan, current):
    before, after = copy.deepcopy(plan["baseline"]["schema"]), copy.deepcopy(current)
    old_constraints = before.pop("link_constraints")
    new_constraints = after.pop("link_constraints")
    if before != after:
        raise ValueError("Stale schema: columns, indexes or triggers changed")
    old = {r["conname"]: r["definition"] for r in old_constraints}
    new = {r["conname"]: r["definition"] for r in new_constraints}
    original = old.pop("item_links_method_check")
    actual = new.pop("item_links_method_check")
    upgraded = (
        original
        if "'materialized_official'" in original
        else original.replace(
            "'new_official_item'::text",
            "'new_official_item'::text, 'materialized_official'::text",
        )
    )
    if old != new or actual not in (original, upgraded):
        raise ValueError("Stale or unsupported item_links constraint semantics")
    return [] if "'materialized_official'" in actual else [MIGRATION]


def provenance(plan, row, allocated_at, new_wine_hash=None):
    return {
        "schema_version": "contest-identity-allocation-evidence/1",
        "allocation_plan_sha256": plan["plan_sha256"],
        "input_hashes": plan["input_hashes"],
        "official_slug": row["official_slug"],
        "decision": row["decision"],
        "review_evidence": row["review_evidence"],
        "previous_link": row["previous_link"],
        "allocated_at": allocated_at,
        "materialized_wine_sha256": new_wine_hash,
        "preserved_identity": row["preserved_identity"],
        "grape_enrichment": row["grape_enrichment"],
        "image_authority": "contest.reference_assets",
    }


def validate_current(plan, state):
    rows = validate_final_plan(plan)
    baseline = plan["baseline"]
    migrations = validate_schema(plan, state["schema"])
    for key in PROTECTED_KEYS:
        if fingerprint(state[key]) != baseline[key]:
            raise ValueError(f"Stale protected state: {key}; regenerate the plan")
    if state["meta"] != baseline["meta"]:
        raise ValueError("Protected annotation/meta state changed; regenerate the plan")
    historical_ids = set(baseline["historical_wine_ids"])
    historical = [w for w in state["wines"] if w["id"] in historical_ids]
    if fingerprint(historical) != baseline["historical_wines"]:
        raise ValueError("Stale historical wines/annotation identities")
    old_relations = [
        r for r in state["wine_grape_relations"] if r["wine_id"] in historical_ids
    ]
    if fingerprint(old_relations) != baseline["historical_grape_relations"]:
        raise ValueError("Stale historical grape relations")
    item_ids = {r["catalog_item_id"] for r in rows}
    old_links = [r for r in state["item_links"] if r["catalog_item_id"] not in item_ids]
    if fingerprint(old_links) != baseline["exact_links"]:
        raise ValueError("Existing exact links changed")
    if len(state["item_links"]) != 2103:
        raise ValueError("Unexpected existing link coverage")
    wines = {w["id"]: w for w in state["wines"]}
    links = {r["catalog_item_id"]: r for r in state["item_links"]}
    officials = {r["id"]: r for r in state["catalog_items"]}
    pending, identical = [], []
    expected_relations = []
    for row in rows:
        official = officials[row["catalog_item_id"]]
        if row["official_slug"] != official["official_slug"]:
            raise ValueError("Allocation official slug changed")
        if row["decision"] == "true_new":
            if row["new_wine"] != new_wine_data(official):
                raise ValueError(
                    "Materialization is not the authoritative organizer row"
                )
            if row["grape_enrichment"] != grape_relations(
                official["grapes"], state["grapes"]
            ):
                raise ValueError("Grape mapping changed")
        current = links.get(row["catalog_item_id"])
        if current == row["previous_link"]:
            pending.append(row)
            if row["decision"] == "true_new" and row["wine_id"] in wines:
                raise ValueError("Conflicting pre-existing materialized wine")
            continue
        if current is None:
            raise ValueError("Missing existing item link")
        wine_hash = None
        if row["decision"] == "true_new":
            wine = wines.get(row["wine_id"])
            if wine is None or any(wine[k] != v for k, v in row["new_wine"].items()):
                raise ValueError("Conflicting existing materialized wine")
            wine_hash = digest(wine)
            expected_relations.extend(
                {"wine_id": row["wine_id"], "grape_id": r["grape_id"]}
                for r in row["grape_enrichment"]["relations"]
            )
        at = current.get("provenance", {}).get("allocated_at")
        if (
            not isinstance(at, str)
            or current["wine_id"] != row["wine_id"]
            or current["method"] != row["method"]
            or current["confidence"] is not None
            or current["created_at"] != row["previous_link"]["created_at"]
            or current["updated_at"] != at
            or current["provenance"] != provenance(plan, row, at, wine_hash)
        ):
            raise ValueError("Conflicting existing link; refusing to overwrite")
        identical.append(row)
    if pending and identical:
        raise ValueError(
            "Partial allocation state: require regeneration, not a partial replay"
        )
    expected_ids = historical_ids | {
        r["wine_id"] for r in identical if r["decision"] == "true_new"
    }
    if set(wines) != expected_ids:
        raise ValueError("Unexpected wines outside the frozen allocation")
    new_relations = [
        r for r in state["wine_grape_relations"] if r["wine_id"] not in historical_ids
    ]
    if fingerprint(new_relations) != fingerprint(expected_relations):
        raise ValueError("Conflicting new wine/grape relations")
    collision_report = check_aliases(historical, rows)
    seq = copy.deepcopy(baseline["sequence"])
    if identical:
        seq.update(
            last_value=max(r["wine_id"] for r in rows if r["decision"] == "true_new")
            + 1,
            is_called=False,
        )
    if state["sequence"] != seq:
        raise ValueError("Stale allocation-time sequence state; regenerate the plan")
    return pending, identical, migrations, collision_report


def lock_tables(connection):
    # READ COMMITTED apply: acquire locks before reading allocation state. All
    # relevant rows then remain stable, even for writers ignoring advisory locks.
    for table in sorted(set(TABLES.values())):
        connection.execute(
            sql.SQL("LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE").format(
                sql.Identifier(*table.split("."))
            )
        )
    for name in meta_tables(connection):
        connection.execute(
            sql.SQL("LOCK TABLE {} IN SHARE MODE").format(sql.Identifier("meta", name))
        )


def write_allocations(connection, plan, *, dry_run=False):
    """One transaction/savepoint; caller owns connection isolation and commit."""
    validate_final_plan(plan)
    with connection.transaction():
        if not dry_run:
            lock_tables(connection)
        before = capture(connection)
        pending, identical, migrations, collisions = validate_current(plan, before)
        new_rows = [r for r in pending if r["decision"] == "true_new"]
        reslugs = [r for r in pending if r["decision"] == "re_slug"]
        relation_count = sum(len(r["grape_enrichment"]["relations"]) for r in new_rows)
        if migrations and not dry_run:
            raise ValueError(f"Migration {MIGRATION} is required before --apply")
        if pending and not dry_run:
            # No sequence state changes before every preflight/collision check.
            # A no-op ALTER obtains the sequence lock, including against naked
            # nextval/setval callers; re-check after waiting for that lock.
            connection.execute("ALTER SEQUENCE svoe_vino.wines_id_seq NO CYCLE")
            if sequence_state(connection) != before["sequence"]:
                raise ValueError("Sequence changed while acquiring allocation lock")
            # RESTART is transactional; avoid non-transactional nextval/setval.
            # https://www.postgresql.org/docs/16/sql-altersequence.html
            connection.execute(
                sql.SQL("ALTER SEQUENCE svoe_vino.wines_id_seq RESTART WITH {}").format(
                    sql.Literal(max(r["wine_id"] for r in new_rows) + 1)
                )
            )
            insert = sql.SQL("INSERT INTO svoe_vino.wines ({}) VALUES ({})").format(
                sql.SQL(", ").join(map(sql.Identifier, ("id", *WINE_FIELDS))),
                sql.SQL(", ").join(
                    sql.Placeholder() for _ in range(1 + len(WINE_FIELDS))
                ),
            )
            with connection.cursor() as cursor:
                cursor.executemany(
                    insert,
                    [
                        (
                            r["wine_id"],
                            *(
                                Jsonb(r["new_wine"][k])
                                if k == "raw_detail_json"
                                else r["new_wine"][k]
                                for k in WINE_FIELDS
                            ),
                        )
                        for r in new_rows
                    ],
                )
                relations = [
                    (r["wine_id"], g["grape_id"])
                    for r in new_rows
                    for g in r["grape_enrichment"]["relations"]
                ]
                if relations:
                    cursor.executemany(
                        "INSERT INTO svoe_vino.wine_grapes (wine_id,grape_id) "
                        "VALUES (%s,%s)",
                        relations,
                    )
            created = {w["id"]: w for w in read_rows(connection, "svoe_vino.wines")}
            at = connection.execute(
                "SELECT to_jsonb(transaction_timestamp()) AS value"
            ).fetchone()["value"]
            for row in pending:
                wine_hash = (
                    digest(created[row["wine_id"]])
                    if row["decision"] == "true_new"
                    else None
                )
                evidence = provenance(plan, row, at, wine_hash)
                updated = connection.execute(
                    "UPDATE contest.item_links SET wine_id=%s, method=%s, "
                    "confidence=NULL, "
                    "provenance=%s, updated_at=%s::timestamptz "
                    "WHERE catalog_item_id=%s AND method='unmatched' "
                    "AND wine_id IS NULL",
                    (
                        row["wine_id"],
                        row["method"],
                        Jsonb(evidence),
                        at,
                        row["catalog_item_id"],
                    ),
                ).rowcount
                if updated != 1:
                    raise ValueError(
                        "Conflicting existing link changed during allocation"
                    )
            after = capture(connection)
            remaining, replayed, required, _ = validate_current(plan, after)
            if remaining or required or len(replayed) != 264:
                raise ValueError("Final allocation did not reach exact replay state")
            if (
                len(after["wines"]) != 2114
                or sum(r["wine_id"] is not None for r in after["item_links"]) != 2103
            ):
                raise ValueError("Final coverage/count invariant failed")
        else:
            after = capture(connection)
            if before != after:
                raise ValueError(
                    "Read-only/replay inspection unexpectedly changed state"
                )
        return {
            "schema_version": "contest-identity-write-report/1",
            "dry_run": dry_run,
            "validation_passed": True,
            "plan_sha256": plan["plan_sha256"],
            "input_hashes": plan["input_hashes"],
            "allocation": plan["summary"],
            "required_migrations": migrations,
            "ready_for_apply": not migrations,
            "collision_checks": collisions,
            "pending_wine_inserts": len(new_rows),
            "pending_re_slug_links": len(reslugs),
            "pending_materialized_links": len(new_rows),
            "pending_grape_relations": relation_count,
            "grape_dictionary_inserts": 0,
            "unresolved_optional_grape_tokens": sum(
                len(r["grape_enrichment"]["unresolved"])
                for r in plan["allocations"]
                if r["decision"] == "true_new"
            ),
            "already_identical_allocations": len(identical),
            "inserted_wines": 0 if dry_run else len(new_rows),
            "updated_links": 0 if dry_run else len(pending),
            "inserted_grape_relations": 0 if dry_run else relation_count,
            "wine_images_writes": 0,
            "meta_writes": 0,
            "existing_exact_links_unchanged": True,
            "historical_wines_and_annotation_identities_unchanged": True,
            "meta_before": before["meta"],
            "meta_after": after["meta"],
            "sequence_before": before["sequence"],
            "sequence_after": after["sequence"],
            "protected_fingerprints": {
                k: fingerprint(after[k]) for k in PROTECTED_KEYS
            },
        }


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_immutable(path, value):
    content = json_bytes(value)
    if path.exists():
        if path.read_bytes() != content:
            raise ValueError(
                f"Immutable artifact differs; use a new output directory: {path}"
            )
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation never replaces a concurrently published allocation.
        with path.open("xb") as stream:
            stream.write(content)


def publish_plan(directory, plan):
    directory.mkdir(parents=True, exist_ok=True)
    save_immutable(directory / "final-allocation-plan.json", plan)
    save_immutable(
        directory / "proposed-new-wines.json",
        [
            {
                "catalog_item_id": r["catalog_item_id"],
                "official_slug": r["official_slug"],
                "allocated_wine_id": r["wine_id"],
                "values": r["new_wine"],
                "grape_enrichment": r["grape_enrichment"],
            }
            for r in plan["allocations"]
            if r["decision"] == "true_new"
        ],
    )
    save_immutable(
        directory / "proposed-link-updates.json",
        [
            {
                k: r[k]
                for k in (
                    "catalog_item_id",
                    "official_slug",
                    "wine_id",
                    "method",
                    "confidence",
                    "preserved_identity",
                    "review_evidence",
                )
            }
            for r in plan["allocations"]
        ],
    )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--final-plan-json", type=Path)
    parser.add_argument("--expected-plan-sha256")
    parser.add_argument("--identity-plan-json", type=Path)
    parser.add_argument("--decisions-json", type=Path)
    parser.add_argument("--snapshot-json", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    inputs = [args.identity_plan_json, args.decisions_json, args.snapshot_json]
    if args.apply and (not args.final_plan_json or not args.expected_plan_sha256):
        parser.error("--apply requires --final-plan-json and --expected-plan-sha256")
    if args.final_plan_json and any(inputs):
        parser.error("Use either an immutable final plan or the three merge inputs")
    if not args.final_plan_json and not all(inputs):
        parser.error(
            "Building a final plan requires identity, decisions and snapshot JSON"
        )
    outputs = [
        args.output_dir / name
        for name in (
            "final-allocation-plan.json",
            "dry-run.json",
            "apply.json",
            "proposed-new-wines.json",
            "proposed-link-updates.json",
            "validation.json",
        )
    ]
    for source in [p for p in [*inputs, args.final_plan_json] if p]:
        for target in outputs:
            if source.resolve() == target.resolve() and not (
                source == args.final_plan_json
                and target.name == "final-allocation-plan.json"
            ):
                parser.error("Output must not replace input artifacts")
    if any(p.is_symlink() for p in outputs):
        parser.error("Output artifacts must not be symlinks")
    url = os.environ.get("DATABASE_URL")
    if not url:
        parser.error("DATABASE_URL is required")
    plan = read_json(args.final_plan_json) if args.final_plan_json else None
    if plan:
        validate_final_plan(plan)
        if (
            args.expected_plan_sha256
            and args.expected_plan_sha256 != plan["plan_sha256"]
        ):
            parser.error("Reviewed allocation plan hash does not match")
    with psycopg.connect(
        url,
        row_factory=dict_row,
        autocommit=True,
        options="-c default_transaction_read_only=on" if args.dry_run else "",
    ) as connection:
        with connection.transaction():
            connection.execute(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
                if args.dry_run
                else "SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE"
            )
            connection.execute("SET LOCAL TIME ZONE 'UTC'")
            connection.execute("SET LOCAL lock_timeout = '15s'")
            if plan is None:
                plan = build_allocation(
                    read_json(args.identity_plan_json),
                    read_json(args.decisions_json),
                    read_json(args.snapshot_json),
                    capture(connection),
                    {
                        name: file_hash(path)
                        for name, path in zip(
                            (
                                "identity_plan_sha256",
                                "human_decisions_sha256",
                                "frozen_snapshot_sha256",
                            ),
                            inputs,
                            strict=True,
                        )
                    },
                )
                # Freeze before issuing the read-only preflight; never auto-rebase
                # a saved plan to newer live state on the next invocation.
                save_immutable(args.output_dir / "final-allocation-plan.json", plan)
            # Detect immutable-output conflicts before any database mutations.
            publish_plan(args.output_dir, plan)
            report = write_allocations(connection, plan, dry_run=args.dry_run)
            report["transaction_read_only"] = (
                connection.execute(
                    "SELECT current_setting('transaction_read_only') AS value"
                ).fetchone()["value"]
                == "on"
            )
            report["transaction_isolation"] = connection.execute(
                "SELECT current_setting('transaction_isolation') AS value"
            ).fetchone()["value"]
            filename = "dry-run.json" if args.dry_run else "apply.json"
            (args.output_dir / filename).write_bytes(json_bytes(report))
            (args.output_dir / "validation.json").write_bytes(
                json_bytes(
                    {
                        "validation_passed": True,
                        "plan_sha256": plan["plan_sha256"],
                        "input_hashes": plan["input_hashes"],
                        "counts": plan["summary"],
                        "collision_checks": report["collision_checks"],
                        "required_migrations": report["required_migrations"],
                        "meta_unchanged": report["meta_before"] == report["meta_after"],
                        "existing_exact_links_unchanged": True,
                        "live_apply_performed": args.apply,
                        "dry_run_transaction_read_only": report[
                            "transaction_read_only"
                        ],
                    }
                )
            )
    print(
        json_bytes(
            {
                k: v
                for k, v in report.items()
                if k not in ("meta_before", "meta_after", "protected_fingerprints")
            }
        ).decode(),
        end="",
    )
    return report


if __name__ == "__main__":
    main()
