"""Crawler orchestration for wine catalog routes."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from app.normalize import (
    normalize_detail_item,
    normalize_dish_item,
    normalize_grape_item,
    normalize_list_item,
)


class JsonClient(Protocol):
    def get_json(
        self,
        path: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ...


class IndexRepository(Protocol):
    def upsert_list_wine(self, wine: dict[str, Any]) -> int:
        ...

    def mark_page(
        self,
        page: int,
        status: str,
        items_count: int | None = None,
        error: str | None = None,
    ) -> None:
        ...

    def mark_wine(
        self,
        slug: str,
        status: str,
        http_status: int | None = None,
        error: str | None = None,
    ) -> None:
        ...


class DetailRepository(Protocol):
    def get_slugs_missing_details(self, limit: int = 1000) -> list[str]:
        ...

    def upsert_detail_wine(self, wine: dict[str, Any]) -> int:
        ...

    def save_grapes(self, wine_id: int, grapes: list[dict[str, Any]]) -> None:
        ...

    def save_dishes(self, wine_id: int, dishes: list[dict[str, Any]]) -> None:
        ...

    def mark_wine(
        self,
        slug: str,
        status: str,
        http_status: int | None = None,
        error: str | None = None,
    ) -> None:
        ...


@dataclass(frozen=True)
class IndexCrawlStats:
    total_pages: int
    pages_ok: int
    pages_failed: int
    items_seen: int
    wines_saved: int
    wines_failed: int


@dataclass(frozen=True)
class DetailCrawlStats:
    slugs_seen: int
    details_saved: int
    details_failed: int
    grapes_saved: int
    dishes_saved: int


def validate_index_payload(payload: dict[str, Any]) -> tuple[int, list[dict[str, Any]]]:
    total_pages = payload.get("totalPages")
    if not isinstance(total_pages, int):
        msg = "totalPages must be an integer"
        raise ValueError(msg)
    if total_pages < 1:
        msg = "totalPages must be greater than or equal to 1"
        raise ValueError(msg)

    items = payload.get("items")
    if not isinstance(items, list):
        msg = "items must be a list"
        raise ValueError(msg)

    for item in items:
        if not isinstance(item, dict):
            msg = "items must contain only objects"
            raise ValueError(msg)

    return total_pages, items


def validate_detail_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        msg = "detail payload must be an object"
        raise ValueError(msg)

    slug = payload.get("slug")
    if not isinstance(slug, str) or not slug:
        msg = "slug is required"
        raise ValueError(msg)

    title = payload.get("title")
    if not isinstance(title, str) or not title:
        msg = "title is required"
        raise ValueError(msg)

    return payload


def crawl_index(
    client: JsonClient,
    repo: IndexRepository,
    base_url: str,
    per_page: int,
) -> IndexCrawlStats:
    if per_page <= 0:
        msg = "per_page must be greater than 0"
        raise ValueError(msg)

    first_payload = client.get_json(
        "/api/wines",
        params={"page": 1, "perPage": per_page},
    )
    total_pages, first_items = validate_index_payload(first_payload)

    pages_ok = 0
    pages_failed = 0
    items_seen = 0
    wines_saved = 0
    wines_failed = 0

    saved, failed = _process_index_items(first_items, repo, base_url)
    repo.mark_page(1, "ok", items_count=len(first_items))
    pages_ok += 1
    items_seen += len(first_items)
    wines_saved += saved
    wines_failed += failed

    for page in range(2, total_pages + 1):
        try:
            payload = client.get_json(
                "/api/wines",
                params={"page": page, "perPage": per_page},
            )
            _, items = validate_index_payload(payload)
            saved, failed = _process_index_items(items, repo, base_url)
            repo.mark_page(page, "ok", items_count=len(items))
        except Exception as exc:
            repo.mark_page(page, "error", error=str(exc))
            pages_failed += 1
            continue

        pages_ok += 1
        items_seen += len(items)
        wines_saved += saved
        wines_failed += failed

    return IndexCrawlStats(
        total_pages=total_pages,
        pages_ok=pages_ok,
        pages_failed=pages_failed,
        items_seen=items_seen,
        wines_saved=wines_saved,
        wines_failed=wines_failed,
    )


def crawl_details(
    client: JsonClient,
    repo: DetailRepository,
    base_url: str,
    limit: int = 1000,
) -> DetailCrawlStats:
    if limit <= 0:
        return DetailCrawlStats(
            slugs_seen=0,
            details_saved=0,
            details_failed=0,
            grapes_saved=0,
            dishes_saved=0,
        )

    slugs = repo.get_slugs_missing_details(limit=limit)
    details_saved = 0
    details_failed = 0
    grapes_saved = 0
    dishes_saved = 0

    for slug in slugs:
        try:
            payload = client.get_json(
                f"/api/wines/{slug}",
                params={"varnish_no_cache": "1"},
            )
            payload = validate_detail_payload(payload)
            wine = normalize_detail_item(base_url, payload)
            wine_id = repo.upsert_detail_wine(wine)

            grapes = _normalize_grapes(base_url, payload)
            repo.save_grapes(wine_id, grapes)

            dishes = _normalize_dishes(base_url, payload)
            repo.save_dishes(wine_id, dishes)

            repo.mark_wine(slug, "detail_ok", http_status=200)
        except Exception as exc:
            repo.mark_wine(slug, "detail_error", error=str(exc))
            details_failed += 1
            continue

        details_saved += 1
        grapes_saved += len(grapes)
        dishes_saved += len(dishes)

    return DetailCrawlStats(
        slugs_seen=len(slugs),
        details_saved=details_saved,
        details_failed=details_failed,
        grapes_saved=grapes_saved,
        dishes_saved=dishes_saved,
    )


def _process_index_items(
    items: list[dict[str, Any]],
    repo: IndexRepository,
    base_url: str,
) -> tuple[int, int]:
    wines_saved = 0
    wines_failed = 0

    for item in items:
        try:
            wine = normalize_list_item(base_url, item)
            repo.upsert_list_wine(wine)
            repo.mark_wine(wine["slug"], "listed")
            wines_saved += 1
        except Exception as exc:
            slug = item.get("slug")
            if isinstance(slug, str) and slug:
                try:
                    repo.mark_wine(slug, "list_error", error=str(exc))
                except Exception:
                    pass
            wines_failed += 1

    return wines_saved, wines_failed


def _normalize_grapes(
    base_url: str,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    grape_items = payload.get("grapes") or []
    if not isinstance(grape_items, list):
        return []

    grapes = []
    for item in grape_items:
        if not isinstance(item, dict):
            continue
        try:
            grapes.append(normalize_grape_item(base_url, item))
        except ValueError:
            continue
    return grapes


def _normalize_dishes(
    base_url: str,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    dish_items = payload.get("dishes") or []
    if not isinstance(dish_items, list):
        return []

    dishes = []
    for item in dish_items:
        if not isinstance(item, dict):
            continue
        try:
            dishes.append(normalize_dish_item(base_url, item))
        except ValueError:
            continue
    return dishes
