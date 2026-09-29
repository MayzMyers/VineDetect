"""Command line entrypoint for the wine crawler."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from app.barcodes import apply_barcode_matches_to_db
from app.config import get_config
from app.crawler import crawl_details, crawl_index
from app.http import WineHttpClient
from app.image_assets import collect_image_assets
from app.image_downloader import download_images
from app.image_stats import collect_image_stats, format_image_stats
from app.image_storage_migration import (
    format_image_storage_migration_report,
    migrate_image_storage,
)
from app.matching import match_roskachestvo_to_wines
from app.rating_snapshots import extract_rating_snapshots_to_db
from app.repositories import DatabaseStats, WineRepository
from app.roskachestvo_products import (
    RoskachestvoProductsClient,
    audit_roskachestvo_products,
    collect_roskachestvo_product_image_urls,
    download_roskachestvo_product_images_to_storage,
    import_roskachestvo_product_details_to_db,
    import_roskachestvo_products_to_db,
)

PLACEHOLDER_MESSAGES = {
    "all": "Full crawling will be implemented in a later stage.",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.main",
        description="Collect public wine catalog data from vino-svoe.ru.",
    )
    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("index")

    details_parser = subparsers.add_parser("details")
    details_parser.add_argument("--limit", type=int, default=1000)

    stats_parser = subparsers.add_parser("stats")
    stats_parser.add_argument("--top-limit", type=int, default=10)

    collect_parser = subparsers.add_parser("collect-images")
    collect_parser.add_argument("--reset", action="store_true")

    download_parser = subparsers.add_parser("download-images")
    download_parser.add_argument("--limit", type=int, default=100)
    download_parser.add_argument("--kind", default=None)
    download_parser.add_argument("--output-dir", default="data/images")
    image_stats_parser = subparsers.add_parser("image-stats")
    image_stats_parser.add_argument("--kind", default="bottle")
    image_stats_parser.add_argument("--base-dir", default=".")
    image_stats_parser.add_argument("--problem-limit", type=int, default=20)
    subparsers.add_parser("extract-rating-snapshots")
    subparsers.add_parser("rating-snapshot-stats")

    products_parser = subparsers.add_parser("import-roskachestvo-products")
    products_parser.add_argument("--limit", type=int, default=None)
    products_parser.add_argument("--reset-list-errors", action="store_true")

    product_details_parser = subparsers.add_parser(
        "import-roskachestvo-product-details",
    )
    product_details_parser.add_argument("--limit", type=int, default=None)
    product_details_parser.add_argument("--failed-only", action="store_true")
    product_details_parser.add_argument("--force", action="store_true")

    image_urls_parser = subparsers.add_parser(
        "collect-roskachestvo-product-image-urls",
    )
    image_urls_parser.add_argument("--limit", type=int, default=None)
    image_urls_parser.add_argument("--failed-only", action="store_true")
    image_urls_parser.add_argument("--force", action="store_true")

    product_images_parser = subparsers.add_parser(
        "download-roskachestvo-product-images",
    )
    product_images_parser.add_argument("--limit", type=int, default=None)
    product_images_parser.add_argument("--failed-only", action="store_true")
    product_images_parser.add_argument("--force", action="store_true")
    product_images_parser.add_argument("--storage-root", default="storage")

    subparsers.add_parser("roskachestvo-product-stats")

    subparsers.add_parser("release-snapshot")

    migrate_images_parser = subparsers.add_parser("migrate-image-storage")
    migrate_images_parser.add_argument("--source-root", default="..")
    migrate_images_parser.add_argument("--target-root", default="storage/images")
    migrate_images_parser.add_argument("--dry-run", action="store_true")
    migrate_images_parser.add_argument("--extra-root", action="append", default=[])

    product_audit_parser = subparsers.add_parser("roskachestvo-product-audit")
    product_audit_parser.add_argument("--storage-root", default="storage")
    product_audit_parser.add_argument("--limit-missing", type=int, default=20)
    product_audit_parser.add_argument("--limit-mismatch", type=int, default=20)

    match_roskachestvo_parser = subparsers.add_parser("match-roskachestvo")
    match_roskachestvo_parser.add_argument("--top-k", type=int, default=5)
    match_roskachestvo_parser.add_argument("--min-score", type=float, default=0.55)
    match_roskachestvo_parser.add_argument("--limit", type=int, default=None)
    match_roskachestvo_parser.add_argument("--reset", action="store_true")

    match_stats_parser = subparsers.add_parser("roskachestvo-match-stats")
    match_stats_parser.add_argument("--limit", type=int, default=20)

    apply_barcode_parser = subparsers.add_parser("apply-barcode-matches")
    apply_barcode_parser.add_argument("--source", default="roskachestvo")
    apply_barcode_parser.add_argument("--min-score", type=float, default=0.88)
    apply_barcode_parser.add_argument("--min-gap", type=float, default=0.08)
    apply_barcode_parser.add_argument("--limit", type=int, default=None)
    apply_barcode_parser.add_argument("--dry-run", action="store_true")

    barcode_stats_parser = subparsers.add_parser("barcode-stats")
    barcode_stats_parser.add_argument("--limit", type=int, default=20)
    for command in PLACEHOLDER_MESSAGES:
        subparsers.add_parser(command)
    return parser


def run_index() -> None:
    config = get_config()

    with WineHttpClient(
        base_url=config.base_url,
        user_agent=config.user_agent,
        timeout=config.timeout,
        delay_min=config.delay_min,
        delay_max=config.delay_max,
    ) as client:
        with WineRepository(database_url=config.database_url) as repo:
            stats = crawl_index(
                client=client,
                repo=repo,
                base_url=config.base_url,
                per_page=config.per_page,
            )

    print("Index crawl finished")
    print(f"Total pages: {stats.total_pages}")
    print(f"Pages ok: {stats.pages_ok}")
    print(f"Pages failed: {stats.pages_failed}")
    print(f"Items seen: {stats.items_seen}")
    print(f"Wines saved: {stats.wines_saved}")
    print(f"Wines failed: {stats.wines_failed}")


def run_details(limit: int) -> None:
    config = get_config()

    with WineHttpClient(
        base_url=config.base_url,
        user_agent=config.user_agent,
        timeout=config.timeout,
        delay_min=config.delay_min,
        delay_max=config.delay_max,
    ) as client:
        with WineRepository(database_url=config.database_url) as repo:
            stats = crawl_details(
                client=client,
                repo=repo,
                base_url=config.base_url,
                limit=limit,
            )

    print("Detail crawl finished")
    print(f"Slugs seen: {stats.slugs_seen}")
    print(f"Details saved: {stats.details_saved}")
    print(f"Details failed: {stats.details_failed}")
    print(f"Grapes saved: {stats.grapes_saved}")
    print(f"Dishes saved: {stats.dishes_saved}")


def _format_named_counts(items: dict[str, int]) -> list[str]:
    if not items:
        return ["  no data"]
    return [f"  {name}: {count}" for name, count in items.items()]


def _format_top_items(items: list[tuple[str, int]]) -> list[str]:
    if not items:
        return ["  no data"]
    return [f"  {name}: {count}" for name, count in items]


def format_stats(stats: DatabaseStats) -> str:
    lines = [
        "Database stats",
        "==============",
        f"Wines total: {stats.wines_total}",
        f"Wines with details: {stats.wines_with_details}",
        f"Wines without details: {stats.wines_without_details}",
        f"Grapes: {stats.grapes_total}",
        f"Dishes: {stats.dishes_total}",
        f"Wine-grape links: {stats.wine_grapes_total}",
        f"Wine-dish links: {stats.wine_dishes_total}",
        "",
        "Crawl page statuses:",
        *_format_named_counts(stats.page_statuses),
        "",
        "Crawl wine statuses:",
        *_format_named_counts(stats.wine_statuses),
        "",
        "Top regions:",
        *_format_top_items(stats.top_regions),
        "",
        "Top categories:",
        *_format_top_items(stats.top_categories),
        "",
        "Top manufacturers:",
        *_format_top_items(stats.top_manufacturers),
    ]
    return "\n".join(lines)


def run_stats(top_limit: int = 10) -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        stats = repo.get_database_stats(top_limit=top_limit)

    print(format_stats(stats))


def run_collect_images(reset: bool = False) -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        if reset:
            repo.clear_wine_images()
        stats = collect_image_assets(repo)

    print("Image assets collection finished")
    print(f"Wines seen: {stats.wines_seen}")
    print(f"Assets seen: {stats.assets_seen}")
    print(f"Assets saved: {stats.assets_saved}")


def run_download_images(limit: int, kind: str | None, output_dir: str) -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        stats = download_images(
            repo=repo,
            output_dir=output_dir,
            limit=limit,
            kind=kind,
            delay_min=config.delay_min,
            delay_max=config.delay_max,
            timeout=config.timeout,
            user_agent=config.user_agent,
        )

    print("Image download finished")
    print(f"Images seen: {stats.images_seen}")
    print(f"Images downloaded: {stats.images_downloaded}")
    print(f"Images skipped: {stats.images_skipped}")
    print(f"Images failed: {stats.images_failed}")


def run_image_stats(
    kind: str | None = "bottle",
    base_dir: str = ".",
    problem_limit: int = 20,
) -> None:
    config = get_config()
    resolved_kind = None if kind == "all" else kind

    with WineRepository(database_url=config.database_url) as repo:
        stats = collect_image_stats(
            repo=repo,
            base_dir=base_dir,
            kind=resolved_kind,
            problem_limit=problem_limit,
        )

    print(format_image_stats(stats))


def run_extract_rating_snapshots() -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        stats = extract_rating_snapshots_to_db(repo)

    print("Rating snapshot extraction finished")
    print(f"Wines seen: {stats.wines_seen}")
    print(f"Snapshots seen: {stats.snapshots_seen}")
    print(f"Snapshots saved: {stats.snapshots_saved}")


def run_rating_snapshot_stats() -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        rows = repo.get_rating_snapshot_stats()

    print("Rating snapshot stats")
    print("=====================")

    if not rows:
        print("no data")
        return

    for row in rows:
        print(
            f"{row['source']}: "
            f"count={row['count']}, "
            f"min={row['min_rating']}, "
            f"max={row['max_rating']}, "
            f"avg={row['avg_rating']}, "
            f"oldest_fetched_at={row['oldest_fetched_at']}, "
            f"newest_fetched_at={row['newest_fetched_at']}"
        )


def _roskachestvo_products_client(config) -> RoskachestvoProductsClient:
    return RoskachestvoProductsClient(
        timeout=config.timeout,
        user_agent=config.user_agent,
    )


def run_import_roskachestvo_products(
    limit: int | None = None,
    reset_list_errors: bool = False,
) -> None:
    config = get_config()

    client = _roskachestvo_products_client(config)
    with WineRepository(database_url=config.database_url) as repo:
        stats = import_roskachestvo_products_to_db(
            repo=repo,
            client=client,
            limit=limit,
            reset_list_errors=reset_list_errors,
        )

    print("Roskachestvo products import finished")
    print(f"Products seen: {stats.products_seen}")
    print(f"Products saved: {stats.products_saved}")
    print(f"Products failed: {stats.products_failed}")


def run_import_roskachestvo_product_details(
    limit: int | None = None,
    failed_only: bool = False,
    force: bool = False,
) -> None:
    config = get_config()

    client = _roskachestvo_products_client(config)
    with WineRepository(database_url=config.database_url) as repo:
        stats = import_roskachestvo_product_details_to_db(
            repo=repo,
            client=client,
            limit=limit,
            failed_only=failed_only,
            force=force,
        )

    print("Roskachestvo product details import finished")
    print(f"Products seen: {stats.products_seen}")
    print(f"Details saved: {stats.details_saved}")
    print(f"Details skipped: {stats.details_skipped}")
    print(f"Details failed: {stats.details_failed}")


def run_collect_roskachestvo_product_image_urls(
    limit: int | None = None,
    failed_only: bool = False,
    force: bool = False,
) -> None:
    config = get_config()

    client = _roskachestvo_products_client(config)
    with WineRepository(database_url=config.database_url) as repo:
        stats = collect_roskachestvo_product_image_urls(
            repo=repo,
            client=client,
            limit=limit,
            failed_only=failed_only,
            force=force,
        )

    print("Roskachestvo product image URL collection finished")
    print(f"Products seen: {stats.products_seen}")
    print(f"Image URLs saved: {stats.image_urls_saved}")
    print(f"Pages skipped: {stats.pages_skipped}")
    print(f"Pages failed: {stats.pages_failed}")


def run_download_roskachestvo_product_images(
    limit: int | None = None,
    failed_only: bool = False,
    force: bool = False,
    storage_root: str = "storage",
) -> None:
    config = get_config()

    client = _roskachestvo_products_client(config)
    with WineRepository(database_url=config.database_url) as repo:
        stats = download_roskachestvo_product_images_to_storage(
            repo=repo,
            client=client,
            storage_root=Path(storage_root),
            limit=limit,
            failed_only=failed_only,
            force=force,
        )

    print("Roskachestvo product image download finished")
    print(f"Products seen: {stats.products_seen}")
    print(f"Images downloaded: {stats.images_downloaded}")
    print(f"Images skipped: {stats.images_skipped}")
    print(f"Images failed: {stats.images_failed}")


def run_roskachestvo_product_stats() -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        stats = repo.get_roskachestvo_product_stats()

    print("Roskachestvo product stats")
    print("==========================")
    print(f"Products total: {stats.get('products_total')}")
    print(f"With barcode: {stats.get('with_barcode')}")
    print(f"Without barcode: {stats.get('without_barcode')}")
    print(f"With list JSON: {stats.get('with_list_json')}")
    print(f"With detail JSON: {stats.get('with_detail_json')}")
    print(f"With product link: {stats.get('with_product_link')}")
    print(f"With image source URL: {stats.get('with_image_source_url')}")
    print(f"With image local path: {stats.get('with_image_local_path')}")
    print(f"List ok: {stats.get('list_ok')}")
    print(f"Detail ok: {stats.get('detail_ok')}")
    print(f"Page ok: {stats.get('page_ok')}")
    print(f"Image download ok: {stats.get('image_download_ok')}")
    print(f"Image processing ok: {stats.get('image_processing_ok')}")


def _snapshot_value(snapshot: dict[str, Any], key: str) -> Any:
    value = snapshot.get(key, 0)
    return 0 if value is None else value


def _snapshot_bool(snapshot: dict[str, Any], key: str) -> str:
    return "true" if bool(snapshot.get(key, False)) else "false"


def format_release_snapshot(snapshot: dict[str, Any]) -> str:
    lines = [
        "Wine crawler release snapshot",
        "=============================",
        "",
        "Svoe Vino",
        "---------",
        f"Wines total: {_snapshot_value(snapshot, 'wines_total')}",
        f"Wines with image URL: {_snapshot_value(snapshot, 'wines_with_image_url')}",
        f"Wines with raw detail JSON: "
        f"{_snapshot_value(snapshot, 'wines_with_raw_detail_json')}",
        f"Wine images total: {_snapshot_value(snapshot, 'wine_images_total')}",
        f"Wine images with local path: "
        f"{_snapshot_value(snapshot, 'wine_images_with_local_path')}",
        "",
        "Roskachestvo",
        "------------",
        f"Roskachestvo products total: "
        f"{_snapshot_value(snapshot, 'roskachestvo_products_total')}",
        f"With barcode: {_snapshot_value(snapshot, 'roskachestvo_with_barcode')}",
        f"With detail JSON: "
        f"{_snapshot_value(snapshot, 'roskachestvo_with_detail_json')}",
        f"With product link: "
        f"{_snapshot_value(snapshot, 'roskachestvo_with_product_link')}",
        f"With image source URL: "
        f"{_snapshot_value(snapshot, 'roskachestvo_with_image_source_url')}",
        f"With image local path: "
        f"{_snapshot_value(snapshot, 'roskachestvo_with_image_local_path')}",
        f"Detail ok: {_snapshot_value(snapshot, 'roskachestvo_detail_ok')}",
        f"Detail failed: {_snapshot_value(snapshot, 'roskachestvo_detail_failed')}",
        f"Page ok: {_snapshot_value(snapshot, 'roskachestvo_page_ok')}",
        f"Page failed: {_snapshot_value(snapshot, 'roskachestvo_page_failed')}",
        f"Image download ok: "
        f"{_snapshot_value(snapshot, 'roskachestvo_image_download_ok')}",
        f"Image download failed: "
        f"{_snapshot_value(snapshot, 'roskachestvo_image_download_failed')}",
        "",
        "Matching",
        "--------",
        f"Roskachestvo matches total: "
        f"{_snapshot_value(snapshot, 'roskachestvo_matches_total')}",
        f"Joined to roskachestvo.products: "
        f"{_snapshot_value(snapshot, 'roskachestvo_matches_joined_to_products')}",
        f"Matching not joined: "
        f"{_snapshot_value(snapshot, 'roskachestvo_matches_not_joined')}",
        "",
        "Barcodes",
        "--------",
        f"Roskachestvo barcode links total: "
        f"{_snapshot_value(snapshot, 'roskachestvo_barcode_links_total')}",
        f"Joined to roskachestvo.products: "
        f"{_snapshot_value(snapshot, 'roskachestvo_barcode_links_joined_to_products')}",
        f"Barcode not joined: "
        f"{_snapshot_value(snapshot, 'roskachestvo_barcode_links_not_joined')}",
        "",
        "Legacy",
        "------",
        f"public.roskachestvo_wines exists: "
        f"{_snapshot_bool(snapshot, 'legacy_roskachestvo_wines_exists')}",
        "",
        "API",
        "---",
        "Read-only catalog API: implemented",
        "GET /health",
        "GET /api/v1/wines",
        "GET /api/v1/wines/by-barcode/{barcode}",
        "GET /api/v1/catalog?source=all",
        "GET /api/v1/catalog?source=svoe_vino",
        "GET /api/v1/catalog?source=roskachestvo",
    ]

    warnings = []
    matches_not_joined = _snapshot_value(
        snapshot,
        "roskachestvo_matches_not_joined",
    )
    barcode_links_not_joined = _snapshot_value(
        snapshot,
        "roskachestvo_barcode_links_not_joined",
    )
    if matches_not_joined > 0:
        warnings.append(
            "Roskachestvo matches not joined to roskachestvo.products: "
            f"{matches_not_joined}",
        )
    if barcode_links_not_joined > 0:
        warnings.append(
            "Roskachestvo barcode links not joined to roskachestvo.products: "
            f"{barcode_links_not_joined}",
        )
    if snapshot.get("legacy_roskachestvo_wines_exists", False):
        warnings.append("public.roskachestvo_wines still exists")

    if warnings:
        lines.extend(["", "Warnings:", *[f"- {warning}" for warning in warnings]])

    return "\n".join(lines)


def run_release_snapshot() -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        snapshot = repo.get_release_snapshot()

    print(format_release_snapshot(snapshot))


def run_migrate_image_storage(
    *,
    source_root: str,
    target_root: str,
    dry_run: bool,
    extra_roots: list[str] | None = None,
):
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        report = migrate_image_storage(
            repo,
            source_root=source_root,
            target_root=target_root,
            dry_run=dry_run,
            extra_roots=extra_roots or [],
        )

    print(format_image_storage_migration_report(report))
    return report


def _print_product_audit_rows(rows: list[dict], limit: int) -> None:
    if not rows or limit <= 0:
        print("  no data")
        return

    for row in rows[:limit]:
        print(
            f"  {row.get('rskrf_product_id')}: "
            f"{row.get('image_local_path')} "
            f"(db_size={row.get('image_size_bytes')}, "
            f"disk_size={row.get('disk_size_bytes', 'n/a')})"
        )


def run_roskachestvo_product_audit(
    storage_root: str = "storage",
    limit_missing: int = 20,
    limit_mismatch: int = 20,
) -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        stats, missing_files, size_mismatches = audit_roskachestvo_products(
            repo=repo,
            storage_root=Path(storage_root),
        )

    print("Roskachestvo product audit")
    print("==========================")
    print(f"Products total: {stats.products_total}")
    print(f"Detail ok: {stats.detail_ok}")
    print(f"Detail failed: {stats.detail_failed}")
    print(f"Page ok: {stats.page_ok}")
    print(f"Page failed: {stats.page_failed}")
    print(f"Image download ok: {stats.image_download_ok}")
    print(f"Image download failed: {stats.image_download_failed}")
    print(f"Image local path filled: {stats.image_local_path_filled}")
    print(f"Files existing: {stats.files_existing}")
    print(f"Files missing: {stats.files_missing}")
    print(f"Files zero size: {stats.files_zero_size}")
    print(f"Files size mismatch: {stats.files_size_mismatch}")
    print(f"DB size total: {stats.db_size_total}")
    print(f"Disk size total: {stats.disk_size_total}")
    print()
    print("Missing files:")
    _print_product_audit_rows(missing_files, limit_missing)
    print()
    print("Size mismatches:")
    _print_product_audit_rows(size_mismatches, limit_mismatch)


def run_match_roskachestvo(
    top_k: int = 5,
    min_score: float = 0.55,
    limit: int | None = None,
    reset: bool = False,
) -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        stats = match_roskachestvo_to_wines(
            repo=repo,
            top_k=top_k,
            min_score=min_score,
            limit=limit,
            reset=reset,
        )

    print("Roskachestvo matching finished")
    print(f"External products seen: {stats.external_products_seen}")
    print(f"Matches seen: {stats.matches_seen}")
    print(f"Matches saved: {stats.matches_saved}")


def run_roskachestvo_match_stats(limit: int = 20) -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        stats = repo.get_external_match_stats(source="roskachestvo")
        rows = repo.get_top_external_matches(source="roskachestvo", limit=limit)

    print("Roskachestvo match stats")
    print("========================")
    print(f"Matches total: {stats['matches_total']}")
    print(f"Source products matched: {stats['source_products_matched']}")
    print(f"Wines matched: {stats['wines_matched']}")
    print(f"High confidence: {stats['high_confidence']}")
    print(f"Medium confidence: {stats['medium_confidence']}")
    print(f"Low confidence: {stats['low_confidence']}")
    print(f"Confirmed: {stats['confirmed']}")

    print()
    print("Top matches:")
    if not rows:
        print("  no data")
    else:
        for row in rows:
            print(
                f"  score={row['match_score']} "
                f"method={row['match_method']} "
                f"source='{row['source_name']}' "
                f"-> wine_id={row['wine_id']} title='{row['title']}'"
            )


def run_apply_barcode_matches(
    source: str = "roskachestvo",
    min_score: float = 0.88,
    min_gap: float = 0.08,
    limit: int | None = None,
    dry_run: bool = False,
) -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        stats = apply_barcode_matches_to_db(
            repo=repo,
            source=source,
            min_score=min_score,
            min_gap=min_gap,
            limit=limit,
            dry_run=dry_run,
        )

    print("Barcode match application finished")
    print(f"Source: {source}")
    print(f"Min score: {min_score}")
    print(f"Min gap: {min_gap}")
    print(f"Dry run: {stats.dry_run}")
    print(f"Candidates seen: {stats.candidates_seen}")
    print(f"Barcode links saved: {stats.barcode_links_saved}")


def run_barcode_stats(limit: int = 20) -> None:
    config = get_config()

    with WineRepository(database_url=config.database_url) as repo:
        stats = repo.get_barcode_stats()
        by_source = repo.get_barcode_stats_by_source()
        duplicates = repo.get_duplicate_wine_barcodes(limit=limit)
        top_rows = repo.get_top_wine_barcodes(limit=limit)

    print("Barcode stats")
    print("=============")
    print(f"Barcode links total: {stats['barcode_links_total']}")
    print(f"Wines with barcode: {stats['wines_with_barcode']}")
    print(f"Distinct barcodes: {stats['distinct_barcodes']}")
    print(f"Duplicate barcodes: {stats['duplicate_barcodes']}")
    print(f"Sources total: {stats['sources_total']}")
    print(f"Confidence min: {stats['min_confidence']}")
    print(f"Confidence max: {stats['max_confidence']}")
    print(f"Confidence avg: {stats['avg_confidence']}")

    print()
    print("By source:")
    if not by_source:
        print("  no data")
    else:
        for row in by_source:
            print(
                f"  {row['source']}: "
                f"links={row['links_count']}, "
                f"wines={row['wines_count']}, "
                f"barcodes={row['barcodes_count']}, "
                f"avg_confidence={row['avg_confidence']}"
            )

    print()
    print("Duplicate barcodes:")
    if not duplicates:
        print("  no data")
    else:
        for row in duplicates:
            print(
                f"  {row['barcode']}: "
                f"links={row['links_count']}, "
                f"wines={row['wines_count']}"
            )

    print()
    print("Top barcode links:")
    if not top_rows:
        print("  no data")
    else:
        for row in top_rows:
            print(
                f"  confidence={row['confidence']} "
                f"gap={row['score_gap']} "
                f"barcode={row['barcode']} "
                f"source={row['source']} "
                f"wine_id={row['wine_id']} "
                f"title='{row['title']}'"
            )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 0

    if args.command == "index":
        run_index()
        return 0

    if args.command == "details":
        run_details(limit=args.limit)
        return 0

    if args.command == "stats":
        run_stats(top_limit=args.top_limit)
        return 0

    if args.command == "collect-images":
        run_collect_images(reset=args.reset)
        return 0

    if args.command == "download-images":
        run_download_images(
            limit=args.limit,
            kind=args.kind,
            output_dir=args.output_dir,
        )
        return 0

    if args.command == "image-stats":
        run_image_stats(
            kind=args.kind,
            base_dir=args.base_dir,
            problem_limit=args.problem_limit,
        )
        return 0

    if args.command == "extract-rating-snapshots":
        run_extract_rating_snapshots()
        return 0

    if args.command == "rating-snapshot-stats":
        run_rating_snapshot_stats()
        return 0

    if args.command == "import-roskachestvo-products":
        run_import_roskachestvo_products(
            limit=args.limit,
            reset_list_errors=args.reset_list_errors,
        )
        return 0

    if args.command == "import-roskachestvo-product-details":
        run_import_roskachestvo_product_details(
            limit=args.limit,
            failed_only=args.failed_only,
            force=args.force,
        )
        return 0

    if args.command == "collect-roskachestvo-product-image-urls":
        run_collect_roskachestvo_product_image_urls(
            limit=args.limit,
            failed_only=args.failed_only,
            force=args.force,
        )
        return 0

    if args.command == "download-roskachestvo-product-images":
        run_download_roskachestvo_product_images(
            limit=args.limit,
            failed_only=args.failed_only,
            force=args.force,
            storage_root=args.storage_root,
        )
        return 0

    if args.command == "roskachestvo-product-stats":
        run_roskachestvo_product_stats()
        return 0

    if args.command == "release-snapshot":
        run_release_snapshot()
        return 0

    if args.command == "migrate-image-storage":
        report = run_migrate_image_storage(
            source_root=args.source_root,
            target_root=args.target_root,
            dry_run=args.dry_run,
            extra_roots=args.extra_root,
        )
        if report.has_missing and not args.dry_run:
            return 1
        return 0

    if args.command == "roskachestvo-product-audit":
        run_roskachestvo_product_audit(
            storage_root=args.storage_root,
            limit_missing=args.limit_missing,
            limit_mismatch=args.limit_mismatch,
        )
        return 0

    if args.command == "match-roskachestvo":
        run_match_roskachestvo(
            top_k=args.top_k,
            min_score=args.min_score,
            limit=args.limit,
            reset=args.reset,
        )
        return 0

    if args.command == "roskachestvo-match-stats":
        run_roskachestvo_match_stats(limit=args.limit)
        return 0

    if args.command == "apply-barcode-matches":
        run_apply_barcode_matches(
            source=args.source,
            min_score=args.min_score,
            min_gap=args.min_gap,
            limit=args.limit,
            dry_run=args.dry_run,
        )
        return 0

    if args.command == "barcode-stats":
        run_barcode_stats(limit=args.limit)
        return 0

    print(PLACEHOLDER_MESSAGES[args.command])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
