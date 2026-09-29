"""Build image manifests from local IRecommend HTML and an offline catalog JSON."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections.abc import Iterable, Mapping
from dataclasses import asdict
from pathlib import Path
from typing import Any

from app.irecommend import parse_product_page, parse_review_page
from app.irecommend_matching import (
    AMBIGUITY_MARGIN,
    MATCH_THRESHOLD,
    REVIEW_THRESHOLD,
    find_irecommend_matches,
)
from app.matching import normalize_match_text

MANIFEST_VERSION = "ugc-manifest/2"
PARSER_VERSION = "irecommend-html/2"
MATCHER_VERSION = "irecommend-catalog/1"
VERIFICATION_STATUSES = {"auto", "human_confirmed", "human_rejected"}
QUALITY_STATUSES = {"keep", "keep_hard", "drop", "unknown"}
MATCH_STATUSES = {"matched", "needs_review", "unmatched"}
CATALOG_FIELDS = ("id", "official_slug", "title", "winery", "category", "grapes")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _load_pages(paths: Iterable[Path], parser, id_field: str) -> dict:
    pages: dict[str, tuple[Any, dict]] = {}
    for path in sorted({Path(path) for path in paths}):
        raw = path.read_bytes()
        parsed = parser(raw.decode("utf-8-sig"))
        identity = getattr(parsed, id_field)
        digest = _sha256(raw)
        if identity in pages:
            provenance = pages[identity][1]
            if digest != provenance["sha256"]:
                raise ValueError(
                    f"Conflicting HTML snapshots for {id_field}={identity}"
                )
            provenance["paths"].append(path.as_posix())
        else:
            pages[identity] = (parsed, {"sha256": digest, "paths": [path.as_posix()]})
    return pages


def build_manifest(
    product_paths: Iterable[Path],
    review_paths: Iterable[Path],
    catalog_items: Iterable[Mapping[str, Any]],
    *,
    review_verifications: Iterable[Mapping[str, Any]] = (),
    image_quality_overrides: Iterable[Mapping[str, Any]] = (),
) -> list[dict[str, Any]]:
    """Build image rows and apply explicit review decisions; no DB or network.

    Reviews must be linked by source product ID to supplied product HTML.
    Different snapshots of one page or reuse of one image across reviews fail
    closed rather than silently discarding provenance or selecting a label.
    """
    products = _load_pages(product_paths, parse_product_page, "product_id")
    reviews = _load_pages(review_paths, parse_review_page, "review_id")
    catalog = [
        {field: row.get(field) for field in CATALOG_FIELDS} for row in catalog_items
    ]
    for row in catalog:
        if (
            type(row["id"]) is not int
            or row["id"] <= 0
            or not isinstance(row["official_slug"], str)
            or not row["official_slug"].strip()
        ):
            raise ValueError("Catalog rows require a positive ID and official_slug")
    catalog.sort(key=lambda row: row["id"])
    if len({row["id"] for row in catalog}) != len(catalog):
        raise ValueError("Duplicate catalog item IDs")
    catalog_sha256 = _sha256(_json(catalog).encode("utf-8"))
    verifications = {}
    catalog_ids = {row["id"] for row in catalog}
    for decision in review_verifications:
        decision = dict(decision)
        review_id = decision.get("source_review_id")
        if (
            not isinstance(review_id, str)
            or not review_id.isdigit()
            or decision.get("verification_status") not in VERIFICATION_STATUSES
            or type(decision.get("catalog_item_id")) is not int
            or decision["catalog_item_id"] not in catalog_ids
        ):
            raise ValueError("Invalid review verification or unknown catalog identity")
        if review_id in verifications and verifications[review_id] != decision:
            raise ValueError(f"Conflicting verification for review {review_id}")
        verifications[review_id] = decision
    quality_overrides = {}
    for quality in image_quality_overrides:
        quality = dict(quality)
        identity = quality.get("image_identity")
        if (
            not isinstance(identity, str)
            or not identity.strip()
            or quality.get("quality_status") not in QUALITY_STATUSES
        ):
            raise ValueError("Invalid image quality override")
        if identity in quality_overrides and quality_overrides[identity] != quality:
            raise ValueError(f"Conflicting quality overrides for {identity}")
        quality_overrides[identity] = quality
    rows = {}
    for review_id, (review, review_provenance) in sorted(reviews.items()):
        if review.product_id not in products:
            raise ValueError(f"Review {review_id} has no supplied product HTML")
        product, product_provenance = products[review.product_id]
        if normalize_match_text(product.title) != normalize_match_text(
            review.product_title
        ):
            raise ValueError(
                f"Review {review_id} product title disagrees with product HTML"
            )
        result = find_irecommend_matches(
            product, catalog, year_candidates=review.vintage_candidates
        )
        top = result.candidates[0] if result.candidates else None
        evidence = {
            **asdict(result),
            "catalog_sha256": catalog_sha256,
            "catalog_items_count": len(catalog),
            "thresholds": {
                "matched": MATCH_THRESHOLD,
                "needs_review": REVIEW_THRESHOLD,
                "ambiguity_margin": AMBIGUITY_MARGIN,
            },
        }
        decision = verifications.get(review_id)
        if decision and (
            top is None or decision["catalog_item_id"] != top.catalog_item_id
        ):
            raise ValueError(
                f"Review {review_id} verification disagrees with catalog match"
            )
        human_confirmed = (
            decision is not None
            and decision["verification_status"] == "human_confirmed"
        )
        resolved = top is not None and (
            result.status != "unmatched" or human_confirmed
        )
        match_status = "matched" if human_confirmed else result.status
        for image in review.images:
            if image.image_key in rows:
                raise ValueError(
                    f"Image {image.image_key} occurs in multiple reviews; "
                    "resolve source ownership before building the manifest"
                )
            quality = quality_overrides.get(image.image_key)
            rows[image.image_key] = {
                "manifest_version": MANIFEST_VERSION,
                "source": "irecommend",
                "source_product_id": product.product_id,
                "product_url": product.canonical_url,
                "source_review_id": review_id,
                "review_url": review.canonical_url,
                "image_identity": image.image_key,
                "preferred_url": image.preferred_url,
                "url_variants": sorted(set(image.url_variants)),
                "catalog_item_id": top.catalog_item_id if resolved else None,
                "official_slug": top.official_slug if resolved else None,
                "match_score": top.score if top else None,
                "match_status": match_status,
                "verification_status": decision["verification_status"]
                if decision
                else "auto",
                "quality_status": quality["quality_status"] if quality else "unknown",
                "year_candidates": sorted(review.year_candidates),
                "vintage_candidates": sorted(review.vintage_candidates),
                "match_evidence": evidence,
                "provenance": {
                    "parser_version": PARSER_VERSION,
                    "matcher_version": MATCHER_VERSION,
                    "product_html": product_provenance,
                    "review_html": review_provenance,
                    "product_title": product.title,
                    "brand": product.brand,
                    "beverage_type": product.beverage_type,
                    "review_title": review.title,
                    "review_author": review.author,
                    "publication_date": review.publication_date.isoformat(),
                    "image_filename": image.filename,
                    "image_quality_override": quality,
                    "image_quality_override_sha256": (
                        _sha256(_json(quality).encode("utf-8")) if quality else None
                    ),
                    "review_verification": decision,
                    "review_verification_sha256": (
                        _sha256(_json(decision).encode("utf-8")) if decision else None
                    ),
                },
            }
    return [rows[key] for key in sorted(rows)]


def confirmed_manifest(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Select only explicitly human-confirmed exact image/SKU assignments.

    Shared field names allow other UGC sources to use this filter. Confirmation
    is an external human action; neither this helper nor build performs it.
    """
    confirmed = {}
    seen = {}
    for row in rows:
        if row.get("verification_status") not in VERIFICATION_STATUSES:
            raise ValueError("Invalid verification_status")
        if row.get("match_status") not in MATCH_STATUSES:
            raise ValueError("Invalid match_status")
        key = (row.get("source"), row.get("image_identity"))
        if not all(isinstance(value, str) and value.strip() for value in key):
            raise ValueError("Manifest rows require source and image_identity")
        serialized = _json(dict(row))
        if key in seen and seen[key] != serialized:
            raise ValueError(f"Conflicting manifest rows for {key}")
        seen[key] = serialized
        if (
            row["match_status"] != "matched"
            or row["verification_status"] != "human_confirmed"
        ):
            continue
        if (
            type(row.get("catalog_item_id")) is not int
            or row["catalog_item_id"] <= 0
            or not isinstance(row.get("official_slug"), str)
            or not row["official_slug"].strip()
            or not row.get("source_review_id")
            or not row.get("review_url")
        ):
            raise ValueError(
                "Confirmed image requires exact catalog and review identity"
            )
        confirmed[key] = dict(row)
    return [confirmed[key] for key in sorted(confirmed)]


