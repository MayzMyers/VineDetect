from __future__ import annotations

from pathlib import Path

import app.main as main

NEW_PRODUCT_COMMANDS = (
    "import-roskachestvo-products",
    "import-roskachestvo-product-details",
    "collect-roskachestvo-product-image-urls",
    "download-roskachestvo-product-images",
    "roskachestvo-product-stats",
    "roskachestvo-product-audit",
)

LEGACY_ROSKACHESTVO_COMMANDS = (
    "import-roskachestvo-" + "wines",
    "roskachestvo-" + "stats",
)


def test_parser_contains_roskachestvo_product_commands() -> None:
    help_text = main.build_parser().format_help()

    for command in NEW_PRODUCT_COMMANDS:
        assert command in help_text


def test_import_roskachestvo_products_parser_options() -> None:
    args = main.build_parser().parse_args(
        [
            "import-roskachestvo-products",
            "--limit",
            "5",
            "--reset-list-errors",
        ],
    )

    assert args.command == "import-roskachestvo-products"
    assert args.limit == 5
    assert args.reset_list_errors is True


def test_import_roskachestvo_product_details_parser_options() -> None:
    args = main.build_parser().parse_args(
        [
            "import-roskachestvo-product-details",
            "--limit",
            "7",
            "--failed-only",
            "--force",
        ],
    )

    assert args.command == "import-roskachestvo-product-details"
    assert args.limit == 7
    assert args.failed_only is True
    assert args.force is True


def test_collect_roskachestvo_product_image_urls_parser_options() -> None:
    args = main.build_parser().parse_args(
        [
            "collect-roskachestvo-product-image-urls",
            "--limit",
            "11",
            "--failed-only",
            "--force",
        ],
    )

    assert args.command == "collect-roskachestvo-product-image-urls"
    assert args.limit == 11
    assert args.failed_only is True
    assert args.force is True


def test_download_roskachestvo_product_images_parser_options() -> None:
    args = main.build_parser().parse_args(
        [
            "download-roskachestvo-product-images",
            "--limit",
            "13",
            "--failed-only",
            "--force",
            "--storage-root",
            "custom-storage",
        ],
    )

    assert args.command == "download-roskachestvo-product-images"
    assert args.limit == 13
    assert args.failed_only is True
    assert args.force is True
    assert args.storage_root == "custom-storage"


def test_roskachestvo_product_audit_parser_options() -> None:
    args = main.build_parser().parse_args(
        [
            "roskachestvo-product-audit",
            "--storage-root",
            "custom-storage",
            "--limit-missing",
            "3",
            "--limit-mismatch",
            "4",
        ],
    )

    assert args.command == "roskachestvo-product-audit"
    assert args.storage_root == "custom-storage"
    assert args.limit_missing == 3
    assert args.limit_mismatch == 4


def test_main_dispatches_import_roskachestvo_products(monkeypatch) -> None:
    calls = []

    def fake_run(*, limit, reset_list_errors):
        calls.append(
            {
                "limit": limit,
                "reset_list_errors": reset_list_errors,
            },
        )

    monkeypatch.setattr(main, "run_import_roskachestvo_products", fake_run)

    exit_code = main.main(
        [
            "import-roskachestvo-products",
            "--limit",
            "2",
            "--reset-list-errors",
        ],
    )

    assert exit_code == 0
    assert calls == [{"limit": 2, "reset_list_errors": True}]


def test_main_dispatches_download_roskachestvo_product_images(monkeypatch) -> None:
    calls = []

    def fake_run(*, limit, failed_only, force, storage_root):
        calls.append(
            {
                "limit": limit,
                "failed_only": failed_only,
                "force": force,
                "storage_root": storage_root,
            },
        )

    monkeypatch.setattr(main, "run_download_roskachestvo_product_images", fake_run)

    exit_code = main.main(
        [
            "download-roskachestvo-product-images",
            "--limit",
            "9",
            "--failed-only",
            "--force",
            "--storage-root",
            "product-storage",
        ],
    )

    assert exit_code == 0
    assert calls == [
        {
            "limit": 9,
            "failed_only": True,
            "force": True,
            "storage_root": "product-storage",
        },
    ]


