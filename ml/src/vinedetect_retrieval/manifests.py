"""Read-only official gallery and conservative historical proxy manifests."""

from __future__ import annotations

from collections import Counter, defaultdict
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from .artifacts import CONTEST, digest, inspect_image, write_json

GALLERY_SQL = """
SELECT c.id AS catalog_item_id,c.official_slug,w.id AS wine_id,
'svoe_vino' AS source,COALESCE(w.external_id,w.slug,w.id::text) AS source_item_id,
l.method AS link_method,l.provenance AS link_provenance,
c.title,c.winery,c.region,c.category,c.color,c.grapes,c.description,
w.manufacturer_name AS historical_manufacturer,
a.id AS reference_asset_id,a.local_path AS reference_path,a.sha256 AS reference_sha256,
a.width,a.height,a.mime_type,a.resolution_method,a.provenance AS reference_provenance,a.review_note
FROM contest.effective_catalog_items c
JOIN contest.import_runs run ON run.id=c.import_run_id AND run.status='completed'
JOIN contest.item_links l ON l.catalog_item_id=c.id
JOIN contest.reference_assets a ON a.catalog_item_id=c.id
JOIN svoe_vino.wines w ON w.id=l.wine_id
WHERE run.version=%s ORDER BY c.id,a.id
"""
HISTORICAL_SQL = """
SELECT c.id AS catalog_item_id,im.id AS historical_image_id,im.wine_id AS historical_wine_id,
im.local_path AS historical_local_path
FROM contest.catalog_items c
JOIN contest.import_runs run ON run.id=c.import_run_id AND run.status='completed'
JOIN contest.item_links l ON l.catalog_item_id=c.id AND l.method='exact_slug'
JOIN svoe_vino.wine_images im ON im.wine_id=l.wine_id
WHERE run.version=%s AND im.local_path IS NOT NULL
ORDER BY c.id,im.id
"""


def validate_gallery(rows, root: Path, expected_count=2103, expected_distinct_sha=2074):
    ordered = sorted(rows, key=lambda r: r["catalog_item_id"])
    if len(rows) != expected_count or len({r["catalog_item_id"] for r in rows}) != len(rows):
        raise ValueError(f"Expected {expected_count} unique official assignments")
    if len({r["official_slug"] for r in rows}) != len(rows):
        raise ValueError("Duplicate official slug")
    if len({r["reference_sha256"] for r in rows}) != expected_distinct_sha:
        raise ValueError(f"Expected {expected_distinct_sha} physical reference SHA identities")
    for row in ordered:
        info, _ = inspect_image(
            root, row["reference_path"], row["reference_sha256"], (row["width"], row["height"])
        )
        if info["mime_type"] != row["mime_type"]:
            raise ValueError(f"MIME mismatch for {row['catalog_item_id']}")
    return ordered


def ambiguities(rows):
    """Connected groups from exact physical evidence and recorded source issues.

    This does not infer visual equivalence from titles, embeddings or near hashes.
    Singleton known source inconsistencies remain explicit review groups.
    """
    rows = sorted(rows, key=lambda r: r["catalog_item_id"])
    by_id = {r["catalog_item_id"]: r for r in rows}
    parent = {key: key for key in by_id}
    reasons = defaultdict(list)

    def find(key):
        while parent[key] != key:
            key = parent[key]
        return key

    evidence_groups = {}
    for field in ("reference_sha256", "reference_path"):
        buckets = defaultdict(list)
        for row in rows:
            buckets[row[field]].append(row["catalog_item_id"])
        evidence_groups[field] = []
        for value, ids in sorted(buckets.items()):
            if len(ids) < 2:
                continue
            evidence_groups[field].append({"value": value, "catalog_item_ids": ids})
            for key in ids:
                parent[find(key)] = find(ids[0])
                reasons[key].append(
                    "duplicate_sha256" if field == "reference_sha256" else "shared_physical_path"
                )
    for row in rows:
        key = row["catalog_item_id"]
        prov = row.get("reference_provenance") or {}
        if row["resolution_method"] in ("shared_reference", "source_preserving_shared"):
            reasons[key].append(row["resolution_method"])
        if prov.get("source_data_inconsistencies"):
            reasons[key].append("organizer_source_inconsistency")
        if prov.get("flags"):
            reasons[key].append("recorded_reference_flags")
        # Retain explicit historical review evidence about organizer mismatches.
        notes = " ".join(
            [
                row.get("review_note") or "",
                str((row.get("link_provenance") or {}).get("review_evidence", {}).get("note", "")),
            ]
        ).lower()
        if any(word in notes for word in ("inconsisten", "mismatch", "wrong label")):
            reasons[key].append("organizer_source_inconsistency")
    components = defaultdict(list)
    for key in by_id:
        components[find(key)].append(key)
    groups = []
    for ids in sorted(components.values(), key=lambda ids: ids[0]):
        if not any(reasons[key] for key in ids):
            continue
        groups.append(
            {
                "group_id": "ambiguity-" + "-".join(map(str, ids)),
                "catalog_item_ids": ids,
                "reasons": sorted({reason for key in ids for reason in reasons[key]}),
                "members": [
                    {**by_id[key], "ambiguity_reasons": sorted(set(reasons[key]))} for key in ids
                ],
            }
        )
    return {
        "schema_version": "siglip-ambiguity/1",
        "gallery_sha256": digest(rows),
        "policy": "Official identities are never collapsed. Only identical SHA is equivalent for diagnostic metrics.",
        "group_count": len(groups),
        "groups": groups,
        "duplicate_sha256_groups": evidence_groups["reference_sha256"],
        "shared_physical_path_groups": evidence_groups["reference_path"],
    }