def training_manifest(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Export exact human-confirmed images with an explicit keep decision only."""
    return [
        row
        for row in confirmed_manifest(rows)
        if row.get("quality_status") in {"keep", "keep_hard"}
    ]


def write_manifest(path: Path, rows: Iterable[Mapping[str, Any]]) -> None:
    """Replace, never append. Serialize fully before touching the output file."""
    content = "".join(_json(dict(row)) + "\n" for row in rows)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_text(content, encoding="utf-8", newline="\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def read_manifest(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser(
        "build", help="Build all, confirmed and training manifests"
    )
    build.add_argument(
        "--samples-dir", type=Path, default=Path("data/irecommend/samples")
    )
    build.add_argument("--product", type=Path, nargs="+")
    build.add_argument("--review", type=Path, nargs="+")
    build.add_argument(
        "--catalog", type=Path, default=Path("data/irecommend/catalog_items.json")
    )
    build.add_argument("--verifications", type=Path)
    build.add_argument("--quality-overrides", type=Path)
    build.add_argument(
        "--output", type=Path, default=Path("data/irecommend/manifest.jsonl")
    )
    build.add_argument("--confirmed-output", type=Path)
    build.add_argument("--training-output", type=Path)
    export = commands.add_parser(
        "confirmed", help="Export human-confirmed exact matches"
    )
    export.add_argument("--input", type=Path, required=True)
    export.add_argument(
        "--output", type=Path, default=Path("data/irecommend/manifest.confirmed.jsonl")
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            products = args.product or sorted(args.samples_dir.glob("product*.html"))
            reviews = args.review or sorted(args.samples_dir.glob("review*.html"))
            if not products or not reviews:
                raise ValueError("Supply local product and review HTML files")
            verifications = (
                args.verifications
                or args.samples_dir.parent / "review_verifications.jsonl"
            )
            decisions = read_manifest(verifications) if verifications.exists() else []
            if args.verifications and not verifications.exists():
                raise ValueError("Explicit --verifications file does not exist")
            quality_path = (
                args.quality_overrides
                or args.samples_dir.parent / "image_quality_overrides.jsonl"
            )
            quality_decisions = (
                read_manifest(quality_path) if quality_path.exists() else []
            )
            if args.quality_overrides and not quality_path.exists():
                raise ValueError("Explicit --quality-overrides file does not exist")
            inputs = [*products, *reviews, args.catalog, verifications, quality_path]
            confirmed_output = args.confirmed_output or args.output.with_name(
                args.output.stem + ".confirmed.jsonl"
            )
            training_output = args.training_output or args.output.with_name(
                args.output.stem + ".training.jsonl"
            )
            outputs = [args.output, confirmed_output, training_output]
        else:
            inputs, outputs = [args.input], [args.output]
        if len({path.resolve() for path in outputs}) != len(outputs):
            raise ValueError("Output files must be distinct")
        if {path.resolve() for path in outputs} & {path.resolve() for path in inputs}:
            raise ValueError("Output must not overwrite an input file")
        if args.command == "build":
            catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
            if not isinstance(catalog, list):
                raise ValueError("--catalog must contain a JSON array")
            rows = build_manifest(
                products,
                reviews,
                catalog,
                review_verifications=decisions,
                image_quality_overrides=quality_decisions,
            )
            confirmed = confirmed_manifest(rows)
            training = training_manifest(rows)
            write_manifest(training_output, training)
            print(f"{len(training)} records -> {training_output}")
            write_manifest(confirmed_output, confirmed)
            print(f"{len(confirmed)} records -> {confirmed_output}")
        else:
            rows = confirmed_manifest(read_manifest(args.input))
        write_manifest(args.output, rows)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        parser.error(str(exc))
    print(f"{len(rows)} records -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
