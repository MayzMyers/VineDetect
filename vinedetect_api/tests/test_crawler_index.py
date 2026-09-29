from __future__ import annotations

from typing import Any

import pytest

from app.crawler import crawl_index, validate_index_payload

BASE_URL = "https://vino-svoe.ru"


class FakeClient:
    def __init__(self, responses: dict[int, dict[str, Any] | Exception]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, Any] | None]] = []

    def get_json(
        self,
        path: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.calls.append((path, params))
        page = params["page"] if params else None
        result = self.responses[page]
        if isinstance(result, Exception):
            raise result
        return result


class FakeRepo:
    def __init__(self, fail_slugs: set[str] | None = None) -> None:
        self.fail_slugs = fail_slugs or set()
        self.wines: list[dict[str, Any]] = []
        self.pages: list[dict[str, Any]] = []
        self.wine_marks: list[dict[str, Any]] = []

    def upsert_list_wine(self, wine: dict[str, Any]) -> int:
        if wine["slug"] in self.fail_slugs:
            msg = f"boom for {wine['slug']}"
            raise RuntimeError(msg)
        self.wines.append(wine)
        return len(self.wines)

    def mark_page(
        self,
        page: int,
        status: str,
        items_count: int | None = None,
        error: str | None = None,
    ) -> None:
        self.pages.append(
            {
                "page": page,
                "status": status,
                "items_count": items_count,
                "error": error,
            }
        )

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


def list_item(slug: str, title: str = "Wine title") -> dict[str, Any]:
    return {
        "slug": slug,
        "title": title,
        "category": "Red dry",
        "manufacturer": "Winery",
        "region": "Kuban",
        "publicRating": 5,
        "image": {"url": "/uploads/wine.webp", "altText": "Bottle"},
        "color": "Ruby",
    }


def test_validate_index_payload_returns_total_pages_and_items():
    items = [list_item("one")]

    total_pages, result_items = validate_index_payload(
        {"totalPages": 2, "items": items}
    )

    assert total_pages == 2
    assert result_items == items


@pytest.mark.parametrize(
    "payload",
    [
        {"items": []},
        {"totalPages": "2", "items": []},
        {"totalPages": 0, "items": []},
        {"totalPages": 1, "items": {}},
        {"totalPages": 1, "items": ["not dict"]},
    ],
)
def test_validate_index_payload_raises_for_invalid_payload(payload):
    with pytest.raises(ValueError):
        validate_index_payload(payload)


def test_crawl_index_fetches_all_pages_and_saves_wines():
    client = FakeClient(
        {
            1: {"totalPages": 2, "items": [list_item("one")]},
            2: {"totalPages": 2, "items": [list_item("two")]},
        }
    )
    repo = FakeRepo()

    stats = crawl_index(client, repo, base_url=BASE_URL, per_page=16)

    assert client.calls == [
        ("/api/wines", {"page": 1, "perPage": 16}),
        ("/api/wines", {"page": 2, "perPage": 16}),
    ]
    assert [wine["slug"] for wine in repo.wines] == ["one", "two"]
    assert [mark["status"] for mark in repo.wine_marks] == ["listed", "listed"]
    assert repo.pages == [
        {"page": 1, "status": "ok", "items_count": 1, "error": None},
        {"page": 2, "status": "ok", "items_count": 1, "error": None},
    ]
    assert stats.total_pages == 2
    assert stats.pages_ok == 2
    assert stats.pages_failed == 0
    assert stats.items_seen == 2
    assert stats.wines_saved == 2
    assert stats.wines_failed == 0


def test_crawl_index_continues_after_page_error():
    client = FakeClient(
        {
            1: {"totalPages": 3, "items": [list_item("one")]},
            2: RuntimeError("page failed"),
            3: {"totalPages": 3, "items": [list_item("three")]},
        }
    )
    repo = FakeRepo()

    stats = crawl_index(client, repo, base_url=BASE_URL, per_page=16)

    assert [call[1]["page"] for call in client.calls] == [1, 2, 3]
    assert repo.pages[1]["page"] == 2
    assert repo.pages[1]["status"] == "error"
    assert "page failed" in repo.pages[1]["error"]
    assert repo.pages[2] == {
        "page": 3,
        "status": "ok",
        "items_count": 1,
        "error": None,
    }
    assert stats.pages_ok == 2
    assert stats.pages_failed == 1
    assert stats.items_seen == 2
    assert stats.wines_saved == 2


def test_crawl_index_first_page_error_is_raised():
    client = FakeClient({1: RuntimeError("first page failed")})
    repo = FakeRepo()

    with pytest.raises(RuntimeError, match="first page failed"):
        crawl_index(client, repo, base_url=BASE_URL, per_page=16)

    assert repo.pages == []


@pytest.mark.parametrize("per_page", [0, -1])
def test_crawl_index_invalid_per_page_raises(per_page):
    client = FakeClient({})
    repo = FakeRepo()

    with pytest.raises(ValueError):
        crawl_index(client, repo, base_url=BASE_URL, per_page=per_page)


def test_crawl_index_continues_after_single_wine_error():
    client = FakeClient(
        {
            1: {
                "totalPages": 1,
                "items": [
                    list_item("one"),
                    {"slug": "broken"},
                    list_item("two"),
                ],
            }
        }
    )
    repo = FakeRepo()

    stats = crawl_index(client, repo, base_url=BASE_URL, per_page=16)

    assert [wine["slug"] for wine in repo.wines] == ["one", "two"]
    assert repo.wine_marks == [
        {"slug": "one", "status": "listed", "http_status": None, "error": None},
        {
            "slug": "broken",
            "status": "list_error",
            "http_status": None,
            "error": "title is required",
        },
        {"slug": "two", "status": "listed", "http_status": None, "error": None},
    ]
    assert stats.pages_ok == 1
    assert stats.items_seen == 3
    assert stats.wines_saved == 2
    assert stats.wines_failed == 1
