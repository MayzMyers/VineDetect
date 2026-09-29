"""PostgreSQL repository for normalized wine catalog data."""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg import Connection, errors
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


class WineNotFoundError(Exception):
    """Raised when a wine row cannot be found."""


class WineConflictError(Exception):
    """Raised when a wine mutation violates a public uniqueness contract."""


class DatabaseUnavailableError(Exception):
    """Raised when PostgreSQL cannot be reached or checked."""


class ReferenceKeywordsNotReadyError(Exception):
    """Prepared keyword snapshots are missing or have stale wine titles."""


@dataclass(frozen=True)
class DatabaseStats:
    wines_total: int
    wines_with_details: int
    wines_without_details: int
    grapes_total: int
    dishes_total: int
    wine_grapes_total: int
    wine_dishes_total: int
    page_statuses: dict[str, int]
    wine_statuses: dict[str, int]
    top_regions: list[tuple[str, int]]
    top_categories: list[tuple[str, int]]
    top_manufacturers: list[tuple[str, int]]


ROSKACHESTVO_DETAIL_CHARACTERISTICS_KEYS = (
    "characteristics",
    "properties",
    "attrs",
    "params",
)
ROSKACHESTVO_DETAIL_EXCLUDED_CHARACTERISTICS_KEYS = {
    "id",
    "title",
    "name",
    "total_rating",
    "rating",
    "description",
    "product_link",
    "link",
    "url",
    "category_name",
    "manufacturer",
}


