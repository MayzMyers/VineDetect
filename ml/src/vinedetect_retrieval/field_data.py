"""Immutable unlabeled inputs and portable, explicitly human-authored labels."""

from __future__ import annotations

import hashlib
import io
from collections import defaultdict
from pathlib import Path

from PIL import Image

from .artifacts import digest, read_json, write_json

STATUSES = (
    "unreviewed",
    "exact_confirmed",
    "family_confirmed",
    "ambiguous",
    "not_in_catalog",
    "unusable",
    "multi_bottle",
)
TAGS = (
    "small_bottle",
    "glare",
    "angle",
    "blur",
    "partial_occlusion",
    "shelf_background",
    "multiple_bottles",
    "redesign",
    "same_family_confusion",
    "vintage_confusion",
    "label_too_small",
    "other",
)
FORMATS = {"JPEG", "PNG", "WEBP"}


def field_path(root, stored):
    """A separate field namespace; never broaden the managed asset resolver."""
    if (
        not isinstance(stored, str)
        or "\\" in stored
        or ":" in stored
        or any(p in ("", ".", "..") for p in stored.split("/"))
    ):
        raise ValueError(f"Unsafe field path: {stored}")
    base = Path(root).resolve()
    path = (base / stored).resolve()
    if not path.is_relative_to(base):
        raise ValueError(f"Field path escapes root: {stored}")
    return path


def inspect_field_image(root, stored, sha=None, dimensions=None):
    raw = field_path(root, stored).read_bytes()
    actual = hashlib.sha256(raw).hexdigest()
    if sha is not None and actual != sha:
        raise ValueError(f"SHA-256 mismatch: {stored}")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            width, height = image.size
            if (
                image.format not in FORMATS
                or width <= 0
                or height <= 0
                or getattr(image, "n_frames", 1) != 1
            ):
                raise ValueError("Unsupported format, animation or invalid dimensions")
            info = {
                "sha256": actual,
                "width": width,
                "height": height,
                "mime_type": Image.MIME[image.format],
                "format": image.format,
            }
            rgb = image.convert("RGB")
    except (OSError, ValueError) as error:
        raise ValueError(f"Unreadable or unsupported field image: {stored}: {error}") from error
    if dimensions is not None and (width, height) != tuple(dimensions):
        raise ValueError(f"Dimension mismatch: {stored}")
    return info, rgb


def build_field_manifest(raw_root, gallery, expected_count=None):
    root = Path(raw_root)
    files = sorted(
        p.relative_to(root).as_posix()
        for p in root.rglob("*")
        if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    )
    if not files or (expected_count is not None and len(files) != expected_count):
        raise ValueError(f"Field count {len(files)} does not match expected {expected_count}")
    rows, duplicates = [], defaultdict(list)
    for stored in files:
        info, _ = inspect_field_image(root, stored)
        identity = "field-" + digest({"relative_source_path": stored, "sha256": info["sha256"]})
        rows.append(
            {
                "field_image_id": identity,
                "original_filename": Path(stored).name,
                "relative_source_path": stored,
                **info,
                "source_dataset": "people_and_wine_public",
                "label_status": "unreviewed",
                "expected_slug": None,
            }
        )
        duplicates[info["sha256"]].append(identity)
    return {
        "schema_version": "siglip-field-manifest/1",
        "dataset_type": "field_real_world",
        "gallery_sha256": digest(gallery["rows"]),
        "row_count": len(rows),
        "files_found": len(files),
        "successfully_decoded": len(rows),
        "decode_failures": [],
        "rows": rows,
        "duplicate_sha256_groups": [
            {"sha256": sha, "field_image_ids": ids}
            for sha, ids in sorted(duplicates.items())
            if len(ids) > 1
        ],
    }


def empty_labels(manifest):
    return {
        "schema_version": "siglip-field-labels/1",
        "dataset_type": "field_real_world",
        "manifest_sha256": digest(manifest),
        "gallery_sha256": manifest["gallery_sha256"],
        "rows": [
            {
                "field_image_id": row["field_image_id"],
                "status": "unreviewed",
                "catalog_item_id": None,
                "official_slug": None,
                "candidate_catalog_ids": [],
                "note": None,
                "tags": [],
            }
            for row in manifest["rows"]
        ],
    }


def validate_labels(labels, manifest, gallery):
    if (
        labels.get("schema_version") != "siglip-field-labels/1"
        or labels.get("dataset_type") != "field_real_world"
        or labels.get("manifest_sha256") != digest(manifest)
        or labels.get("gallery_sha256") != digest(gallery["rows"])
    ):
        raise ValueError("Label schema, field or gallery snapshot differs")
    rows = labels.get("rows")
    expected = {r["field_image_id"] for r in manifest["rows"]}
    if (
        not isinstance(rows, list)
        or len(rows) != len(expected)
        or {r.get("field_image_id") for r in rows} != expected
    ):
        raise ValueError("Labels must represent every field identity exactly once")
    catalog = {r["catalog_item_id"]: r["official_slug"] for r in gallery["rows"]}
    for row in rows:
        if row.get("status") not in STATUSES:
            raise ValueError("Unknown review status")
        target = row.get("catalog_item_id")
        if row["status"] == "exact_confirmed":
            if (
                type(target) is not int
                or target not in catalog
                or row.get("official_slug") != catalog[target]
            ):
                raise ValueError("Exact catalog ID and slug must match the same gallery row")
        elif target is not None or row.get("official_slug") is not None:
            raise ValueError("Only exact_confirmed may carry an exact target")
        candidates, tags = row.get("candidate_catalog_ids"), row.get("tags")
        if (
            not isinstance(candidates, list)
            or any(type(c) is not int or c not in catalog for c in candidates)
            or len(set(candidates)) != len(candidates)
        ):
            raise ValueError("Invalid candidate catalog IDs")
        if (
            not isinstance(tags, list)
            or any(t not in TAGS for t in tags)
            or len(set(tags)) != len(tags)
        ):
            raise ValueError("Invalid human reviewer tags")
        if row.get("note") is not None and not isinstance(row["note"], str):
            raise ValueError("Reviewer note must be text or null")
    return labels


def ensure_labels(path, manifest, gallery):
    if Path(path).exists():
        return validate_labels(read_json(path), manifest, gallery)
    labels = empty_labels(manifest)
    validate_labels(labels, manifest, gallery)
    write_json(path, labels)
    return labels
