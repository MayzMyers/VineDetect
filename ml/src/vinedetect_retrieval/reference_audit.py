"""Read-only diagnostics for the immutable Phase 4A official reference gallery."""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import io
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import quote

import numpy as np
from PIL import Image, ImageOps

from .artifacts import asset_path, digest, read_json, write_json
from .embeddings import load_bundle
from .encoder import MODEL_ID, MODEL_REVISION, SiglipEncoder

POSITIVE_PROMPTS = (
    "a product photo of a wine bottle with a visible wine label",
    "a wine bottle photographed for a product catalog",
    "a close-up photograph of a wine bottle label",
)
NEGATIVE_PROMPTS = (
    "a glass of wine",
    "wine being served in a glass",
    "a vineyard landscape",
    "a decorative lifestyle wine photograph",
    "a restaurant table",
    "food",
    "people",
    "a logo",
    "an illustration",
    "an abstract decorative image",
)
KNOWN_BAD = {1681}
STATUS_VALUES = {
    "pending_review",
    "confirmed_bad",
    "replacement_confirmed",
    "false_positive",
    "unresolved",
}


def rounded(value):
    return None if value is None else round(float(value), 8)


def prompt_diagnostics(images, positive, negative):
    """Return transparent per-prompt cosine scores; never make replacement decisions."""
    images = np.asarray(images, dtype=np.float32)
    positive = np.asarray(positive, dtype=np.float32)
    negative = np.asarray(negative, dtype=np.float32)
    if (
        images.ndim != 2
        or positive.ndim != 2
        or negative.ndim != 2
        or images.shape[1] != positive.shape[1]
        or images.shape[1] != negative.shape[1]
    ):
        raise ValueError("Image and text feature dimensions differ")
    if (
        not np.isfinite(images).all()
        or not np.isfinite(positive).all()
        or not np.isfinite(negative).all()
    ):
        raise ValueError("Diagnostic features must be finite")
    product = images @ positive.T
    non_product = images @ negative.T
    return {
        "product": product,
        "non_product": non_product,
        "product_mean": product.mean(axis=1),
        "product_max": product.max(axis=1),
        "non_product_mean": non_product.mean(axis=1),
        "non_product_max": non_product.max(axis=1),
        "contrast": product.mean(axis=1) - non_product.mean(axis=1),
    }


def historical_diagnostics(gallery, gallery_rows, queries, query_rows, evaluation):
    """Compare every historical query with its expected official reference."""
    if gallery.ndim != 2 or queries.ndim != 2 or gallery.shape[1] != queries.shape[1]:
        raise ValueError("Historical and gallery feature dimensions differ")
    positions = {row["catalog_item_id"]: index for index, row in enumerate(gallery_rows)}
    eval_rows = {row["query_row_id"]: row for row in evaluation.get("results", [])}
    grouped = defaultdict(list)
    for vector, row in zip(queries, query_rows, strict=True):
        catalog_id = row["catalog_item_id"]
        if catalog_id not in positions:
            raise ValueError(f"Historical target missing from gallery: {catalog_id}")
        evaluation_row = eval_rows.get(row["row_id"])
        grouped[catalog_id].append(
            {
                "query_row_id": row["row_id"],
                "historical_image_id": row.get("historical_image_id"),
                "historical_path": row.get("path"),
                "historical_sha256": row.get("sha256"),
                "self_similarity": rounded(vector @ gallery[positions[catalog_id]]),
                "expected_rank": evaluation_row.get("strict_rank") if evaluation_row else None,
                "diagnostic_visual_equivalence_rank": evaluation_row.get(
                    "diagnostic_visual_equivalence_rank"
                )
                if evaluation_row
                else None,
            }
        )
    result = {}
    for catalog_id, observations in grouped.items():
        observations.sort(key=lambda row: row["query_row_id"])
        similarities = [row["self_similarity"] for row in observations]
        ranks = [row["expected_rank"] for row in observations if row["expected_rank"] is not None]
        result[catalog_id] = {
            "query_count": len(observations),
            "self_similarity_min": rounded(min(similarities)),
            "self_similarity_mean": rounded(sum(similarities) / len(similarities)),
            "self_similarity_max": rounded(max(similarities)),
            "expected_rank_best": min(ranks) if ranks else None,
            "expected_rank_worst": max(ranks) if ranks else None,
            "observations": observations,
        }
    return result


