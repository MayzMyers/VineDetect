from __future__ import annotations

from typing import Any

import pytest

from app.crawler import crawl_details, validate_detail_payload

BASE_URL = "https://vino-svoe.ru"


class FakeClient:
    def __init__(self, responses: dict[str, dict[str, Any] | Exception]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, Any] | None]] = []

    def get_json(
        self,
        path: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.calls.append((path, params))
        slug = path.rsplit("/", 1)[-1]
        result = self.responses[slug]
        if isinstance(result, Exception):
            raise result
        return result


class FakeRepo:
    def __init__(self, slugs: list[str]) -> None:
        self.slugs = slugs
        self.wines: list[dict[str, Any]] = []
        self.grapes: dict[int, list[dict[str, Any]]] = {}
        self.dishes: dict[int, list[dict[str, Any]]] = {}
        self.wine_marks: list[dict[str, Any]] = []

    def get_slugs_missing_details(self, limit: int = 1000) -> list[str]:
        return self.slugs[:limit]

    def upsert_detail_wine(self, wine: dict[str, Any]) -> int:
        self.wines.append(wine)
        return len(self.wines)

    def save_grapes(self, wine_id: int, grapes: list[dict[str, Any]]) -> None:
        self.grapes[wine_id] = grapes

    def save_dishes(self, wine_id: int, dishes: list[dict[str, Any]]) -> None:
        self.dishes[wine_id] = dishes

    def mark_wine(
        self,
        slug: str,
        status: str,
        http_status: int | None = None,
        error: str | None = None,
    ) -> None:
        self.wine_marks.append(
            {
                "slug": slug,
                "status": status,
                "http_status": http_status,
                "error": error,
            }
        )


def detail_payload(slug: str = "wine-slug") -> dict[str, Any]:
    return {
        "slug": slug,
        "title": "Wine title",
        "category": {"name": "Red dry"},
        "manufacturer": {"name": "Winery", "slug": "winery"},
        "region": {"name": "Kuban"},
        "alcohol": 13.5,
        "temperature": "16-18",
        "color": "Ruby",
        "description": "Description",
        "publicRating": 5,
        "image": {"url": "/uploads/wine.webp", "altText": "Bottle"},
        "grapes": [
            {
                "name": "Cabernet Franc",
                "image": {"url": "/uploads/grape.webp"},
                "backgroundImage": {"url": "/uploads/grape-bg.webp"},
            }
        ],
        "dishes": [
            {
                "name": "Poultry",
                "image": {"url": "/uploads/dish.webp"},
            }
        ],
    }


def empty_stats_assertions(stats):
    assert stats.slugs_seen == 0
    assert stats.details_saved == 0
    assert stats.details_failed == 0
    assert stats.grapes_saved == 0
    assert stats.dishes_saved == 0


def test_validate_detail_payload_returns_valid_payload():
    payload = detail_payload()

    assert validate_detail_payload(payload) is payload


@pytest.mark.parametrize(
    "payload",
    [
        {"title": "Wine title"},
        {"slug": "", "title": "Wine title"},
        {"slug": "wine-slug"},
        {"slug": "wine-slug", "title": ""},
        [],
    ],
)
def test_validate_detail_payload_raises_for_invalid_payload(payload):
    with pytest.raises(ValueError):
        validate_detail_payload(payload)


def test_crawl_details_fetches_and_saves_details():
    client = FakeClient({"wine-slug": detail_payload()})
    repo = FakeRepo(["wine-slug"])

    stats = crawl_details(client, repo, base_url=BASE_URL, limit=1000)

    assert client.calls == [
        ("/api/wines/wine-slug", {"varnish_no_cache": "1"})
    ]
    assert len(repo.wines) == 1
    assert repo.wines[0]["slug"] == "wine-slug"
    assert repo.grapes[1][0]["name"] == "Cabernet Franc"
    assert repo.dishes[1][0]["name"] == "Poultry"
    assert repo.wine_marks == [
        {
            "slug": "wine-slug",
            "status": "detail_ok",
            "http_status": 200,
            "error": None,
        }
    ]
    assert stats.slugs_seen == 1
    assert stats.details_saved == 1
    assert stats.details_failed == 0
    assert stats.grapes_saved == 1
    assert stats.dishes_saved == 1


def test_crawl_details_respects_limit():
    client = FakeClient(
        {
            "one": detail_payload("one"),
            "two": detail_payload("two"),
            "three": detail_payload("three"),
        }
    )
    repo = FakeRepo(["one", "two", "three"])

    stats = crawl_details(client, repo, base_url=BASE_URL, limit=2)

    assert [call[0] for call in client.calls] == ["/api/wines/one", "/api/wines/two"]
    assert stats.slugs_seen == 2
    assert stats.details_saved == 2


def test_crawl_details_continues_after_slug_error():
    client = FakeClient(
        {
            "one": detail_payload("one"),
            "two": RuntimeError("detail failed"),
        }
    )
    repo = FakeRepo(["one", "two"])

    stats = crawl_details(client, repo, base_url=BASE_URL, limit=1000)

    assert [wine["slug"] for wine in repo.wines] == ["one"]
    assert repo.wine_marks == [
        {"slug": "one", "status": "detail_ok", "http_status": 200, "error": None},
        {
            "slug": "two",
            "status": "detail_error",
            "http_status": None,
            "error": "detail failed",
        },
    ]
    assert stats.details_saved == 1
    assert stats.details_failed == 1


def test_crawl_details_invalid_payload_marks_error():
    payload = detail_payload("broken")
    payload.pop("title")
    client = FakeClient({"broken": payload})
    repo = FakeRepo(["broken"])

    stats = crawl_details(client, repo, base_url=BASE_URL, limit=1000)

    assert repo.wines == []
    assert repo.wine_marks == [
        {
            "slug": "broken",
            "status": "detail_error",
            "http_status": None,
            "error": "title is required",
        }
    ]
    assert stats.details_failed == 1


@pytest.mark.parametrize("limit", [0, -1])
def test_crawl_details_non_positive_limit_returns_empty_stats(limit):
    client = FakeClient({"wine-slug": detail_payload()})
    repo = FakeRepo(["wine-slug"])

    stats = crawl_details(client, repo, base_url=BASE_URL, limit=limit)

    empty_stats_assertions(stats)
    assert client.calls == []
    assert repo.wines == []


def test_crawl_details_skips_invalid_grapes_and_dishes():
    payload = detail_payload("wine-slug")
    payload["grapes"] = [
        {
            "name": "Cabernet Franc",
            "image": {"url": "/uploads/grape.webp"},
            "backgroundImage": {"url": "/uploads/grape-bg.webp"},
        },
        "not a dict",
        {"image": {"url": "/uploads/missing-name.webp"}},
    ]
    payload["dishes"] = [
        {"name": "Poultry", "image": {"url": "/uploads/dish.webp"}},
        "not a dict",
        {"image": {"url": "/uploads/missing-name.webp"}},
    ]
    client = FakeClient({"wine-slug": payload})
    repo = FakeRepo(["wine-slug"])

    stats = crawl_details(client, repo, base_url=BASE_URL, limit=1000)

    assert repo.grapes[1] == [
        {
            "name": "Cabernet Franc",
            "image_url": "https://vino-svoe.ru/uploads/grape.webp",
            "background_image_url": "https://vino-svoe.ru/uploads/grape-bg.webp",
        }
    ]
    assert repo.dishes[1] == [
        {
            "name": "Poultry",
            "image_url": "https://vino-svoe.ru/uploads/dish.webp",
        }
    ]
    assert stats.details_saved == 1
    assert stats.details_failed == 0
    assert stats.grapes_saved == 1
    assert stats.dishes_saved == 1
