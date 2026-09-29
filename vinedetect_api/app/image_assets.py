"""Extract and collect bottle image asset URLs for wines."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

IMAGE_PROXY_BASE_URL = "https://api.vino-svoe.ru/v1/img/str-api"
BOTTLE_IMAGE_WIDTH = 1920
BOTTLE_IMAGE_HEIGHT = 1920
IMAGE_PROXY_UPLOADS_MARKER = "/v1/img/str-api/1920/1920/resize/uploads/"
UPLOADS_MARKER = "/uploads/"


@dataclass(frozen=True)
class WineImageAsset:
    wine_id: int
    kind: str
    url: str


@dataclass(frozen=True)
class ImageAssetCollectStats:
    wines_seen: int
    assets_seen: int
    assets_saved: int


def build_bottle_image_url(raw_url: str) -> str | None:
    value = raw_url.strip()
    if not value:
        return None

    if IMAGE_PROXY_UPLOADS_MARKER in value and value.startswith(("http://", "https://")):
        return value

    uploads_path = _extract_uploads_path(value)
    if uploads_path is None:
        return None

    return (
        f"{IMAGE_PROXY_BASE_URL}/{BOTTLE_IMAGE_WIDTH}/{BOTTLE_IMAGE_HEIGHT}"
        f"/resize{uploads_path}"
    )


def extract_image_assets(wine_row: dict[str, Any]) -> list[WineImageAsset]:
    raw_url = _source_bottle_url(wine_row)
    if raw_url is None:
        return []

    bottle_url = build_bottle_image_url(raw_url)
    if bottle_url is None:
        return []

    return [
        WineImageAsset(
            wine_id=wine_row["id"],
            kind="bottle",
            url=bottle_url,
        )
    ]


def collect_image_assets(repo: Any) -> ImageAssetCollectStats:
    wines = repo.get_wines_for_image_assets()
    assets_seen = 0
    assets_saved = 0

    for wine in wines:
        assets = extract_image_assets(wine)
        assets_seen += len(assets)
        for asset in assets:
            repo.upsert_wine_image(asset.wine_id, asset.kind, asset.url)
            assets_saved += 1

    return ImageAssetCollectStats(
        wines_seen=len(wines),
        assets_seen=assets_seen,
        assets_saved=assets_saved,
    )


def _source_bottle_url(wine_row: dict[str, Any]) -> str | None:
    image_url = wine_row.get("image_url")
    if isinstance(image_url, str) and image_url.strip():
        return image_url

    raw_detail_json = wine_row.get("raw_detail_json")
    if not isinstance(raw_detail_json, dict):
        return None

    image = raw_detail_json.get("image")
    if not isinstance(image, dict):
        return None

    detail_url = image.get("url")
    if isinstance(detail_url, str) and detail_url.strip():
        return detail_url
    return None


def _extract_uploads_path(raw_url: str) -> str | None:
    parsed = urlparse(raw_url)
    path = parsed.path if parsed.scheme else raw_url

    uploads_index = path.find(UPLOADS_MARKER)
    if uploads_index == -1:
        normalized_path = f"/{path.lstrip('/')}"
    else:
        normalized_path = path[uploads_index:]

    if not normalized_path.startswith(UPLOADS_MARKER):
        return None
    return normalized_path
