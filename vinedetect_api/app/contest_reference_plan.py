"""Validate a complete, deterministic reference assignment plan without DB access."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from pathlib import Path, PurePosixPath
from typing import Any

from app.contest_media import canonical_catalog, inspect_file, json_bytes

DETERMINISTIC_METHODS = {
    "exact_filename",
    "normalized_unique",
    "shared_reference",
    "sha_equivalent",
    "historical_asset_exact",
    "historical_asset_normalized",
}
MANUAL_METHODS = {
    "confirmed_visual",
    "manual_equivalent",
    "manual_historical_fallback",
    "source_preserving_shared",
}
INCONSISTENT_SLUG = "zhemchuzhnaya-9-czitron-shardone"
RELATED_SLUG = "zhemchuzhnaya-9-aligote-czitron"
ASSET_FIELDS = ("filename", "sha256", "width", "height", "byte_size", "mime_type")
RASTER_STATUSES = {"header_only", "oversized"}


def digest(value: Any) -> str:
    return hashlib.sha256(json_bytes(value)).hexdigest()


def index_unique(rows, key, label):
    result = {}
    for row in rows:
        value = row.get(key)
        if value is None or value == "" or value in result:
            raise ValueError(f"{label}: missing or duplicate {key}: {value!r}")
        result[value] = row
    return result


def relative_name(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or "\\" in value
        or ":" in value
        or PurePosixPath(value).is_absolute()
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise ValueError(f"Unsafe relative path: {value!r}")
    return value


def selected_path(recommendation: str, candidates: list[dict]) -> str:
    """A bare basename must identify exactly one path inside this item's set."""
    relative_name(recommendation)
    paths = sorted({relative_name(c["relative_path"]) for c in candidates})
    if "/" in recommendation:
        matches = [path for path in paths if path == recommendation]
    else:
        matches = [path for path in paths if PurePosixPath(path).name == recommendation]
    if len(matches) != 1:
        raise ValueError(
            f"Candidate-scoped selection {recommendation!r} has {len(matches)} "
            "matches; global basename fallback is prohibited"
        )
    return matches[0]


def candidate_sets(review: dict, unresolved: dict) -> dict[str, dict]:
    scopes = {}
    for key, expected_class in (
        ("ambiguous_items", "ambiguous"),
        ("remaining_missing", "missing"),
    ):
        for item in review[key]:
            slug = item["official_slug"]
            if slug in scopes or slug not in unresolved:
                raise ValueError(f"Unexpected or duplicate review item: {slug}")
            source = unresolved[slug]
            if (
                item["photo_name"] != source["photo_name"]
                or source["match_class"] != expected_class
            ):
                raise ValueError(f"Review identity/class mismatch: {slug}")
            historical = item.get("historical_archive_matches", [])
            candidates = (
                item["candidates"]
                if expected_class == "ambiguous"
                else historical + item.get("diagnostic_candidates", [])
            )
            # Repeated evidence for one path is allowed only if metadata agrees.
            by_path = {}
            for candidate in candidates:
                path = relative_name(candidate["relative_path"])
                if path in by_path and any(
                    candidate.get(field) != by_path[path].get(field)
                    for field in ASSET_FIELDS
                ):
                    raise ValueError(f"Conflicting candidate metadata: {slug}: {path}")
                by_path[path] = candidate
            scopes[slug] = {
                "candidates": [by_path[path] for path in sorted(by_path)],
                "historical_paths": {c["relative_path"] for c in historical},
                "linked_wine_id": item.get("linked_wine_id"),
            }
    if set(scopes) != set(unresolved):
        raise ValueError(
            "Review candidate sets do not cover all unresolved catalog items"
        )
    return scopes


def validate_asset(root: Path, entry: dict) -> dict:
    path_name = relative_name(entry["relative_path"])
    if entry["filename"] != PurePosixPath(path_name).name:
        raise ValueError(f"Manifest filename/path mismatch: {path_name}")
    if (
        not entry["is_raster"]
        or entry["decode_status"] not in RASTER_STATUSES
        or not re.fullmatch(r"[0-9a-f]{64}", entry.get("sha256") or "")
        or not entry.get("mime_type", "").startswith("image/")
        or any(
            not isinstance(entry.get(k), int) or entry[k] <= 0
            for k in ("width", "height", "byte_size")
        )
    ):
        raise ValueError(f"Non-raster or unreadable manifest selection: {path_name}")
    path = root / path_name
    if not path.is_file():
        raise ValueError(f"Selected file does not exist: {path_name}")
    if root not in path.resolve().parents or any(
        part.is_symlink() for part in (path, *path.parents) if part != root
    ):
        raise ValueError(
            f"Selected file escapes snapshot or uses a symlink: {path_name}"
        )
    actual = inspect_file(path, path_name)
    if not actual["is_raster"] or actual["decode_status"] not in RASTER_STATUSES:
        raise ValueError(f"Selected raster is not header-readable: {path_name}")
    for field in (*ASSET_FIELDS, "format"):
        if actual[field] != entry[field]:
            raise ValueError(f"Manifest {field} mismatch: {path_name}")
    return actual


