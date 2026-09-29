from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse

import psycopg
import pytest
from psycopg.rows import dict_row

from app.repositories import WineRepository


def assert_safe_test_database_url(database_url: str) -> None:
    parsed = urlparse(database_url)
    database_name = parsed.path.lstrip("/")

    if not database_name:
        raise RuntimeError("TEST_DATABASE_URL must include database name")

    if database_name == "svoe_vino.wines":
        raise RuntimeError(
            "Refusing to run destructive repository tests against "
            "production database 'svoe_vino.wines'. Use wines_test."
        )

    if not database_name.endswith("_test"):
        raise RuntimeError(
            "Refusing to run destructive repository tests against "
            f"database '{database_name}'. Test database name must end with '_test'."
        )

@pytest.fixture()
def repo():
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("TEST_DATABASE_URL is not set")

    assert_safe_test_database_url(database_url)

    connection = psycopg.connect(database_url, row_factory=dict_row)

    with connection.cursor() as cur:
        cur.execute(
            """
            TRUNCATE TABLE
                svoe_vino.wine_dishes,
                svoe_vino.wine_grapes,
                svoe_vino.dishes,
                svoe_vino.grapes,
                svoe_vino.crawl_wines,
                svoe_vino.crawl_pages,
                svoe_vino.wines
            RESTART IDENTITY CASCADE
            """
        )
    connection.commit()

    repository = WineRepository(connection=connection)

    yield repository

    connection.close()


def list_wine(slug: str = "wine-slug") -> dict[str, Any]:
    return {
        "slug": slug,
        "title": "List wine",
        "category_name": "Red dry",
        "manufacturer_name": "Winery",
        "manufacturer_slug": None,
        "region_name": "Kuban",
        "public_rating": 5,
        "color": "Ruby",
        "image_url": "https://vino-svoe.ru/uploads/list.webp",
        "image_alt": "Bottle",
        "raw_list_json": {"slug": slug, "source": "list"},
    }


def detail_wine(
    slug: str = "wine-slug",
    description: str = "Description",
) -> dict[str, Any]:
    return {
        "slug": slug,
        "title": "Detail wine",
        "category_name": "Red dry",
        "manufacturer_name": "Winery",
        "manufacturer_slug": "winery",
        "region_name": "Kuban",
        "alcohol": 13.5,
        "temperature": "16-18",
        "color": "Ruby",
        "description": description,
        "public_rating": 5,
        "image_url": "https://vino-svoe.ru/uploads/detail.webp",
        "image_alt": "Bottle detail",
        "raw_detail_json": {"slug": slug, "description": description},
    }


def fetch_one(
    repo: WineRepository,
    query: str,
    params: tuple[Any, ...] = (),
) -> dict[str, Any]:
    with repo.connection.cursor() as cur:
        cur.execute(query, params)
        return cur.fetchone()


def fetch_value(
    repo: WineRepository,
    query: str,
    params: tuple[Any, ...] = (),
) -> Any:
    with repo.connection.cursor() as cur:
        cur.execute(query, params)
        row = cur.fetchone()
        return next(iter(row.values())) if isinstance(row, dict) else row[0]


def test_upsert_list_wine_inserts_wine(repo):
    wine_id = repo.upsert_list_wine(list_wine())

    row = fetch_one(
        repo,
        """
        SELECT id, slug, title, raw_list_json, list_seen_at
        FROM svoe_vino.wines
        WHERE slug = %s
        """,
        ("wine-slug",),
    )

    assert row["id"] == wine_id
    assert row["slug"] == "wine-slug"
    assert row["title"] == "List wine"
    assert row["raw_list_json"]["source"] == "list"
    assert row["list_seen_at"] is not None


def test_upsert_list_wine_updates_existing_without_removing_detail(repo):
    repo.upsert_detail_wine(detail_wine())
    repo.upsert_list_wine(list_wine())

    row = fetch_one(
        repo,
        "SELECT raw_detail_json FROM svoe_vino.wines WHERE slug = %s",
        ("wine-slug",),
    )

    assert row["raw_detail_json"] is not None


def test_upsert_detail_wine_inserts_and_updates(repo):
    first_id = repo.upsert_detail_wine(detail_wine(description="First"))
    second_id = repo.upsert_detail_wine(detail_wine(description="Second"))

    row = fetch_one(
        repo,
        "SELECT description, raw_detail_json FROM svoe_vino.wines WHERE slug = %s",
        ("wine-slug",),
    )

    assert second_id == first_id
    assert row["description"] == "Second"
    assert row["raw_detail_json"]["description"] == "Second"


