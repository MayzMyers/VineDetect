"""Read-only Strapi media inventory and deterministic catalog photo resolution."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import re
import struct
import unicodedata
import warnings
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import PIL
import psycopg
from PIL import Image, UnidentifiedImageError
from psycopg.rows import dict_row

SCHEMA_VERSION = "contest-media/1"
NORMALIZATION_VERSION = "strapi-filename/2"
MAX_INSPECTION_BYTES = 64 * 1024 * 1024
MAX_PIXELS = 89_478_485
RASTER_EXTENSIONS = {
    ".avif",
    ".bmp",
    ".dib",
    ".gif",
    ".heic",
    ".heif",
    ".ico",
    ".jfif",
    ".jpe",
    ".jpeg",
    ".jpg",
    ".pbm",
    ".pgm",
    ".png",
    ".pnm",
    ".ppm",
    ".tif",
    ".tiff",
    ".webp",
}
FORMAT_EXTENSIONS = {
    "AVIF": {".avif"},
    "BMP": {".bmp", ".dib"},
    "GIF": {".gif"},
    "HEIF": {".heic", ".heif"},
    "ICO": {".ico"},
    "JPEG": {".jpg", ".jpeg", ".jpe", ".jfif"},
    "PNG": {".png"},
    "PPM": {".pbm", ".pgm", ".pnm", ".ppm"},
    "TIFF": {".tif", ".tiff"},
    "WEBP": {".webp"},
}
# One explicit Russian transliteration, not a fuzzy/phonetic similarity search.
TRANSLITERATION = str.maketrans(
    dict(
        zip(
            "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
            (
                "a",
                "b",
                "v",
                "g",
                "d",
                "e",
                "yo",
                "zh",
                "z",
                "i",
                "j",
                "k",
                "l",
                "m",
                "n",
                "o",
                "p",
                "r",
                "s",
                "t",
                "u",
                "f",
                "h",
                "cz",
                "ch",
                "sh",
                "shh",
                "",
                "y",
                "",
                "e",
                "yu",
                "ya",
            ),
            strict=True,
        )
    )
)


def normalization_trace(
    filename: str, *, strip_strapi_hash: bool = True
) -> dict[str, Any]:
    """Expose every key stage; numero punctuation must precede NFKC expansion."""
    numero = re.sub(r"№(?=\s*\d)", "", filename)
    nfkc = unicodedata.normalize("NFKC", numero)
    folded = nfkc.casefold()
    stem, extension = os.path.splitext(folded)
    unhashed = re.sub(r"_[0-9a-f]{10}$", "", stem) if strip_strapi_hash else stem
    transliterated = unhashed.translate(TRANSLITERATION)
    normalized = re.sub(r"[\W_]+", "", transliterated)
    return {
        "input": filename,
        "strip_strapi_hash": strip_strapi_hash,
        "numero_punctuation": numero,
        "nfkc": nfkc,
        "casefold": folded,
        "stem": stem,
        "extension": extension,
        "hash_stripped_stem": unhashed,
        "transliterated_stem": transliterated,
        "normalized_key": [normalized, extension],
    }


def normalize_filename(
    filename: str, *, strip_strapi_hash: bool = True
) -> tuple[str, str]:
    trace = normalization_trace(filename, strip_strapi_hash=strip_strapi_hash)
    return tuple(trace["normalized_key"])


def candidate_key_traces(entry: dict[str, Any]) -> list[dict[str, Any]]:
    """Full-name keys plus a narrowly bounded Strapi conversion-name alias.

    Only an inspected WebP with <stem>_<raster-extension>_<10hex>.webp supplies
    an original-extension alias. Never remove arbitrary years or suffixes.
    """
    traces = [
        {
            "rule": "filename",
            **normalization_trace(entry["filename"], strip_strapi_hash=strip),
        }
        for strip in (False, True)
    ]
    converted = re.fullmatch(
        r"(.+)_(png|jpe?g|tiff?|bmp|gif)_[0-9a-f]{10}\.webp",
        entry["filename"],
        flags=re.IGNORECASE,
    )
    if converted and entry.get("format") == "WEBP":
        original = f"{converted[1]}.{converted[2]}"
        traces.append(
            {
                "rule": "strapi_embedded_source_extension",
                "archive_filename": entry["filename"],
                **normalization_trace(original, strip_strapi_hash=False),
            }
        )
    return traces


def json_bytes(value: Any) -> bytes:
    """Stable UTF-8 serialization: no timestamps, platform paths or locale ordering."""
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    ).encode("utf-8")


def _header_dimensions(path: Path) -> tuple[str | None, int | None, int | None]:
    """Bounded PNG/JPEG header fallback after Pillow refuses an oversized image.

    Reads no compressed pixels. JPEG marker traversal is limited to the first MiB.
    """
    with path.open("rb") as stream:
        header = stream.read(24)
        if (
            header[:8] == b"\x89PNG\r\n\x1a\n"
            and header[8:16] == b"\x00\x00\x00\rIHDR"
            and len(header) == 24
        ):
            width, height = struct.unpack(">II", header[16:24])
            return "PNG", width, height
        if header[:2] != b"\xff\xd8":
            return None, None, None
        stream.seek(2)
        while stream.tell() < 1024 * 1024:
            if stream.read(1) != b"\xff":
                break
            marker = stream.read(1)
            while marker == b"\xff" and stream.tell() < 1024 * 1024:
                marker = stream.read(1)
            if not marker or marker[0] in (0xD9, 0xDA):
                break
            if marker[0] in (0x01, *range(0xD0, 0xD9)):
                continue
            size_bytes = stream.read(2)
            if len(size_bytes) != 2:
                break
            length = int.from_bytes(size_bytes, "big")
            if length < 2:
                break
            if marker[0] in {
                0xC0,
                0xC1,
                0xC2,
                0xC3,
                0xC5,
                0xC6,
                0xC7,
                0xC9,
                0xCA,
                0xCB,
                0xCD,
                0xCE,
                0xCF,
            }:
                data = stream.read(5)
                if len(data) == 5 and length >= 8:
                    height, width = struct.unpack(">HH", data[1:5])
                    return "JPEG", width, height
                break
            stream.seek(length - 2, 1)
    return None, None, None


def inspect_file(path: Path, relative_path: str) -> dict[str, Any]:
    extension = path.suffix.casefold()
    entry: dict[str, Any] = {
        "filename": path.name,
        "relative_path": relative_path,
        "extension": extension,
        "byte_size": None,
        "sha256": None,
        "width": None,
        "height": None,
        "format": None,
        "mime_type": None,
        "raster_candidate": False,
        "is_raster": False,
        "decode_status": "non_raster",
        "decode_error": None,
        "extension_mismatch": False,
    }
    if path.is_symlink() or not path.is_file():
        entry["decode_status"] = "skipped_non_regular"
        return entry
    try:
        before = path.stat()
        entry["byte_size"] = before.st_size
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        entry["sha256"] = digest.hexdigest()
        entry["raster_candidate"] = extension in RASTER_EXTENSIONS
        if entry["raster_candidate"]:
            _inspect_raster(path, entry)
        after = path.stat()
        if (before.st_size, before.st_mtime_ns, before.st_ino) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ino,
        ):
            raise RuntimeError(f"Media changed while scanning: {relative_path}")
    except OSError as exc:
        entry["decode_status"] = "io_error"
        entry["decode_error"] = type(exc).__name__
        entry["sha256"] = None
        entry["is_raster"] = False
    return entry


def _inspect_raster(path: Path, entry: dict[str, Any]) -> None:
    try:
        if entry["byte_size"] > MAX_INSPECTION_BYTES:
            fmt, width, height = _header_dimensions(path)
            entry.update(
                format=fmt,
                width=width,
                height=height,
                decode_status="inspection_limit",
                decode_error="Compressed file exceeds 64 MiB inspection limit",
            )
        else:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(path) as image:
                    entry.update(
                        format=image.format, width=image.width, height=image.height
                    )
                    if image.format not in FORMAT_EXTENSIONS:
                        entry["decode_status"] = "unsupported_format"
                    elif image.width * image.height > MAX_PIXELS:
                        entry["decode_status"] = "oversized"
                        entry["decode_error"] = "Pixel count exceeds inspection limit"
                    else:
                        # verify() checks available container integrity without load().
                        # Some plugins only inspect headers; never claim pixel decoding.
                        image.verify()
                        entry["decode_status"] = "header_only"
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        fmt, width, height = _header_dimensions(path)
        entry.update(
            format=fmt,
            width=width,
            height=height,
            decode_status="oversized",
            decode_error=type(exc).__name__,
        )
    except UnidentifiedImageError:
        entry.update(
            decode_status="unidentified", decode_error="UnidentifiedImageError"
        )
    except (OSError, ValueError, SyntaxError, EOFError, struct.error) as exc:
        entry.update(decode_status="invalid", decode_error=type(exc).__name__)
    fmt = entry["format"]
    entry["is_raster"] = fmt in FORMAT_EXTENSIONS
    entry["mime_type"] = Image.MIME.get(fmt) if fmt else None
    entry["extension_mismatch"] = (
        fmt in FORMAT_EXTENSIONS and entry["extension"] not in FORMAT_EXTENSIONS[fmt]
    )


def scan_media(media_root: Path) -> dict[str, Any]:
    root = media_root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Media root must be a directory")
    paths = []

    def fail(error: OSError) -> None:
        raise error

    for directory, dirs, files in os.walk(root, followlinks=False, onerror=fail):
        dirs.sort()
        for name in list(dirs):
            path = Path(directory) / name
            if path.is_symlink():
                paths.append(path)
                dirs.remove(name)
        paths.extend(Path(directory) / name for name in files)
    paths.sort(key=lambda path: path.relative_to(root).as_posix())
    entries = [inspect_file(path, path.relative_to(root).as_posix()) for path in paths]
    return {
        "schema_version": SCHEMA_VERSION,
        "inspection_policy": {
            "pillow_version": PIL.__version__,
            "pixel_decode": False,
            "max_pixels": MAX_PIXELS,
            "pillow_max_image_pixels": Image.MAX_IMAGE_PIXELS,
            "max_inspection_bytes": MAX_INSPECTION_BYTES,
            "symlinks": "record-without-following",
        },
        "files": entries,
    }


def read_catalog(database_url: str, version: str) -> dict[str, Any]:
    """Snapshot a single version in a database-enforced read-only transaction."""
    with psycopg.connect(
        database_url,
        row_factory=dict_row,
        options="-c default_transaction_read_only=on",
    ) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        run = connection.execute(
            """SELECT id, version, source_sha256, status FROM contest.import_runs
               WHERE version = %s""",
            (version,),
        ).fetchone()
        if run is None or run["status"] != "completed":
            raise ValueError("Select an existing completed contest import version")
        items = connection.execute(
            """SELECT i.id AS catalog_item_id, i.official_slug, i.photo_name,
                      i.title, i.winery, l.wine_id AS linked_wine_id,
                      w.slug AS linked_wine_slug
               FROM contest.catalog_items i
               LEFT JOIN contest.item_links l ON l.catalog_item_id = i.id
               LEFT JOIN svoe_vino.wines w ON w.id = l.wine_id
               WHERE i.import_run_id = %s ORDER BY i.official_slug""",
            (run["id"],),
        ).fetchall()
        wine_ids = sorted(
            {
                item["linked_wine_id"]
                for item in items
                if item["linked_wine_id"] is not None
            }
        )
        images = connection.execute(
            """SELECT id AS image_id, wine_id, kind, url, local_path
               FROM svoe_vino.wine_images WHERE wine_id = ANY(%s) ORDER BY id""",
            (wine_ids,),
        ).fetchall()
        by_wine = defaultdict(list)
        for image in images:
            by_wine[image["wine_id"]].append(image)
        for item in items:
            item["historical_images"] = by_wine[item["linked_wine_id"]]
    return {"import_run": run, "items": items, "historical_evidence_available": True}


def _resolve_primary(
    manifest: dict[str, Any], catalog: dict[str, Any]
) -> dict[str, Any]:
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("Unsupported media manifest schema version")
    files = sorted(manifest["files"], key=lambda entry: entry["relative_path"])
    if len({entry["relative_path"] for entry in files}) != len(files):
        raise ValueError("Manifest relative paths must be unique")
    items = sorted(catalog["items"], key=lambda item: item["official_slug"])
    if not items or len({item["official_slug"] for item in items}) != len(items):
        raise ValueError("Catalog must contain distinct canonical official slugs")
    if any(
        not isinstance(item["photo_name"], str)
        or not isinstance(item["official_slug"], str)
        or not item["official_slug"].strip()
        for item in items
    ):
        raise ValueError("Catalog slug/photo_name must be strings with non-blank slugs")
    exact: dict[str, list] = defaultdict(list)
    normalized: dict[tuple, list] = defaultdict(list)
    for entry in files:
        # Do not admit corrupt, unsupported, non-raster or uninspected files.
        # Oversized raster headers can resolve, with their safety status retained.
        if (
            entry["is_raster"]
            and entry["sha256"]
            and entry["decode_status"] in {"header_only", "oversized"}
        ):
            exact[entry["filename"]].append(entry)
            # Preserve full names as well: source names can contain timestamp
            # suffixes, and can already include the original Strapi hash.
            keys = {
                tuple(trace["normalized_key"]) for trace in candidate_key_traces(entry)
            }
            for key in sorted(keys):
                normalized[key].append(entry)
    resolutions = []
    by_path: dict[str, list] = defaultdict(list)
    for item in items:
        candidates = exact.get(item["photo_name"], [])
        basis = "exact_filename"
        if not candidates:
            key = normalize_filename(item["photo_name"], strip_strapi_hash=False)
            candidates = normalized.get(key, [])
            basis = "normalized_unique"
        resolved = len(candidates) == 1
        row = {
            **item,
            "match_class": basis
            if resolved
            else ("ambiguous" if candidates else "missing"),
            "match_basis": basis if candidates else None,
            "selected_relative_path": None,
            "candidate_paths": [],
            "sha256": None,
            "width": None,
            "height": None,
            "byte_size": None,
            "decode_status": None,
            "decode_error": None,
            "normalization_evidence": {
                "official": normalization_trace(
                    item["photo_name"], strip_strapi_hash=False
                ),
                "candidate_keys": [
                    {
                        "relative_path": asset["relative_path"],
                        "traces": candidate_key_traces(asset),
                    }
                    for asset in candidates
                ],
            },
        }
        if resolved:
            asset = candidates[0]
            row["selected_relative_path"] = asset["relative_path"]
            for field in (
                "sha256",
                "width",
                "height",
                "byte_size",
                "decode_status",
                "decode_error",
            ):
                row[field] = asset[field]
            by_path[asset["relative_path"]].append(row)
        elif candidates:
            row["candidate_paths"] = [asset["relative_path"] for asset in candidates]
        resolutions.append(row)
    shared = []
    for path, group in sorted(by_path.items()):
        if len(group) > 1:
            for row in group:
                row["match_class"] = "shared_reference"
            shared.append(
                {
                    "relative_path": path,
                    "sha256": group[0]["sha256"],
                    "official_slugs": [row["official_slug"] for row in group],
                    "photo_names": sorted({row["photo_name"] for row in group}),
                }
            )
    hashes: dict[str, list[str]] = defaultdict(list)
    for entry in files:
        if entry["sha256"]:
            hashes[entry["sha256"]].append(entry["relative_path"])
    duplicates = [
        {"sha256": digest, "relative_paths": paths}
        for digest, paths in sorted(hashes.items())
        if len(paths) > 1
    ]
    used = set(by_path)
    unused = [
        entry["relative_path"] for entry in files if entry["relative_path"] not in used
    ]
    failures = [
        entry
        for entry in files
        if entry["decode_status"]
        in {"unidentified", "invalid", "unsupported_format", "io_error"}
    ]
    oversized = [
        entry
        for entry in files
        if entry["decode_status"] in {"oversized", "inspection_limit"}
    ]
    counts = Counter(row["match_class"] for row in resolutions)
    bases = Counter(
        row["match_basis"]
        for row in resolutions
        if row["selected_relative_path"] is not None
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "normalization_version": NORMALIZATION_VERSION,
        "import_run": catalog.get("import_run"),
        "manifest_sha256": hashlib.sha256(
            json_bytes({**manifest, "files": files})
        ).hexdigest(),
        "catalog_sha256": hashlib.sha256(
            json_bytes({**catalog, "items": items})
        ).hexdigest(),
        "summary": {
            "canonical_items": len(items),
            "unique_photo_names": len({item["photo_name"] for item in items}),
            "resolved_items": len(items) - counts["missing"] - counts["ambiguous"],
            "resolved_exactly": bases["exact_filename"],
            "resolved_normalized_unique": bases["normalized_unique"],
            "match_classes": {
                name: counts[name]
                for name in (
                    "exact_filename",
                    "normalized_unique",
                    "shared_reference",
                    "ambiguous",
                    "missing",
                )
            },
            "shared_reference_groups": len(shared),
            "selected_physical_assets": len(used),
            "archive_files": len(files),
            "raster_candidates": sum(entry["raster_candidate"] for entry in files),
            "inspection_statuses": dict(
                sorted(Counter(entry["decode_status"] for entry in files).items())
            ),
            "unused_archive_files": len(unused),
            "duplicate_sha256_groups": len(duplicates),
            "decode_failures": len(failures),
            "oversized_assets": len(oversized),
            "extension_mismatches": sum(entry["extension_mismatch"] for entry in files),
        },
        "items": resolutions,
        "shared_reference_groups": shared,
        "ambiguous_items": [
            row for row in resolutions if row["match_class"] == "ambiguous"
        ],
        "missing_items": [
            row for row in resolutions if row["match_class"] == "missing"
        ],
        # Unused means not uniquely selected; may include ambiguous candidates.
        "unused_archive_files": unused,
        "duplicate_physical_files_by_sha256": duplicates,
        "decode_failures": failures,
        "oversized_assets": oversized,
        "extension_mismatches": [
            entry for entry in files if entry["extension_mismatch"]
        ],
    }


RESOLUTION_CLASSES = (
    "exact_filename",
    "normalized_unique",
    "shared_reference",
    "sha_equivalent",
    "historical_asset_exact",
    "historical_asset_normalized",
    "ambiguous",
    "missing",
)


def canonical_catalog(catalog: dict[str, Any]) -> dict[str, Any]:
    items = []
    for item in sorted(catalog["items"], key=lambda row: row["official_slug"]):
        row = dict(item)
        if "historical_images" in row:
            row["historical_images"] = sorted(row["historical_images"], key=json_bytes)
        items.append(row)
    return {**catalog, "items": items}


def historical_basename(value: str | None) -> str:
    """Extract a decoded basename from a URL or POSIX/Windows source path."""
    if not value:
        return ""
    return unquote(urlsplit(value.replace("\\", "/")).path).rsplit("/", 1)[-1]


def _historical_names(item: dict[str, Any]) -> list[dict[str, Any]]:
    if item.get("linked_wine_id") is None:
        return []
    names = []
    for image in item.get("historical_images", []):
        # Reject inconsistent offline exports rather than use another wine's image.
        if image.get("wine_id", item["linked_wine_id"]) != item["linked_wine_id"]:
            raise ValueError("Historical image belongs to a different linked wine")
        for field in ("url", "local_path"):
            basename = historical_basename(image.get(field))
            if basename:
                names.append(
                    {
                        "image_id": image.get("image_id"),
                        "source_field": field,
                        "basename": basename,
                    }
                )
    return sorted(names, key=json_bytes)


def _evidence_resolution(
    candidates: list[dict[str, Any]], names: list[dict[str, Any]]
) -> tuple[dict[str, Any] | None, str | None, dict[str, Any]]:
    candidates = sorted(candidates, key=lambda entry: entry["relative_path"])
    hashes = {entry["sha256"] for entry in candidates}
    if len(hashes) == 1 and re.fullmatch(r"[0-9a-f]{64}", next(iter(hashes)) or ""):
        return (
            candidates[0],
            "sha_equivalent",
            {
                "strength_rank": 3,
                "rule": "all-candidate-sha256-equal",
                "equivalent_candidate_paths": [c["relative_path"] for c in candidates],
            },
        )
    for method, normalize in (
        ("historical_asset_exact", False),
        ("historical_asset_normalized", True),
    ):
        matched = defaultdict(list)
        for entry in candidates:
            for name in names:
                left, right = entry["filename"], name["basename"]
                if normalize:
                    # Retain hashes: stripping them would destroy the tie-breaker.
                    left = normalize_filename(left, strip_strapi_hash=False)
                    right = normalize_filename(right, strip_strapi_hash=False)
                if left == right:
                    matched[entry["relative_path"]].append(name)
        evidence = {
            "strength_rank": 1 if normalize else 2,
            "rule": method,
            "matched_candidates": [
                {"relative_path": path, "historical_sources": sources}
                for path, sources in sorted(matched.items())
            ],
        }
        if len(matched) == 1:
            selected = next(c for c in candidates if c["relative_path"] in matched)
            return selected, method, evidence
        if len(matched) > 1:
            # Conflicting exact evidence must not be overridden by weaker evidence.
            return None, None, {**evidence, "conflict": True}
    return None, None, {"rule": "no-unique-historical-candidate"}


def _missing_analysis(
    row: dict[str, Any], files: list[dict[str, Any]]
) -> dict[str, Any]:
    key = normalize_filename(row["photo_name"], strip_strapi_hash=False)
    names = _historical_names(row)
    ranked = []
    historical_matches = []
    for entry in files:
        for name in names:
            if entry["filename"] == name["basename"]:
                historical_matches.append(
                    {
                        "relative_path": entry["relative_path"],
                        "historical_source": name,
                        "rule": "historical_basename_exact",
                        "decode_status": entry["decode_status"],
                        "sha256": entry["sha256"],
                    }
                )
        if not entry["raster_candidate"]:
            continue
        stem, extension = normalize_filename(entry["filename"])
        common = len(os.path.commonprefix((key[0], stem)))
        if stem == key[0] and stem:
            tier, reason = 0, "same-normalized-stem"
        elif min(len(stem), len(key[0])) >= 8 and common == min(len(stem), len(key[0])):
            tier, reason = 1, "complete-stem-prefix"
        elif common >= 12:
            tier, reason = 2, "longest-common-prefix"
        else:
            continue
        ranked.append(
            (
                tier,
                -common,
                {
                    "relative_path": entry["relative_path"],
                    "rule": reason,
                    "normalized_key": [stem, extension],
                    "common_prefix_length": common,
                    "decode_status": entry["decode_status"],
                    "sha256": entry["sha256"],
                },
            )
        )
    best = min((length, tier) for tier, length, _ in ranked) if ranked else None
    nearest = [entry for tier, length, entry in ranked if (length, tier) == best]
    return {
        "official_slug": row["official_slug"],
        "title": row.get("title"),
        "winery": row.get("winery"),
        "photo_name": row["photo_name"],
        "normalized_photo_key": list(key),
        "linked_historical_wine_exists": row.get("linked_wine_id") is not None,
        "linked_wine_id": row.get("linked_wine_id"),
        "historical_image_basenames": names,
        "historical_archive_matches": historical_matches,
        "closest_deterministic_candidates": nearest,
        "automatic_selection": False,
    }


def resolve_catalog(
    manifest: dict[str, Any], catalog: dict[str, Any]
) -> dict[str, Any]:
    """Refine primary ambiguity using content equality, then linked image names."""
    catalog = canonical_catalog(catalog)
    before = _resolve_primary(manifest, catalog)
    report = copy.deepcopy(before)
    files = sorted(manifest["files"], key=lambda entry: entry["relative_path"])
    by_path = {entry["relative_path"]: entry for entry in files}
    before_items = {row["official_slug"]: row for row in before["items"]}
    changes = []
    for row in report["items"]:
        row["original_match_class"] = row["match_class"]
        row["historical_image_basenames"] = _historical_names(row)
        row["equivalent_candidate_paths"] = []
        row["resolution_evidence"] = None
        if row["match_class"] != "ambiguous":
            continue
        selected, method, evidence = _evidence_resolution(
            [by_path[path] for path in row["candidate_paths"]],
            row["historical_image_basenames"],
        )
        row["resolution_evidence"] = evidence
        if selected is None:
            continue
        row["match_class"] = row["match_basis"] = method
        row["selected_relative_path"] = selected["relative_path"]
        row["equivalent_candidate_paths"] = evidence.get(
            "equivalent_candidate_paths", []
        )
        for field in (
            "sha256",
            "width",
            "height",
            "byte_size",
            "decode_status",
            "decode_error",
        ):
            row[field] = selected[field]
        changes.append(
            {
                "official_slug": row["official_slug"],
                "before": "ambiguous",
                "after": method,
                "selected_relative_path": selected["relative_path"],
                "evidence": evidence,
            }
        )
    # Evidence classes remain visible; sharing is a separate content-identity audit.
    physical = defaultdict(list)
    selected_paths = set()
    for row in report["items"]:
        row["physical_asset_id"] = f"sha256:{row['sha256']}" if row["sha256"] else None
        if row["physical_asset_id"]:
            physical[row["physical_asset_id"]].append(row)
            selected_paths.add(row["selected_relative_path"])
    shared_assets = []
    for asset_id, rows in sorted(physical.items()):
        if len(rows) > 1:
            shared_assets.append(
                {
                    "physical_asset_id": asset_id,
                    "official_slugs": [row["official_slug"] for row in rows],
                    "selected_relative_paths": sorted(
                        {row["selected_relative_path"] for row in rows}
                    ),
                    "photo_names": sorted({row["photo_name"] for row in rows}),
                }
            )
    counts = Counter(row["match_class"] for row in report["items"])
    after_counts = {name: counts[name] for name in RESOLUTION_CLASSES}
    before_counts = {
        name: before["summary"]["match_classes"].get(name, 0)
        for name in RESOLUTION_CLASSES
    }
    duplicate_names = defaultdict(list)
    for row in report["items"]:
        duplicate_names[row["photo_name"]].append(row)
    duplicate_groups = []
    for photo_name, rows in sorted(duplicate_names.items()):
        if len(rows) < 2:
            continue
        resolved = [row for row in rows if row["physical_asset_id"]]
        assets = {row["physical_asset_id"] for row in resolved}
        outcome = (
            "unresolved"
            if not resolved
            else "partially_resolved"
            if len(resolved) < len(rows)
            else "same_asset"
            if len(assets) == 1
            else "distinct_assets"
        )
        duplicate_groups.append(
            {
                "photo_name": photo_name,
                "item_count": len(rows),
                "outcome": outcome,
                "items": [
                    {
                        "official_slug": row["official_slug"],
                        "before": before_items[row["official_slug"]]["match_class"],
                        "after": row["match_class"],
                        "selected_relative_path": row["selected_relative_path"],
                        "physical_asset_id": row["physical_asset_id"],
                    }
                    for row in rows
                ],
            }
        )
    report.update(
        resolution_version="contest-resolution/2",
        before_after={"before": before_counts, "after": after_counts},
        resolution_changes=changes,
        baseline_shared_reference_groups=before["shared_reference_groups"],
        shared_physical_asset_groups=shared_assets,
        duplicate_photo_name_groups=duplicate_groups,
        duplicate_photo_name_audit={
            "catalog_items": len(report["items"]),
            "unique_photo_names": len(duplicate_names),
            "duplicate_name_groups": len(duplicate_groups),
            "items_in_duplicate_name_groups": sum(
                g["item_count"] for g in duplicate_groups
            ),
            "extra_items_beyond_unique_names": sum(
                g["item_count"] - 1 for g in duplicate_groups
            ),
            "group_outcomes": dict(
                sorted(Counter(g["outcome"] for g in duplicate_groups).items())
            ),
        },
        ambiguous_items=[
            row for row in report["items"] if row["match_class"] == "ambiguous"
        ],
        missing_items=[
            row for row in report["items"] if row["match_class"] == "missing"
        ],
        missing_analysis=[
            _missing_analysis(row, files)
            for row in report["items"]
            if row["match_class"] == "missing"
        ],
        unused_archive_files=[
            entry["relative_path"]
            for entry in files
            if entry["relative_path"] not in selected_paths
        ],
    )
    report["summary"].update(
        match_classes=after_counts,
        resolved_items=len(report["items"]) - counts["ambiguous"] - counts["missing"],
        selected_physical_assets=len(physical),
        selected_relative_paths=len(selected_paths),
        shared_physical_asset_groups=len(shared_assets),
        baseline_shared_reference_groups=len(before["shared_reference_groups"]),
        unused_archive_files=len(report["unused_archive_files"]),
        newly_resolved_items=len(changes),
    )
    return report


def render_review(report: dict[str, Any]) -> bytes:
    """Human-readable full audit, generated from the same deterministic report."""
    lines = [
        "# Official media evidence review",
        "",
        "No database or media mutations. Missing suggestions are not selections.",
        "",
        "## Before / after",
        "",
        "| Class | Before | After |",
        "| --- | ---: | ---: |",
    ]
    for name in RESOLUTION_CLASSES:
        before = report["before_after"]["before"][name]
        after = report["before_after"]["after"][name]
        lines.append(f"| {name} | {before} | {after} |")

    def section(title: str, entries: list[dict[str, Any]], key: str) -> None:
        lines.extend(["", f"## {title}", ""])
        for entry in entries:
            lines.extend(
                [
                    f"### {entry[key]}",
                    "",
                    "```json",
                    json_bytes(entry).decode("utf-8").rstrip(),
                    "```",
                    "",
                ]
            )

    section(
        "Baseline shared-reference groups",
        report["baseline_shared_reference_groups"],
        "relative_path",
    )
    lines.extend(
        [
            "",
            "## Duplicate photo-name accounting",
            "",
            "```json",
            json_bytes(report["duplicate_photo_name_audit"]).decode().rstrip(),
            "```",
            "",
        ]
    )
    section(
        "All duplicate photo-name groups",
        report["duplicate_photo_name_groups"],
        "photo_name",
    )
    section(
        "All unresolved ambiguous items", report["ambiguous_items"], "official_slug"
    )
    section(
        "All missing items and deterministic evidence",
        report["missing_analysis"],
        "official_slug",
    )
    return ("\n".join(lines).rstrip() + "\n").encode("utf-8")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    media = parser.add_mutually_exclusive_group(required=True)
    media.add_argument("--media-root", type=Path)
    media.add_argument("--manifest-json", type=Path, help="Reuse a prior manifest")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--import-version", help="Read via DATABASE_URL, read-only")
    source.add_argument("--catalog-json", type=Path, help="Exported catalog-items.json")
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    output = args.output_dir.resolve()
    if args.media_root:
        root = args.media_root.resolve(strict=True)
        if output == root or root in output.parents:
            parser.error("Report output must be outside the media snapshot")
    input_paths = [p.resolve() for p in (args.catalog_json, args.manifest_json) if p]
    outputs = [
        output / name
        for name in (
            "media-manifest.json",
            "catalog-items.json",
            "media-resolution.json",
            "media-review.md",
        )
    ]
    if any(path in input_paths for path in outputs):
        parser.error("Report outputs must not overwrite the input JSON files")
    if args.catalog_json:
        catalog = json.loads(args.catalog_json.read_text(encoding="utf-8-sig"))
    else:
        database_url = os.environ.get("DATABASE_URL")
        if not database_url:
            parser.error("DATABASE_URL must be set with --import-version")
        catalog = read_catalog(database_url, args.import_version)
    manifest = (
        json.loads(args.manifest_json.read_text(encoding="utf-8-sig"))
        if args.manifest_json
        else scan_media(args.media_root)
    )
    # Canonical ordering also makes exported JSON and its provenance hash agree.
    catalog = canonical_catalog(catalog)
    manifest = {
        **manifest,
        "files": sorted(manifest["files"], key=lambda entry: entry["relative_path"]),
    }
    report = resolve_catalog(manifest, catalog)
    output.mkdir(parents=True, exist_ok=True)
    for path, value in zip(
        outputs, (manifest, catalog, report, render_review(report)), strict=True
    ):
        if path.is_symlink():
            raise ValueError(f"Report destination is a symlink: {path.name}")
        path.write_bytes(value if isinstance(value, bytes) else json_bytes(value))
    print(json_bytes(report["summary"]).decode("utf-8"), end="")


if __name__ == "__main__":
    main()
