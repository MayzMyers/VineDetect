"""Read-only, deterministic Phase 3B1 identity proposals; never a DB writer."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from pathlib import Path

from app.contest_media import (
    TRANSLITERATION,
    historical_basename,
    json_bytes,
    normalize_filename,
)

SCHEMA = "contest-identity-plan/1"
FIELDS = (
    "title",
    "winery",
    "year",
    "color",
    "category",
    "region",
    "grapes",
    "description",
)


def normalized(value):
    """Typography/case/transliteration only; preserve vintage and cuvee numbers."""
    value = html.unescape(re.sub(r"<[^>]+>", " ", str(value or "")))
    value = unicodedata.normalize("NFKC", value).casefold().replace("ё", "е")
    return " ".join(re.findall(r"[^\W_]+", value.translate(TRANSLITERATION)))


def winery_key(value):
    return " ".join(t for t in normalized(value).split() if t not in {"vinodelnya"})


def years(value):
    return sorted(set(re.findall(r"(?<!\d)(?:19|20)\d{2}(?!\d)", value or "")))


def category_key(value):
    text = normalized(value)
    for pattern, key in (
        (r"rozov|rose|pink", "rose"),
        (r"krasn|red", "red"),
        (r"bel|white", "white"),
        (r"oranzh|orange", "orange"),
    ):
        if re.search(pattern, text):
            return key
    return text


def sweetness(value):
    text = normalized(value)
    for patterns, kind in (
        (("poluslad", "semi sweet", "semisweet"), "semi_sweet"),
        (("polusuh", "semi dry", "semidry"), "semi_dry"),
        (("ekstra bryut", "extra brut"), "extra_brut"),
        (("bryut", "brut"), "brut"),
        (("sladk", "sweet"), "sweet"),
        (("suhoe", "suhoj", "dry"), "dry"),
    ):
        if any(pattern in text for pattern in patterns):
            return kind
    return None


def color_family(value):
    text = normalized(value)
    matches = []
    for pattern, key in (
        (r"rozov|rose|pink", "rose"),
        (r"krasn|rubin|granat|purpur|red|ruby", "red"),
        (r"solom|zolot|zhelt|yantar|white|gold", "white"),
    ):
        if re.search(pattern, text):
            matches.append(key)
    return matches[0] if len(matches) == 1 else None


def grapes_key(values):
    if isinstance(values, str):
        values = re.split(r"[,;\n]", values)
    return sorted({normalized(x) for x in values if normalized(x)})


def metadata(row, *, official=False, grape_names=()):
    return {
        "title": normalized(row.get("title")),
        "winery": winery_key(row.get("winery" if official else "manufacturer_name")),
        "year": years(row.get("title")),
        "color": normalized(row.get("color")),
        "category": category_key(row.get("category" if official else "category_name")),
        "region": normalized(row.get("region" if official else "region_name")),
        "grapes": grapes_key(row.get("grapes", "") if official else grape_names),
        "description": normalized(row.get("description")),
    }


def compare_metadata(official, wine, left, right):
    comparison = {}
    for field in FIELDS:
        a, b = left[field], right[field]
        state = "missing" if not a or not b else "equal" if a == b else "different"
        comparison[field] = {"official": a, "historical": b, "state": state}
    hard = [
        f
        for f in ("winery", "year", "category", "region", "grapes")
        if comparison[f]["state"] == "different"
    ]
    detail = (official.get("category", ""), wine.get("category_name", ""))
    styles = (
        sweetness(detail[0] + " " + official.get("title", "")),
        sweetness((detail[1] or "") + " " + wine.get("title", "")),
    )
    comparison["category_detail"] = {"official": detail[0], "historical": detail[1]}
    comparison["sweetness"] = {"official": styles[0], "historical": styles[1]}
    if all(styles) and styles[0] != styles[1]:
        hard.append("sweetness")
    cf = color_family(official.get("color")), color_family(wine.get("color"))
    if all(cf) and cf[0] != cf[1]:
        hard.append("color_family")
    comparison["color_family"] = {"official": cf[0], "historical": cf[1]}
    # Same words in a different order are normalization, not fuzzy evidence.
    a, b = left["title"], right["title"]
    title_equal = bool(a and b and (a == b or sorted(a.split()) == sorted(b.split())))
    title_contained = bool(a and b and (f" {a} " in f" {b} " or f" {b} " in f" {a} "))
    support = [
        f
        for f in ("category", "region", "grapes", "description", "year")
        if comparison[f]["state"] == "equal"
    ]
    return comparison, hard, title_equal, title_contained, support


def media_index(snapshot):
    indexes = {
        k: defaultdict(list) for k in ("exact", "normalized", "unhashed", "sha256")
    }
    hashes = snapshot.get("historical_image_hashes", {})
    for image in sorted(snapshot["wine_images"], key=lambda x: x["id"]):
        for field in ("url", "local_path"):
            name = historical_basename(image.get(field))
            if not name:
                continue
            evidence = {
                "wine_id": image["wine_id"],
                "image_id": image["id"],
                "historical_field": field,
                "historical_value": image[field],
                "historical_basename": name,
            }
            indexes["exact"][name].append(evidence)
            indexes["normalized"][
                normalize_filename(name, strip_strapi_hash=False)
            ].append(evidence)
            indexes["unhashed"][normalize_filename(name)].append(evidence)
        sha = hashes.get(str(image["id"])) or image.get("sha256")
        if sha:
            indexes["sha256"][sha].append(
                {"wine_id": image["wine_id"], "image_id": image["id"], "sha256": sha}
            )
    return indexes


def media_evidence(item, reference, indexes):
    found = defaultdict(list)
    provenance = reference.get("provenance") or {}
    names = [
        ("original_filename", reference["original_filename"]),
        ("source_relative_path", provenance.get("source_relative_path")),
        ("photo_name", item.get("photo_name")),
    ]
    for field, value in names:
        name = historical_basename(value)
        if not name:
            continue
        for rule, key, strong in (
            ("exact", name, True),
            ("normalized", normalize_filename(name, strip_strapi_hash=False), True),
            ("unhashed", normalize_filename(name), False),
        ):
            for evidence in indexes[rule].get(key, []):
                found[evidence["wine_id"]].append(
                    {
                        "rule": "media_" + rule,
                        "strong": strong,
                        "official_field": field,
                        "official_value": value,
                        "normalized_key": list(key) if isinstance(key, tuple) else key,
                        **evidence,
                    }
                )
    for evidence in indexes["sha256"].get(reference["sha256"], []):
        found[evidence["wine_id"]].append(
            {"rule": "media_sha256", "strong": True, **evidence}
        )
    return {
        key: sorted({json_bytes(e): e for e in values}.values(), key=json_bytes)
        for key, values in found.items()
    }


def alias_collisions(item, wines):
    key = item["official_slug"]
    return [
        {"source_key": key, "wine_id": w["id"], "alias_field": field}
        for w in wines
        for field, value in (
            ("external_id", w.get("external_id")),
            ("slug", w["slug"]),
            ("numeric_id", str(w["id"])),
        )
        if key == value
    ]


def new_wine_data(item):
    """Exact organizer values; absent properties use NULL/database defaults later."""
    result = {
        "slug": item["official_slug"],
        "external_id": item["official_slug"],
        "source": "vino-svoe",
        "title": item["title"],
    }
    for source, destination in (
        ("category", "category_name"),
        ("winery", "manufacturer_name"),
        ("region", "region_name"),
        ("color", "color"),
        ("description", "description"),
    ):
        result[destination] = item.get(source) or None
    # wines has no grapes/year column. Preserve the verbatim organizer record in
    # raw_detail_json, without inventing an API response or inferred vintage.
    result["raw_detail_json"] = {
        "organizer_catalog": {
            key: item[key]
            for key in (
                "official_slug",
                "title",
                "category",
                "color",
                "region",
                "grapes",
                "description",
                "winery",
                "photo_name",
            )
        },
        "contest_catalog_item_id": item["id"],
        "contest_import_run_id": item.get("import_run_id"),
    }
    return result


def candidate(item, wine, left, right, evidence):
    comp, hard, title_equal, contained, support = compare_metadata(
        item, wine, left, right
    )
    same_winery = bool(left["winery"] and left["winery"] == right["winery"])
    overlap = set(left["title"].split()) & set(right["title"].split())
    similarity = (
        SequenceMatcher(None, left["title"], right["title"], autojunk=False).ratio()
        if same_winery or len(overlap) >= 2 or evidence
        else 0.0
    )
    strong_media = any(e["strong"] for e in evidence)
    metadata_match = title_equal and same_winery and len(support) >= 2 and not hard
    # Contradictory or unrecognizable titles cannot be rescued by a shared photo.
    title_supported = (
        title_equal or contained or comp["description"]["state"] == "equal"
    )
    if strong_media and not title_supported:
        hard.append("title_unconfirmed")
    automatic = not hard and (
        (strong_media and same_winery and len(support) >= 2) or metadata_match
    )
    likely_title = same_winery and (
        title_equal
        or (
            similarity >= 0.8
            and not any(field in hard for field in ("year", "category"))
        )
    )
    plausible = (
        strong_media
        or metadata_match
        or likely_title
        or (
            title_equal
            and not (left["winery"] and right["winery"])
            and len(support) >= 2
        )
        or (
            same_winery
            and (contained or similarity >= 0.62)
            and not any(x in hard for x in ("year", "category", "grapes"))
        )
    )
    if not plausible and not evidence and not title_equal and similarity < 0.45:
        return None
    ev = list(evidence)
    if metadata_match:
        ev.append(
            {
                "rule": "exact_title_winery_supported_metadata",
                "strong": True,
                "support_fields": support,
            }
        )
    if similarity:
        ev.append(
            {
                "rule": "fuzzy_title_candidate_only",
                "strong": False,
                "score": round(similarity, 6),
            }
        )
    return {
        "wine_id": wine["id"],
        "existing_slug": wine["slug"],
        "existing_external_id": wine.get("external_id"),
        "title": wine["title"],
        "winery": wine.get("manufacturer_name"),
        "metadata_comparison": comp,
        "contradictions": hard,
        "evidence": ev,
        "automatic_eligible": automatic,
        "plausible": plausible,
        "strong_media": strong_media,
        "confidence": "high" if automatic else "medium" if plausible else "low",
        "fuzzy_title_score": round(similarity, 6),
    }


def unique_index(rows, field):
    result = {x[field]: x for x in rows}
    if len(result) != len(rows):
        raise ValueError(f"Duplicate {field}")
    return result


def build_plan(snapshot, *, expected_unmatched=264):
    snapshot = {
        k: sorted(v, key=json_bytes) if isinstance(v, list) else v
        for k, v in snapshot.items()
    }
    catalogs = unique_index(snapshot["catalog_items"], "id")
    wines = unique_index(snapshot["wines"], "id")
    links = unique_index(snapshot["item_links"], "catalog_item_id")
    refs = unique_index(snapshot["reference_assets"], "catalog_item_id")
    unique_index(snapshot["reference_assets"], "id")
    inputs = [catalogs[k] for k, link in links.items() if link["method"] == "unmatched"]
    if len(inputs) != expected_unmatched:
        raise ValueError(
            f"Expected {expected_unmatched} unmatched items; got {len(inputs)}"
        )
    for link in links.values():
        if link["wine_id"] is not None and link["wine_id"] not in wines:
            raise ValueError("Dangling linked wine")
    grapes = defaultdict(list)
    for row in snapshot.get("wine_grapes") or []:
        grapes[row["wine_id"]].append(row["name"])
    wm = {key: metadata(wine, grape_names=grapes[key]) for key, wine in wines.items()}
    indexes = media_index(snapshot)
    rows, collisions = [], []
    proposed_aliases = defaultdict(list)
    for item in inputs:
        proposed_aliases[item["official_slug"]].append(item["id"])
    for item in sorted(inputs, key=lambda x: (x["official_slug"], x["id"])):
        if item["id"] not in refs or links[item["id"]]["wine_id"] is not None:
            raise ValueError("Unmatched item lacks exactly one reference or has a wine")
        ref = refs[item["id"]]
        evidence = media_evidence(item, ref, indexes)
        left = metadata(item, official=True)
        candidates = [
            c
            for key, wine in sorted(wines.items())
            if (c := candidate(item, wine, left, wm[key], evidence.get(key, [])))
        ]
        candidates.sort(
            key=lambda c: (
                -c["strong_media"],
                -c["automatic_eligible"],
                -c["plausible"],
                -c["fuzzy_title_score"],
                c["wine_id"],
            )
        )
        plausible = [c for c in candidates if c["plausible"]]
        automatic = [c for c in plausible if c["automatic_eligible"]]
        aliases = alias_collisions(item, list(wines.values()))
        peers = sorted(proposed_aliases[item["official_slug"]])
        if len(peers) > 1:
            aliases.append(
                {
                    "source_key": item["official_slug"],
                    "alias_field": "proposed_slug_external_id",
                    "catalog_item_ids": peers,
                }
            )
        collisions.extend({"catalog_item_id": item["id"], **c} for c in aliases)
        classification, selected, note = (
            "manual_review",
            None,
            "Multiple or insufficient identity evidence.",
        )
        if len(plausible) == 1 and len(automatic) == 1 and not aliases:
            classification, selected, note = (
                "re_slug",
                automatic[0],
                (
                    "Unique strong identity with non-conflicting metadata. "
                    "Preserve every historical identity field."
                ),
            )
        elif not plausible and not evidence and not aliases:
            classification, note = (
                "true_new",
                (
                    "No strong media/identifier match, likely re-slug candidate or "
                    "lookup alias collision. Organizer-only row proposed."
                ),
            )
        elif aliases:
            note = (
                "Proposed source key collides with an existing accepted lookup alias."
            )
        elif any(c["strong_media"] and c["contradictions"] for c in candidates):
            note = (
                "Historical media identity conflicts with metadata; "
                "automatic linking rejected."
            )
        elif len(plausible) > 1:
            note = (
                "Multiple existing wines remain plausible; automatic linking rejected."
            )
        elif plausible:
            note = (
                "Likely existing identity requires review; "
                "fuzzy/partial evidence alone is insufficient."
            )
        elif evidence:
            note = (
                "Hash-stripped historical filename suggests identity "
                "but does not prove it."
            )
        provenance = ref.get("provenance") or {}
        if provenance.get(
            "source_data_inconsistencies"
        ) or "organizer_photo_title_inconsistency" in provenance.get("flags", []):
            classification, selected, note = (
                "manual_review",
                None,
                "Reference provenance records an organizer source inconsistency.",
            )
        row = {
            "catalog_item_id": item["id"],
            "official_slug": item["official_slug"],
            "official_title": item["title"],
            "official_winery": item["winery"],
            "classification": classification,
            "confidence": "high" if classification == "re_slug" else "medium",
            "proposed_wine_id": selected["wine_id"] if selected else None,
            "existing_wine_slug": selected["existing_slug"] if selected else None,
            "existing_wine_external_id": selected["existing_external_id"]
            if selected
            else None,
            "proposed_source_key": ["svoe_vino", item["official_slug"]]
            if classification == "true_new"
            else None,
            "proposed_new_wine_data": new_wine_data(item)
            if classification == "true_new"
            else None,
            "reference_asset_id": ref["id"],
            "reference_sha256": ref["sha256"],
            "source_filename_path_evidence": {
                "official_photo_name": item["photo_name"],
                "source_filename": ref["original_filename"],
                "local_path": ref["local_path"],
                "provenance": ref.get("provenance"),
                "review_note": ref.get("review_note"),
            },
            "metadata_comparison": selected["metadata_comparison"]
            if selected
            else candidates[0]["metadata_comparison"]
            if candidates
            else {"official": left},
            "evidence": selected["evidence"]
            if selected
            else [
                {
                    "rule": "exhaustive_identity_search",
                    "strong": False,
                    "historical_wines_compared": len(wines),
                    "historical_images_compared": len(snapshot["wine_images"]),
                    "sha256_hashes_available": len(
                        snapshot.get("historical_image_hashes", {})
                    ),
                    "strong_media_candidate_wine_ids": sorted(
                        c["wine_id"] for c in candidates if c["strong_media"]
                    ),
                    "plausible_wine_ids": sorted(c["wine_id"] for c in plausible),
                    "alias_collision_count": len(aliases),
                }
            ],
            "review_note": note,
            "alias_collisions": aliases,
            "plausible_wine_ids": sorted(c["wine_id"] for c in plausible),
            "candidates": [
                c
                for i, c in enumerate(candidates)
                if i < 3
                or c["plausible"]
                or any(e["rule"].startswith("media_") for e in c["evidence"])
            ],
            "many_to_one": [],
        }
        rows.append(row)
    many = detect_many_to_one(rows, snapshot, catalogs)
    # New proposals must not duplicate another official item semantically either.
    signatures = defaultdict(list)
    for item in snapshot["catalog_items"]:
        m = metadata(item, official=True)
        signatures[
            json_bytes(
                {k: m[k] for k in ("title", "winery", "year", "category", "grapes")}
            )
        ].append(item["id"])
    for row in rows:
        if row["classification"] != "true_new":
            continue
        m = metadata(catalogs[row["catalog_item_id"]], official=True)
        peers = signatures[
            json_bytes(
                {k: m[k] for k in ("title", "winery", "year", "category", "grapes")}
            )
        ]
        if len(peers) > 1:
            row.update(
                classification="manual_review",
                proposed_new_wine_data=None,
                proposed_source_key=None,
                review_note=(
                    "Duplicate normalized organizer identity under multiple slugs; "
                    "review before creating a new wine."
                ),
            )
            row["duplicate_official_catalog_item_ids"] = sorted(peers)
    counts = Counter(row["classification"] for row in rows)
    summary = {
        "schema_version": SCHEMA,
        "total_unmatched_input": len(inputs),
        **{k: counts[k] for k in ("re_slug", "true_new", "manual_review")},
        "alias_collision_count": len(collisions),
        "alias_collisions": collisions,
        "many_to_one_candidate_count": len(many),
        "many_to_one_candidates": many,
        "manual_review_slugs": [
            r["official_slug"] for r in rows if r["classification"] == "manual_review"
        ],
        "input_sha256": hashlib.sha256(json_bytes(snapshot)).hexdigest(),
        "historical_images": len(snapshot["wine_images"]),
        "historical_image_hashes_available": len(
            snapshot.get("historical_image_hashes", {})
        ),
        "writes_performed": 0,
        "policy": (
            "Exact media plus confirmed metadata, or exact normalized title/winery "
            "with >=2 supporting metadata fields. Fuzzy scores never authorize "
            "links. All many-to-one groups are explicit."
        ),
    }
    validate_plan(rows, summary, snapshot, expected_unmatched=expected_unmatched)
    return rows, summary


def detect_many_to_one(rows, snapshot, catalogs):
    by_wine = defaultdict(set)
    existing = defaultdict(set)
    for link in snapshot["item_links"]:
        if link["wine_id"] is not None:
            by_wine[link["wine_id"]].add(link["catalog_item_id"])
            existing[link["wine_id"]].add(link["catalog_item_id"])
    for row in rows:
        for wine_id in row["plausible_wine_ids"]:
            by_wine[wine_id].add(row["catalog_item_id"])
    result = []
    by_id = {r["catalog_item_id"]: r for r in rows}
    for wine_id, ids in sorted(by_wine.items()):
        if len(ids) < 2 or not ids.intersection(by_id):
            continue
        items = [catalogs[i] for i in sorted(ids)]
        # Only truly identical organizer metadata can certify duplicate aliases.
        references = {r["catalog_item_id"]: r for r in snapshot["reference_assets"]}
        signatures = {
            json_bytes(
                {
                    "metadata": metadata(item, official=True),
                    "reference_sha256": references[item["id"]]["sha256"],
                }
            )
            for item in items
        }
        kind = (
            "legitimate_duplicate_organizer_metadata"
            if len(signatures) == 1
            else "ambiguous_identity"
        )
        group = {
            "wine_id": wine_id,
            "catalog_item_ids": sorted(ids),
            "official_slugs": [i["official_slug"] for i in items],
            "classification": kind,
            "already_linked_catalog_item_ids": sorted(existing[wine_id]),
        }
        result.append(group)
        for key in ids.intersection(by_id):
            row = by_id[key]
            row["many_to_one"].append(group)
            if kind == "ambiguous_identity":
                row.update(
                    classification="manual_review",
                    proposed_wine_id=None,
                    existing_wine_slug=None,
                    existing_wine_external_id=None,
                    proposed_new_wine_data=None,
                    proposed_source_key=None,
                    confidence="medium",
                    review_note=(
                        "Multiple official items plausibly point to this historical "
                        "wine with differing metadata; identity review required."
                    ),
                )
    return result


def validate_plan(rows, summary, snapshot, *, expected_unmatched):
    inputs = {
        x["catalog_item_id"]
        for x in snapshot["item_links"]
        if x["method"] == "unmatched"
    }
    if (
        len(rows) != expected_unmatched
        or {r["catalog_item_id"] for r in rows} != inputs
    ):
        raise ValueError("Output does not cover exactly the unmatched inputs")
    unique_index(rows, "catalog_item_id")
    wines = unique_index(snapshot["wines"], "id")
    refs = unique_index(snapshot["reference_assets"], "id")
    proposed = set()
    for row in rows:
        if row["classification"] not in {"re_slug", "true_new", "manual_review"}:
            raise ValueError("Invalid classification")
        ref = refs[row["reference_asset_id"]]
        if (
            ref["catalog_item_id"] != row["catalog_item_id"]
            or ref["sha256"] != row["reference_sha256"]
        ):
            raise ValueError("Reference identity mismatch")
        for candidate_row in row["candidates"]:
            if candidate_row["wine_id"] not in wines:
                raise ValueError("Missing candidate wine")
        if row["classification"] == "re_slug":
            wine = wines[row["proposed_wine_id"]]
            if row["plausible_wine_ids"] != [wine["id"]] or not any(
                e["strong"] for e in row["evidence"]
            ):
                raise ValueError("Automatic re-slug lacks a unique strong identity")
            if any(
                g["classification"] == "ambiguous_identity" for g in row["many_to_one"]
            ):
                raise ValueError("Unresolved many-to-one mapping")
        if row["classification"] == "true_new":
            data = row["proposed_new_wine_data"]
            key = data["external_id"]
            if (
                data["slug"] != key
                or key in proposed
                or alias_collisions({"official_slug": key}, list(wines.values()))
            ):
                raise ValueError("New source key collision")
            proposed.add(key)
    if sum(summary[k] for k in ("re_slug", "true_new", "manual_review")) != len(rows):
        raise ValueError("Classification summary mismatch")


def review_markdown(rows, summary):
    lines = [
        "# Phase 3B1 identity review",
        "",
        "Read-only plan; no database writes authorized by this artifact.",
        "",
        (
            f"Input: {summary['total_unmatched_input']}; "
            f"re_slug: {summary['re_slug']}; true_new: {summary['true_new']}; "
            f"manual_review: {summary['manual_review']}."
        ),
        (
            f"Alias collisions: {summary['alias_collision_count']}; "
            f"many-to-one candidate groups: {summary['many_to_one_candidate_count']}."
        ),
        "",
        (
            "Fuzzy scores generate candidates only. New row IDs/timestamps use "
            "database defaults in a later controlled write; missing fields are not "
            "fabricated. Grapes remain organizer evidence in raw_detail_json "
            "because wines has no grapes column."
        ),
        "",
        "## Manual-review slugs",
        "",
    ]
    lines += [f"- `{slug}`" for slug in summary["manual_review_slugs"]]
    for row in rows:
        if row["classification"] != "manual_review":
            continue
        lines += [
            "",
            f"## {row['official_slug']}",
            "",
            f"Official: {row['official_title'].strip()} | {row['official_winery']}",
            (
                "Reference: `"
                f"{row['source_filename_path_evidence']['source_filename']}` "
                f"(asset {row['reference_asset_id']})."
            ),
            f"Decision confidence: {row['confidence']}. {row['review_note']}",
        ]
        if row.get("duplicate_official_catalog_item_ids"):
            lines += [
                "",
                "Organizer duplicates to compare: "
                + ", ".join(str(i) for i in row["duplicate_official_catalog_item_ids"]),
            ]
        if row["alias_collisions"]:
            lines += [
                "",
                "Alias collisions: `"
                + json.dumps(row["alias_collisions"], ensure_ascii=False)
                + "`",
            ]
        if row["many_to_one"]:
            lines += [
                "",
                "Many-to-one: "
                + "; ".join(", ".join(g["official_slugs"]) for g in row["many_to_one"]),
            ]
        if not row["candidates"]:
            lines += ["", "No existing-wine candidate met the candidate threshold."]
        for c in row["candidates"]:
            lines += [
                "",
                (
                    f"- Candidate wine **{c['wine_id']}**: {c['title']} | "
                    f"{c['winery']} | `{c['existing_slug']}`."
                ),
                (
                    f"  Confidence: {c['confidence']}; "
                    f"fuzzy candidate score {c['fuzzy_title_score']}; "
                    f"contradictions: {', '.join(c['contradictions']) or 'none'}."
                ),
            ]
            for ev in c["evidence"]:
                lines.append(
                    "  Evidence: `"
                    + json.dumps(ev, ensure_ascii=False, sort_keys=True)
                    + "`."
                )
            for field in (*FIELDS, "sweetness"):
                comp = c["metadata_comparison"][field]
                if field == "sweetness":
                    comp = {
                        **comp,
                        "state": "different"
                        if comp["official"]
                        and comp["historical"]
                        and comp["official"] != comp["historical"]
                        else "equal",
                    }
                if comp["state"] == "different":
                    # Full values remain machine-readable; keep prose readable.
                    lines.append(
                        f"  {field}: official `{str(comp['official'])[:350]}`; "
                        f"historical `{str(comp['historical'])[:350]}`."
                    )
    lines += [
        "",
        "## Phase 3B2 prerequisites",
        "",
        (
            "Resolve manual-review rows and ambiguous many-to-one groups before "
            "writing them. Revalidate snapshot hashes, all three lookup aliases, "
            "and generated numeric-ID aliases in the write transaction. Preserve "
            "historical wine IDs/slugs/external IDs; this phase adds no wine_images "
            "or annotations."
        ),
        "",
    ]
    return "\n".join(lines).encode("utf-8")


def write_artifacts(rows, summary, output):
    output.mkdir(parents=True, exist_ok=True)
    artifacts = {
        "identity-plan.json": json_bytes(rows),
        "identity-summary.json": json_bytes(summary),
        "IDENTITY_REVIEW.md": review_markdown(rows, summary),
    }
    for name, value in artifacts.items():
        (output / name).write_bytes(value)
    return {
        name: hashlib.sha256(value).hexdigest() for name, value in artifacts.items()
    }


def add_image_hashes(snapshot, root):
    hashes = {}
    root = root.resolve(strict=True)
    for image in snapshot["wine_images"]:
        relative = image.get("local_path")
        if not relative:
            continue
        path = (root / relative).resolve()
        if root not in path.parents:
            raise ValueError("Historical image escapes root")
        if path.is_file():
            with path.open("rb") as stream:
                hashes[str(image["id"])] = hashlib.file_digest(
                    stream, "sha256"
                ).hexdigest()
    return {**snapshot, "historical_image_hashes": hashes}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--historical-root", type=Path)
    parser.add_argument("--expected-unmatched", type=int, default=264)
    args = parser.parse_args(argv)
    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    if args.historical_root:
        snapshot = add_image_hashes(snapshot, args.historical_root)
    rows, summary = build_plan(snapshot, expected_unmatched=args.expected_unmatched)
    hashes = write_artifacts(rows, summary, args.output_dir)
    print(
        json.dumps(
            {
                k: summary[k]
                for k in (
                    "re_slug",
                    "true_new",
                    "manual_review",
                    "alias_collision_count",
                    "many_to_one_candidate_count",
                )
            }
        )
    )
    print(json.dumps(hashes, sort_keys=True))


if __name__ == "__main__":
    main()
