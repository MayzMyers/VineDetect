from __future__ import annotations

import pytest

from app.normalize import (
    full_media_url,
    normalize_detail_item,
    normalize_dish_item,
    normalize_grape_item,
    normalize_list_item,
)

BASE_URL = "https://vino-svoe.ru"


def test_full_media_url_returns_none_for_none():
    assert full_media_url(BASE_URL, None) is None


def test_full_media_url_returns_none_without_url():
    assert full_media_url(BASE_URL, {"altText": "Bottle"}) is None


def test_full_media_url_builds_absolute_url_from_leading_slash_path():
    assert (
        full_media_url(BASE_URL, {"url": "/uploads/a.webp"})
        == "https://vino-svoe.ru/uploads/a.webp"
    )


def test_full_media_url_builds_absolute_url_from_relative_path():
    assert (
        full_media_url(BASE_URL, {"url": "uploads/a.webp"})
        == "https://vino-svoe.ru/uploads/a.webp"
    )


def test_full_media_url_keeps_absolute_url():
    assert (
        full_media_url(BASE_URL, {"url": "https://cdn.example/a.webp"})
        == "https://cdn.example/a.webp"
    )


def test_full_media_url_avoids_double_slash_after_base_url():
    assert (
        full_media_url("https://vino-svoe.ru/", {"url": "/uploads/a.webp"})
        == "https://vino-svoe.ru/uploads/a.webp"
    )


def test_normalize_list_item_normalizes_payload():
    item = {
        "category": "Red dry",
        "manufacturer": "LETO winery",
        "region": "Kuban",
        "title": "LETO Cabernet Franc Reserve 2020",
        "slug": "leto-cabernet-franc-reserve-2020",
        "publicRating": 5,
        "image": {
            "altText": "Cabernet Franc bottle",
            "url": "/uploads/cabernet.webp",
        },
        "color": "Ruby red",
    }

    result = normalize_list_item(BASE_URL, item)

    assert result == {
        "slug": "leto-cabernet-franc-reserve-2020",
        "title": "LETO Cabernet Franc Reserve 2020",
        "category_name": "Red dry",
        "manufacturer_name": "LETO winery",
        "manufacturer_slug": None,
        "region_name": "Kuban",
        "public_rating": 5,
        "color": "Ruby red",
        "image_url": "https://vino-svoe.ru/uploads/cabernet.webp",
        "image_alt": "Cabernet Franc bottle",
        "raw_list_json": item,
    }
    assert result["raw_list_json"] is item


@pytest.mark.parametrize("missing_key", ["slug", "title"])
def test_normalize_list_item_requires_slug_and_title(missing_key):
    item = {"slug": "wine-slug", "title": "Wine title"}
    item.pop(missing_key)

    with pytest.raises(ValueError):
        normalize_list_item(BASE_URL, item)


def test_normalize_list_item_handles_missing_image():
    item = {"slug": "wine-slug", "title": "Wine title"}

    result = normalize_list_item(BASE_URL, item)

    assert result["image_url"] is None
    assert result["image_alt"] is None


def test_normalize_detail_item_normalizes_payload():
    item = {
        "alcohol": 13.5,
        "category": {"name": "Red dry"},
        "color": "Ruby red",
        "description": "Wine description",
        "image": {
            "altText": "Wine bottle",
            "url": "/uploads/detail.webp",
        },
        "manufacturer": {"name": "LETO winery", "slug": "leto"},
        "publicRating": 5,
        "region": {"name": "Kuban"},
        "slug": "leto-cabernet-franc-reserve-2021",
        "temperature": "16-18",
        "title": "LETO Cabernet Franc Reserve 2021",
    }

    result = normalize_detail_item(BASE_URL, item)

    assert result == {
        "slug": "leto-cabernet-franc-reserve-2021",
        "title": "LETO Cabernet Franc Reserve 2021",
        "category_name": "Red dry",
        "manufacturer_name": "LETO winery",
        "manufacturer_slug": "leto",
        "region_name": "Kuban",
        "alcohol": 13.5,
        "temperature": "16-18",
        "color": "Ruby red",
        "description": "Wine description",
        "public_rating": 5,
        "image_url": "https://vino-svoe.ru/uploads/detail.webp",
        "image_alt": "Wine bottle",
        "raw_detail_json": item,
    }
    assert result["raw_detail_json"] is item


@pytest.mark.parametrize("missing_key", ["slug", "title"])
def test_normalize_detail_item_requires_slug_and_title(missing_key):
    item = {"slug": "wine-slug", "title": "Wine title"}
    item.pop(missing_key)

    with pytest.raises(ValueError):
        normalize_detail_item(BASE_URL, item)


def test_normalize_detail_item_handles_missing_nested_objects():
    item = {"slug": "wine-slug", "title": "Wine title"}

    result = normalize_detail_item(BASE_URL, item)

    assert result["category_name"] is None
    assert result["manufacturer_name"] is None
    assert result["manufacturer_slug"] is None
    assert result["region_name"] is None
    assert result["image_url"] is None
    assert result["image_alt"] is None


def test_normalize_grape_item_normalizes_payload():
    item = {
        "name": "Cabernet Franc",
        "image": {"url": "/uploads/grape.webp"},
        "backgroundImage": {"url": "uploads/grape-bg.webp"},
    }

    result = normalize_grape_item(BASE_URL, item)

    assert result == {
        "name": "Cabernet Franc",
        "image_url": "https://vino-svoe.ru/uploads/grape.webp",
        "background_image_url": "https://vino-svoe.ru/uploads/grape-bg.webp",
    }


def test_normalize_grape_item_requires_name():
    with pytest.raises(ValueError):
        normalize_grape_item(BASE_URL, {})


def test_normalize_dish_item_normalizes_payload():
    item = {
        "name": "Poultry dishes",
        "image": {"url": "/uploads/dish.webp"},
    }

    result = normalize_dish_item(BASE_URL, item)

    assert result == {
        "name": "Poultry dishes",
        "image_url": "https://vino-svoe.ru/uploads/dish.webp",
    }


def test_normalize_dish_item_requires_name():
    with pytest.raises(ValueError):
        normalize_dish_item(BASE_URL, {})