def percentile(values, value):
    ordered = np.sort(np.asarray(values, dtype=np.float64))
    return float(np.searchsorted(ordered, value, side="right") / len(ordered))


def _vintage_marked(row):
    text = " ".join(str(row.get(key) or "") for key in ("title", "official_slug", "description"))
    return bool(re.search(r"\b(?:19|20)\d{2}\b", text))


def build_audit_rows(gallery_rows, prompt_scores, historical):
    """Build deterministic human-review priorities from diagnostic signals."""
    if len(gallery_rows) != len(prompt_scores["contrast"]):
        raise ValueError("Gallery and prompt diagnostic row counts differ")
    sha_counts = Counter(row["sha256"] for row in gallery_rows)
    path_counts = Counter(row["path"] for row in gallery_rows)
    style_risk_values = -np.asarray(prompt_scores["contrast"])
    historical_values = [details["self_similarity_min"] for details in historical.values()]
    rank_values = [
        details["expected_rank_worst"]
        for details in historical.values()
        if details["expected_rank_worst"] is not None
    ]
    rows = []
    for index, base in enumerate(gallery_rows):
        catalog_id = base["catalog_item_id"]
        details = historical.get(catalog_id)
        style_risk = percentile(style_risk_values, style_risk_values[index])
        historical_risk = (
            percentile([-value for value in historical_values], -details["self_similarity_min"])
            if details
            else 0.0
        )
        rank_risk = (
            percentile(rank_values, details["expected_rank_worst"])
            if details and details["expected_rank_worst"] is not None
            else 0.0
        )
        width, height = base["width"], base["height"]
        aspect = width / height
        method = base.get("resolution_method")
        reasons = []
        categories = []
        if catalog_id in KNOWN_BAD:
            reasons.append("known_confirmed_bad_lifestyle_reference")
            categories.append("likely_bad_reference")
        if style_risk >= 0.95:
            reasons.append("low_product_high_non_product_prompt_contrast")
        if prompt_scores["non_product_max"][index] >= np.quantile(
            prompt_scores["non_product_max"], 0.95
        ):
            reasons.append("high_non_product_prompt_score")
        if aspect > 1.05:
            reasons.append("landscape_or_wide_reference")
        elif aspect < 0.22 or aspect > 2.0:
            reasons.append("unusual_aspect_ratio")
        provenance = base.get("reference_provenance") or {}
        source_name = " ".join(
            str(value or "")
            for value in (
                provenance.get("source_relative_path"),
                provenance.get("photo_name"),
                base.get("path"),
            )
        ).lower()
        if any(
            token in source_name for token in ("generated_image", "generated image", "screenshot")
        ):
            reasons.append("generic_generated_or_screenshot_filename")
        if details and historical_risk >= 0.95:
            reasons.append("historical_self_similarity_outlier")
        if details and rank_risk >= 0.95 and details["expected_rank_worst"] > 10:
            reasons.append("poor_expected_rank_against_historical_image")
        if sha_counts[base["sha256"]] > 1:
            reasons.append("shared_physical_sha")
            categories.append("identical_shared_reference_ambiguity")
        if path_counts[base["path"]] > 1:
            reasons.append("reused_reference_path")
        if method in {
            "shared_reference",
            "source_preserving_shared",
            "manual_equivalent",
            "manual_historical_fallback",
            "historical_asset_exact",
            "historical_asset_normalized",
        }:
            reasons.append(f"resolution_method_{method}")
        if provenance.get("source_data_inconsistencies"):
            reasons.append("recorded_source_inconsistency")
        if details and historical_risk >= 0.9:
            if _vintage_marked(base):
                categories.append("possible_vintage_redesign")
            elif details["expected_rank_best"] is not None and details["expected_rank_best"] <= 10:
                categories.append("possible_label_redesign")
            elif details["expected_rank_worst"] and details["expected_rank_worst"] > 100:
                categories.append("historical_image_mismatch")
        if "low_product_high_non_product_prompt_contrast" in reasons and (
            "landscape_or_wide_reference" in reasons or style_risk >= 0.99
        ):
            categories.append("likely_bad_reference")
        metadata_risk = min(
            1.0,
            0.18 * ("landscape_or_wide_reference" in reasons)
            + 0.12 * ("generic_generated_or_screenshot_filename" in reasons)
            + 0.12 * ("recorded_source_inconsistency" in reasons)
            + 0.08 * ("shared_physical_sha" in reasons),
        )
        combined = (
            0.58 * style_risk
            + (0.24 * historical_risk if details else 0.0)
            + (0.12 * rank_risk if details else 0.0)
            + metadata_risk
        )
        if catalog_id in KNOWN_BAD:
            combined = max(combined, 1.0)
        rows.append(
            {
                "catalog_item_id": catalog_id,
                "official_slug": base["official_slug"],
                "title": base.get("title"),
                "winery": base.get("winery"),
                "wine_id": base.get("wine_id"),
                "current_reference_asset_id": base.get("reference_asset_id"),
                "current_reference_path": base["path"],
                "sha256": base["sha256"],
                "width": width,
                "height": height,
                "aspect_ratio": rounded(aspect),
                "resolution": {
                    "method": method,
                    "provenance": provenance,
                    "review_note": base.get("review_note"),
                },
                "product_photo_scores": {
                    "by_prompt": {
                        prompt: rounded(prompt_scores["product"][index, prompt_index])
                        for prompt_index, prompt in enumerate(POSITIVE_PROMPTS)
                    },
                    "mean": rounded(prompt_scores["product_mean"][index]),
                    "max": rounded(prompt_scores["product_max"][index]),
                },
                "negative_prompt_scores": {
                    "by_prompt": {
                        prompt: rounded(prompt_scores["non_product"][index, prompt_index])
                        for prompt_index, prompt in enumerate(NEGATIVE_PROMPTS)
                    },
                    "mean": rounded(prompt_scores["non_product_mean"][index]),
                    "max": rounded(prompt_scores["non_product_max"][index]),
                },
                "product_minus_non_product_mean": rounded(prompt_scores["contrast"][index]),
                "historical": details,
                "duplicate_shared_reference": {
                    "sha_assignment_count": sha_counts[base["sha256"]],
                    "path_assignment_count": path_counts[base["path"]],
                },
                "suspicion_reasons": sorted(set(reasons)),
                "diagnostic_categories": sorted(set(categories)),
                "combined_diagnostic_priority": rounded(min(1.0, combined)),
            }
        )
    rows.sort(
        key=lambda row: (
            row["catalog_item_id"] not in KNOWN_BAD,
            -row["combined_diagnostic_priority"],
            row["catalog_item_id"],
        )
    )
    for position, row in enumerate(rows, 1):
        score = row["combined_diagnostic_priority"]
        if row["catalog_item_id"] in KNOWN_BAD or score >= 0.85:
            level = "high"
        elif score >= 0.70:
            level = "medium"
        elif score >= 0.55 or row["suspicion_reasons"]:
            level = "low"
        else:
            level = "none"
        row["diagnostic_rank"] = position
        row["priority_level"] = level
    return rows