def proxy_rows(gallery, historical, root):
    by_id = {r["catalog_item_id"]: r for r in gallery}
    included, excluded = [], []
    for item in sorted(historical, key=lambda r: (r["catalog_item_id"], r["historical_image_id"])):
        row = by_id[item["catalog_item_id"]]
        if row["link_method"] != "exact_slug":
            raise ValueError("Proxy rows must use exact_slug links")
        if item["historical_wine_id"] != row["wine_id"]:
            raise ValueError("Historical image wine identity differs from the catalog link")
        try:
            info, _ = inspect_image(root, item["historical_local_path"])
        except (OSError, ValueError) as error:
            excluded.append({**item, "reason": str(error)})
            continue
        included.append(
            {
                **item,
                "query_id": f"{row['catalog_item_id']}:{item['historical_image_id']}",
                "dataset_type": "proxy_same_source",
                "official_slug": row["official_slug"],
                "expected_catalog_item_id": row["catalog_item_id"],
                "wine_id": row["wine_id"],
                "historical_sha256": info["sha256"],
                "historical_width": info["width"],
                "historical_height": info["height"],
                "official_reference_sha256": row["reference_sha256"],
                "official_width": row["width"],
                "official_height": row["height"],
                "byte_identical": info["sha256"] == row["reference_sha256"],
            }
        )
    return included, excluded


def build_manifests(dsn: str, root: Path, output: Path):
    # PostgreSQL enforces read-only at connection and transaction level.
    with psycopg.connect(
        dsn, row_factory=dict_row, options="-c default_transaction_read_only=on"
    ) as db:
        db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        if db.execute("SHOW transaction_read_only").fetchone()["transaction_read_only"] != "on":
            raise RuntimeError("Database connection must be read-only")
        gallery = db.execute(GALLERY_SQL, (CONTEST,)).fetchall()
        historical = db.execute(HISTORICAL_SQL, (CONTEST,)).fetchall()
        counts = {
            name: db.execute(f"SELECT count(*) AS n FROM {name}").fetchone()["n"]
            for name in (
                "contest.catalog_items",
                "contest.reference_assets",
                "contest.item_links",
                "svoe_vino.wines",
                "svoe_vino.wine_images",
            )
        }
    expected = [2103, 2103, 2103, 2114, 1866]
    if list(counts.values()) != expected:
        raise ValueError(f"Unexpected source counts: {counts}")
    gallery = validate_gallery(gallery, root)
    methods = dict(sorted(Counter(r["link_method"] for r in gallery).items()))
    if methods != {"exact_slug": 1839, "re_slug": 16, "materialized_official": 248}:
        raise ValueError(f"Unexpected link coverage: {methods}")
    queries, exclusions = proxy_rows(gallery, historical, root)
    gallery_manifest = {
        "schema_version": "siglip-gallery/1",
        "dataset_type": "official_gallery",
        "contest_version": CONTEST,
        "counts": counts,
        "link_methods": methods,
        "row_count": len(gallery),
        "rows": gallery,
    }
    proxy_manifest = {
        "schema_version": "siglip-proxy/1",
        "dataset_type": "proxy_same_source",
        "warning": "Sanity benchmark only; not expected contest or field-photo accuracy.",
        "gallery_sha256": digest(gallery),
        "row_count": len(queries),
        "rows": queries,
        "excluded_unusable_images": exclusions,
    }
    ambiguity = ambiguities(gallery)
    write_json(output / "gallery-manifest.json", gallery_manifest)
    write_json(output / "proxy-query-manifest.json", proxy_manifest)
    write_json(output / "ambiguity-manifest.json", ambiguity)
    # Training policy is a separate artifact; inference/proxy evaluator inputs stay intact.
    from .training import build_training_dataset

    training = build_training_dataset(gallery_manifest, proxy_manifest)
    write_json(output / "training-dataset.json", training)
    write_json(output / "training-policy-report.json", training["policy"])
    return {
        "gallery_rows": len(gallery),
        "physical_sha_identities": len({r["reference_sha256"] for r in gallery}),
        "proxy_queries": len(queries),
        "excluded_proxy_images": len(exclusions),
        "ambiguity_groups": ambiguity["group_count"],
        "duplicate_sha_groups": len(ambiguity["duplicate_sha256_groups"]),
        "read_only": True,
    }