def test_new_import_runner_uses_product_pipeline() -> None:
    names = set(main.run_import_roskachestvo_products.__code__.co_names)
    legacy_name = "import_roskachestvo_" + "wines_to_db"

    assert "import_roskachestvo_products_to_db" in names
    assert legacy_name not in names


def test_parser_contains_release_snapshot_command() -> None:
    assert "release-snapshot" in main.build_parser().format_help()


def test_release_snapshot_parser_accepts_no_extra_args() -> None:
    args = main.build_parser().parse_args(["release-snapshot"])

    assert args.command == "release-snapshot"


def test_parser_excludes_legacy_roskachestvo_commands() -> None:
    help_text = main.build_parser().format_help()

    for command in LEGACY_ROSKACHESTVO_COMMANDS:
        assert command not in help_text


def test_main_module_does_not_import_legacy_roskachestvo_importer() -> None:
    source = Path("vinedetect_api/app/main.py").read_text()

    legacy_importer = "import_roskachestvo_" + "wines_to_db"

    assert legacy_importer not in source
    for command in LEGACY_ROSKACHESTVO_COMMANDS:
        assert command not in source


def test_drop_legacy_roskachestvo_wines_migration_exists() -> None:
    legacy_table = "roskachestvo_" + "wines"
    migration = Path(
        f"vinedetect_api/migrations/011_drop_legacy_{legacy_table}.sql",
    )

    assert migration.exists()
    assert migration.read_text().strip() == (
        f"DROP TABLE IF EXISTS public.{legacy_table};"
    )


def test_parser_contains_migrate_image_storage_command() -> None:
    assert "migrate-image-storage" in main.build_parser().format_help()


def test_migrate_image_storage_parser_options() -> None:
    args = main.build_parser().parse_args(
        [
            "migrate-image-storage",
            "--source-root",
            "..",
            "--target-root",
            "storage/images",
            "--dry-run",
            "--extra-root",
            "legacy-a",
            "--extra-root",
            "legacy-b",
        ],
    )

    assert args.command == "migrate-image-storage"
    assert args.source_root == ".."
    assert args.target_root == "storage/images"
    assert args.dry_run is True
    assert args.extra_root == ["legacy-a", "legacy-b"]


def test_main_dispatches_migrate_image_storage(monkeypatch) -> None:
    calls = []

    class Report:
        has_missing = False

    def fake_run(*, source_root, target_root, dry_run, extra_roots):
        calls.append(
            {
                "source_root": source_root,
                "target_root": target_root,
                "dry_run": dry_run,
                "extra_roots": extra_roots,
            },
        )
        return Report()

    monkeypatch.setattr(main, "run_migrate_image_storage", fake_run)

    exit_code = main.main(
        [
            "migrate-image-storage",
            "--source-root",
            "legacy-root",
            "--target-root",
            "storage/images",
            "--dry-run",
            "--extra-root",
            "extra-root",
        ],
    )

    assert exit_code == 0
    assert calls == [
        {
            "source_root": "legacy-root",
            "target_root": "storage/images",
            "dry_run": True,
            "extra_roots": ["extra-root"],
        },
    ]


def test_main_migrate_image_storage_returns_1_for_real_missing(monkeypatch) -> None:
    class Report:
        has_missing = True

    monkeypatch.setattr(
        main,
        "run_migrate_image_storage",
        lambda **kwargs: Report(),
    )

    assert main.main(["migrate-image-storage"]) == 1


def test_main_migrate_image_storage_returns_0_for_dry_run_missing(monkeypatch) -> None:
    class Report:
        has_missing = True

    monkeypatch.setattr(
        main,
        "run_migrate_image_storage",
        lambda **kwargs: Report(),
    )

    assert main.main(["migrate-image-storage", "--dry-run"]) == 0