def changed_sha_catalog_ids(old_rows, new_rows):
    old = {row["catalog_item_id"]: row["sha256"] for row in old_rows}
    new = {row["catalog_item_id"]: row["sha256"] for row in new_rows}
    if set(old) != set(new):
        raise ValueError("Gallery identity set changed")
    return [catalog_id for catalog_id in sorted(old) if old[catalog_id] != new[catalog_id]]


def v2_reuse_plan(old_rows, new_rows, old_vectors, *, model_config_sha256):
    changed = changed_sha_catalog_ids(old_rows, new_rows)
    if old_vectors.shape[0] != len(old_rows):
        raise ValueError("Old gallery vectors do not match row mapping")
    positions = {row["catalog_item_id"]: index for index, row in enumerate(old_rows)}
    reusable = [
        row["catalog_item_id"]
        for row in new_rows
        if row["sha256"] == old_rows[positions[row["catalog_item_id"]]]["sha256"]
    ]
    return {
        "schema_version": "siglip-gallery-v2-reuse-plan/1",
        "model_config_sha256": model_config_sha256,
        "row_count": len(new_rows),
        "reused_catalog_item_ids": sorted(reusable),
        "reused_count": len(reusable),
        "inference_required_catalog_item_ids": changed,
        "inference_required_count": len(changed),
    }


def file_fingerprints(paths):
    result = {}
    for supplied in paths:
        path = Path(supplied)
        files = sorted(p for p in ([path] if path.is_file() else path.rglob("*")) if p.is_file())
        for file in files:
            raw = file.read_bytes()
            result[str(file.resolve())] = {
                "sha256": hashlib.sha256(raw).hexdigest(),
                "bytes": len(raw),
            }
    return result


