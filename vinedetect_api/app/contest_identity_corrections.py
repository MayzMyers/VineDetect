"""Reviewed identity correction using the existing official materialization rules.

Dry-run freezes a plan before apply; replay accepts only its exact resulting state.
No schema migration or reference/image writes are performed.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
from collections import Counter
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.contest_identity_allocation import (
    WINE_FIELDS,
    check_aliases,
    grape_relations,
    new_wine_data,
)
from app.contest_identity_state import capture, digest, fingerprint, sequence_state
from app.contest_identity_write import lock_tables, save_immutable
from app.contest_media import json_bytes

DEFAULT_MANIFEST = (
    Path(__file__).resolve().parents[1]
    / "data/contest_identity_corrections/lct-rshb-2026-09-15-603.json"
)
PLAN_SCHEMA = "contest-identity-correction-plan/1"


def load_manifest(path=DEFAULT_MANIFEST):
    decision = json.loads(Path(path).read_text(encoding="utf-8"))
    if decision.get("status") == "superseded_organizer_truth":
        raise ValueError("Correction superseded by organizer-truth rollback; replay disabled")
    if (
        decision["schema_version"] != "contest-identity-correction/1"
        or decision["status"] != "materialization_confirmed"
        or type(decision["catalog_item_id"]) is not int
        or decision["catalog_item_id"] == decision["control"]["catalog_item_id"]
        or not decision["reviewer_note"].strip()
        or decision["expected_link"]["method"] != "re_slug"
        or decision["control"]["method"] != "exact_slug"
        or decision["expected_link"]["wine_id"] != decision["control"]["wine_id"]
    ):
        raise ValueError("Invalid reviewed identity correction")
    return decision


def by_id(rows, key):
    result = {row[key]: row for row in rows}
    if len(result) != len(rows):
        raise ValueError(f"Duplicate {key}")
    return result


def check_identity(decision, state):
    catalog = by_id(state["catalog_items"], "id")
    links = by_id(state["item_links"], "catalog_item_id")
    target = catalog[decision["catalog_item_id"]]
    control = decision["control"]
    if (
        target["official_slug"] != decision["official_slug"]
        or any(target[k] != v for k, v in decision["expected_catalog"].items())
        or catalog[control["catalog_item_id"]]["official_slug"]
        != control["official_slug"]
        or any(
            links[control["catalog_item_id"]][k] != control[k]
            for k in ("wine_id", "method")
        )
    ):
        raise ValueError("Reviewed catalog/control identity changed")
    old_wine = by_id(state["wines"], "id")[control["wine_id"]]
    if (
        old_wine["slug"] != control["official_slug"]
        or old_wine["external_id"] != control["official_slug"]
        or old_wine["source"] != "vino-svoe"
    ):
        raise ValueError("Historical control wine identity changed")
    return target, links[decision["catalog_item_id"]]


def protected_state(state, catalog_id, wine_id):
    result = {}
    for key, value in state.items():
        if key == "sequence":
            continue
        if key == "item_links":
            value = [r for r in value if r["catalog_item_id"] != catalog_id]
        elif key == "wines":
            value = [r for r in value if r["id"] != wine_id]
        elif key in ("wine_grapes", "wine_grape_relations"):
            value = [r for r in value if r["wine_id"] != wine_id]
        result[key] = fingerprint(value) if isinstance(value, list) else value
    return result


def counts(state):
    return {
        **{
            key: len(state[key])
            for key in (
                "catalog_items",
                "reference_assets",
                "item_links",
                "wines",
                "wine_images",
            )
        },
        "resolved_links": sum(r["wine_id"] is not None for r in state["item_links"]),
        "link_methods": dict(
            sorted(Counter(r["method"] for r in state["item_links"]).items())
        ),
    }


def build_plan(decision, state):
    official, current = check_identity(decision, state)
    if any(current[k] != v for k, v in decision["expected_link"].items()):
        raise ValueError(
            "Expected previous link missing; use the saved plan for replay"
        )
    if counts(state) != {
        "catalog_items": 2103,
        "reference_assets": 2103,
        "item_links": 2103,
        "resolved_links": 2103,
        "wines": 2114,
        "wine_images": 1866,
        "link_methods": {
            "exact_slug": 1839,
            "re_slug": 16,
            "materialized_official": 248,
        },
    }:
        raise ValueError("Unexpected pre-correction coverage/counts")
    sequence = state["sequence"]
    wine_id = sequence["last_value"] + int(sequence["is_called"])
    if (
        wine_id <= max(w["id"] for w in state["wines"])
        or wine_id >= sequence["max_value"]
    ):
        raise ValueError("Unsafe next wine ID")
    new_wine = new_wine_data(official)
    collisions = check_aliases(
        state["wines"],
        [{"decision": "true_new", "wine_id": wine_id, "new_wine": new_wine}],
    )
    plan = {
        "schema_version": PLAN_SCHEMA,
        "decision": decision,
        "decision_sha256": digest(decision),
        "catalog_item_id": official["id"],
        "wine_id": wine_id,
        "new_wine": new_wine,
        "grape_enrichment": grape_relations(official["grapes"], state["grapes"]),
        "previous_link": current,
        "baseline": protected_state(state, official["id"], wine_id),
        "sequence_before": sequence,
        "counts_before": counts(state),
        "collision_checks": collisions,
    }
    plan["plan_sha256"] = digest(plan)
    return plan


def evidence(plan, at, wine):
    return {
        "schema_version": "contest-identity-correction-evidence/1",
        "correction_plan_sha256": plan["plan_sha256"],
        "decision_sha256": plan["decision_sha256"],
        "official_slug": plan["decision"]["official_slug"],
        "decision": "true_new",
        "review_evidence": plan["decision"],
        "previous_link": plan["previous_link"],
        "allocated_at": at,
        "materialized_wine_sha256": digest(wine),
        "grape_enrichment": plan["grape_enrichment"],
        "image_authority": "contest.reference_assets",
    }


def validate_current(plan, state):
    body = {k: v for k, v in plan.items() if k != "plan_sha256"}
    if (
        plan["schema_version"] != PLAN_SCHEMA
        or digest(body) != plan["plan_sha256"]
        or digest(plan["decision"]) != plan["decision_sha256"]
    ):
        raise ValueError("Correction plan checksum mismatch")
    official, current = check_identity(plan["decision"], state)
    wine_id = plan["wine_id"]
    if (
        plan["catalog_item_id"] != official["id"]
        or plan["new_wine"] != new_wine_data(official)
        or plan["grape_enrichment"]
        != grape_relations(official["grapes"], state["grapes"])
        or protected_state(state, official["id"], wine_id) != plan["baseline"]
    ):
        raise ValueError("Stale protected state or materialization mapping")
    wines = by_id(state["wines"], "id")
    historical = [w for w in state["wines"] if w["id"] != wine_id]
    check_aliases(
        historical,
        [{"decision": "true_new", "wine_id": wine_id, "new_wine": plan["new_wine"]}],
    )
    expected_sequence = copy.deepcopy(plan["sequence_before"])
    expected_counts = copy.deepcopy(plan["counts_before"])
    relations = [r for r in state["wine_grape_relations"] if r["wine_id"] == wine_id]
    pending = current == plan["previous_link"]
    if pending:
        if wine_id in wines or relations:
            raise ValueError("Conflicting pre-existing materialized wine")
    else:
        wine = wines.get(wine_id)
        if (
            wine is None
            or any(wine[k] != v for k, v in plan["new_wine"].items())
            or wine["alcohol"] is not None
        ):
            raise ValueError("Conflicting materialized wine")
        at = current.get("provenance", {}).get("allocated_at")
        expected_link = {
            **plan["previous_link"],
            "wine_id": wine_id,
            "method": "materialized_official",
            "confidence": None,
            "updated_at": at,
            "provenance": evidence(plan, at, wine),
        }
        if not isinstance(at, str) or current != expected_link:
            raise ValueError("Conflicting correction link")
        expected_relations = [
            {"wine_id": wine_id, "grape_id": r["grape_id"]}
            for r in plan["grape_enrichment"]["relations"]
        ]
        if fingerprint(relations) != fingerprint(expected_relations):
            raise ValueError("Conflicting materialized grape relations")
        expected_sequence.update(last_value=wine_id + 1, is_called=False)
        expected_counts["wines"] += 1
        expected_counts["link_methods"]["re_slug"] -= 1
        expected_counts["link_methods"]["materialized_official"] += 1
    if state["sequence"] != expected_sequence or counts(state) != expected_counts:
        raise ValueError("Stale sequence or correction counts")
    return pending


def write_correction(connection, plan, *, dry_run=False):
    with connection.transaction():
        if not dry_run:
            lock_tables(connection)
        before = capture(connection)
        pending = validate_current(plan, before)
        if pending and not dry_run:
            connection.execute("ALTER SEQUENCE svoe_vino.wines_id_seq NO CYCLE")
            if sequence_state(connection) != before["sequence"]:
                raise ValueError("Sequence changed while acquiring allocation lock")
            # Same transactional allocation pattern as contest_identity_write.
            connection.execute(
                sql.SQL("ALTER SEQUENCE svoe_vino.wines_id_seq RESTART WITH {}").format(
                    sql.Literal(plan["wine_id"] + 1)
                )
            )
            connection.execute(
                sql.SQL("INSERT INTO svoe_vino.wines ({}) VALUES ({})").format(
                    sql.SQL(",").join(map(sql.Identifier, ("id", *WINE_FIELDS))),
                    sql.SQL(",").join(
                        sql.Placeholder() for _ in range(1 + len(WINE_FIELDS))
                    ),
                ),
                (
                    plan["wine_id"],
                    *(
                        Jsonb(plan["new_wine"][k])
                        if k == "raw_detail_json"
                        else plan["new_wine"][k]
                        for k in WINE_FIELDS
                    ),
                ),
            )
            for relation in plan["grape_enrichment"]["relations"]:
                connection.execute(
                    "INSERT INTO svoe_vino.wine_grapes(wine_id,grape_id) "
                    "VALUES (%s,%s)",
                    (plan["wine_id"], relation["grape_id"]),
                )
            wine = connection.execute(
                "SELECT to_jsonb(w) AS value FROM svoe_vino.wines w WHERE id=%s",
                (plan["wine_id"],),
            ).fetchone()["value"]
            at = connection.execute(
                "SELECT to_jsonb(transaction_timestamp()) AS value"
            ).fetchone()["value"]
            updated = connection.execute(
                "UPDATE contest.item_links SET wine_id=%s,"
                "method='materialized_official',"
                "confidence=NULL,provenance=%s,updated_at=%s::timestamptz "
                "WHERE catalog_item_id=%s AND wine_id=%s AND method=%s",
                (
                    plan["wine_id"],
                    Jsonb(evidence(plan, at, wine)),
                    at,
                    plan["catalog_item_id"],
                    plan["previous_link"]["wine_id"],
                    plan["previous_link"]["method"],
                ),
            ).rowcount
            if updated != 1:
                raise ValueError("Reviewed link changed during correction")
            after = capture(connection)
            if validate_current(plan, after):
                raise ValueError("Correction did not reach exact replay state")
        else:
            after = capture(connection)
            if before != after:
                raise ValueError("Dry-run/replay changed state")
        links = by_id(after["item_links"], "catalog_item_id")
        return {
            "schema_version": "contest-identity-correction-report/1",
            "plan_sha256": plan["plan_sha256"],
            "dry_run": dry_run,
            "would_insert_wines": int(pending and dry_run),
            "would_update_links": int(pending and dry_run),
            "inserted_wines": int(pending and not dry_run),
            "updated_links": int(pending and not dry_run),
            "already_applied": not pending,
            "old_mapping": plan["previous_link"],
            "proposed_mapping": {
                "catalog_item_id": plan["catalog_item_id"],
                "wine_id": plan["wine_id"],
                "method": "materialized_official",
            },
            "new_wine": plan["new_wine"],
            "control": links[plan["decision"]["control"]["catalog_item_id"]],
            "before_counts": counts(before),
            "after_counts": counts(after),
            "protected_state_unchanged": True,
            "historical_images_unchanged": True,
            "reference_assets_unchanged": True,
            "sequence_before": before["sequence"],
            "sequence_after": after["sequence"],
        }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--expected-plan-sha256")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.apply and (not args.plan.exists() or not args.expected_plan_sha256):
        parser.error(
            "Apply requires an existing dry-run plan and --expected-plan-sha256"
        )
    if args.report.resolve() in (args.plan.resolve(), args.manifest.resolve()):
        parser.error("Report must not overwrite an input")
    decision = load_manifest(args.manifest)
    with psycopg.connect(
        os.environ["DATABASE_URL"],
        row_factory=dict_row,
        options="-c default_transaction_read_only=on" if args.dry_run else "",
    ) as db:
        if args.dry_run:
            db.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
        if args.plan.exists():
            plan = json.loads(args.plan.read_text())
        else:
            state = capture(db)
            official, _ = check_identity(decision, state)
            version = db.execute(
                "SELECT version FROM contest.import_runs "
                "WHERE id=%s AND status='completed'",
                (official["import_run_id"],),
            ).fetchone()
            if not version or version["version"] != decision["contest_version"]:
                raise ValueError("Wrong contest import version")
            plan = build_plan(decision, state)
            save_immutable(args.plan, plan)
        if plan["decision"] != decision:
            raise ValueError("Plan differs from the canonical reviewed decision")
        if args.apply and plan["plan_sha256"] != args.expected_plan_sha256:
            raise ValueError("Plan differs from the approved dry-run hash")
        report = write_correction(db, plan, dry_run=args.dry_run)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_bytes(json_bytes(report))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
