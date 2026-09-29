"""Deterministic, read-only official media investigation and human review package."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import unicodedata
import warnings
from collections import defaultdict
from pathlib import Path
from typing import Any

import PIL
from PIL import Image, ImageDraw, ImageFont, ImageOps, features

from app.contest_media import (
    TRANSLITERATION,
    candidate_key_traces,
    canonical_catalog,
    json_bytes,
    normalization_trace,
    read_catalog,
    resolve_catalog,
)

PREVIEW_MAX_PIXELS = 20_000_000
PREVIEW_MAX_BYTES = 64 * 1024 * 1024


def legacy_trace(filename: str, *, strip_strapi_hash: bool) -> dict[str, Any]:
    """Frozen v1 stages explain why the saved Phase 2A.1 report missed an item."""
    nfkc = unicodedata.normalize("NFKC", filename)
    folded = nfkc.casefold()
    stem, extension = os.path.splitext(folded)
    unhashed = re.sub(r"_[0-9a-f]{10}$", "", stem) if strip_strapi_hash else stem
    transliterated = unhashed.translate(TRANSLITERATION)
    return {
        "input": filename,
        "strip_strapi_hash": strip_strapi_hash,
        "nfkc": nfkc,
        "casefold": folded,
        "stem": stem,
        "extension": extension,
        "hash_stripped_stem": unhashed,
        "transliterated_stem": transliterated,
        "normalized_key": [re.sub(r"[\W_]+", "", transliterated), extension],
    }


def investigate_missing(before, after, files):
    """Retain every baseline missing case, including those subsequently resolved."""
    by_path = {entry["relative_path"]: entry for entry in files}
    after_items = {row["official_slug"]: row for row in after["items"]}
    diagnostics = {row["official_slug"]: row for row in before["missing_analysis"]}
    investigations = []
    for old in sorted(before["missing_items"], key=lambda row: row["official_slug"]):
        row = after_items[old["official_slug"]]
        diagnostic = diagnostics[old["official_slug"]]
        names = row["historical_image_basenames"]
        historical = [
            {
                **entry,
                "historical_source": name,
                "legacy_keys": [
                    legacy_trace(entry["filename"], strip_strapi_hash=strip)
                    for strip in (False, True)
                ],
                "current_keys": candidate_key_traces(entry),
            }
            for entry in files
            for name in names
            if entry["filename"] == name["basename"]
        ]
        suggestions = []
        for suggestion in diagnostic["closest_deterministic_candidates"]:
            entry = by_path[suggestion["relative_path"]]
            suggestions.append(
                {
                    **entry,
                    "diagnostic_rule": suggestion["rule"],
                    "legacy_keys": [
                        legacy_trace(entry["filename"], strip_strapi_hash=strip)
                        for strip in (False, True)
                    ],
                    "current_keys": candidate_key_traces(entry),
                }
            )
        selected = row["selected_relative_path"]
        official = normalization_trace(row["photo_name"], strip_strapi_hash=False)
        old_official = legacy_trace(row["photo_name"], strip_strapi_hash=False)
        rule = None
        if selected and old_official["normalized_key"] != official["normalized_key"]:
            rule = "numero_sign_before_numeric_identifier"
        elif selected and any(
            trace["rule"] == "strapi_embedded_source_extension"
            and trace["normalized_key"] == official["normalized_key"]
            for trace in candidate_key_traces(by_path[selected])
        ):
            rule = "strapi_embedded_source_extension"
        reason = (
            "No literal filename or eligible v1 normalized (stem, extension) key "
            "matched the official photo_name. Historical evidence was only applied "
            "inside the official candidate set; a historical basename alone cannot "
            "supply a replacement for a missing official asset."
        )
        if rule == "numero_sign_before_numeric_identifier":
            finding = (
                "NFKC expands the numero punctuation to 'No'. Removing № immediately "
                "before a numeric identifier before NFKC restores the complete key."
            )
        elif rule == "strapi_embedded_source_extension":
            finding = (
                "The WebP name embeds the complete original stem and extension "
                "before the terminal Strapi hash. The original-extension "
                "alias is unique."
            )
        else:
            finding = (
                "The complete official key still differs from the archive identity. "
                "Historical linkage or a partial prefix cannot establish that the "
                "organizer intended this asset; no safe generic rule was established."
            )
        if not selected and any(
            re.sub(r"(?:19|20)[0-9]{2}$", "", official["normalized_key"][0])
            == trace["normalized_key"][0]
            and official["normalized_key"][0] != trace["normalized_key"][0]
            and official["normalized_key"][1] == trace["normalized_key"][1]
            for entry in historical
            for trace in entry["current_keys"]
        ):
            finding = (
                "The official filename includes a vintage year absent from the "
                "historical archive filename. Removing that year would discard "
                "catalog identity information. A filename prefix alone is "
                "insufficient; the historical asset remains unselected."
            )
        investigations.append(
            {
                "official_slug": row["official_slug"],
                "title": row.get("title"),
                "winery": row.get("winery"),
                "photo_name": row["photo_name"],
                "linked_historical_wine_exists": row.get("linked_wine_id") is not None,
                "linked_wine_id": row.get("linked_wine_id"),
                "linked_wine_slug": row.get("linked_wine_slug"),
                "historical_image_basenames": [
                    {
                        **name,
                        "legacy_keys": [
                            legacy_trace(name["basename"], strip_strapi_hash=strip)
                            for strip in (False, True)
                        ],
                        "current_keys": [
                            normalization_trace(
                                name["basename"], strip_strapi_hash=strip
                            )
                            for strip in (False, True)
                        ],
                    }
                    for name in names
                ],
                "historical_basename_exists_in_archive": bool(historical),
                "historical_archive_matches": historical,
                "official_legacy_trace": old_official,
                "official_current_trace": official,
                "diagnostic_candidates": suggestions,
                "previous_missing_reason": reason,
                "generic_rule": rule,
                "finding": finding,
                "after_class": row["match_class"],
                "selected_relative_path": selected,
                "cannot_select_reason": None if selected else finding,
            }
        )
    return investigations


def build_review(manifest, catalog, before, after):
    def identity(rows):
        return sorted((r["official_slug"], r["photo_name"]) for r in rows)

    if identity(before["items"]) != identity(after["items"]):
        raise ValueError("Baseline and current catalog identities differ")
    files = sorted(manifest["files"], key=lambda entry: entry["relative_path"])
    by_path = {entry["relative_path"]: entry for entry in files}
    hashes = defaultdict(list)
    for entry in files:
        if entry["sha256"]:
            hashes[entry["sha256"]].append(entry["relative_path"])
    ambiguous = []
    for row in after["ambiguous_items"]:
        candidates = []
        for index, path in enumerate(sorted(row["candidate_paths"]), 1):
            entry = by_path[path]
            candidates.append(
                {
                    **entry,
                    "candidate_id": f"C{index:02}",
                    "duplicate_sha_paths": [
                        other for other in hashes[entry["sha256"]] if other != path
                    ],
                    "normalization_traces": candidate_key_traces(entry),
                }
            )
        ambiguous.append(
            {
                key: row.get(key)
                for key in ("official_slug", "title", "winery", "photo_name")
            }
            | {
                "normalized_photo_key": normalization_trace(
                    row["photo_name"], strip_strapi_hash=False
                )["normalized_key"],
                "candidates": candidates,
                "contact_sheets": [],
            }
        )
    duplicates = []
    for group in after["duplicate_photo_name_groups"]:
        items = group["items"]
        resolved = [item for item in items if item["selected_relative_path"]]
        identical = (
            len({item["physical_asset_id"] for item in resolved}) == 1
            if len(resolved) == len(items)
            else None
        )
        status = (
            "fully shared"
            if identical
            else "partially resolved"
            if resolved and len(resolved) < len(items)
            else "missing"
            if all(item["after"] == "missing" for item in items)
            else "ambiguous"
            if not resolved
            else "resolved to distinct content"
        )
        duplicates.append(
            {
                "photo_name": group["photo_name"],
                "items": items,
                "files_identical_by_sha256": identical,
                "status": status,
            }
        )
    investigations = investigate_missing(before, after, files)
    before_items = {row["official_slug"]: row for row in before["items"]}
    changes = [
        {
            "official_slug": row["official_slug"],
            "before": before_items[row["official_slug"]]["match_class"],
            "after": row["match_class"],
            "selected_relative_path": row["selected_relative_path"],
        }
        for row in after["items"]
        if (row["match_class"], row["selected_relative_path"])
        != (
            before_items[row["official_slug"]]["match_class"],
            before_items[row["official_slug"]]["selected_relative_path"],
        )
    ]
    return {
        "schema_version": "contest-media-review/1",
        "provenance": {
            "baseline_sha256": hashlib.sha256(json_bytes(before)).hexdigest(),
            "manifest_sha256": after["manifest_sha256"],
            "catalog_sha256": hashlib.sha256(
                json_bytes(canonical_catalog(catalog))
            ).hexdigest(),
            "normalization_version": after["normalization_version"],
        },
        "summary": {
            "before": before["summary"]["match_classes"],
            "after": after["summary"]["match_classes"],
            "resolved_before": before["summary"]["resolved_items"],
            "resolved_after": after["summary"]["resolved_items"],
            "new_generic_rule_resolutions": sum(
                bool(r["generic_rule"]) for r in investigations
            ),
            "ambiguous_manual_review_items": len(ambiguous),
            "missing_items": len(after["missing_items"]),
            "total_unresolved_items": len(ambiguous) + len(after["missing_items"]),
            "canonical_items": len(after["items"]),
            "unique_photo_names": after["summary"]["unique_photo_names"],
        },
        "resolution_changes": changes,
        "baseline_shared_reference_groups": before["baseline_shared_reference_groups"],
        "missing_investigations": investigations,
        "remaining_missing": [
            r for r in investigations if r["after_class"] == "missing"
        ],
        "ambiguous_items": ambiguous,
        "duplicate_photo_name_groups": duplicates,
    }


def _wrap(draw, text, font, width):
    """Wrap by measured glyph width, including long slugs and filenames."""
    lines, current = [], ""
    for char in str(text):
        if char == "\n" or draw.textlength(current + char, font=font) > width:
            lines.append(current)
            current = "" if char == "\n" else char
        else:
            current += char
    return lines + [current]


def preview_image(root, candidate):
    """Verify source identity and enforce bounds before any pixel decoding."""
    relative = Path(candidate["relative_path"])
    if relative.is_absolute() or ".." in relative.parts:
        return None, "unsafe_relative_path"
    path = root / relative
    if path.is_symlink() or root not in path.resolve().parents:
        return None, "unsafe_source_path"
    if candidate["decode_status"] != "header_only":
        return None, "unsafe_decode_status"
    if not candidate["width"] or not candidate["height"]:
        return None, "unknown_dimensions"
    if candidate["width"] * candidate["height"] > PREVIEW_MAX_PIXELS:
        return None, "pixel_limit"
    try:
        with path.open("rb") as stream:
            if os.fstat(stream.fileno()).st_size > PREVIEW_MAX_BYTES:
                return None, "byte_limit"
            if hashlib.file_digest(stream, "sha256").hexdigest() != candidate["sha256"]:
                return None, "source_sha_mismatch"
            stream.seek(0)
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(stream) as source:
                    if source.size != (candidate["width"], candidate["height"]):
                        return None, "source_dimensions_mismatch"
                    source.thumbnail((520, 360), Image.Resampling.LANCZOS)
                    thumbnail = ImageOps.exif_transpose(source).convert("RGBA")
                    canvas = Image.new("RGBA", thumbnail.size, "white")
                    canvas.alpha_composite(thumbnail)
                    return canvas.convert("RGB"), "rendered"
    except (
        OSError,
        ValueError,
        Image.DecompressionBombWarning,
        Image.DecompressionBombError,
    ) as error:
        return None, type(error).__name__


def contact_sheets(review, root, output, font_path):
    """Fixed layout and encoding; no timestamps, metadata or random IDs."""
    font_bytes = font_path.read_bytes()
    font = ImageFont.truetype(str(font_path), 17)
    title_font = ImageFont.truetype(str(font_path), 20)
    review["preview_provenance"] = {
        "font_sha256": hashlib.sha256(font_bytes).hexdigest(),
        "pillow_version": PIL.__version__,
        "webp_codec_version": features.version("webp"),
        "pixel_limit": PREVIEW_MAX_PIXELS,
        "byte_limit": PREVIEW_MAX_BYTES,
    }
    preview_dir = output / "previews"
    preview_dir.mkdir()
    for number, item in enumerate(review["ambiguous_items"], 1):
        for page, start in enumerate(range(0, len(item["candidates"]), 4), 1):
            candidates = item["candidates"][start : start + 4]
            measure = ImageDraw.Draw(Image.new("RGB", (1, 1)))
            header = _wrap(measure, item["official_slug"], title_font, 1160)
            header += _wrap(measure, item["title"] or "", title_font, 1160)
            header += _wrap(measure, f"Photo: {item['photo_name']}", title_font, 1160)
            header_height = 24 * len(header) + 35
            label_lines = [
                _wrap(measure, f"{c['candidate_id']} | {c['filename']}", font, 550)
                for c in candidates
            ]
            cell_height = 400 + max(map(len, label_lines)) * 22
            sheet = Image.new(
                "RGB",
                (1200, header_height + ((len(candidates) + 1) // 2) * cell_height),
                "white",
            )
            draw = ImageDraw.Draw(sheet)
            for index, line in enumerate(header):
                draw.text((20, 12 + index * 24), line, font=title_font, fill="black")
            for index, (candidate, labels) in enumerate(
                zip(candidates, label_lines, strict=True)
            ):
                x, y = (
                    20 + (index % 2) * 600,
                    header_height + (index // 2) * cell_height,
                )
                thumbnail, status = preview_image(root, candidate)
                candidate["preview_status"] = status
                if thumbnail is not None:
                    sheet.paste(thumbnail, (x + (550 - thumbnail.width) // 2, y))
                else:
                    draw.text(
                        (x, y + 150),
                        f"Preview unavailable: {status}",
                        font=font,
                        fill="black",
                    )
                for line_index, label in enumerate(labels):
                    draw.text(
                        (x, y + 370 + 22 * line_index), label, font=font, fill="black"
                    )
            relative = f"previews/{number:03}-{page:02}.png"
            sheet.save(
                output / relative, format="PNG", optimize=False, compress_level=9
            )
            item["contact_sheets"].append(relative)


def _cell(value):
    return (
        str(value if value is not None else "")
        .replace("|", "&#124;")
        .replace("\n", " ")
    )


def render_markdown(review):
    lines = [
        "# Official media human review",
        "",
        "Decisions are blank. No database or source-media writes. Candidate "
        "IDs are item-local.",
        "Full normalization stages and historical metadata: "
        "[review-data.json](review-data.json).",
        "Decision template: [review-decisions.json](review-decisions.json).",
        "",
        "## Before / after",
        "",
        "| Class | Before | After |",
        "| --- | ---: | ---: |",
    ]
    summary = review["summary"]
    for name, count in summary["after"].items():
        lines.append(f"| {name} | {summary['before'].get(name, 0)} | {count} |")
    lines += [
        f"| Total resolved | {summary['resolved_before']} | "
        f"{summary['resolved_after']} |",
        "",
        f"New generic-rule resolutions: {summary['new_generic_rule_resolutions']}. "
        f"Ambiguous items for review: {summary['ambiguous_manual_review_items']}; "
        f"missing: {summary['missing_items']}.",
        "",
        "## Missing-case investigation",
        "",
    ]
    for item in review["missing_investigations"]:
        lines += [
            f"### {item['official_slug']}",
            "",
            f"Title: {_cell(item['title'])}; winery: {_cell(item['winery'])}.",
            f"Official photo: {_cell(item['photo_name'])}.",
            f"Historical wine: {item['linked_wine_id']} / "
            f"{_cell(item['linked_wine_slug'])}.",
            f"Before key: {item['official_legacy_trace']['normalized_key']}.",
            f"After key: {item['official_current_trace']['normalized_key']}.",
            "",
            item["previous_missing_reason"],
            "",
            item["finding"],
            "",
            f"After: **{item['after_class']}**; selected: "
            f"{_cell(item['selected_relative_path'])}.",
            "",
            "| Historical basename | Exists in archive | Matching archive paths |",
            "| --- | --- | --- |",
        ]
        for name in item["historical_image_basenames"]:
            paths = [
                entry["relative_path"]
                for entry in item["historical_archive_matches"]
                if entry["historical_source"]["basename"] == name["basename"]
            ]
            lines.append(
                f"| {_cell(name['basename'])} | {bool(paths)} | "
                f"{_cell(', '.join(paths))} |"
            )
        lines += [
            "",
            "Complete stage-by-stage keys (including diagnostic candidates):",
            "",
            "```json",
            json_bytes(item).decode().rstrip(),
            "```",
            "",
        ]
    lines += ["## Remaining missing items", ""]
    for item in review["remaining_missing"]:
        lines += [f"- **{item['official_slug']}**: {item['cannot_select_reason']}"]
    lines += [
        "",
        "## Duplicate official photo names",
        "",
        f"{summary['canonical_items']} catalog items; "
        f"{summary['unique_photo_names']} unique names; "
        f"{len(review['duplicate_photo_name_groups'])} duplicated names.",
        "",
        "| Photo name | Slugs / class / selected asset | Identical SHA-256 | Status |",
        "| --- | --- | --- | --- |",
    ]
    for group in review["duplicate_photo_name_groups"]:
        members = "; ".join(
            f"{r['official_slug']} / {r['after']} / "
            f"{r['selected_relative_path'] or 'unresolved'}"
            f" / {r['physical_asset_id'] or 'no SHA selected'}"
            for r in group["items"]
        )
        lines.append(
            f"| {_cell(group['photo_name'])} | {_cell(members)} | "
            f"{group['files_identical_by_sha256']} | {group['status']} |"
        )
    lines += [
        "",
        "## Original six shared-reference groups",
        "",
        "```json",
        json_bytes(review["baseline_shared_reference_groups"]).decode().rstrip(),
        "```",
        "",
        "## Ambiguous items",
        "",
    ]
    for item in review["ambiguous_items"]:
        lines += [
            f"### {item['official_slug']}",
            "",
            f"Title: {_cell(item['title'])}; winery: {_cell(item['winery'])}.",
            f"Photo: {_cell(item['photo_name'])}; key: {item['normalized_photo_key']}.",
            "",
        ]
        for sheet in item["contact_sheets"]:
            lines += [f"![Candidate contact sheet]({sheet})", ""]
        lines += [
            "| ID | Relative path / filename | Dimensions | Bytes | SHA-256 | "
            "Other identical-SHA paths |",
            "| --- | --- | --- | ---: | --- | --- |",
        ]
        for candidate in item["candidates"]:
            lines.append(
                f"| {candidate['candidate_id']} | "
                f"{_cell(candidate['relative_path'])} / {_cell(candidate['filename'])} "
                f"| {candidate['width']} × {candidate['height']} | "
                f"{candidate['byte_size']} "
                f"| {candidate['sha256']} | "
                f"{_cell(', '.join(candidate['duplicate_sha_paths']))} |"
            )
        lines.append("")
    return ("\n".join(lines) + "\n").encode("utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest-json", type=Path, required=True)
    parser.add_argument("--baseline-json", type=Path, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--catalog-json", type=Path)
    source.add_argument("--import-version")
    parser.add_argument("--media-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--font",
        type=Path,
        required=True,
        help="Fixed TrueType font with Cyrillic glyphs",
    )
    args = parser.parse_args(argv)
    root = args.media_root.resolve(strict=True)
    output = args.output_dir.resolve()
    if output == root or root in output.parents:
        parser.error("Review output must be outside the media snapshot")
    if output.exists() and any(output.iterdir()):
        parser.error("Use a new or empty review output directory")

    def load(path):
        return json.loads(path.read_text(encoding="utf-8-sig"))

    manifest, before = load(args.manifest_json), load(args.baseline_json)
    catalog = (
        load(args.catalog_json)
        if args.catalog_json
        else read_catalog(os.environ["DATABASE_URL"], args.import_version)
    )
    catalog = canonical_catalog(catalog)
    manifest = {
        **manifest,
        "files": sorted(manifest["files"], key=lambda entry: entry["relative_path"]),
    }
    after = resolve_catalog(manifest, catalog)
    review = build_review(manifest, catalog, before, after)
    # All outputs are isolated from input snapshots; previews read/hash sources.
    output.mkdir(parents=True, exist_ok=True)
    contact_sheets(review, root, output, args.font)
    decisions = [
        {
            "official_slug": row["official_slug"],
            "photo_name": row["photo_name"],
            "decision": None,
            "selected_relative_path": None,
            "note": None,
        }
        for row in review["ambiguous_items"]
    ]
    for name, value in (
        ("media-manifest.json", manifest),
        ("catalog-items.json", catalog),
        ("media-resolution.json", after),
        ("review-data.json", review),
        ("review-decisions.json", decisions),
    ):
        (output / name).write_bytes(json_bytes(value))
    (output / "review.md").write_bytes(render_markdown(review))
    print(json_bytes(review["summary"]).decode(), end="")


if __name__ == "__main__":
    main()