def guard_audit_output(output, protected):
    output = Path(output).resolve()
    for supplied in protected:
        source = Path(supplied).resolve()
        if output == source or source in output.parents or output in source.parents:
            raise ValueError("Audit output must be separate from immutable Phase 4A artifacts")
    return output


def _candidate_key(name):
    stem = Path(name).stem.casefold()
    stem = re.sub(r"_[0-9a-f]{10}$", "", stem)
    stem = re.sub(r"(?:[ _-]*\(?1\)?)$", "", stem)
    return re.sub(r"[^a-zа-яё0-9]+", "", stem)


def discover_local_candidates(rows, media_root):
    root = Path(media_root).resolve(strict=True)
    by_key = defaultdict(list)
    for path in sorted(root.iterdir(), key=lambda item: item.name.casefold()):
        if path.is_file():
            by_key[_candidate_key(path.name)].append(path)
    assigned = defaultdict(list)
    for row in rows:
        source = (row.get("reference_provenance") or {}).get("source_relative_path")
        if source:
            assigned[source].append(row["catalog_item_id"])
    output = {}
    for row in rows:
        provenance = row.get("reference_provenance") or {}
        name = provenance.get("photo_name") or provenance.get("source_relative_path")
        if not name:
            continue
        candidates = []
        for path in by_key.get(_candidate_key(name), [])[:20]:
            try:
                raw = path.read_bytes()
                with Image.open(io.BytesIO(raw)) as image:
                    image.load()
                    width, height = image.size
                    mime = Image.MIME.get(image.format)
            except (OSError, ValueError):
                continue
            candidate_sha = hashlib.sha256(raw).hexdigest()
            candidates.append(
                {
                    "source_authority": "official_extracted_strapi_media_archive",
                    "source_path": path.name,
                    "sha256": candidate_sha,
                    "width": width,
                    "height": height,
                    "byte_size": len(raw),
                    "mime_type": mime,
                    "already_assigned_catalog_item_ids": sorted(assigned.get(path.name, [])),
                    "is_current_reference": candidate_sha == row["sha256"],
                }
            )
        if candidates:
            output[row["catalog_item_id"]] = candidates
    return output


def validate_override_manifest(manifest):
    if manifest.get("schema_version") != "contest-reference-overrides/1":
        raise ValueError("Unsupported override manifest")
    entries = manifest.get("entries")
    if not isinstance(entries, list):
        raise ValueError("Override entries must be a list")
    ids, slugs = set(), set()
    for entry in entries:
        catalog_id, slug, status = (
            entry.get("catalog_item_id"),
            entry.get("official_slug"),
            entry.get("status"),
        )
        if type(catalog_id) is not int or catalog_id <= 0 or catalog_id in ids:
            raise ValueError("Duplicate or invalid override catalog_item_id")
        if not isinstance(slug, str) or not slug or slug in slugs:
            raise ValueError("Duplicate or invalid override slug")
        if status not in STATUS_VALUES:
            raise ValueError(f"Invalid override status: {status}")
        replacement = entry.get("replacement")
        if status == "replacement_confirmed":
            required = {
                "source_authority",
                "source_path",
                "sha256",
                "width",
                "height",
                "byte_size",
                "mime_type",
            }
            if not isinstance(replacement, dict) or not required <= set(replacement):
                raise ValueError("Confirmed replacement requires explicit source metadata")
        elif replacement is not None:
            raise ValueError("Unconfirmed override cannot carry a replacement")
        ids.add(catalog_id)
        slugs.add(slug)
    return entries


def applied_override_catalog_ids(manifest, report):
    confirmed = {
        entry["catalog_item_id"]
        for entry in validate_override_manifest(manifest)
        if entry["status"] == "replacement_confirmed"
    }
    if not report or report.get("dry_run") is not False:
        return []
    if report.get("manifest_sha256") != digest(manifest):
        raise ValueError("Apply report does not match override manifest")
    diffs = report.get("diffs")
    if not isinstance(diffs, list):
        raise ValueError("Apply report diffs are missing")
    applied = {
        row.get("catalog_item_id")
        for row in diffs
        if row.get("state") in {"updated", "already_applied"}
    }
    if (
        applied != confirmed
        or report.get("updated", 0) + report.get("already_applied", 0)
        != len(confirmed)
    ):
        raise ValueError("Apply report does not cover every confirmed replacement")
    return sorted(applied)


