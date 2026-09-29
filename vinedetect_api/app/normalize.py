"""Normalization helpers for API payloads."""

from __future__ import annotations

from typing import Any


def full_media_url(base_url: str, image_obj: dict[str, Any] | None) -> str | None:
    if not isinstance(image_obj, dict):
        return None

    url = image_obj.get("url")
    if not url or not isinstance(url, str):
        return None

    if url.startswith(("http://", "https://")):
        return url

    return f"{base_url.rstrip('/')}/{url.lstrip('/')}"


def normalize_list_item(base_url: str, item: dict[str, Any]) -> dict[str, Any]:
    image = _dict_or_empty(item.get("image"))

    return {
        "slug": _required_str(item, "slug"),
        "title": _required_str(item, "title"),
        "category_name": item.get("category"),
        "manufacturer_name": item.get("manufacturer"),
        "manufacturer_slug": None,
        "region_name": item.get("region"),
        "public_rating": item.get("publicRating"),
        "color": item.get("color"),
        "image_url": full_media_url(base_url, image),
        "image_alt": image.get("altText"),
        "raw_list_json": item,
    }


def normalize_detail_item(base_url: str, item: dict[str, Any]) -> dict[str, Any]:
    category = _dict_or_empty(item.get("category"))
    manufacturer = _dict_or_empty(item.get("manufacturer"))
    region = _dict_or_empty(item.get("region"))
    image = _dict_or_empty(item.get("image"))

    return {
        "slug": _required_str(item, "slug"),
        "title": _required_str(item, "title"),
        "category_name": category.get("name"),
        "manufacturer_name": manufacturer.get("name"),
        "manufacturer_slug": manufacturer.get("slug"),
        "region_name": region.get("name"),
        "alcohol": item.get("alcohol"),
        "temperature": item.get("temperature"),
        "color": item.get("color"),
        "description": item.get("description"),
        "public_rating": item.get("publicRating"),
        "image_url": full_media_url(base_url, image),
        "image_alt": image.get("altText"),
        "raw_detail_json": item,
    }


def normalize_grape_item(base_url: str, item: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": _required_str(item, "name"),
        "image_url": full_media_url(base_url, _dict_or_empty(item.get("image"))),
        "background_image_url": full_media_url(
            base_url,
            _dict_or_empty(item.get("backgroundImage")),
        ),
    }


def normalize_dish_item(base_url: str, item: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": _required_str(item, "name"),
        "image_url": full_media_url(base_url, _dict_or_empty(item.get("image"))),
    }


def _required_str(item: dict[str, Any], key: str) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value:
        msg = f"{key} is required"
        raise ValueError(msg)
    return value


def _dict_or_empty(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}
