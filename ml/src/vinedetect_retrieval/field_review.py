"""Self-contained static human review, with previews and explicit JSON export."""

from __future__ import annotations

import io
import json
from pathlib import Path
from urllib.parse import quote

from PIL import Image

from .artifacts import atomic_write, digest, inspect_image
from .field_data import STATUSES, TAGS, inspect_field_image, validate_labels
from .field_groups import grouping_for


def preview(image, target, size):
    image = image.copy()
    image.thumbnail(size, Image.Resampling.LANCZOS)
    stream = io.BytesIO()
    image.save(stream, format="JPEG", quality=90, optimize=True)
    data = stream.getvalue()
    if not target.exists() or target.read_bytes() != data:
        atomic_write(target, data)


def build_review(
    manifest, gallery, retrieval, labels, raw_root, asset_root, output, *, grouping=None
):
    validate_labels(labels, manifest, gallery)
    grouping = grouping_for(manifest, grouping)
    group_rows = {r["field_image_id"]: r for r in grouping["rows"]}
    if retrieval["manifest_sha256"] != digest(manifest) or retrieval["gallery_sha256"] != digest(
        gallery["rows"]
    ):
        raise ValueError("Review retrieval snapshot differs")
    fields = {r["field_image_id"]: r for r in manifest["rows"]}
    targets = {r["catalog_item_id"]: r for r in gallery["rows"]}
    results = retrieval["results"]
    if len(results) != len(fields) or {r["field_image_id"] for r in results} != set(fields):
        raise ValueError("Review must include every field identity exactly once")
    output = Path(output)
    displayed = set()
    records = []
    for result in results:
        row = fields[result["field_image_id"]]
        _, image = inspect_field_image(
            raw_root, row["relative_source_path"], row["sha256"], (row["width"], row["height"])
        )
        filename = row["field_image_id"] + ".jpg"
        preview(image, output / "assets/field" / filename, (1200, 1200))
        # Relative links allow full original inspection without copying or mutating bytes.
        import os

        original = quote(
            Path(os.path.relpath(Path(raw_root) / row["relative_source_path"], output)).as_posix(),
            safe="/",
        )
        candidates = []
        for rank, item in enumerate(result["top_10"], 1):
            target = targets[item["catalog_item_id"]]
            if (
                item["official_slug"] != target["official_slug"]
                or item["reference_path"] != target["reference_path"]
                or item["reference_sha256"] != target["reference_sha256"]
                or item["rank"] != rank
            ):
                raise ValueError("Candidate identity/reference mapping differs")
            sha = target["reference_sha256"]
            if sha not in displayed:
                _, reference = inspect_image(
                    asset_root, target["reference_path"], sha, (target["width"], target["height"])
                )
                preview(reference, output / "assets/gallery" / (sha + ".jpg"), (600, 800))
                displayed.add(sha)
            candidates.append({**item, "preview": "assets/gallery/" + sha + ".jpg"})
        records.append(
            {
                **result,
                **group_rows[row["field_image_id"]],
                "preview": "assets/field/" + filename,
                "original": original,
                "top_10": candidates,
            }
        )
    payload = {
        "records": records,
        "grouping_summary": grouping["summary"],
        "labels": labels,
        "statuses": STATUSES,
        "tags": TAGS,
        "catalog": [
            {
                "catalog_item_id": r["catalog_item_id"],
                "official_slug": r["official_slug"],
                "title": r.get("title"),
            }
            for r in gallery["rows"]
        ],
    }
    encoded = (
        json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False)
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("&", "\\u0026")
    )
    template = Path(__file__).with_name("field_review.html").read_text(encoding="utf-8-sig")
    atomic_write(output / "index.html", template.replace("__FIELD_DATA__", encoded).encode("utf-8"))
    return {
        "review_count": len(records),
        "default_primary_count": grouping["summary"]["primary_images"],
        "grouping_summary": grouping["summary"],
        "field_previews": len(records),
        "unique_gallery_previews": len(displayed),
        "html": str(output / "index.html"),
        "labels_modified": False,
    }