def build_override_manifest(rows, candidates, existing=None, review_limit=80):
    selected = rows[:review_limit]
    prior = (
        {entry["catalog_item_id"]: entry for entry in validate_override_manifest(existing)}
        if existing
        else {}
    )
    entries = [
        entry
        for catalog_id, entry in sorted(prior.items())
        if catalog_id not in {row["catalog_item_id"] for row in selected}
    ]
    for row in selected:
        catalog_id = row["catalog_item_id"]
        expected = {
            "reference_asset_id": row["current_reference_asset_id"],
            "path": row["current_reference_path"],
            "sha256": row["sha256"],
            "width": row["width"],
            "height": row["height"],
            "provenance": row["resolution"]["provenance"],
        }
        entry = prior.get(catalog_id)
        if entry is None:
            entry = {
                "catalog_item_id": catalog_id,
                "official_slug": row["official_slug"],
                "status": "unresolved" if catalog_id in KNOWN_BAD else "pending_review",
                "reason": (
                    "Known bad lifestyle image; no trustworthy local authoritative "
                    "replacement identified."
                    if catalog_id in KNOWN_BAD
                    else "Diagnostic candidate awaiting human review."
                ),
                "expected_current": expected,
                "candidate_assets": candidates.get(catalog_id, []),
                "replacement": None,
            }
        elif entry["official_slug"] != row["official_slug"]:
            raise ValueError("Existing override manifest identity mismatch")
        entries.append(entry)
    manifest = {
        "schema_version": "contest-reference-overrides/1",
        "contest_version": "lct-rshb-2026-09-15",
        "policy": (
            "Only replacement_confirmed entries with explicit authoritative source path "
            "and SHA may be materialized or applied."
        ),
        "entries": sorted(entries, key=lambda entry: entry["catalog_item_id"]),
    }
    validate_override_manifest(manifest)
    return manifest


