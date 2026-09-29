"""Filename-based logical source groups, independent of frozen embedding manifests."""

from __future__ import annotations

from collections import Counter, defaultdict
from pathlib import PurePosixPath

from .artifacts import digest

EVALUATION_MODES = ("primary_field", "low_resolution_robustness")
GROUPING_POLICY = (
    "Within each relative directory, strip one terminal _thumb suffix (case-insensitive) "
    "from the filename stem and ignore the format extension; retain stem/directory case. "
    "A paired non-thumb is original; an unpaired non-thumb is standalone. "
    "Orphan thumbnails remain thumb and are excluded from primary_field. "
    "Multiple files for the same source/variant are rejected, never silently deduplicated."
)


def build_source_groups(manifest):
    if manifest["dataset_type"] != "field_real_world":
        raise ValueError("Source grouping requires a field_real_world manifest")
    rows = manifest["rows"]
    if manifest["row_count"] != len(rows) or len({r["field_image_id"] for r in rows}) != len(rows):
        raise ValueError("Field manifest count/identities differ")
    sources = defaultdict(lambda: {"primary": [], "thumb": []})
    for row in rows:
        stored = row["relative_source_path"]
        if "\\" in stored or ":" in stored or any(p in ("", ".", "..") for p in stored.split("/")):
            raise ValueError(f"Unsafe source grouping path: {stored}")
        path = PurePosixPath(stored)
        thumb = path.stem.lower().endswith("_thumb")
        stem = path.stem[:-6] if thumb else path.stem
        if not stem:
            raise ValueError(f"Empty source stem: {stored}")
        key = (row["source_dataset"], (path.parent / stem).as_posix())
        sources[key]["thumb" if thumb else "primary"].append(row)
    assignments, groups = [], []
    for (dataset, source_key), members in sorted(sources.items()):
        if any(len(v) > 1 for v in members.values()):
            raise ValueError(f"Ambiguous source/variant filenames: {source_key}")
        group_id = "source-" + digest(
            {"source_dataset": dataset, "relative_source_stem": source_key}
        )
        both = bool(members["primary"] and members["thumb"])
        group_rows = []
        for kind in ("primary", "thumb"):
            for row in members[kind]:
                variant = "thumb" if kind == "thumb" else "original" if both else "standalone"
                group_rows.append(
                    {
                        "field_image_id": row["field_image_id"],
                        "relative_source_path": row["relative_source_path"],
                        "source_group_id": group_id,
                        "variant": variant,
                    }
                )
        for row in group_rows:
            row["paired_field_image_id"] = next(
                (r["field_image_id"] for r in group_rows if r is not row), None
            )
        assignments.extend(group_rows)
        groups.append(
            {
                "source_group_id": group_id,
                "source_dataset": dataset,
                "relative_source_stem": source_key,
                "has_original_and_thumb": both,
                "primary_field_image_id": members["primary"][0]["field_image_id"]
                if members["primary"]
                else None,
                "field_image_ids": [r["field_image_id"] for r in group_rows],
            }
        )
    assignments.sort(key=lambda r: (r["relative_source_path"], r["field_image_id"]))
    counts = Counter(r["variant"] for r in assignments)
    return {
        "schema_version": "siglip-field-source-groups/1",
        "dataset_type": "field_real_world",
        "manifest_sha256": digest(manifest),
        "policy": GROUPING_POLICY,
        "summary": {
            "total_files": len(rows),
            "source_groups": len(groups),
            "original": counts["original"],
            "thumb": counts["thumb"],
            "standalone": counts["standalone"],
            "groups_with_both_original_and_thumb": sum(g["has_original_and_thumb"] for g in groups),
            "orphan_thumb_groups": sum(g["primary_field_image_id"] is None for g in groups),
            "primary_images": counts["original"] + counts["standalone"],
        },
        "rows": assignments,
        "groups": groups,
    }


def validate_source_groups(grouping, manifest):
    # Validate membership, pairing, variants, stable IDs, and snapshot in one comparison.
    if grouping != build_source_groups(manifest):
        raise ValueError("Source grouping differs from the field manifest or filename policy")
    return grouping


def grouping_for(manifest, grouping=None):
    return (
        build_source_groups(manifest)
        if grouping is None
        else validate_source_groups(grouping, manifest)
    )


def mode_includes(variant, mode):
    if mode not in EVALUATION_MODES:
        raise ValueError(f"Unknown field evaluation mode: {mode}")
    if variant not in ("original", "standalone", "thumb"):
        raise ValueError(f"Unknown field variant: {variant}")
    return variant in ("original", "standalone") if mode == "primary_field" else variant == "thumb"