class WineRepository:
    def __init__(
        self,
        database_url: str | None = None,
        connection: Connection | None = None,
    ) -> None:
        if connection is None and database_url is None:
            msg = "database_url or connection is required"
            raise ValueError(msg)

        self.connection = connection or psycopg.connect(
            database_url,
            row_factory=dict_row,
        )
        self._owns_connection = connection is None
        self._column_cache: dict[tuple[str, str, str], bool] = {}

    def close(self) -> None:
        if self._owns_connection:
            self.connection.close()

    def __enter__(self) -> WineRepository:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def list_recognition_references(self) -> list[dict[str, Any]]:
        """One read-only query; refuse incomplete snapshots rather than lose wines."""
        try:
            with self.connection.cursor() as cur:
                cur.execute(
                    '''
                    SELECT wine.slug, reference.keywords
                    FROM svoe_vino.wines AS wine
                    LEFT JOIN svoe_vino.reference_keywords AS reference
                      ON reference.slug = wine.slug
                    ORDER BY wine.slug COLLATE "C"
                    '''
                )
                rows = list(cur.fetchall())
        except errors.UndefinedTable as exc:
            raise ReferenceKeywordsNotReadyError from exc
        if any(row["keywords"] is None for row in rows):
            raise ReferenceKeywordsNotReadyError
        return rows

    def upsert_list_wine(self, wine: dict[str, Any]) -> int:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO svoe_vino.wines (
                    slug,
                    title,
                    category_name,
                    manufacturer_name,
                    manufacturer_slug,
                    region_name,
                    public_rating,
                    color,
                    image_url,
                    image_alt,
                    raw_list_json,
                    list_seen_at,
                    updated_at
                )
                VALUES (
                    %(slug)s,
                    %(title)s,
                    %(category_name)s,
                    %(manufacturer_name)s,
                    %(manufacturer_slug)s,
                    %(region_name)s,
                    %(public_rating)s,
                    %(color)s,
                    %(image_url)s,
                    %(image_alt)s,
                    %(raw_list_json)s::jsonb,
                    now(),
                    now()
                )
                ON CONFLICT (slug) DO UPDATE SET
                    title = EXCLUDED.title,
                    category_name = EXCLUDED.category_name,
                    manufacturer_name = EXCLUDED.manufacturer_name,
                    manufacturer_slug = EXCLUDED.manufacturer_slug,
                    region_name = EXCLUDED.region_name,
                    public_rating = EXCLUDED.public_rating,
                    color = EXCLUDED.color,
                    image_url = EXCLUDED.image_url,
                    image_alt = EXCLUDED.image_alt,
                    raw_list_json = EXCLUDED.raw_list_json,
                    list_seen_at = now(),
                    updated_at = now()
                RETURNING id
                """,
                self._list_wine_params(wine),
            )
            wine_id = cur.fetchone()["id"]
        self.connection.commit()
        return wine_id

    def upsert_detail_wine(self, wine: dict[str, Any]) -> int:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO svoe_vino.wines (
                    slug,
                    title,
                    category_name,
                    manufacturer_name,
                    manufacturer_slug,
                    region_name,
                    alcohol,
                    temperature,
                    color,
                    description,
                    public_rating,
                    image_url,
                    image_alt,
                    raw_detail_json,
                    detail_seen_at,
                    updated_at
                )
                VALUES (
                    %(slug)s,
                    %(title)s,
                    %(category_name)s,
                    %(manufacturer_name)s,
                    %(manufacturer_slug)s,
                    %(region_name)s,
                    %(alcohol)s,
                    %(temperature)s,
                    %(color)s,
                    %(description)s,
                    %(public_rating)s,
                    %(image_url)s,
                    %(image_alt)s,
                    %(raw_detail_json)s::jsonb,
                    now(),
                    now()
                )
                ON CONFLICT (slug) DO UPDATE SET
                    title = EXCLUDED.title,
                    category_name = EXCLUDED.category_name,
                    manufacturer_name = EXCLUDED.manufacturer_name,
                    manufacturer_slug = EXCLUDED.manufacturer_slug,
                    region_name = EXCLUDED.region_name,
                    alcohol = EXCLUDED.alcohol,
                    temperature = EXCLUDED.temperature,
                    color = EXCLUDED.color,
                    description = EXCLUDED.description,
                    public_rating = EXCLUDED.public_rating,
                    image_url = EXCLUDED.image_url,
                    image_alt = EXCLUDED.image_alt,
                    raw_detail_json = EXCLUDED.raw_detail_json,
                    detail_seen_at = now(),
                    updated_at = now()
                RETURNING id
                """,
                self._detail_wine_params(wine),
            )
            wine_id = cur.fetchone()["id"]
        self.connection.commit()
        return wine_id

    def save_grapes(self, wine_id: int, grapes: Sequence[dict[str, Any]]) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                "DELETE FROM svoe_vino.wine_grapes WHERE wine_id = %s",
                (wine_id,),
            )
            for grape in grapes:
                grape_id = self._upsert_grape(cur, grape)
                cur.execute(
                    """
                    INSERT INTO svoe_vino.wine_grapes (wine_id, grape_id)
                    VALUES (%s, %s)
                    ON CONFLICT DO NOTHING
                    """,
                    (wine_id, grape_id),
                )
        self.connection.commit()

    def save_dishes(self, wine_id: int, dishes: Sequence[dict[str, Any]]) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                "DELETE FROM svoe_vino.wine_dishes WHERE wine_id = %s",
                (wine_id,),
            )
            for dish in dishes:
                dish_id = self._upsert_dish(cur, dish)
                cur.execute(
                    """
                    INSERT INTO svoe_vino.wine_dishes (wine_id, dish_id)
                    VALUES (%s, %s)
                    ON CONFLICT DO NOTHING
                    """,
                    (wine_id, dish_id),
                )
        self.connection.commit()

    def mark_page(
        self,
        page: int,
        status: str,
        items_count: int | None = None,
        error: str | None = None,
    ) -> None:
        columns = ["page", "status"]
        values: list[Any] = [page, status]
        updates = ["status = EXCLUDED.status"]

        if self._has_column("svoe_vino.crawl_pages", "per_page"):
            columns.append("per_page")
            values.append(items_count or 0)
            updates.append("per_page = EXCLUDED.per_page")
        if self._has_column("svoe_vino.crawl_pages", "items_count"):
            columns.append("items_count")
            values.append(items_count)
            updates.append("items_count = EXCLUDED.items_count")
        if self._has_column("svoe_vino.crawl_pages", "error"):
            columns.append("error")
            values.append(error)
            updates.append("error = EXCLUDED.error")

        timestamp_column = self._timestamp_column("svoe_vino.crawl_pages")
        if timestamp_column:
            columns.append(timestamp_column)
            values.append(None)
            updates.append(f"{timestamp_column} = now()")

        placeholders = [
            "now()" if column == timestamp_column else "%s"
            for column in columns
        ]
        params = [
            value
            for column, value in zip(columns, values, strict=True)
            if column != timestamp_column
        ]

        with self.connection.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO svoe_vino.crawl_pages ({", ".join(columns)})
                VALUES ({", ".join(placeholders)})
                ON CONFLICT (page) DO UPDATE SET {", ".join(updates)}
                """,
                params,
            )
        self.connection.commit()

    def mark_wine(
        self,
        slug: str,
        status: str,
        http_status: int | None = None,
        error: str | None = None,
    ) -> None:
        columns = ["slug", "status"]
        values: list[Any] = [slug, status]
        updates = ["status = EXCLUDED.status"]

        if self._has_column("svoe_vino.crawl_wines", "http_status"):
            columns.append("http_status")
            values.append(http_status)
            updates.append("http_status = EXCLUDED.http_status")
        if self._has_column("svoe_vino.crawl_wines", "error"):
            columns.append("error")
            values.append(error)
            updates.append("error = EXCLUDED.error")
        if self._has_column("svoe_vino.crawl_wines", "attempts"):
            columns.append("attempts")
            values.append(1)
            updates.append("attempts = crawl_wines.attempts + 1")

        timestamp_column = self._timestamp_column("svoe_vino.crawl_wines")
        if timestamp_column:
            columns.append(timestamp_column)
            values.append(None)
            updates.append(f"{timestamp_column} = now()")

        placeholders = [
            "now()" if column == timestamp_column else "%s"
            for column in columns
        ]
        params = [
            value
            for column, value in zip(columns, values, strict=True)
            if column != timestamp_column
        ]

        with self.connection.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO svoe_vino.crawl_wines AS crawl_wines ({", ".join(columns)})
                VALUES ({", ".join(placeholders)})
                ON CONFLICT (slug) DO UPDATE SET {", ".join(updates)}
                """,
                params,
            )
        self.connection.commit()

    def get_slugs_missing_details(self, limit: int = 1000) -> list[str]:
        if limit <= 0:
            return []

        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT slug
                FROM svoe_vino.wines
                WHERE raw_detail_json IS NULL
                ORDER BY id
                LIMIT %s
                """,
                (limit,),
            )
            return [row["slug"] for row in cur.fetchall()]


    def get_database_stats(self, top_limit: int = 10) -> DatabaseStats:
        if top_limit <= 0:
            top_limit = 10

        with self.connection.cursor() as cur:
            return DatabaseStats(
                wines_total=self._fetch_count(
                    cur,
                    "SELECT COUNT(*) FROM svoe_vino.wines",
                ),
                wines_with_details=self._fetch_count(
                    cur,
                    """
                    SELECT COUNT(*)
                    FROM svoe_vino.wines
                    WHERE raw_detail_json IS NOT NULL
                    """,
                ),
                wines_without_details=self._fetch_count(
                    cur,
                    """
                    SELECT COUNT(*)
                    FROM svoe_vino.wines
                    WHERE raw_detail_json IS NULL
                    """,
                ),
                grapes_total=self._fetch_count(
                    cur,
                    "SELECT COUNT(*) FROM svoe_vino.grapes",
                ),
                dishes_total=self._fetch_count(
                    cur,
                    "SELECT COUNT(*) FROM svoe_vino.dishes",
                ),
                wine_grapes_total=self._fetch_count(
                    cur,
                    "SELECT COUNT(*) FROM svoe_vino.wine_grapes",
                ),
                wine_dishes_total=self._fetch_count(
                    cur,
                    "SELECT COUNT(*) FROM svoe_vino.wine_dishes",
                ),
                page_statuses=self._fetch_status_counts(
                    cur,
                    """
                    SELECT status, COUNT(*)
                    FROM svoe_vino.crawl_pages
                    GROUP BY status
                    ORDER BY status
                    """,
                ),
                wine_statuses=self._fetch_status_counts(
                    cur,
                    """
                    SELECT status, COUNT(*)
                    FROM svoe_vino.crawl_wines
                    GROUP BY status
                    ORDER BY status
                    """,
                ),
                top_regions=self._fetch_top_names(
                    cur,
                    """
                    SELECT COALESCE(region_name, 'UNKNOWN') AS name, COUNT(*) AS count
                    FROM svoe_vino.wines
                    GROUP BY COALESCE(region_name, 'UNKNOWN')
                    ORDER BY count DESC, name ASC
                    LIMIT %s
                    """,
                    top_limit,
                ),
                top_categories=self._fetch_top_names(
                    cur,
                    """
                    SELECT COALESCE(category_name, 'UNKNOWN') AS name,
                           COUNT(*) AS count
                    FROM svoe_vino.wines
                    GROUP BY COALESCE(category_name, 'UNKNOWN')
                    ORDER BY count DESC, name ASC
                    LIMIT %s
                    """,
                    top_limit,
                ),
                top_manufacturers=self._fetch_top_names(
                    cur,
                    """
                    SELECT COALESCE(manufacturer_name, 'UNKNOWN') AS name,
                           COUNT(*) AS count
                    FROM svoe_vino.wines
                    GROUP BY COALESCE(manufacturer_name, 'UNKNOWN')
                    ORDER BY count DESC, name ASC
                    LIMIT %s
                    """,
                    top_limit,
                ),
            )

    def get_wines_for_image_assets(self) -> list[dict[str, Any]]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT id, image_url, raw_detail_json
                FROM svoe_vino.wines
                ORDER BY id
                """,
            )
            return list(cur.fetchall())

    def upsert_wine_image(self, wine_id: int, kind: str, url: str) -> int:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO svoe_vino.wine_images (wine_id, kind, url)
                VALUES (%s, %s, %s)
                ON CONFLICT (wine_id, kind, url) DO UPDATE SET
                    url = EXCLUDED.url
                RETURNING id
                """,
                (wine_id, kind, url),
            )
            image_id = cur.fetchone()["id"]
        self.connection.commit()
        return image_id


    def clear_wine_images(self) -> None:
        with self.connection.cursor() as cur:
            cur.execute("TRUNCATE TABLE svoe_vino.wine_images RESTART IDENTITY")
        self.connection.commit()

    def get_images_to_download(
        self,
        limit: int = 100,
        kind: str | None = None,
    ) -> list[dict[str, Any]]:
        if limit <= 0:
            return []

        query = """
            SELECT id, wine_id, kind, url
            FROM svoe_vino.wine_images
            WHERE (local_path IS NULL OR local_path = '')
              AND (download_status IS NULL OR download_status <> 'ok')
        """
        params: list[Any] = []
        if kind is not None:
            query += " AND kind = %s"
            params.append(kind)
        query += " ORDER BY id LIMIT %s"
        params.append(limit)

        with self.connection.cursor() as cur:
            cur.execute(query, params)
            return list(cur.fetchall())


    def get_image_rows_for_stats(
        self,
        kind: str | None = "bottle",
    ) -> list[dict[str, Any]]:
        query = """
            SELECT
                id,
                wine_id,
                kind,
                url,
                local_path,
                download_status,
                download_error,
                content_type,
                size_bytes,
                downloaded_at
            FROM svoe_vino.wine_images
        """
        params: list[Any] = []
        if kind is not None:
            query += " WHERE kind = %s"
            params.append(kind)
        query += " ORDER BY id"

        with self.connection.cursor() as cur:
            cur.execute(query, params)
            return list(cur.fetchall())

    def get_wine_image_storage_rows(self) -> list[dict[str, Any]]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    'svoe_vino' AS source,
                    id,
                    wine_id AS owner_id,
                    local_path
                FROM svoe_vino.wine_images
                WHERE local_path IS NOT NULL
                  AND local_path <> ''
                ORDER BY id
                """,
            )
            return list(cur.fetchall())

    def update_wine_image_local_path(
        self,
        image_id: int,
        new_local_path: str,
    ) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                UPDATE svoe_vino.wine_images
                SET local_path = %s
                WHERE id = %s
                """,
                (new_local_path, image_id),
            )
        self.connection.commit()

    def mark_image_downloaded(
        self,
        image_id: int,
        local_path: str,
        content_type: str | None,
        size_bytes: int,
    ) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                UPDATE svoe_vino.wine_images
                SET local_path = %s,
                    content_type = %s,
                    size_bytes = %s,
                    download_status = 'ok',
                    download_error = NULL,
                    downloaded_at = now()
                WHERE id = %s
                """,
                (local_path, content_type, size_bytes, image_id),
            )
        self.connection.commit()

    def mark_image_download_failed(self, image_id: int, error: str) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                UPDATE svoe_vino.wine_images
                SET download_status = 'error',
                    download_error = %s,
                    downloaded_at = now()
                WHERE id = %s
                """,
                (error, image_id),
            )
        self.connection.commit()


    def get_wines_for_rating_snapshot_extraction(self) -> list[dict[str, Any]]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT id, slug, title, raw_detail_json
                FROM svoe_vino.wines
                WHERE raw_detail_json IS NOT NULL
                ORDER BY id
                """,
            )
            return list(cur.fetchall())

    def upsert_wine_rating_snapshot(
        self,
        wine_id: int,
        source: str,
        rating_value: Any,
        rating_raw: Any,
        votes_count: int | None = None,
        reviews_count: int | None = None,
    ) -> int:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO svoe_vino.wine_rating_snapshots (
                    wine_id,
                    source,
                    rating_value,
                    rating_raw,
                    votes_count,
                    reviews_count,
                    fetched_at,
                    updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, now(), now())
                ON CONFLICT (wine_id, source) DO UPDATE SET
                    rating_value = EXCLUDED.rating_value,
                    rating_raw = EXCLUDED.rating_raw,
                    votes_count = EXCLUDED.votes_count,
                    reviews_count = EXCLUDED.reviews_count,
                    fetched_at = now(),
                    updated_at = now()
                RETURNING id
                """,
                (
                    wine_id,
                    source,
                    rating_value,
                    Jsonb(rating_raw),
                    votes_count,
                    reviews_count,
                ),
            )
            snapshot_id = cur.fetchone()["id"]
        self.connection.commit()
        return snapshot_id

    def get_rating_snapshot_stats(self) -> list[dict[str, Any]]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    source,
                    COUNT(*) AS count,
                    MIN(rating_value) AS min_rating,
                    MAX(rating_value) AS max_rating,
                    AVG(rating_value) AS avg_rating,
                    MIN(fetched_at) AS oldest_fetched_at,
                    MAX(fetched_at) AS newest_fetched_at
                FROM svoe_vino.wine_rating_snapshots
                GROUP BY source
                ORDER BY source
                """,
            )
            return list(cur.fetchall())


    def upsert_roskachestvo_product_from_list_item(
        self,
        product: dict[str, Any],
    ) -> int:
        fields = extract_roskachestvo_product_list_fields(product)
        with self.connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO roskachestvo.products (
                    rskrf_product_id,
                    list_name,
                    barcode,
                    list_rating,
                    raw_list_json,
                    list_status,
                    list_error,
                    list_fetched_at,
                    updated_at
                )
                VALUES (%s, %s, %s, %s, %s, 'ok', NULL, now(), now())
                ON CONFLICT (rskrf_product_id) DO UPDATE SET
                    list_name = EXCLUDED.list_name,
                    barcode = EXCLUDED.barcode,
                    list_rating = EXCLUDED.list_rating,
                    raw_list_json = EXCLUDED.raw_list_json,
                    list_status = 'ok',
                    list_error = NULL,
                    list_fetched_at = now(),
                    updated_at = now()
                RETURNING id
                """,
                (
                    fields['rskrf_product_id'],
                    fields['list_name'],
                    fields['barcode'],
                    fields['list_rating'],
                    Jsonb(fields['raw_list_json']),
                ),
            )
            product_id = cur.fetchone()['id']
        self.connection.commit()
        return product_id

    def mark_roskachestvo_product_list_failed(
        self,
        rskrf_product_id: str,
        error: str,
    ) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO roskachestvo.products (
                    rskrf_product_id,
                    list_status,
                    list_error,
                    list_fetched_at,
                    updated_at
                )
                VALUES (%s, 'failed', %s, now(), now())
                ON CONFLICT (rskrf_product_id) DO UPDATE SET
                    list_status = 'failed',
                    list_error = EXCLUDED.list_error,
                    list_fetched_at = now(),
                    updated_at = now()
                """,
                (rskrf_product_id, error),
            )
        self.connection.commit()

    def reset_roskachestvo_product_list_errors(self) -> int:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                UPDATE roskachestvo.products
                SET
                    list_status = 'pending',
                    list_error = NULL,
                    updated_at = now()
                WHERE list_status = 'failed'
                   OR list_error IS NOT NULL
                """,
            )
            updated_count = cur.rowcount
        self.connection.commit()
        return updated_count

    def get_roskachestvo_products_for_detail_import(
        self,
        limit: int | None = None,
        failed_only: bool = False,
        force: bool = False,
    ) -> list[dict[str, Any]]:
        query = """
            SELECT rskrf_product_id, detail_status, raw_detail_json
            FROM roskachestvo.products
        """
        params: list[Any] = []

        if failed_only:
            query += " WHERE detail_status = 'failed'"
        elif not force:
            query += """
                WHERE detail_status IN ('pending', 'failed')
                   OR raw_detail_json IS NULL
            """

        query += " ORDER BY rskrf_product_id"
        if limit is not None and limit > 0:
            query += " LIMIT %s"
            params.append(limit)

        with self.connection.cursor() as cur:
            cur.execute(query, params)
            return list(cur.fetchall())

    def update_roskachestvo_product_detail(
        self,
        rskrf_product_id: str,
        detail: dict[str, Any],
    ) -> None:
        fields = extract_roskachestvo_product_detail_fields(detail)
        with self.connection.cursor() as cur:
            cur.execute(
                """
                UPDATE roskachestvo.products
                SET
                    title = %s,
                    total_rating = %s,
                    description = %s,
                    product_link = %s,
                    source_page_url = %s,
                    category_name = %s,
                    manufacturer = %s,
                    characteristics = %s,
                    raw_detail_json = %s,
                    detail_status = 'ok',
                    detail_error = NULL,
                    detail_fetched_at = now(),
                    updated_at = now()
                WHERE rskrf_product_id = %s
                """,
                (
                    fields["title"],
                    fields["total_rating"],
                    fields["description"],
                    fields["product_link"],
                    fields["source_page_url"],
                    fields["category_name"],
                    fields["manufacturer"],
                    Jsonb(fields["characteristics"]),
                    Jsonb(detail),
                    rskrf_product_id,
                ),
            )
        self.connection.commit()

    def mark_roskachestvo_product_detail_failed(
        self,
        rskrf_product_id: str,
        error: str,
    ) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                UPDATE roskachestvo.products
                SET
                    detail_status = 'failed',
                    detail_error = %s,
                    updated_at = now()
                WHERE rskrf_product_id = %s
                """,
                (error, rskrf_product_id),
            )
        self.connection.commit()

    def get_roskachestvo_products_for_image_url_import(
        self,
        limit: int | None = None,
        failed_only: bool = False,
        force: bool = False,
    ) -> list[dict[str, Any]]:
        query = """
            SELECT
                rskrf_product_id,
                product_link,
                page_status,
                image_source_url
            FROM roskachestvo.products
            WHERE product_link IS NOT NULL
              AND product_link <> ''
        """
        params: list[Any] = []

        if failed_only:
            query += " AND page_status = 'failed'"
        elif not force:
            query += """
                AND (
                    page_status IN ('pending', 'failed')
                    OR image_source_url IS NULL
                    OR image_source_url = ''
                )
            """

        query += " ORDER BY rskrf_product_id"
        if limit is not None and limit > 0:
            query += " LIMIT %s"
            params.append(limit)

        with self.connection.cursor() as cur:
            cur.execute(query, params)
            return list(cur.fetchall())

    def update_roskachestvo_product_image_source_url(
        self,
        rskrf_product_id: str,
        image_source_url: str | None,
        source_page_url: str | None = None,
    ) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                UPDATE roskachestvo.products
                SET
                    image_source_url = %s,
                    source_page_url = COALESCE(%s, source_page_url),
                    page_status = 'ok',
                    page_error = NULL,
                    page_fetched_at = now(),
                    updated_at = now()
                WHERE rskrf_product_id = %s
                """,
                (image_source_url, source_page_url, rskrf_product_id),
            )
        self.connection.commit()

    def mark_roskachestvo_product_page_failed(
        self,
        rskrf_product_id: str,
        error: str,
    ) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                UPDATE roskachestvo.products
                SET
                    page_status = 'failed',
                    page_error = %s,
                    page_fetched_at = now(),
                    updated_at = now()
                WHERE rskrf_product_id = %s
                """,
                (error, rskrf_product_id),
            )
        self.connection.commit()

    def get_roskachestvo_products_for_image_download(
        self,
        limit: int | None = None,
        failed_only: bool = False,
        force: bool = False,
    ) -> list[dict[str, Any]]:
        query = """
            SELECT
                rskrf_product_id,
                image_source_url,
                image_local_path,
                image_download_status
            FROM roskachestvo.products
            WHERE image_source_url IS NOT NULL
              AND image_source_url <> ''
        """
        params: list[Any] = []

        if failed_only:
            query += " AND image_download_status = 'failed'"
        elif not force:
            query += """
                AND (
                    image_download_status IN ('pending', 'failed')
                    OR image_local_path IS NULL
                    OR image_local_path = ''
                )
            """

        query += " ORDER BY rskrf_product_id"
        if limit is not None and limit > 0:
            query += " LIMIT %s"
            params.append(limit)

        with self.connection.cursor() as cur:
            cur.execute(query, params)
            return list(cur.fetchall())

    def get_roskachestvo_image_storage_rows(self) -> list[dict[str, Any]]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    'roskachestvo' AS source,
                    id,
                    rskrf_product_id AS owner_id,
                    image_local_path AS local_path
                FROM roskachestvo.products
                WHERE image_local_path IS NOT NULL
                  AND image_local_path <> ''
                ORDER BY id
                """,
            )
            return list(cur.fetchall())

    def update_roskachestvo_product_image_local_path(
        self,
        product_id: int,
        new_local_path: str,
    ) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                UPDATE roskachestvo.products
                SET image_local_path = %s
                WHERE id = %s
                """,
                (new_local_path, product_id),
            )
        self.connection.commit()

    def update_roskachestvo_product_image_download(
        self,
        rskrf_product_id: str,
        image_local_path: str,
        image_content_type: str | None,
        image_size_bytes: int | None,
    ) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                UPDATE roskachestvo.products
                SET
                    image_local_path = %s,
                    image_content_type = %s,
                    image_size_bytes = %s,
                    image_download_status = 'ok',
                    image_download_error = NULL,
                    image_downloaded_at = now(),
                    updated_at = now()
                WHERE rskrf_product_id = %s
                """,
                (
                    image_local_path,
                    image_content_type,
                    image_size_bytes,
                    rskrf_product_id,
                ),
            )
        self.connection.commit()

    def mark_roskachestvo_product_image_download_failed(
        self,
        rskrf_product_id: str,
        error: str,
    ) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                UPDATE roskachestvo.products
                SET
                    image_download_status = 'failed',
                    image_download_error = %s,
                    updated_at = now()
                WHERE rskrf_product_id = %s
                """,
                (error, rskrf_product_id),
            )
        self.connection.commit()

    def get_roskachestvo_product_audit_rows(self) -> list[dict[str, Any]]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    rskrf_product_id,
                    detail_status,
                    page_status,
                    image_download_status,
                    image_processing_status,
                    image_local_path,
                    image_size_bytes
                FROM roskachestvo.products
                ORDER BY rskrf_product_id
                """,
            )
            return list(cur.fetchall())

    def get_roskachestvo_product_stats(self) -> dict[str, Any]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) AS products_total,
                    COUNT(*) FILTER (
                        WHERE barcode IS NOT NULL AND barcode <> ''
                    ) AS with_barcode,
                    COUNT(*) FILTER (
                        WHERE barcode IS NULL OR barcode = ''
                    ) AS without_barcode,
                    COUNT(*) FILTER (
                        WHERE raw_list_json IS NOT NULL
                    ) AS with_list_json,
                    COUNT(*) FILTER (
                        WHERE raw_detail_json IS NOT NULL
                    ) AS with_detail_json,
                    COUNT(*) FILTER (
                        WHERE product_link IS NOT NULL AND product_link <> ''
                    ) AS with_product_link,
                    COUNT(*) FILTER (
                        WHERE image_source_url IS NOT NULL
                          AND image_source_url <> ''
                    ) AS with_image_source_url,
                    COUNT(*) FILTER (
                        WHERE image_local_path IS NOT NULL
                          AND image_local_path <> ''
                    ) AS with_image_local_path,
                    COUNT(*) FILTER (WHERE list_status = 'ok') AS list_ok,
                    COUNT(*) FILTER (WHERE detail_status = 'ok') AS detail_ok,
                    COUNT(*) FILTER (WHERE page_status = 'ok') AS page_ok,
                    COUNT(*) FILTER (
                        WHERE image_download_status = 'ok'
                    ) AS image_download_ok,
                    COUNT(*) FILTER (
                        WHERE image_processing_status = 'ok'
                    ) AS image_processing_ok,
                    MIN(updated_at) AS updated_min,
                    MAX(updated_at) AS updated_max
                FROM roskachestvo.products
                """,
            )
            return dict(cur.fetchone())


    def get_release_snapshot(self) -> dict[str, Any]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                WITH match_counts AS (
                    SELECT
                        COUNT(*) AS total,
                        COUNT(*) FILTER (
                            WHERE product.rskrf_product_id IS NOT NULL
                        ) AS joined
                    FROM svoe_vino.wine_external_matches AS external_match
                    LEFT JOIN roskachestvo.products AS product
                        ON product.rskrf_product_id = external_match.source_product_id
                    WHERE external_match.source = %(source)s
                ),
                barcode_counts AS (
                    SELECT
                        COUNT(*) AS total,
                        COUNT(*) FILTER (
                            WHERE product.rskrf_product_id IS NOT NULL
                        ) AS joined
                    FROM svoe_vino.wine_barcodes AS barcode
                    LEFT JOIN roskachestvo.products AS product
                        ON product.rskrf_product_id = barcode.source_product_id
                    WHERE barcode.source = %(source)s
                )
                SELECT
                    (
                        SELECT COUNT(*)
                        FROM svoe_vino.wines
                    ) AS wines_total,
                    (
                        SELECT COUNT(*)
                        FROM svoe_vino.wines
                        WHERE image_url IS NOT NULL
                          AND image_url <> ''
                    ) AS wines_with_image_url,
                    (
                        SELECT COUNT(*)
                        FROM svoe_vino.wines
                        WHERE raw_detail_json IS NOT NULL
                    ) AS wines_with_raw_detail_json,
                    (
                        SELECT COUNT(*)
                        FROM svoe_vino.wine_images
                    ) AS wine_images_total,
                    (
                        SELECT COUNT(*)
                        FROM svoe_vino.wine_images
                        WHERE local_path IS NOT NULL
                          AND local_path <> ''
                    ) AS wine_images_with_local_path,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                    ) AS roskachestvo_products_total,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                        WHERE barcode IS NOT NULL
                          AND barcode <> ''
                    ) AS roskachestvo_with_barcode,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                        WHERE raw_detail_json IS NOT NULL
                    ) AS roskachestvo_with_detail_json,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                        WHERE product_link IS NOT NULL
                          AND product_link <> ''
                    ) AS roskachestvo_with_product_link,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                        WHERE image_source_url IS NOT NULL
                          AND image_source_url <> ''
                    ) AS roskachestvo_with_image_source_url,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                        WHERE image_local_path IS NOT NULL
                          AND image_local_path <> ''
                    ) AS roskachestvo_with_image_local_path,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                        WHERE detail_status = 'ok'
                    ) AS roskachestvo_detail_ok,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                        WHERE detail_status = 'failed'
                    ) AS roskachestvo_detail_failed,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                        WHERE page_status = 'ok'
                    ) AS roskachestvo_page_ok,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                        WHERE page_status = 'failed'
                    ) AS roskachestvo_page_failed,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                        WHERE image_download_status = 'ok'
                    ) AS roskachestvo_image_download_ok,
                    (
                        SELECT COUNT(*)
                        FROM roskachestvo.products
                        WHERE image_download_status = 'failed'
                    ) AS roskachestvo_image_download_failed,
                    match_counts.total AS roskachestvo_matches_total,
                    match_counts.joined AS roskachestvo_matches_joined_to_products,
                    (
                        match_counts.total - match_counts.joined
                    ) AS roskachestvo_matches_not_joined,
                    barcode_counts.total AS roskachestvo_barcode_links_total,
                    barcode_counts.joined
                        AS roskachestvo_barcode_links_joined_to_products,
                    (
                        barcode_counts.total - barcode_counts.joined
                    ) AS roskachestvo_barcode_links_not_joined,
                    to_regclass(%(legacy_table)s) IS NOT NULL
                        AS legacy_roskachestvo_wines_exists
                FROM match_counts, barcode_counts
                """,
                {
                    "source": "roskachestvo",
                    "legacy_table": "public.roskachestvo_wines",
                },
            )
            return dict(cur.fetchone())


    def get_roskachestvo_products_for_matching(
        self,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        query = """
            SELECT
                rskrf_product_id,
                COALESCE(title, list_name) AS name,
                barcode,
                COALESCE(total_rating, list_rating) AS rating,
                COALESCE(raw_detail_json, raw_list_json) AS raw_json
            FROM roskachestvo.products
            WHERE COALESCE(title, list_name) IS NOT NULL
              AND btrim(COALESCE(title, list_name)) <> ''
            ORDER BY rskrf_product_id
        """
        params: list[Any] = []
        if limit is not None and limit > 0:
            query += ' LIMIT %s'
            params.append(limit)

        with self.connection.cursor() as cur:
            cur.execute(query, params)
            return list(cur.fetchall())

    def get_wines_for_external_matching(self) -> list[dict[str, Any]]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    id,
                    slug,
                    title,
                    manufacturer_name,
                    category_name,
                    region_name
                FROM contest.effective_wines
                ORDER BY id
                """,
            )
            return list(cur.fetchall())

    def clear_external_matches(self, source: str) -> None:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                DELETE FROM svoe_vino.wine_external_matches
                WHERE source = %s
                """,
                (source,),
            )
        self.connection.commit()

    def upsert_external_match(
        self,
        wine_id: int,
        source: str,
        source_product_id: str,
        barcode: str | None,
        source_name: str,
        match_score: Any,
        match_method: str,
        match_details: dict[str, Any],
    ) -> int:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO svoe_vino.wine_external_matches (
                    wine_id,
                    source,
                    source_product_id,
                    barcode,
                    source_name,
                    match_score,
                    match_method,
                    match_details,
                    is_confirmed,
                    updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, false, now())
                ON CONFLICT (source, source_product_id, wine_id) DO UPDATE SET
                    barcode = EXCLUDED.barcode,
                    source_name = EXCLUDED.source_name,
                    match_score = EXCLUDED.match_score,
                    match_method = EXCLUDED.match_method,
                    match_details = EXCLUDED.match_details,
                    updated_at = now()
                RETURNING id
                """,
                (
                    wine_id,
                    source,
                    source_product_id,
                    barcode,
                    source_name,
                    match_score,
                    match_method,
                    Jsonb(match_details),
                ),
            )
            match_id = cur.fetchone()["id"]
        self.connection.commit()
        return match_id

    def get_external_match_stats(
        self,
        source: str = "roskachestvo",
    ) -> dict[str, Any]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) AS matches_total,
                    COUNT(DISTINCT source_product_id) AS source_products_matched,
                    COUNT(DISTINCT wine_id) AS wines_matched,
                    COUNT(*) FILTER (WHERE match_score >= 0.85) AS high_confidence,
                    COUNT(*) FILTER (
                        WHERE match_score >= 0.70 AND match_score < 0.85
                    ) AS medium_confidence,
                    COUNT(*) FILTER (WHERE match_score < 0.70) AS low_confidence,
                    COUNT(*) FILTER (WHERE is_confirmed) AS confirmed
                FROM svoe_vino.wine_external_matches
                WHERE source = %s
                """,
                (source,),
            )
            return dict(cur.fetchone())

    def get_top_external_matches(
        self,
        source: str = "roskachestvo",
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        if limit <= 0:
            return []

        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    wem.source_product_id,
                    wem.source_name,
                    wem.barcode,
                    wem.match_score,
                    wem.match_method,
                    w.id AS wine_id,
                    w.slug,
                    w.title,
                    w.manufacturer_name,
                    w.category_name,
                    w.region_name
                FROM svoe_vino.wine_external_matches wem
                JOIN contest.effective_wines w ON w.id = wem.wine_id
                WHERE wem.source = %s
                ORDER BY wem.match_score DESC, wem.source_product_id, w.id
                LIMIT %s
                """,
                (source, limit),
            )
            return list(cur.fetchall())
    def get_safe_barcode_match_candidates(
        self,
        source: str = "roskachestvo",
        min_score: float = 0.88,
        min_gap: float = 0.08,
    ) -> list[dict[str, Any]]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                WITH ranked AS (
                    SELECT
                        wem.*,
                        ROW_NUMBER() OVER (
                            PARTITION BY source_product_id
                            ORDER BY match_score DESC, wine_id
                        ) AS rn,
                        LEAD(match_score) OVER (
                            PARTITION BY source_product_id
                            ORDER BY match_score DESC, wine_id
                        ) AS next_score
                    FROM svoe_vino.wine_external_matches wem
                    WHERE source = %s
                      AND barcode IS NOT NULL
                      AND barcode <> ''
                ),
                top1 AS (
                    SELECT
                        *,
                        match_score - COALESCE(next_score, 0) AS score_gap
                    FROM ranked
                    WHERE rn = 1
                )
                SELECT
                    wine_id,
                    source,
                    source_product_id,
                    barcode,
                    source_name,
                    match_score,
                    score_gap,
                    match_method,
                    match_details
                FROM top1
                WHERE match_score >= %s
                  AND score_gap >= %s
                ORDER BY match_score DESC, score_gap DESC, source_product_id, wine_id
                """,
                (source, min_score, min_gap),
            )
            return list(cur.fetchall())

    def upsert_wine_barcode(
        self,
        wine_id: int,
        barcode: str,
        source: str,
        source_product_id: str | None,
        confidence: Any,
        match_score: Any,
        score_gap: Any,
        match_method: str,
        match_details: dict[str, Any] | None,
        is_primary: bool = False,
    ) -> int:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                INSERT INTO svoe_vino.wine_barcodes (
                    wine_id,
                    barcode,
                    source,
                    source_product_id,
                    confidence,
                    match_score,
                    score_gap,
                    match_method,
                    match_details,
                    is_primary,
                    updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (wine_id, barcode, source) DO UPDATE SET
                    source_product_id = EXCLUDED.source_product_id,
                    confidence = EXCLUDED.confidence,
                    match_score = EXCLUDED.match_score,
                    score_gap = EXCLUDED.score_gap,
                    match_method = EXCLUDED.match_method,
                    match_details = EXCLUDED.match_details,
                    is_primary = (
                        svoe_vino.wine_barcodes.is_primary
                        OR EXCLUDED.is_primary
                    ),
                    updated_at = now()
                RETURNING id
                """,
                (
                    wine_id,
                    barcode,
                    source,
                    source_product_id,
                    confidence,
                    match_score,
                    score_gap,
                    match_method,
                    Jsonb(match_details) if match_details is not None else None,
                    is_primary,
                ),
            )
            barcode_id = cur.fetchone()["id"]
        self.connection.commit()
        return barcode_id

    def get_barcode_stats(self) -> dict[str, Any]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    COUNT(*) AS barcode_links_total,
                    COUNT(DISTINCT wine_id) AS wines_with_barcode,
                    COUNT(DISTINCT barcode) AS distinct_barcodes,
                    COUNT(DISTINCT source) AS sources_total,
                    MIN(confidence) AS min_confidence,
                    MAX(confidence) AS max_confidence,
                    AVG(confidence) AS avg_confidence
                FROM svoe_vino.wine_barcodes
                """,
            )
            stats = dict(cur.fetchone())
            stats["duplicate_barcodes"] = self._fetch_count(
                cur,
                """
                SELECT COUNT(*)
                FROM (
                    SELECT barcode
                    FROM svoe_vino.wine_barcodes
                    GROUP BY barcode
                    HAVING COUNT(DISTINCT wine_id) > 1
                ) t
                """,
            )
            return stats

    def get_barcode_stats_by_source(self) -> list[dict[str, Any]]:
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    source,
                    COUNT(*) AS links_count,
                    COUNT(DISTINCT wine_id) AS wines_count,
                    COUNT(DISTINCT barcode) AS barcodes_count,
                    MIN(confidence) AS min_confidence,
                    MAX(confidence) AS max_confidence,
                    AVG(confidence) AS avg_confidence
                FROM svoe_vino.wine_barcodes
                GROUP BY source
                ORDER BY source
                """,
            )
            return list(cur.fetchall())

    def get_duplicate_wine_barcodes(self, limit: int = 20) -> list[dict[str, Any]]:
        if limit <= 0:
            return []

        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    barcode,
                    COUNT(*) AS links_count,
                    COUNT(DISTINCT wine_id) AS wines_count
                FROM svoe_vino.wine_barcodes
                GROUP BY barcode
                HAVING COUNT(DISTINCT wine_id) > 1
                ORDER BY wines_count DESC, links_count DESC, barcode
                LIMIT %s
                """,
                (limit,),
            )
            return list(cur.fetchall())

    def get_top_wine_barcodes(self, limit: int = 20) -> list[dict[str, Any]]:
        if limit <= 0:
            return []

        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT
                    wb.barcode,
                    wb.source,
                    wb.source_product_id,
                    wb.confidence,
                    wb.match_score,
                    wb.score_gap,
                    wb.match_method,
                    w.id AS wine_id,
                    w.slug,
                    w.title,
                    w.manufacturer_name,
                    w.category_name,
                    w.region_name
                FROM svoe_vino.wine_barcodes wb
                JOIN contest.effective_wines w ON w.id = wb.wine_id
                ORDER BY wb.confidence DESC, wb.score_gap DESC, wb.barcode, w.id
                LIMIT %s
                """,
                (limit,),
            )
            return list(cur.fetchall())

    def check_database(self) -> None:
        try:
            with self.connection.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
        except psycopg.Error as exc:
            raise DatabaseUnavailableError from exc

    def search_svoe_vino_catalog_items(
        self,
        query: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        limit, offset = self._catalog_bounds(limit=limit, offset=offset)
        where_sql, params = self._svoe_vino_catalog_filter(query)
        params.extend([limit, offset])

        with self.connection.cursor() as cur:
            cur.execute(
                f"""
                SELECT
                    'svoe_vino' AS source,
                    COALESCE(wine.external_id, wine.slug, wine.id::text)
                        AS external_id,
                    'svoe_vino:'
                        || COALESCE(wine.external_id, wine.slug, wine.id::text)
                        AS recognition_key,
                    wine.id AS local_id,
                    wine.title AS title,
                    wine.manufacturer_name AS manufacturer,
                    wine.category_name AS category,
                    wine.region_name AS region,
                    NULL::integer AS year,
                    wine.public_rating AS rating,
                    NULL::text AS barcode,
                    wine.description AS description,
                    wine.source_url AS source_url,
                    jsonb_build_object(
                        'url', wine.image_url,
                        'local_path', image.local_path,
                        'content_type', image.content_type,
                        'size_bytes', image.size_bytes
                    ) AS image
                FROM contest.effective_wines AS wine
                LEFT JOIN LATERAL (
                    SELECT local_path, content_type, size_bytes
                    FROM svoe_vino.wine_images
                    WHERE wine_id = wine.id
                    ORDER BY
                        CASE
                            WHEN local_path IS NOT NULL AND local_path <> '' THEN 0
                            ELSE 1
                        END,
                        id
                    LIMIT 1
                ) AS image ON true
                {where_sql}
                ORDER BY
                    lower(COALESCE(wine.title, '')),
                    source,
                    external_id
                LIMIT %s OFFSET %s
                """,
                params,
            )
            return self._catalog_items_from_rows(cur.fetchall())

    def search_roskachestvo_catalog_items(
        self,
        query: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        limit, offset = self._catalog_bounds(limit=limit, offset=offset)
        where_sql, params = self._roskachestvo_catalog_filter(query)
        params.extend([limit, offset])

        with self.connection.cursor() as cur:
            cur.execute(
                f"""
                SELECT
                    'roskachestvo' AS source,
                    product.rskrf_product_id AS external_id,
                    'roskachestvo:' || product.rskrf_product_id
                        AS recognition_key,
                    product.id AS local_id,
                    COALESCE(product.title, product.list_name) AS title,
                    product.manufacturer AS manufacturer,
                    product.category_name AS category,
                    NULL::text AS region,
                    NULL::integer AS year,
                    COALESCE(product.total_rating, product.list_rating) AS rating,
                    product.barcode AS barcode,
                    product.description AS description,
                    COALESCE(product.source_page_url, product.product_link)
                        AS source_url,
                    jsonb_build_object(
                        'url', product.image_source_url,
                        'local_path', product.image_local_path,
                        'content_type', product.image_content_type,
                        'size_bytes', product.image_size_bytes
                    ) AS image
                FROM roskachestvo.products AS product
                {where_sql}
                ORDER BY
                    lower(COALESCE(product.title, product.list_name, '')),
                    source,
                    external_id
                LIMIT %s OFFSET %s
                """,
                params,
            )
            return self._catalog_items_from_rows(cur.fetchall())

    def search_catalog_items(
        self,
        source: str = "all",
        query: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        if source == "svoe_vino":
            return self.search_svoe_vino_catalog_items(
                query=query,
                limit=limit,
                offset=offset,
            )
        if source == "roskachestvo":
            return self.search_roskachestvo_catalog_items(
                query=query,
                limit=limit,
                offset=offset,
            )
        if source != "all":
            msg = f"unknown catalog source: {source}"
            raise ValueError(msg)

        limit, offset = self._catalog_bounds(limit=limit, offset=offset)
        svoe_where_sql, svoe_params = self._svoe_vino_catalog_filter(query)
        roskachestvo_where_sql, roskachestvo_params = (
            self._roskachestvo_catalog_filter(query)
        )
        params = [*svoe_params, *roskachestvo_params, limit, offset]

        with self.connection.cursor() as cur:
            cur.execute(
                f"""
                WITH catalog_items AS (
                    SELECT
                        'svoe_vino' AS source,
                        COALESCE(wine.external_id, wine.slug, wine.id::text)
                            AS external_id,
                        'svoe_vino:'
                            || COALESCE(wine.external_id, wine.slug, wine.id::text)
                            AS recognition_key,
                        wine.id AS local_id,
                        wine.title AS title,
                        wine.manufacturer_name AS manufacturer,
                        wine.category_name AS category,
                        wine.region_name AS region,
                        NULL::integer AS year,
                        wine.public_rating AS rating,
                        NULL::text AS barcode,
                        wine.description AS description,
                        wine.source_url AS source_url,
                        jsonb_build_object(
                            'url', wine.image_url,
                            'local_path', image.local_path,
                            'content_type', image.content_type,
                            'size_bytes', image.size_bytes
                        ) AS image
                    FROM contest.effective_wines AS wine
                    LEFT JOIN LATERAL (
                        SELECT local_path, content_type, size_bytes
                        FROM svoe_vino.wine_images
                        WHERE wine_id = wine.id
                        ORDER BY
                            CASE
                                WHEN local_path IS NOT NULL
                                 AND local_path <> '' THEN 0
                                ELSE 1
                            END,
                            id
                        LIMIT 1
                    ) AS image ON true
                    {svoe_where_sql}
                    UNION ALL
                    SELECT
                        'roskachestvo' AS source,
                        product.rskrf_product_id AS external_id,
                        'roskachestvo:' || product.rskrf_product_id
                            AS recognition_key,
                        product.id AS local_id,
                        COALESCE(product.title, product.list_name) AS title,
                        product.manufacturer AS manufacturer,
                        product.category_name AS category,
                        NULL::text AS region,
                        NULL::integer AS year,
                        COALESCE(product.total_rating, product.list_rating) AS rating,
                        product.barcode AS barcode,
                        product.description AS description,
                        COALESCE(product.source_page_url, product.product_link)
                            AS source_url,
                        jsonb_build_object(
                            'url', product.image_source_url,
                            'local_path', product.image_local_path,
                            'content_type', product.image_content_type,
                            'size_bytes', product.image_size_bytes
                        ) AS image
                    FROM roskachestvo.products AS product
                    {roskachestvo_where_sql}
                )
                SELECT *
                FROM catalog_items
                ORDER BY lower(COALESCE(title, '')), source, external_id
                LIMIT %s OFFSET %s
                """,
                params,
            )
            return self._catalog_items_from_rows(cur.fetchall())

    @staticmethod
    def _catalog_bounds(limit: int, offset: int) -> tuple[int, int]:
        return min(max(limit, 1), 100), max(offset, 0)

    @staticmethod
    def _svoe_vino_catalog_filter(query: str | None) -> tuple[str, list[Any]]:
        if not query:
            return "", []

        pattern = f"%{query}%"
        return (
            """
                WHERE wine.title ILIKE %s
                   OR wine.manufacturer_name ILIKE %s
                   OR wine.category_name ILIKE %s
                   OR wine.region_name ILIKE %s
                   OR wine.slug ILIKE %s
                   OR wine.external_id ILIKE %s
            """,
            [pattern, pattern, pattern, pattern, pattern, pattern],
        )

    @staticmethod
    def _roskachestvo_catalog_filter(query: str | None) -> tuple[str, list[Any]]:
        if not query:
            return "", []

        pattern = f"%{query}%"
        return (
            """
                WHERE COALESCE(product.title, product.list_name) ILIKE %s
                   OR product.manufacturer ILIKE %s
                   OR product.category_name ILIKE %s
                   OR product.barcode ILIKE %s
                   OR product.rskrf_product_id ILIKE %s
            """,
            [pattern, pattern, pattern, pattern, pattern],
        )

    @classmethod
    def _catalog_items_from_rows(
        cls,
        rows: Sequence[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        return [cls._catalog_item_from_row(row) for row in rows]

    @staticmethod
    def _catalog_item_from_row(row: dict[str, Any]) -> dict[str, Any]:
        item = dict(row)
        image = item.get("image")
        if not isinstance(image, dict):
            image = {}
        item["image"] = {
            "url": image.get("url"),
            "local_path": image.get("local_path"),
            "content_type": image.get("content_type"),
            "size_bytes": image.get("size_bytes"),
        }
        return item


    def list_api_wines(
        self,
        query: str | None = None,
        region: str | None = None,
        category: str | None = None,
        manufacturer: str | None = None,
        limit: int = 20,
        offset: int = 0,
    ) -> tuple[list[dict[str, Any]], int]:
        where_clauses: list[str] = []
        params: list[Any] = []

        if query:
            pattern = f"%{query}%"
            where_clauses.append(
                "(title ILIKE %s OR slug ILIKE %s OR manufacturer_name ILIKE %s)"
            )
            params.extend([pattern, pattern, pattern])
        if region:
            where_clauses.append("region_name = %s")
            params.append(region)
        if category:
            where_clauses.append("category_name = %s")
            params.append(category)
        if manufacturer:
            where_clauses.append("manufacturer_name = %s")
            params.append(manufacturer)

        where_sql = ""
        if where_clauses:
            where_sql = "WHERE " + " AND ".join(where_clauses)

        with self.connection.cursor() as cur:
            cur.execute(
                f"SELECT COUNT(*) AS count FROM contest.effective_wines {where_sql}",
                params,
            )
            total = cur.fetchone()["count"]
            cur.execute(
                f"""
                SELECT
                    id,
                    slug,
                    title,
                    category_name,
                    manufacturer_name,
                    region_name,
                    public_rating,
                    image_url,
                    color,
                    alcohol,
                    source,
                    external_id
                FROM contest.effective_wines
                {where_sql}
                ORDER BY id
                LIMIT %s OFFSET %s
                """,
                [*params, limit, offset],
            )
            return list(cur.fetchall()), total

    def get_api_wine(self, wine_id: int) -> dict[str, Any]:
        with self.connection.cursor() as cur:
            row = self._fetch_api_wine_detail(cur, "w.id = %s", [wine_id])
        if row is None:
            raise WineNotFoundError
        return row

    def get_api_wine_by_barcode(self, barcode: str) -> dict[str, Any]:
        with self.connection.cursor() as cur:
            row = self._fetch_api_wine_detail(cur, "wb.barcode = %s", [barcode])
        if row is None:
            raise WineNotFoundError
        return row

    def get_api_wine_by_official_slug(self, official_slug: str) -> dict[str, Any]:
        """Resolve a saved organizer identity through its exact local binding."""
        with self.connection.cursor() as cur:
            cur.execute(
                """
                SELECT link.wine_id, asset.local_path,
                       asset.mime_type AS content_type, asset.byte_size AS size_bytes
                FROM contest.catalog_items AS item
                JOIN contest.import_runs AS run ON run.id = item.import_run_id
                LEFT JOIN contest.item_links AS link ON link.catalog_item_id = item.id
                LEFT JOIN contest.reference_assets AS asset
                  ON asset.catalog_item_id = item.id
                WHERE item.official_slug = %s AND run.status = 'completed'
                """,
                [official_slug],
            )
            bindings = list(cur.fetchall())
            if not bindings:
                raise WineNotFoundError
            if len(bindings) != 1:
                raise WineConflictError("official slug has ambiguous catalog bindings")
            binding = bindings[0]
            if binding["wine_id"] is None:
                raise WineNotFoundError
            row = self._fetch_api_wine_detail(cur, "w.id = %s", [binding["wine_id"]])
        if row is None:
            raise WineNotFoundError
        row["official_slug"] = official_slug
        row["official_reference"] = (
            {key: binding[key] for key in ("local_path", "content_type", "size_bytes")}
            if binding["local_path"] else None
        )
        return row

    def create_api_wine(self, values: dict[str, Any]) -> dict[str, Any]:
        wine_values = self._api_wine_values(values)
        grapes = values.get("grapes") or []
        dishes = values.get("dishes") or []
        barcodes = values.get("barcodes") or []

        with self.connection.cursor() as cur:
            self._ensure_api_barcodes_available(cur, barcodes)
            try:
                cur.execute(
                    """
                    INSERT INTO svoe_vino.wines (
                        slug,
                        title,
                        category_name,
                        manufacturer_name,
                        manufacturer_slug,
                        region_name,
                        alcohol,
                        temperature,
                        color,
                        description,
                        public_rating,
                        image_url,
                        image_alt,
                        source,
                        external_id,
                        source_url,
                        source_updated_at,
                        updated_at
                    )
                    VALUES (
                        %(slug)s,
                        %(title)s,
                        %(category_name)s,
                        %(manufacturer_name)s,
                        %(manufacturer_slug)s,
                        %(region_name)s,
                        %(alcohol)s,
                        %(temperature)s,
                        %(color)s,
                        %(description)s,
                        %(public_rating)s,
                        %(image_url)s,
                        %(image_alt)s,
                        %(source)s,
                        %(external_id)s,
                        %(source_url)s,
                        %(source_updated_at)s,
                        now()
                    )
                    RETURNING id
                    """,
                    wine_values,
                )
            except errors.UniqueViolation as exc:
                raise WineConflictError("wine identity already exists") from exc
            wine_id = cur.fetchone()["id"]
            self._replace_api_grapes(cur, wine_id, grapes)
            self._replace_api_dishes(cur, wine_id, dishes)
            self._replace_api_barcodes(cur, wine_id, barcodes)
            row = self._fetch_api_wine_detail(cur, "w.id = %s", [wine_id])
        if row is None:  # pragma: no cover
            raise WineNotFoundError
        return row

    def update_api_wine(
        self,
        wine_id: int,
        values: dict[str, Any],
    ) -> dict[str, Any]:
        with self.connection.cursor() as cur:
            cur.execute("SELECT id FROM svoe_vino.wines WHERE id = %s", (wine_id,))
            if cur.fetchone() is None:
                raise WineNotFoundError

            scalar_values = {
                key: value
                for key, value in values.items()
                if key not in {"grapes", "dishes", "barcodes"}
            }
            if scalar_values:
                assignments = [f"{key} = %({key})s" for key in scalar_values]
                assignments.append("updated_at = now()")
                try:
                    cur.execute(
                        f"""
                        UPDATE svoe_vino.wines
                        SET {", ".join(assignments)}
                        WHERE id = %(id)s
                        """,
                        {**scalar_values, "id": wine_id},
                    )
                except errors.UniqueViolation as exc:
                    raise WineConflictError("wine identity already exists") from exc
            else:
                cur.execute(
                    "UPDATE svoe_vino.wines SET updated_at = now() WHERE id = %s",
                    (wine_id,),
                )

            if "grapes" in values:
                self._replace_api_grapes(cur, wine_id, values.get("grapes") or [])
            if "dishes" in values:
                self._replace_api_dishes(cur, wine_id, values.get("dishes") or [])
            if "barcodes" in values:
                barcodes = values.get("barcodes") or []
                self._ensure_api_barcodes_available(cur, barcodes, wine_id=wine_id)
                self._replace_api_barcodes(cur, wine_id, barcodes)

            row = self._fetch_api_wine_detail(cur, "w.id = %s", [wine_id])
        if row is None:  # pragma: no cover
            raise WineNotFoundError
        return row

    def delete_api_wine(self, wine_id: int) -> None:
        with self.connection.cursor() as cur:
            cur.execute("DELETE FROM svoe_vino.wines WHERE id = %s", (wine_id,))
            if cur.rowcount == 0:
                raise WineNotFoundError

    def _fetch_api_wine_detail(
        self,
        cur,
        predicate: str,
        params: Sequence[Any],
    ) -> dict[str, Any] | None:
        cur.execute(
            f"""
            SELECT
                w.id,
                w.slug,
                w.title,
                w.category_name,
                w.manufacturer_name,
                w.manufacturer_slug,
                w.region_name,
                w.alcohol,
                w.temperature,
                w.color,
                w.description,
                w.public_rating,
                w.image_url,
                w.image_alt,
                w.source,
                w.external_id,
                w.source_url,
                w.source_updated_at,
                w.created_at,
                w.updated_at,
                COALESCE(grapes.names, ARRAY[]::TEXT[]) AS grapes,
                COALESCE(dishes.names, ARRAY[]::TEXT[]) AS dishes,
                COALESCE(barcodes.values, ARRAY[]::TEXT[]) AS barcodes,
                COALESCE(images.items, '[]'::jsonb) AS images
            FROM contest.effective_wines w
            LEFT JOIN svoe_vino.wine_barcodes wb ON wb.wine_id = w.id
            LEFT JOIN LATERAL (
                SELECT array_agg(g.name ORDER BY g.name) AS names
                FROM svoe_vino.wine_grapes wg
                JOIN svoe_vino.grapes g ON g.id = wg.grape_id
                WHERE wg.wine_id = w.id
            ) grapes ON true
            LEFT JOIN LATERAL (
                SELECT array_agg(d.name ORDER BY d.name) AS names
                FROM svoe_vino.wine_dishes wd
                JOIN svoe_vino.dishes d ON d.id = wd.dish_id
                WHERE wd.wine_id = w.id
            ) dishes ON true
            LEFT JOIN LATERAL (
                SELECT array_agg(DISTINCT wb2.barcode ORDER BY wb2.barcode) AS values
                FROM svoe_vino.wine_barcodes wb2
                WHERE wb2.wine_id = w.id
            ) barcodes ON true
            LEFT JOIN LATERAL (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'id', wi.id,
                        'kind', wi.kind,
                        'url', wi.url,
                        'local_path', wi.local_path,
                        'download_status', wi.download_status,
                        'content_type', wi.content_type,
                        'size_bytes', wi.size_bytes
                    ) ORDER BY wi.id
                ) AS items
                FROM svoe_vino.wine_images wi
                WHERE wi.wine_id = w.id
            ) images ON true
            WHERE {predicate}
            ORDER BY w.id
            LIMIT 1
            """,
            params,
        )
        row = cur.fetchone()
        return dict(row) if row is not None else None

    def _replace_api_grapes(self, cur, wine_id: int, names: Sequence[str]) -> None:
        cur.execute("DELETE FROM svoe_vino.wine_grapes WHERE wine_id = %s", (wine_id,))
        for name in names:
            grape_id = self._upsert_grape(
                cur,
                {
                    "name": name,
                    "image_url": None,
                    "background_image_url": None,
                },
            )
            cur.execute(
                """
                INSERT INTO svoe_vino.wine_grapes (wine_id, grape_id)
                VALUES (%s, %s)
                ON CONFLICT DO NOTHING
                """,
                (wine_id, grape_id),
            )

    def _replace_api_dishes(self, cur, wine_id: int, names: Sequence[str]) -> None:
        cur.execute("DELETE FROM svoe_vino.wine_dishes WHERE wine_id = %s", (wine_id,))
        for name in names:
            dish_id = self._upsert_dish(cur, {"name": name, "image_url": None})
            cur.execute(
                """
                INSERT INTO svoe_vino.wine_dishes (wine_id, dish_id)
                VALUES (%s, %s)
                ON CONFLICT DO NOTHING
                """,
                (wine_id, dish_id),
            )

    def _replace_api_barcodes(
        self,
        cur,
        wine_id: int,
        barcodes: Sequence[str],
    ) -> None:
        cur.execute(
            "DELETE FROM svoe_vino.wine_barcodes WHERE wine_id = %s",
            (wine_id,),
        )
        for barcode in barcodes:
            cur.execute(
                """
                INSERT INTO svoe_vino.wine_barcodes (
                    wine_id,
                    barcode,
                    source,
                    confidence,
                    match_method,
                    is_primary,
                    updated_at
                )
                VALUES (%s, %s, 'manual', 1.0, 'api', false, now())
                """,
                (wine_id, barcode),
            )

    def _ensure_api_barcodes_available(
        self,
        cur,
        barcodes: Sequence[str],
        wine_id: int | None = None,
    ) -> None:
        if not barcodes:
            return
        params: list[Any] = [list(barcodes)]
        predicate = "barcode = ANY(%s)"
        if wine_id is not None:
            predicate += " AND wine_id <> %s"
            params.append(wine_id)
        cur.execute(
            f"SELECT 1 FROM svoe_vino.wine_barcodes WHERE {predicate} LIMIT 1",
            params,
        )
        if cur.fetchone() is not None:
            raise WineConflictError("barcode already exists")

    @staticmethod
    def _api_wine_values(values: dict[str, Any]) -> dict[str, Any]:
        return {
            "slug": values["slug"],
            "title": values["title"],
            "category_name": values.get("category_name"),
            "manufacturer_name": values.get("manufacturer_name"),
            "manufacturer_slug": values.get("manufacturer_slug"),
            "region_name": values.get("region_name"),
            "alcohol": values.get("alcohol"),
            "temperature": values.get("temperature"),
            "color": values.get("color"),
            "description": values.get("description"),
            "public_rating": values.get("public_rating"),
            "image_url": values.get("image_url"),
            "image_alt": values.get("image_alt"),
            "source": values.get("source") or "manual",
            "external_id": values.get("external_id"),
            "source_url": values.get("source_url"),
            "source_updated_at": values.get("source_updated_at"),
        }
    def _upsert_grape(self, cur, grape: dict[str, Any]) -> int:
        if self._has_column("svoe_vino.grapes", "image_url"):
            cur.execute(
                """
                INSERT INTO svoe_vino.grapes (name, image_url, background_image_url)
                VALUES (%(name)s, %(image_url)s, %(background_image_url)s)
                ON CONFLICT (name) DO UPDATE SET
                    image_url = EXCLUDED.image_url,
                    background_image_url = EXCLUDED.background_image_url
                RETURNING id
                """,
                grape,
            )
        else:
            cur.execute(
                """
                INSERT INTO svoe_vino.grapes (name)
                VALUES (%(name)s)
                ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
                RETURNING id
                """,
                grape,
            )
        return cur.fetchone()["id"]

    def _upsert_dish(self, cur, dish: dict[str, Any]) -> int:
        if self._has_column("svoe_vino.dishes", "image_url"):
            cur.execute(
                """
                INSERT INTO svoe_vino.dishes (name, image_url)
                VALUES (%(name)s, %(image_url)s)
                ON CONFLICT (name) DO UPDATE SET image_url = EXCLUDED.image_url
                RETURNING id
                """,
                dish,
            )
        else:
            cur.execute(
                """
                INSERT INTO svoe_vino.dishes (name)
                VALUES (%(name)s)
                ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
                RETURNING id
                """,
                dish,
            )
        return cur.fetchone()["id"]

    def _has_column(self, table_name: str, column_name: str) -> bool:
        schema_name, plain_table_name = self._split_table_name(table_name)
        key = (schema_name, plain_table_name, column_name)
        if key not in self._column_cache:
            with self.connection.cursor() as cur:
                cur.execute(
                    """
                    SELECT EXISTS (
                        SELECT 1
                        FROM information_schema.columns
                        WHERE table_schema = %s
                          AND table_name = %s
                          AND column_name = %s
                    ) AS exists
                    """,
                    (schema_name, plain_table_name, column_name),
                )
                self._column_cache[key] = cur.fetchone()["exists"]
        return self._column_cache[key]

    @staticmethod
    def _split_table_name(table_name: str) -> tuple[str, str]:
        if "." in table_name:
            schema_name, plain_table_name = table_name.split(".", 1)
            return schema_name, plain_table_name
        return "svoe_vino", table_name

    def _timestamp_column(self, table_name: str) -> str | None:
        if self._has_column(table_name, "fetched_at"):
            return "fetched_at"
        if self._has_column(table_name, "crawled_at"):
            return "crawled_at"
        return None

    @staticmethod
    def _fetch_count(cur, query: str) -> int:
        cur.execute(query)
        return cur.fetchone()["count"]

    @staticmethod
    def _fetch_status_counts(cur, query: str) -> dict[str, int]:
        cur.execute(query)
        return {row["status"]: row["count"] for row in cur.fetchall()}

    @staticmethod
    def _fetch_top_names(cur, query: str, limit: int) -> list[tuple[str, int]]:
        cur.execute(query, (limit,))
        return [(row["name"], row["count"]) for row in cur.fetchall()]

    @staticmethod
    def _list_wine_params(wine: dict[str, Any]) -> dict[str, Any]:
        return {
            "slug": wine["slug"],
            "title": wine["title"],
            "category_name": wine.get("category_name"),
            "manufacturer_name": wine.get("manufacturer_name"),
            "manufacturer_slug": wine.get("manufacturer_slug"),
            "region_name": wine.get("region_name"),
            "public_rating": wine.get("public_rating"),
            "color": wine.get("color"),
            "image_url": wine.get("image_url"),
            "image_alt": wine.get("image_alt"),
            "raw_list_json": json.dumps(
                wine.get("raw_list_json"),
                ensure_ascii=False,
            ),
        }

    @staticmethod
    def _detail_wine_params(wine: dict[str, Any]) -> dict[str, Any]:
        return {
            "slug": wine["slug"],
            "title": wine["title"],
            "category_name": wine.get("category_name"),
            "manufacturer_name": wine.get("manufacturer_name"),
            "manufacturer_slug": wine.get("manufacturer_slug"),
            "region_name": wine.get("region_name"),
            "alcohol": wine.get("alcohol"),
            "temperature": wine.get("temperature"),
            "color": wine.get("color"),
            "description": wine.get("description"),
            "public_rating": wine.get("public_rating"),
            "image_url": wine.get("image_url"),
            "image_alt": wine.get("image_alt"),
            "raw_detail_json": json.dumps(
                wine.get("raw_detail_json"),
                ensure_ascii=False,
            ),
        }


def extract_roskachestvo_product_list_fields(
    product: dict[str, Any],
) -> dict[str, Any]:
    product_id = _first_present_detail_value(
        product,
        'rskrf_product_id',
        'id',
        'product_id',
    )
    return {
        'rskrf_product_id': str(product_id).strip() if product_id is not None else '',
        'list_name': _text_or_none(
            _first_present_detail_value(product, 'list_name', 'name', 'title')
        ),
        'barcode': _text_or_none(product.get('barcode')),
        'list_rating': _first_present_detail_value(product, 'list_rating', 'rating'),
        'raw_list_json': product,
    }


def extract_roskachestvo_product_detail_fields(
    detail: dict[str, Any],
) -> dict[str, Any]:
    product_link = _first_present_detail_value(detail, "product_link", "link", "url")
    return {
        "title": _text_or_none(_first_present_detail_value(detail, "title", "name")),
        "total_rating": _first_present_detail_value(
            detail,
            "total_rating",
            "rating",
        ),
        "description": _text_or_none(detail.get("description")),
        "product_link": _text_or_none(product_link),
        "source_page_url": _text_or_none(product_link),
        "category_name": _text_or_none(detail.get("category_name")),
        "manufacturer": _text_or_none(detail.get("manufacturer")),
        "characteristics": _extract_roskachestvo_product_characteristics(detail),
    }


def _first_present_detail_value(detail: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = detail.get(key)
        if value not in (None, ""):
            return value
    return None


def _text_or_none(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        nested_value = _first_present_detail_value(value, "title", "name")
        return _text_or_none(nested_value)
    if isinstance(value, list):
        return None

    text = str(value).strip()
    return text or None


def _extract_roskachestvo_product_characteristics(detail: dict[str, Any]) -> Any:
    for key in ROSKACHESTVO_DETAIL_CHARACTERISTICS_KEYS:
        value = detail.get(key)
        if isinstance(value, dict | list):
            return value

    return {
        key: value
        for key, value in detail.items()
        if key not in ROSKACHESTVO_DETAIL_EXCLUDED_CHARACTERISTICS_KEYS
    }