def build_plan(
    manifest, catalog, resolution, review, manual, media_root, *, expected_items=2103
):
    root = Path(media_root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Media root must be a directory")
    catalog = canonical_catalog(catalog)
    manifest = {
        **manifest,
        "files": sorted(manifest["files"], key=lambda row: row["relative_path"]),
    }
    items = index_unique(catalog["items"], "official_slug", "Catalog")
    index_unique(catalog["items"], "catalog_item_id", "Catalog")
    if len(items) != expected_items:
        raise ValueError(
            f"Full coverage requires {expected_items} catalog items; got {len(items)}"
        )
    if any(
        type(row["catalog_item_id"]) is not int or row["catalog_item_id"] <= 0
        for row in items.values()
    ):
        raise ValueError("Catalog item IDs must be positive integers")
    resolved = index_unique(resolution["items"], "official_slug", "Resolution")
    index_unique(resolution["items"], "catalog_item_id", "Resolution")
    if set(items) != set(resolved):
        raise ValueError("Resolution has missing or extra catalog items")
    for slug, item in items.items():
        if any(
            item[key] != resolved[slug][key]
            for key in ("catalog_item_id", "photo_name")
        ):
            raise ValueError(f"Resolution/catalog identity mismatch: {slug}")
    for key, expected in (
        ("manifest_sha256", digest(manifest)),
        ("catalog_sha256", digest(catalog)),
    ):
        if resolution.get(key) != expected or review["provenance"].get(key) != expected:
            raise ValueError(f"Artifact provenance {key} mismatch")
    assets = index_unique(manifest["files"], "relative_path", "Manifest")
    unresolved = {
        slug: row
        for slug, row in resolved.items()
        if row["match_class"] in {"ambiguous", "missing"}
    }
    scopes = candidate_sets(review, unresolved)
    if manual.get("schema_version") != "assistant-media-review/1":
        raise ValueError("Unsupported manual review schema")
    decisions = index_unique(
        manual["ambiguous_recommendations"] + manual["missing_recommendations"],
        "official_slug",
        "Manual decisions",
    )
    if set(decisions) != set(unresolved):
        raise ValueError(
            "Manual decisions must cover exactly the unresolved items; "
            "overrides are forbidden"
        )
    for key, expected_class in (
        ("ambiguous_recommendations", "ambiguous"),
        ("missing_recommendations", "missing"),
    ):
        if any(
            resolved[row["official_slug"]]["match_class"] != expected_class
            for row in manual[key]
        ):
            raise ValueError(f"Manual recommendation category mismatch: {key}")
    assignments, validated = [], {}
    for slug, item in sorted(items.items()):
        deterministic = resolved[slug]
        note, confidence, recommendation = None, None, None
        if slug in unresolved:
            decision = decisions[slug]
            method = decision["review_class"]
            if method not in MANUAL_METHODS:
                raise ValueError(
                    f"Unsupported manual resolution method: {slug}: {method}"
                )
            scope = scopes[slug]
            recommendation = decision["recommended_relative_path"]
            path = selected_path(recommendation, scope["candidates"])
            if method == "manual_historical_fallback" and (
                path not in scope["historical_paths"] or scope["linked_wine_id"] is None
            ):
                raise ValueError(
                    f"Manual historical fallback for {slug} "
                    "lacks item-scoped historical evidence"
                )
            candidate = next(
                c for c in scope["candidates"] if c["relative_path"] == path
            )
            if path not in assets or any(
                candidate.get(field) != assets[path].get(field)
                for field in ASSET_FIELDS
            ):
                raise ValueError(f"Review candidate/manifest mismatch: {slug}: {path}")
            note, confidence = decision.get("note"), decision.get("confidence")
            if note is not None and not isinstance(note, str):
                raise ValueError(f"Manual review note must be text: {slug}")
        else:
            method = deterministic["match_class"]
            if method not in DETERMINISTIC_METHODS:
                raise ValueError(
                    f"Unsupported deterministic resolution method: {slug}: {method}"
                )
            path = relative_name(deterministic["selected_relative_path"])
            if path not in assets or any(
                deterministic.get(field) != assets[path].get(field)
                for field in ("sha256", "width", "height", "byte_size")
            ):
                raise ValueError(f"Deterministic resolution/manifest mismatch: {slug}")
        if path not in validated:
            validated[path] = validate_asset(root, assets[path])
        asset = validated[path]
        assignments.append(
            {
                "catalog_item_id": item["catalog_item_id"],
                "official_slug": slug,
                "photo_name": item["photo_name"],
                "relative_path": path,
                "source_filename": asset["filename"],
                "sha256": asset["sha256"],
                "width": asset["width"],
                "height": asset["height"],
                "bytes": asset["byte_size"],
                "mime_type": asset["mime_type"],
                "resolution_method": method,
                "review_note": note,
                "review_confidence": confidence,
                "manual_recommendation": recommendation,
                "header_status": asset["decode_status"],
                "flags": [],
            }
        )
    index_unique(assignments, "catalog_item_id", "Final assignments")
    if len(assignments) != expected_items:
        raise ValueError("Final assignment coverage invariant failed")
    by_slug = {row["official_slug"]: row for row in assignments}
    inconsistencies = []
    if INCONSISTENT_SLUG in items:
        flagged = by_slug[INCONSISTENT_SLUG]
        peer = by_slug.get(RELATED_SLUG)
        if (
            peer is None
            or flagged["photo_name"] != peer["photo_name"]
            or flagged["sha256"] != peer["sha256"]
            or flagged["resolution_method"] != "source_preserving_shared"
        ):
            raise ValueError(
                "Organizer Citron/Chardonnay shared-image "
                "inconsistency was not preserved"
            )
        flagged["flags"].append("organizer_photo_title_inconsistency")
        inconsistencies.append(
            {
                "official_slug": INCONSISTENT_SLUG,
                "title": items[INCONSISTENT_SLUG].get("title"),
                "photo_name": flagged["photo_name"],
                "related_official_slug": RELATED_SLUG,
                "relative_path": flagged["relative_path"],
                "sha256": flagged["sha256"],
                "reason": (
                    "Organizer photo maps to Aligote/Citron "
                    "despite the Citron/Chardonnay title."
                ),
            }
        )
    paths, hashes = defaultdict(list), defaultdict(list)
    for row in assignments:
        paths[row["relative_path"]].append(row)
        hashes[row["sha256"]].append(row)
    shared_files = [
        {
            "relative_path": path,
            "sha256": rows[0]["sha256"],
            "catalog_item_ids": [r["catalog_item_id"] for r in rows],
            "official_slugs": [r["official_slug"] for r in rows],
        }
        for path, rows in sorted(paths.items())
        if len(rows) > 1
    ]
    shared_content = [
        {
            "sha256": sha,
            "relative_paths": sorted({r["relative_path"] for r in rows}),
            "catalog_item_ids": [r["catalog_item_id"] for r in rows],
            "official_slugs": [r["official_slug"] for r in rows],
        }
        for sha, rows in sorted(hashes.items())
        if len(rows) > 1
    ]
    duplicate_files = [
        group for group in shared_content if len(group["relative_paths"]) > 1
    ]
    counts = Counter(row["resolution_method"] for row in assignments)
    return {
        "schema_version": "contest-reference-plan/1",
        "import_run": catalog["import_run"],
        "provenance": {
            "hash_encoding": "SHA-256 of canonical UTF-8 JSON",
            "manifest_sha256": digest(manifest),
            "catalog_sha256": digest(catalog),
            "resolution_sha256": digest(resolution),
            "review_data_sha256": digest(review),
            "manual_review_sha256": digest(manual),
        },
        "summary": {
            "catalog_items": len(items),
            "selected_reference_assignments": len(assignments),
            "unresolved": 0,
            "deterministic_assignments": len(items) - len(unresolved),
            "manual_assignments": len(unresolved),
            "resolution_methods": {
                method: counts[method]
                for method in sorted(DETERMINISTIC_METHODS | MANUAL_METHODS)
            },
            "unique_physical_files": len(paths),
            "unique_sha256_content": len(hashes),
            "shared_file_groups": len(shared_files),
            "shared_content_groups": len(shared_content),
            "duplicate_selected_file_sha_groups": len(duplicate_files),
            "source_data_inconsistencies": len(inconsistencies),
            "validated_files_present": len(validated),
            "validated_raster_headers": len(validated),
            "validated_manifest_hashes": len(validated),
            "validation_failures": [],
        },
        "assignments": assignments,
        "shared_file_groups": shared_files,
        "shared_content_groups": shared_content,
        "duplicate_selected_file_sha_groups": duplicate_files,
        "source_data_inconsistencies": inconsistencies,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "manifest-json",
        "catalog-json",
        "resolution-json",
        "review-json",
        "manual-json",
    ):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--media-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    root, output = args.media_root.resolve(strict=True), args.output_dir.resolve()
    if output == root or root in output.parents:
        parser.error("Plan output must be outside the media snapshot")
    if output.exists() and any(output.iterdir()):
        parser.error("Use a new or empty plan output directory")
    inputs = [
        json.loads(path.read_text(encoding="utf-8-sig"))
        for path in (
            args.manifest_json,
            args.catalog_json,
            args.resolution_json,
            args.review_json,
            args.manual_json,
        )
    ]
    plan = build_plan(*inputs, root)
    output.mkdir(parents=True, exist_ok=True)
    (output / "reference-plan.json").write_bytes(json_bytes(plan))
    (output / "reference-plan-summary.json").write_bytes(json_bytes(plan["summary"]))
    print(json_bytes(plan["summary"]).decode(), end="")


if __name__ == "__main__":
    main()