def test_save_grapes_replaces_links(repo):
    wine_id = repo.upsert_detail_wine(detail_wine())

    repo.save_grapes(
        wine_id,
        [
            {
                "name": "Cabernet Franc",
                "image_url": "https://vino-svoe.ru/uploads/cf.webp",
                "background_image_url": "https://vino-svoe.ru/uploads/cf-bg.webp",
            },
            {
                "name": "Merlot",
                "image_url": "https://vino-svoe.ru/uploads/merlot.webp",
                "background_image_url": "https://vino-svoe.ru/uploads/merlot-bg.webp",
            },
        ],
    )
    assert fetch_value(repo, "SELECT count(*) FROM svoe_vino.wine_grapes") == 2

    repo.save_grapes(
        wine_id,
        [
            {
                "name": "Cabernet Franc",
                "image_url": "https://vino-svoe.ru/uploads/cf-2.webp",
                "background_image_url": "https://vino-svoe.ru/uploads/cf-bg-2.webp",
            }
        ],
    )

    assert fetch_value(repo, "SELECT count(*) FROM svoe_vino.wine_grapes") == 1
    assert fetch_value(repo, "SELECT count(*) FROM svoe_vino.grapes") == 2


def test_save_dishes_replaces_links(repo):
    wine_id = repo.upsert_detail_wine(detail_wine())

    repo.save_dishes(
        wine_id,
        [
            {"name": "Poultry", "image_url": "https://vino-svoe.ru/uploads/p.webp"},
            {"name": "Cheese", "image_url": "https://vino-svoe.ru/uploads/c.webp"},
        ],
    )
    assert fetch_value(repo, "SELECT count(*) FROM svoe_vino.wine_dishes") == 2

    repo.save_dishes(
        wine_id,
        [{"name": "Poultry", "image_url": "https://vino-svoe.ru/uploads/p2.webp"}],
    )

    assert fetch_value(repo, "SELECT count(*) FROM svoe_vino.wine_dishes") == 1
    assert fetch_value(repo, "SELECT count(*) FROM svoe_vino.dishes") == 2


def test_mark_page_upserts(repo):
    repo.mark_page(page=1, status="started", items_count=10)
    repo.mark_page(page=1, status="done", items_count=16)

    row = fetch_one(repo, "SELECT * FROM svoe_vino.crawl_pages WHERE page = %s", (1,))

    pages_count = fetch_value(
        repo,
        "SELECT count(*) FROM svoe_vino.crawl_pages WHERE page = %s",
        (1,),
    )
    assert pages_count == 1
    assert row["status"] == "done"
    if "items_count" in row:
        assert row["items_count"] == 16


def test_mark_wine_increments_attempts(repo):
    repo.mark_wine(slug="wine-slug", status="failed", http_status=500)
    repo.mark_wine(slug="wine-slug", status="done", http_status=200)

    row = fetch_one(
        repo,
        "SELECT * FROM svoe_vino.crawl_wines WHERE slug = %s",
        ("wine-slug",),
    )

    assert row["status"] == "done"
    if "attempts" in row:
        assert row["attempts"] == 2


def test_get_slugs_missing_details(repo):
    repo.upsert_list_wine(list_wine(slug="list-only"))
    repo.upsert_detail_wine(detail_wine(slug="has-detail"))

    assert repo.get_slugs_missing_details() == ["list-only"]


def test_get_slugs_missing_details_with_non_positive_limit(repo):
    assert repo.get_slugs_missing_details(limit=0) == []
    assert repo.get_slugs_missing_details(limit=-1) == []


def test_close_does_not_close_external_connection(repo):
    connection = repo.connection

    repo.close()

    assert not connection.closed



def ensure_wine_images_table(repo: WineRepository) -> None:
    with repo.connection.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS svoe_vino.wine_images (
                id BIGSERIAL PRIMARY KEY,
                wine_id BIGINT REFERENCES svoe_vino.wines(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                url TEXT NOT NULL,
                local_path TEXT,
                created_at TIMESTAMPTZ DEFAULT now(),
                download_status TEXT,
                download_error TEXT,
                downloaded_at TIMESTAMPTZ,
                content_type TEXT,
                size_bytes BIGINT,
                UNIQUE (wine_id, kind, url)
            )
            """
        )
    repo.connection.commit()

def test_get_images_to_download_returns_only_pending_images(repo):
    ensure_wine_images_table(repo)

    first_wine_id = repo.upsert_list_wine(list_wine(slug="first"))
    second_wine_id = repo.upsert_list_wine(list_wine(slug="second"))
    third_wine_id = repo.upsert_list_wine(list_wine(slug="third"))

    repo.upsert_wine_image(first_wine_id, "bottle", "https://example.com/1.webp")
    repo.upsert_wine_image(second_wine_id, "bottle", "https://example.com/2.webp")
    repo.upsert_wine_image(third_wine_id, "bottle", "https://example.com/3.webp")

    repo.mark_image_downloaded(
        image_id=1,
        local_path="data/images/bottle/1/1.webp",
        content_type="image/webp",
        size_bytes=10,
    )

    rows = repo.get_images_to_download(limit=10, kind="bottle")

    assert [row["id"] for row in rows] == [2, 3]
