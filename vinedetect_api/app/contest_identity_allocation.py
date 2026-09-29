"""Immutable merge of Phase 3B1 evidence and final human identity decisions."""

from __future__ import annotations

import copy
import re
import unicodedata
from collections import Counter, defaultdict

from app.contest_identity_plan import new_wine_data
from app.contest_identity_state import digest, fingerprint

SCHEMA = "contest-final-allocation/1"
EXPECTED = {"re_slug": 16, "true_new": 248}
EXPECTED_RESLUGS = {
    "chenin-blanc-shenen-blan-oleg-repin": 1088,
    "di-kaspiko-di-caspico-fiori-di-mare-verde": 730,
    "dry-red-wine-56-rubinovyj-magaracha-oleg-repin": 1742,
    "golubitskoe-estate-risling": 1426,
    "lorio-sovinon-blan-2024": 828,
    "rose-roze-oleg-repin": 189,
    "skalistyj-bereg-shepot-czvetov": 480,
    "soyuz-vino-soyuz-vino-izabella-beg-in-boks-krasnoe-polusladkoe-11": 161,
    "soyuz-vino-soyuz-vino-kaberne-sovinon-beg-in-boks-krasnoe-suhoe-11": 160,
    "soyuz-vino-soyuz-vino-muskat-beg-in-boks-beloe-polusladkoe-11": 159,
    "soyuz-vino-soyuz-vino-shardone-suhoe-beg-in-boks-beloe-11": 158,
    (
        "soyuz-vino-zelyonaya-dolina-kaberne-merlo-v-banke-"
        "kaberne-sovinon-krasnoe-polusladkoe-12"
    ): 100,
    "soyuz-vino-zelyonaya-dolina-pino-nuar-v-banke-krasnoe-suhoe-12": 103,
    "soyuz-vino-zelyonaya-dolina-shardone-v-banke-beloe-suhoe-12": 98,
    "vibes-silvaner-2022": 1684,
    "vibes-silvaner-barrel-fermented-2022": 791,
}
FROZEN_KEYS = (
    "catalog_items",
    "reference_assets",
    "item_links",
    "wines",
    "wine_images",
    "wine_grapes",
)
PROTECTED_KEYS = ("catalog_items", "reference_assets", "wine_images", "grapes")
WINE_FIELDS = (
    "slug",
    "external_id",
    "source",
    "title",
    "category_name",
    "manufacturer_name",
    "region_name",
    "color",
    "description",
    "raw_detail_json",
)


def unique(rows, key, label):
    result = {}
    for row in rows:
        value = row[key]
        if value in result:
            raise ValueError(f"{label}: duplicate {key}: {value}")
        result[value] = row
    return result


def validate_decisions(decisions, manual, wines):
    if not isinstance(decisions, list) or len(decisions) != 48:
        raise ValueError("Human decisions require exactly 48 items")
    fields = {"official_slug", "decision", "wine_id", "confidence", "note"}
    if any(not isinstance(r, dict) or set(r) != fields for r in decisions):
        raise ValueError("Invalid manual decision fields")
    by_slug = unique(decisions, "official_slug", "Human decisions")
    if set(by_slug) != manual:
        raise ValueError("Human decision slugs do not match manual-review items")
    for row in decisions:
        if row["decision"] not in ("re_slug", "true_new"):
            raise ValueError("Invalid manual decision: re_slug or true_new required")
        if row["decision"] == "re_slug":
            if type(row["wine_id"]) is not int or row["wine_id"] not in wines:
                raise ValueError("Unknown re_slug wine ID in manual decision")
        elif row["wine_id"] is not None:
            raise ValueError("Invalid manual decision: true_new wine_id must be null")
        if row["confidence"] is not None and type(row["confidence"]) not in (
            str,
            int,
            float,
        ):
            raise ValueError("Invalid manual decision confidence")
        if row["note"] is not None and not isinstance(row["note"], str):
            raise ValueError("Invalid manual decision note")
    if Counter(r["decision"] for r in decisions) != {"re_slug": 15, "true_new": 33}:
        raise ValueError("Human decisions must resolve to 15 re_slug / 33 true_new")
    return by_slug


