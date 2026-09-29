"""Discover and rank product links in saved IRecommend HTML; never fetch URLs."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import asdict
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

from app.irecommend import _SavedHTMLParser, _text
from app.irecommend_manifest import write_manifest
from app.irecommend_matching import _GENERIC, _tokens, find_irecommend_matches
from app.matching import normalize_match_text

PRODUCT_NAME_CLASSES = {"productName", "product-name", "productTitle", "product-title"}
REVIEW_LINK_CLASSES = {
    "reviewTextSnippet",
    "review-summary",
    "reviewTitle",
    "review-title",
}


def _content_url(value: str | None) -> str | None:
    if not value or not value.startswith(("/", "https://", "http://")):
        return None
    parsed = urlsplit(urljoin("https://irecommend.ru/", value))
    if (
        parsed.hostname != "irecommend.ru"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in {None, 80, 443}
        or not re.fullmatch(r"/content/[^/]+/?", parsed.path)
    ):
        return None
    # Tracking fragments/query parameters do not create another product.
    return urlunsplit(("https", "irecommend.ru", parsed.path.rstrip("/"), "", ""))


def discover_products(paths: Iterable[Path]) -> list[dict[str, Any]]:
    """Use explicit product-name markup, never a global content-link crawl."""
    products: dict[str, dict] = {}
    review_urls = set()
    for path in sorted({Path(path) for path in paths}):
        raw = path.read_bytes()
        parser = _SavedHTMLParser()
        parser.feed(raw.decode("utf-8-sig"))
        parser.close()
        parents = {child: node for node in parser.root.iter() for child in node}
        canonical = next(
            (
                _content_url(node.get("href"))
                for node in parser.root.iter("link")
                if "canonical" in node.get("rel", "").split()
            ),
            None,
        )
        if canonical and any(
            "review-node" in node.get("class", "").split()
            for node in parser.root.iter()
        ):
            review_urls.add(canonical)
        origin = {
            "html_path": path.as_posix(),
            "page_url": canonical,
            "html_sha256": hashlib.sha256(raw).hexdigest(),
        }
        for anchor in parser.root.iter("a"):
            url = _content_url(anchor.get("href"))
            if url is None:
                continue
            ancestors = []
            node = anchor
            while node is not None:
                ancestors.append(node)
                node = parents.get(node)
            classes = {
                value for node in ancestors for value in node.get("class", "").split()
            }
            if classes & REVIEW_LINK_CLASSES:
                review_urls.add(url)
                continue
            if not classes & PRODUCT_NAME_CLASSES or not _text(anchor):
                continue
            product = products.setdefault(url, {"titles": set(), "origins": []})
            product["titles"].add(_text(anchor))
            if origin not in product["origins"]:
                product["origins"].append(origin)
    return [
        {
            "source_url": url,
            "discovered_title": sorted(value["titles"])[0],
            "discovered_from": value["origins"],
            "observed_titles": sorted(value["titles"]),
        }
        for url, value in sorted(products.items())
        if url not in review_urls
    ]


def _brand_from_title(title: str, catalog: list[Mapping[str, Any]]) -> str:
    """A title-only hypothesis, using producer names explicitly present in it."""
    title_tokens = _tokens(title)
    matches = {}
    for row in catalog:
        winery = str(row.get("winery") or "")
        tokens = _tokens(winery) - _GENERIC
        if tokens and tokens <= title_tokens:
            matches.setdefault(frozenset(tokens), []).append(winery)
    if not matches:
        return ""
    longest = max(map(len, matches))
    best = [names for tokens, names in matches.items() if len(tokens) == longest]
    return sorted(best[0])[0] if len(best) == 1 else ""


def build_discovery(
    paths: Iterable[Path], catalog_items: Iterable[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    catalog = sorted((dict(row) for row in catalog_items), key=lambda row: row["id"])
    catalog_hash = hashlib.sha256(
        json.dumps(catalog, ensure_ascii=False, sort_keys=True, allow_nan=False).encode(
            "utf-8"
        )
    ).hexdigest()
    rows = []
    for product in discover_products(paths):
        brand = _brand_from_title(product["discovered_title"], catalog)
        result = find_irecommend_matches(
            {"title": product["discovered_title"], "brand": brand}, catalog
        )
        top = result.candidates[0] if result.candidates else None
        reasons = []
        if top:
            evidence = top.evidence
            if (
                not evidence["source_discriminative_tokens"]
                or evidence["discriminative_score"] != 1
            ):
                reasons.append("distinctive_identity_not_exact")
            if evidence["grape_score"] != 1:
                reasons.append("grape_not_exact")
        if (
            len({normalize_match_text(title) for title in product["observed_titles"]})
            > 1
        ):
            reasons.append("conflicting_discovered_titles")
        status = "reject"
        if result.status != "unmatched":
            status = (
                "strong_candidate"
                if result.status == "matched" and not reasons
                else "review_candidate"
            )
        rows.append(
            {
                "source_url": product["source_url"],
                "discovered_title": product["discovered_title"],
                "discovered_from": product["discovered_from"],
                "best_catalog_item_id": top.catalog_item_id if top else None,
                "best_official_slug": top.official_slug if top else None,
                "score": top.score if top else 0.0,
                "status": status,
                "evidence": {
                    "purpose": "discovery_only",
                    "requires_product_page_parse": True,
                    "observed_titles": product["observed_titles"],
                    "brand_hypothesis_from_title": brand,
                    "strong_candidate_exclusions": reasons,
                    "matcher": asdict(result),
                    "catalog_sha256": catalog_hash,
                    "catalog_items_count": len(catalog),
                },
            }
        )
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--samples-dir", type=Path, default=Path("data/irecommend/samples")
    )
    parser.add_argument(
        "--catalog", type=Path, default=Path("data/irecommend/catalog_items.json")
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/irecommend/discovery_candidates.jsonl"),
    )
    args = parser.parse_args(argv)
    try:
        paths = sorted(args.samples_dir.glob("*.html"))
        if not paths:
            raise ValueError("No local HTML samples found")
        if args.output.resolve() in {path.resolve() for path in [*paths, args.catalog]}:
            raise ValueError("Output must not overwrite an input")
        catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
        if not isinstance(catalog, list):
            raise ValueError("Catalog snapshot must be a JSON array")
        rows = build_discovery(paths, catalog)
        write_manifest(args.output, rows)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        parser.error(str(exc))
    counts = Counter(row["status"] for row in rows)
    print(f"unique product URLs: {len(rows)}")
    for status in ("strong_candidate", "review_candidate", "reject"):
        print(f"{status}: {counts[status]}")
    print("Top 30 strong_candidate (discovery predictions only):")
    for row in sorted(rows, key=lambda row: (-row["score"], row["source_url"])):
        if row["status"] == "strong_candidate":
            print(
                json.dumps(
                    {
                        "discovered_title": row["discovered_title"],
                        "source_url": row["source_url"],
                        "predicted official_slug": row["best_official_slug"],
                        "score": row["score"],
                    },
                    ensure_ascii=False,
                )
            )
            counts["printed"] += 1
            if counts["printed"] == 30:
                break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