def _thumbnail(source, destination, size=(420, 420)):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as image:
        image.load()
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail(size, Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", size, "white")
        canvas.paste(image, ((size[0] - image.width) // 2, (size[1] - image.height) // 2))
        canvas.save(destination, "JPEG", quality=88, optimize=False, progressive=False)


def write_review(rows, output, asset_root, media_root, candidates, limit=80):
    review = output / "review"
    assets = review / "assets"
    cards = []
    for row in rows[:limit]:
        catalog_id = row["catalog_item_id"]
        current = asset_path(asset_root, row["current_reference_path"])
        current_name = f"{catalog_id}-current-{row['sha256'][:12]}.jpg"
        _thumbnail(current, assets / current_name)
        historical_html = ""
        details = row.get("historical")
        if details and details["observations"]:
            observation = min(
                details["observations"],
                key=lambda item: (item["self_similarity"], item["query_row_id"]),
            )
            try:
                historical_path = asset_path(asset_root, observation["historical_path"])
                historical_name = (
                    f"{catalog_id}-historical-{observation['historical_sha256'][:12]}.jpg"
                )
                _thumbnail(historical_path, assets / historical_name)
                historical_html = (
                    f'<figure><img src="assets/{quote(historical_name)}" alt="">'
                    f"<figcaption>historical query · similarity "
                    f"{observation['self_similarity']:.4f} · rank "
                    f"{observation['expected_rank']}</figcaption></figure>"
                )
            except (OSError, ValueError):
                historical_html = "<p>Historical image unavailable for preview.</p>"
        candidate_html = []
        for number, candidate in enumerate(candidates.get(catalog_id, []), 1):
            path = Path(media_root) / candidate["source_path"]
            name = f"{catalog_id}-candidate-{number}-{candidate['sha256'][:12]}.jpg"
            _thumbnail(path, assets / name)
            assigned = candidate["already_assigned_catalog_item_ids"]
            candidate_html.append(
                f'<figure><img src="assets/{quote(name)}" alt="">'
                f"<figcaption>candidate {number} · {html.escape(candidate['source_path'])}"
                f" · assigned {html.escape(str(assigned))}</figcaption></figure>"
            )
        reasons = ", ".join(row["suspicion_reasons"]) or "diagnostic score only"
        cards.append(
            f"""<article class="card" id="catalog-{catalog_id}">
<header><strong>#{row["diagnostic_rank"]} · catalog {catalog_id}</strong>
<span class="priority {row["priority_level"]}">{row["priority_level"]}</span></header>
<h2>{html.escape(row.get("title") or "")}</h2>
<p><code>{html.escape(row["official_slug"])}</code> · {html.escape(row.get("winery") or "")}</p>
<div class="images"><figure><img src="assets/{quote(current_name)}" alt="">
<figcaption>current official · {row["width"]}×{row["height"]}</figcaption></figure>
{historical_html}{"".join(candidate_html)}</div>
<p><b>Reasons:</b> {html.escape(reasons)}</p>
<p><b>Scores:</b> product mean {row["product_photo_scores"]["mean"]:.4f};
non-product mean {row["negative_prompt_scores"]["mean"]:.4f};
contrast {row["product_minus_non_product_mean"]:.4f};
combined {row["combined_diagnostic_priority"]:.4f}</p>
</article>"""
        )
    document = f"""<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Official reference audit</title>
<style>
body{{font:15px system-ui;margin:24px;background:#f3f3f3;color:#171717}}
main{{display:grid;gap:18px}} .card{{background:white;padding:18px;border-radius:12px}}
header{{display:flex;justify-content:space-between}} .priority{{padding:3px 9px;border-radius:12px}}
.high{{background:#ffd2d2}} .medium{{background:#ffe8bd}} .low{{background:#e7eef8}}
.images{{display:flex;gap:12px;overflow-x:auto}} figure{{margin:0;min-width:260px}}
img{{display:block;width:320px;height:320px;object-fit:contain;background:white;border:1px solid #ddd}}
figcaption{{max-width:320px;color:#555;margin-top:5px}} code{{word-break:break-all}}
</style><body><h1>Official reference audit · top {min(limit, len(rows))}</h1>
<p>Diagnostic ranking for human review. No row is automatically replaced.</p>
<main>{"".join(cards)}</main></body></html>"""
    (review / "index.html").write_text(document, encoding="utf-8")


def write_csv_file(path, rows):
    fields = [
        "diagnostic_rank",
        "priority_level",
        "catalog_item_id",
        "official_slug",
        "title",
        "winery",
        "wine_id",
        "current_reference_asset_id",
        "current_reference_path",
        "sha256",
        "width",
        "height",
        "resolution_method",
        "product_score_mean",
        "non_product_score_mean",
        "contrast",
        "historical_self_similarity_min",
        "expected_rank_worst",
        "sha_assignment_count",
        "path_assignment_count",
        "combined_diagnostic_priority",
        "diagnostic_categories",
        "suspicion_reasons",
    ]
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        historical = row.get("historical") or {}
        writer.writerow(
            {
                "diagnostic_rank": row["diagnostic_rank"],
                "priority_level": row["priority_level"],
                "catalog_item_id": row["catalog_item_id"],
                "official_slug": row["official_slug"],
                "title": row.get("title"),
                "winery": row.get("winery"),
                "wine_id": row.get("wine_id"),
                "current_reference_asset_id": row["current_reference_asset_id"],
                "current_reference_path": row["current_reference_path"],
                "sha256": row["sha256"],
                "width": row["width"],
                "height": row["height"],
                "resolution_method": row["resolution"]["method"],
                "product_score_mean": row["product_photo_scores"]["mean"],
                "non_product_score_mean": row["negative_prompt_scores"]["mean"],
                "contrast": row["product_minus_non_product_mean"],
                "historical_self_similarity_min": historical.get("self_similarity_min"),
                "expected_rank_worst": historical.get("expected_rank_worst"),
                "sha_assignment_count": row["duplicate_shared_reference"]["sha_assignment_count"],
                "path_assignment_count": row["duplicate_shared_reference"]["path_assignment_count"],
                "combined_diagnostic_priority": row["combined_diagnostic_priority"],
                "diagnostic_categories": "|".join(row["diagnostic_categories"]),
                "suspicion_reasons": "|".join(row["suspicion_reasons"]),
            }
        )
    path.write_text(stream.getvalue(), encoding="utf-8")


def run_audit(args):
    protected = [args.gallery, args.proxy, args.proxy_evaluation]
    before = file_fingerprints(protected)
    output = guard_audit_output(args.output, protected)
    output.mkdir(parents=True, exist_ok=True)
    gallery, gallery_rows, gallery_metadata = load_bundle(args.gallery)
    proxy, proxy_rows, proxy_metadata = load_bundle(args.proxy)
    if (
        gallery_metadata["dataset_type"] != "official_gallery"
        or proxy_metadata["dataset_type"] != "proxy_same_source"
        or gallery_metadata["row_count"] != 2103
        or gallery_metadata["config_sha256"] != proxy_metadata["config_sha256"]
    ):
        raise ValueError("Unexpected or incompatible Phase 4A bundles")
    gallery_manifest = read_json(args.gallery_manifest)
    manifest_by_id = {row["catalog_item_id"]: row for row in gallery_manifest["rows"]}
    enriched = []
    for row in gallery_rows:
        source = manifest_by_id.get(row["catalog_item_id"])
        if source is None or source["reference_sha256"] != row["sha256"]:
            raise ValueError("Gallery bundle and manifest differ")
        enriched.append(
            {
                **row,
                **{
                    key: source.get(key)
                    for key in (
                        "title",
                        "winery",
                        "wine_id",
                        "reference_asset_id",
                        "resolution_method",
                        "reference_provenance",
                        "review_note",
                        "description",
                    )
                },
            }
        )
    evaluation = read_json(args.proxy_evaluation)
    historical = historical_diagnostics(gallery, enriched, proxy, proxy_rows, evaluation)
    text_cache_path = output / "text-features.json"
    if text_cache_path.exists():
        text_cache = read_json(text_cache_path)
        if (
            text_cache.get("schema_version") != "siglip-reference-audit-text/1"
            or text_cache.get("config_sha256") != gallery_metadata["config_sha256"]
            or text_cache.get("prompts") != [*POSITIVE_PROMPTS, *NEGATIVE_PROMPTS]
        ):
            raise ValueError("Cached text features differ from frozen audit configuration")
        text = np.asarray(text_cache.get("vectors"), dtype=np.float32)
        if (
            text.shape
            != (
                len(POSITIVE_PROMPTS) + len(NEGATIVE_PROMPTS),
                gallery_metadata["dimension"],
            )
            or not np.isfinite(text).all()
        ):
            raise ValueError("Cached text feature matrix is invalid")
    else:
        encoder = SiglipEncoder(
            model_id=args.model_id,
            revision=args.revision,
            device=args.device,
            dtype=args.dtype,
            max_num_patches=args.max_num_patches,
            batch_size=1,
            threads=args.threads,
            cache_dir=args.cache_dir,
            offline=True,
        )
        if digest(encoder.config) != gallery_metadata["config_sha256"]:
            raise ValueError("Text encoder config differs from immutable gallery encoder")
        text = encoder.encode_text([*POSITIVE_PROMPTS, *NEGATIVE_PROMPTS])
        write_json(
            text_cache_path,
            {
                "schema_version": "siglip-reference-audit-text/1",
                "config_sha256": gallery_metadata["config_sha256"],
                "prompts": [*POSITIVE_PROMPTS, *NEGATIVE_PROMPTS],
                "vectors": text.tolist(),
            },
        )
    prompt_scores = prompt_diagnostics(
        gallery, text[: len(POSITIVE_PROMPTS)], text[len(POSITIVE_PROMPTS) :]
    )
    rows = build_audit_rows(enriched, prompt_scores, historical)
    candidates = discover_local_candidates(enriched, args.media_root)
    counts = Counter(row["priority_level"] for row in rows)
    existing_path = output / "reference-overrides.json"
    existing = read_json(existing_path) if existing_path.exists() else None
    overrides = build_override_manifest(rows, candidates, existing=existing)
    apply_report_path = output / "override-apply.json"
    apply_report = read_json(apply_report_path) if apply_report_path.exists() else None
    applied_replacements = applied_override_catalog_ids(overrides, apply_report)
    human_status_counts = Counter(entry["status"] for entry in overrides["entries"])
    additional_confirmed_bad = sorted(
        entry["catalog_item_id"]
        for entry in overrides["entries"]
        if entry["status"] == "confirmed_bad" and entry["catalog_item_id"] not in KNOWN_BAD
    )
    audit = {
        "schema_version": "contest-reference-audit/1",
        "policy": (
            "Diagnostic human-review ranking only. Zero-shot or historical scores never "
            "authorize a replacement."
        ),
        "model": {
            "model_id": MODEL_ID,
            "revision": MODEL_REVISION,
            "config_sha256": gallery_metadata["config_sha256"],
            "positive_prompts": list(POSITIVE_PROMPTS),
            "negative_prompts": list(NEGATIVE_PROMPTS),
        },
        "immutable_baseline": {
            "gallery_rows": len(gallery_rows),
            "gallery_bundle": str(Path(args.gallery)),
            "proxy_bundle": str(Path(args.proxy)),
            "proxy_evaluation": str(Path(args.proxy_evaluation)),
            "fingerprints": before,
        },
        "summary": {
            "audited_rows": len(rows),
            "priority_counts": dict(sorted(counts.items())),
            "historical_consistency_rows": len(historical),
            "duplicate_sha_assignments": sum(
                row["duplicate_shared_reference"]["sha_assignment_count"] > 1 for row in rows
            ),
            "known_confirmed_bad": sorted(KNOWN_BAD - set(applied_replacements)),
            "human_override_status_counts": dict(sorted(human_status_counts.items())),
            "applied_replacements": applied_replacements,
            "unresolved_without_replacement": human_status_counts.get("unresolved", 0),
            "confirmed_bad_without_replacement": human_status_counts.get(
                "confirmed_bad", 0
            ),
            "additional_visually_confirmed_bad": additional_confirmed_bad,
            "automatically_replaced": 0,
        },
        "rows": rows,
    }
    write_json(output / "reference-audit.json", audit)
    write_csv_file(output / "reference-audit.csv", rows)
    write_json(existing_path, overrides)
    write_review(rows, output, args.asset_root, args.media_root, candidates)
    changed_ids = []
    v2_manifest_path = output / "manifests-v2/gallery-manifest.json"
    if v2_manifest_path.exists():
        v2_manifest = read_json(v2_manifest_path)
        changed_ids = changed_sha_catalog_ids(
            [
                {
                    "catalog_item_id": row["catalog_item_id"],
                    "sha256": row["sha256"],
                }
                for row in enriched
            ],
            [
                {
                    "catalog_item_id": row["catalog_item_id"],
                    "sha256": row["reference_sha256"],
                }
                for row in v2_manifest["rows"]
            ],
        )
    changed_label = ", ".join(map(str, changed_ids)) if changed_ids else "none"
    instructions = f"""# gallery-256-v2

The Phase 4A v1 bundle stays immutable. After reviewed overrides are applied:

1. Export a fresh 2103-row gallery manifest from PostgreSQL into this audit directory.
2. Compare catalog IDs and SHA-256 values with v1 using changed_sha_catalog_ids.
3. Run the existing embed command with a new output path backups/lct/catalog_reference_audit/embeddings/gallery-256-v2 and the existing checkpoint directory.
4. Checkpoint keys include model config, row ID, SHA-256 and dimensions, so unchanged rows reuse frozen features; only changed SHA rows run SigLIP inference.
5. Verify the v2 bundle contains exactly 2103 deterministic rows and keep field benchmarks pending review.

Current changed SHA catalog IDs: {changed_label}.
"""
    (output / "gallery-256-v2.md").write_text(instructions, encoding="utf-8")
    after = file_fingerprints(protected)
    if before != after:
        raise RuntimeError("Immutable Phase 4A artifact changed during audit")
    return {
        "audited_rows": len(rows),
        "priority_counts": dict(sorted(counts.items())),
        "review_html": str(output / "review/index.html"),
        "override_manifest": str(existing_path),
        "immutable_v1_verified": True,
    }


def main(argv=None):
    root = Path(__file__).resolve().parents[3]
    phase4a = root / "backups/lct/siglip_phase4a"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gallery", type=Path, default=phase4a / "embeddings/gallery-256")
    parser.add_argument("--proxy", type=Path, default=phase4a / "embeddings/proxy-256")
    parser.add_argument(
        "--proxy-evaluation", type=Path, default=phase4a / "evaluations/proxy-256.json"
    )
    parser.add_argument(
        "--gallery-manifest", type=Path, default=phase4a / "manifests/gallery-manifest.json"
    )
    parser.add_argument("--asset-root", type=Path, default=root / "asset-store")
    parser.add_argument("--media-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=root / "backups/lct/catalog_reference_audit")
    parser.add_argument("--model-id", default=MODEL_ID)
    parser.add_argument("--revision", default=MODEL_REVISION)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="cpu")
    parser.add_argument("--dtype", choices=["float32", "float16", "bfloat16"], default="float32")
    parser.add_argument("--max-num-patches", type=int, choices=[256, 512], default=256)
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--cache-dir", type=Path, default=root / "ml/.cache/huggingface/hub")
    args = parser.parse_args(argv)
    result = run_audit(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