def grape_key(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def grape_relations(raw, dictionary):
    by_key = defaultdict(list)
    for row in dictionary:
        by_key[grape_key(row["name"])].append(row)
    resolved, unresolved = {}, []
    for token in sorted(set(re.split(r"[,;\n]", raw))):
        if not token.strip():
            continue
        matches = by_key[grape_key(token)]
        if len(matches) == 1:
            row = matches[0]
            resolved[row["id"]] = {"grape_id": row["id"], "name": row["name"]}
        else:
            unresolved.append(
                {
                    "raw_token": token,
                    "reason": "ambiguous_normalization"
                    if matches
                    else "no_exact_dictionary_match",
                    "candidate_grape_ids": sorted(r["id"] for r in matches),
                }
            )
    return {
        "raw_official_grapes": raw,
        "relations": [resolved[k] for k in sorted(resolved)],
        "unresolved": unresolved,
        "dictionary_inserts": 0,
    }


def check_aliases(wines, allocations):
    """Check every newly introduced detail-lookup alias, including allocated IDs."""
    aliases = defaultdict(set)
    for wine in wines:
        for value in (wine.get("external_id"), wine.get("slug"), str(wine["id"])):
            if value is not None:
                aliases[value].add(wine["id"])
    pending_keys = set()
    for row in allocations:
        if row["decision"] != "true_new":
            continue
        wid = row["wine_id"]
        data = row["new_wine"]
        for value in {data["slug"], data["external_id"], str(wid)}:
            # Numeric keys outside the allocated own ID could shadow a future ID.
            if re.fullmatch(r"[1-9][0-9]*", value) and value != str(wid):
                raise ValueError(f"Future numeric alias collision: {value}")
            aliases[value].add(wid)
            pending_keys.add(value)
    collisions = {
        key: sorted(aliases[key])
        for key in sorted(pending_keys)
        if len(aliases[key]) > 1
    }
    if collisions:
        raise ValueError(
            f"Source-key / allocation-time numeric alias collision: {collisions}"
        )
    return {
        "collisions": [],
        "checked_aliases": len(pending_keys),
        "aliases": ["external_id", "slug", "id::text"],
        "future_numeric_source_keys_checked": True,
    }


def build_allocation(automatic, decisions, frozen, state, input_hashes):
    for key in FROZEN_KEYS:
        if fingerprint(frozen[key]) != fingerprint(state[key]):
            raise ValueError(f"Stale Phase 3B1 snapshot: {key}; regenerate the plan")
    counts = {
        key: len(state[key])
        for key in (
            "wines",
            "wine_images",
            "catalog_items",
            "reference_assets",
            "item_links",
        )
    }
    if counts != {
        "wines": 1866,
        "wine_images": 1866,
        "catalog_items": 2103,
        "reference_assets": 2103,
        "item_links": 2103,
    }:
        raise ValueError(f"Unexpected baseline counts: {counts}")
    if Counter(r["method"] for r in state["item_links"]) != {
        "exact_slug": 1839,
        "unmatched": 264,
    }:
        raise ValueError("Expected 1839 exact links and 264 unresolved links")
    rows = sorted(automatic, key=lambda r: r["official_slug"])
    if len(rows) != 264 or Counter(r["classification"] for r in rows) != {
        "re_slug": 1,
        "true_new": 215,
        "manual_review": 48,
    }:
        raise ValueError("Frozen automatic allocation must be 1/215/48, total 264")
    unique(rows, "official_slug", "Frozen plan")
    by_id = unique(rows, "catalog_item_id", "Frozen plan")
    unresolved = {
        r["catalog_item_id"]: r
        for r in state["item_links"]
        if r["method"] == "unmatched" and r["wine_id"] is None
    }
    if set(by_id) != set(unresolved):
        raise ValueError("Frozen plan does not cover exactly the unresolved links")
    wines = unique(state["wines"], "id", "Historical wines")
    officials = unique(state["catalog_items"], "id", "Official catalog")
    reviews = validate_decisions(
        decisions,
        {r["official_slug"] for r in rows if r["classification"] == "manual_review"},
        wines,
    )
    seq = state["sequence"]
    next_id = seq["last_value"] + int(seq["is_called"])
    if next_id <= max(wines):
        raise ValueError("Wine sequence is behind existing IDs; do not silently repair")
    if next_id + 248 > seq["max_value"]:
        raise ValueError("Insufficient sequence range for materialization")
    allocations = []
    for row in rows:
        official = officials[row["catalog_item_id"]]
        if (row["official_slug"], row["official_title"], row["official_winery"]) != (
            official["official_slug"],
            official["title"],
            official["winery"],
        ):
            raise ValueError("Frozen plan/official catalog mismatch")
        human = reviews.get(row["official_slug"])
        decision = human["decision"] if human else row["classification"]
        wid = human["wine_id"] if human else row["proposed_wine_id"]
        new_data = None
        identity = None
        enrichment = None
        if decision == "true_new":
            new_data = new_wine_data(official)
            if not human and new_data != row["proposed_new_wine_data"]:
                raise ValueError(
                    "Frozen true-new proposal no longer matches organizer row"
                )
            wid = next_id
            next_id += 1
            enrichment = grape_relations(official["grapes"], state["grapes"])
        else:
            if wid not in wines:
                raise ValueError("Unknown re_slug wine ID")
            wine = wines[wid]
            identity = {key: wine[key] for key in ("id", "external_id", "slug")}
            identity["source"] = "svoe_vino"
            identity["source_item_id"] = (
                wine["external_id"]
                if wine["external_id"] is not None
                else wine["slug"]
                if wine["slug"] is not None
                else str(wid)
            )
        allocations.append(
            {
                "catalog_item_id": official["id"],
                "official_slug": official["official_slug"],
                "decision": decision,
                "wine_id": wid,
                "new_wine": new_data,
                "preserved_identity": identity,
                "grape_enrichment": enrichment,
                "method": "re_slug"
                if decision == "re_slug"
                else "materialized_official",
                "confidence": None,
                "review_evidence": human
                or {
                    "origin": "frozen_automatic_plan",
                    "confidence": row["confidence"],
                    "note": row["review_note"],
                },
                "previous_link": unresolved[official["id"]],
            }
        )
    if Counter(r["decision"] for r in allocations) != EXPECTED:
        raise ValueError("Final allocation must be exactly 16 re_slug / 248 true_new")
    if {
        r["official_slug"]: r["wine_id"]
        for r in allocations
        if r["decision"] == "re_slug"
    } != EXPECTED_RESLUGS:
        raise ValueError(
            "Reviewed re-slug mappings differ from validation expectations"
        )
    collisions = check_aliases(state["wines"], allocations)
    baseline = {key: fingerprint(state[key]) for key in PROTECTED_KEYS}
    baseline.update(
        {
            "historical_wines": fingerprint(state["wines"]),
            "historical_wine_ids": sorted(wines),
            "historical_grape_relations": fingerprint(state["wine_grape_relations"]),
            "exact_links": fingerprint(
                [r for r in state["item_links"] if r["method"] == "exact_slug"]
            ),
            "meta": state["meta"],
            "schema": state["schema"],
            "sequence": seq,
        }
    )
    plan = {
        "schema_version": SCHEMA,
        "input_hashes": input_hashes,
        "frozen_snapshot_fingerprints": {
            key: fingerprint(frozen[key]) for key in FROZEN_KEYS
        },
        "baseline": baseline,
        "allocations": allocations,
        "summary": {
            "re_slug": 16,
            "true_new": 248,
            "total": 264,
            "unresolved": 0,
            "expected_wines": 2114,
            "expected_links": 2103,
            "expected_reference_assets": 2103,
            "expected_wine_images": 1866,
        },
        "collision_checks": collisions,
        "allocation_policy": (
            "Explicit IDs reserved under table/sequence locks; "
            "transactional sequence RESTART. No nextval or setval."
        ),
    }
    plan["plan_sha256"] = digest(plan)
    return plan


def validate_final_plan(plan):
    body = copy.deepcopy(plan)
    supplied = body.pop("plan_sha256", None)
    if body.get("schema_version") != SCHEMA or supplied != digest(body):
        raise ValueError("Final allocation plan hash/schema mismatch")
    if plan["summary"] != {
        "re_slug": 16,
        "true_new": 248,
        "total": 264,
        "unresolved": 0,
        "expected_wines": 2114,
        "expected_links": 2103,
        "expected_reference_assets": 2103,
        "expected_wine_images": 1866,
    }:
        raise ValueError("Final allocation summary/count mismatch")
    rows = plan["allocations"]
    if len(rows) != 264 or Counter(r["decision"] for r in rows) != EXPECTED:
        raise ValueError("Final allocation must be exactly 16/248, total 264")
    unique(rows, "catalog_item_id", "Final plan")
    unique(rows, "official_slug", "Final plan")
    if {
        r["official_slug"]: r["wine_id"] for r in rows if r["decision"] == "re_slug"
    } != EXPECTED_RESLUGS:
        raise ValueError("Final re-slug expectation mismatch")
    seq = plan["baseline"]["sequence"]
    expected_ids = list(
        range(
            seq["last_value"] + int(seq["is_called"]),
            seq["last_value"] + int(seq["is_called"]) + 248,
        )
    )
    new_rows = [r for r in rows if r["decision"] == "true_new"]
    if [r["wine_id"] for r in new_rows] != expected_ids:
        raise ValueError("Final planned numeric ID allocation mismatch")
    for row in rows:
        if row["confidence"] is not None:
            raise ValueError("Do not invent numeric identity confidence")
        if row["previous_link"]["catalog_item_id"] != row["catalog_item_id"]:
            raise ValueError("Previous link identity mismatch")
        expected_method = (
            "re_slug" if row["decision"] == "re_slug" else "materialized_official"
        )
        if row["method"] != expected_method:
            raise ValueError("Invalid final link method")
        if row["decision"] == "true_new":
            data = row["new_wine"]
            if set(data) != set(WINE_FIELDS) or (
                data["slug"],
                data["external_id"],
                data["source"],
            ) != (row["official_slug"], row["official_slug"], "vino-svoe"):
                raise ValueError("Invalid organizer-only materialization fields")
    return rows
