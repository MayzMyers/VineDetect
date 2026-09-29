from __future__ import annotations

from typing import Any

from app.image_assets import (
    WineImageAsset,
    build_bottle_image_url,
    collect_image_assets,
    extract_image_assets,
)

BOTTLE_PROXY_PREFIX = (
    "https://api.vino-svoe.ru/v1/img/str-api/1920/1920/resize/uploads/"
)


def asset_tuples(assets: list[WineImageAsset]) -> list[tuple[int, str, str]]:
    return [(asset.wine_id, asset.kind, asset.url) for asset in assets]


def test_build_bottle_image_url_from_absolute_uploads_path() -> None:
    assert build_bottle_image_url("/uploads/a.webp") == f"{BOTTLE_PROXY_PREFIX}a.webp"


def test_build_bottle_image_url_from_relative_uploads_path() -> None:
    assert build_bottle_image_url("uploads/a.webp") == f"{BOTTLE_PROXY_PREFIX}a.webp"


def test_build_bottle_image_url_from_public_absolute_url() -> None:
    assert (
        build_bottle_image_url("https://vino-svoe.ru/uploads/a.webp")
        == f"{BOTTLE_PROXY_PREFIX}a.webp"
    )


def test_build_bottle_image_url_rebuilds_other_proxy_size() -> None:
    assert (
        build_bottle_image_url(
            "https://api.vino-svoe.ru/v1/img/str-api/1200/1200/resize/uploads/a.webp"
        )
        == f"{BOTTLE_PROXY_PREFIX}a.webp"
    )


def test_build_bottle_image_url_keeps_correct_proxy_url() -> None:
    url = f"{BOTTLE_PROXY_PREFIX}a.webp"

    assert build_bottle_image_url(url) == url


def test_build_bottle_image_url_rejects_empty_or_non_upload_paths() -> None:
    assert build_bottle_image_url("") is None
    assert build_bottle_image_url("/assets/a.webp") is None


def test_extract_image_assets_reads_bottle_url() -> None:
    assets = extract_image_assets(
        {
            "id": 1,
            "image_url": "https://vino-svoe.ru/uploads/bottle.webp",
            "raw_detail_json": None,
        }
    )

    assert asset_tuples(assets) == [
        (1, "bottle", f"{BOTTLE_PROXY_PREFIX}bottle.webp")
    ]


def test_extract_image_assets_falls_back_to_detail_image() -> None:
    assets = extract_image_assets(
        {
            "id": 2,
            "image_url": None,
            "raw_detail_json": {"image": {"url": "/uploads/detail.webp"}},
        }
    )

    assert asset_tuples(assets) == [
        (2, "bottle", f"{BOTTLE_PROXY_PREFIX}detail.webp")
    ]


def test_extract_image_assets_ignores_non_bottle_assets() -> None:
    assets = extract_image_assets(
        {
            "id": 3,
            "image_url": "/uploads/bottle.webp",
            "raw_detail_json": {
                "image": {"url": "/uploads/detail.webp"},
                "grapes": [
                    {
                        "image": {"url": "/uploads/grape.webp"},
                        "backgroundImage": {"url": "/uploads/grape-bg.webp"},
                    }
                ],
                "dishes": [{"image": {"url": "/uploads/dish.webp"}}],
                "region": {"image": {"url": "/uploads/region.webp"}},
            },
        }
    )

    assert asset_tuples(assets) == [
        (3, "bottle", f"{BOTTLE_PROXY_PREFIX}bottle.webp")
    ]


def test_extract_image_assets_returns_empty_list_without_bottle_source() -> None:
    assets = extract_image_assets(
        {
            "id": 4,
            "image_url": None,
            "raw_detail_json": {
                "grapes": [{"image": {"url": "/uploads/grape.webp"}}],
                "dishes": [{"image": {"url": "/uploads/dish.webp"}}],
                "region": {"image": {"url": "/uploads/region.webp"}},
            },
        }
    )

    assert assets == []


def test_collect_image_assets_uses_repo() -> None:
    class FakeRepo:
        def __init__(self, wines: list[dict[str, Any]]) -> None:
            self.wines = wines
            self.saved: list[tuple[int, str, str]] = []

        def get_wines_for_image_assets(self) -> list[dict[str, Any]]:
            return self.wines

        def upsert_wine_image(self, wine_id: int, kind: str, url: str) -> int:
            self.saved.append((wine_id, kind, url))
            return len(self.saved)

    repo = FakeRepo(
        [
            {"id": 1, "image_url": "/uploads/one.webp", "raw_detail_json": {}},
            {
                "id": 2,
                "image_url": None,
                "raw_detail_json": {"image": {"url": "/uploads/two.webp"}},
            },
        ]
    )

    stats = collect_image_assets(repo)

    assert stats.wines_seen == 2
    assert stats.assets_seen == 2
    assert stats.assets_saved == 2
    assert repo.saved == [
        (1, "bottle", f"{BOTTLE_PROXY_PREFIX}one.webp"),
        (2, "bottle", f"{BOTTLE_PROXY_PREFIX}two.webp"),
    ]
