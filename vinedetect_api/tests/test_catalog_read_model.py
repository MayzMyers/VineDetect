from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest

from app.repositories import WineRepository

SVOE_VINO_ROW = {
    "source": "svoe_vino",
    "external_id": "svoe-1",
    "recognition_key": "svoe_vino:svoe-1",
    "local_id": 7,
    "title": "Svoe Wine",
    "manufacturer": "Svoe Winery",
    "category": "red dry",
    "region": "Crimea",
    "year": None,
    "rating": Decimal("4.1"),
    "barcode": None,
    "description": "Local catalog item",
    "source_url": "https://vino-svoe.example/svoe_vino.wines/svoe-1",
    "image": {
        "url": "https://vino-svoe.example/image.jpg",
        "local_path": "storage/svoe-1.jpg",
        "content_type": "image/jpeg",
        "size_bytes": 123,
    },
}

ROSKACHESTVO_ROW = {
    "source": "roskachestvo",
    "external_id": "rskrf-1",
    "recognition_key": "roskachestvo:rskrf-1",
    "local_id": 11,
    "title": "Roskachestvo Wine",
    "manufacturer": "RSK Winery",
    "category": "wine",
    "region": None,
    "year": None,
    "rating": Decimal("4.5"),
    "barcode": "4601234567890",
    "description": "Roskachestvo catalog item",
    "source_url": "https://rskrf.example/products/rskrf-1",
    "image": {
        "url": "https://rskrf.example/image.jpg",
        "local_path": "storage/rskrf-1.jpg",
        "content_type": "image/jpeg",
        "size_bytes": 456,
    },
}


class FakeCursor:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection
        self.result = connection.results.pop(0) if connection.results else []

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query: str, params: Any = None) -> None:
        self.connection.executed.append((query, params))

    def fetchall(self) -> list[dict[str, Any]]:
        return list(self.result)


class FakeConnection:
    def __init__(self, results: list[list[dict[str, Any]]] | None = None) -> None:
        self.results = list(results or [])
        self.executed: list[tuple[str, Any]] = []
        self.commits = 0

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def close(self) -> None:
        return None


def make_repo(
    results: list[list[dict[str, Any]]] | None = None,
) -> tuple[WineRepository, FakeConnection]:
    connection = FakeConnection(results=results)
    return WineRepository(connection=connection), connection


def compact(sql: str) -> str:
    return " ".join(sql.split())


def last_sql(connection: FakeConnection) -> str:
    return compact(connection.executed[-1][0])


def assert_read_only(sql: str) -> None:
    lowered = f" {sql.lower()} "
    assert " insert " not in lowered
    assert " update " not in lowered
    assert " delete " not in lowered


def test_search_svoe_vino_catalog_items_reads_wines_and_images() -> None:
    repo, connection = make_repo(results=[[SVOE_VINO_ROW]])

    result = repo.search_svoe_vino_catalog_items(limit=10, offset=2)

    sql = last_sql(connection)
    assert result == [SVOE_VINO_ROW]
    assert "FROM contest.effective_wines AS wine" in sql
    assert "LEFT JOIN LATERAL" in sql
    assert "FROM svoe_vino.wine_images" in sql
    assert "roskachestvo_wines" not in sql
    assert "roskachestvo.products" not in sql
    assert connection.executed[-1][1] == [10, 2]
    assert connection.commits == 0
    assert_read_only(sql)


def test_search_roskachestvo_catalog_items_reads_products() -> None:
    repo, connection = make_repo(results=[[ROSKACHESTVO_ROW]])

    result = repo.search_roskachestvo_catalog_items(limit=10, offset=2)

    sql = last_sql(connection)
    assert result == [ROSKACHESTVO_ROW]
    assert "FROM roskachestvo.products AS product" in sql
    assert "roskachestvo_wines" not in sql
    assert "FROM svoe_vino.wines" not in sql
    assert connection.executed[-1][1] == [10, 2]
    assert connection.commits == 0
    assert_read_only(sql)


def test_search_catalog_items_svoe_vino_source_uses_only_svoe_query() -> None:
    repo, connection = make_repo(results=[[SVOE_VINO_ROW]])

    result = repo.search_catalog_items(source="svoe_vino", limit=5, offset=0)

    sql = last_sql(connection)
    assert result == [SVOE_VINO_ROW]
    assert "FROM contest.effective_wines AS wine" in sql
    assert "roskachestvo.products" not in sql


def test_search_catalog_items_roskachestvo_source_uses_only_products_query() -> None:
    repo, connection = make_repo(results=[[ROSKACHESTVO_ROW]])

    result = repo.search_catalog_items(source="roskachestvo", limit=5, offset=0)

    sql = last_sql(connection)
    assert result == [ROSKACHESTVO_ROW]
    assert "FROM roskachestvo.products AS product" in sql
    assert "FROM svoe_vino.wines" not in sql


def test_search_catalog_items_all_uses_union_all() -> None:
    repo, connection = make_repo(results=[[
        SVOE_VINO_ROW,
        ROSKACHESTVO_ROW,
    ]])

    result = repo.search_catalog_items(source="all", limit=50, offset=0)

    sql = last_sql(connection)
    assert result == [SVOE_VINO_ROW, ROSKACHESTVO_ROW]
    assert "UNION ALL" in sql
    assert "FROM contest.effective_wines AS wine" in sql
    assert "FROM roskachestvo.products AS product" in sql
    assert "roskachestvo_wines" not in sql
    assert connection.executed[-1][1] == [50, 0]
    assert_read_only(sql)


def test_search_catalog_items_parameterizes_query() -> None:
    user_query = "Wine%' OR 1=1 --"
    repo, connection = make_repo(results=[[SVOE_VINO_ROW]])

    repo.search_svoe_vino_catalog_items(query=user_query, limit=250, offset=-10)

    sql, params = connection.executed[-1]
    assert user_query not in sql
    assert params[:-2] == [f"%{user_query}%"] * 6
    assert params[-2:] == [100, 0]


def test_search_catalog_items_output_shape_contains_stable_keys_and_image() -> None:
    row = dict(SVOE_VINO_ROW)
    row["image"] = None
    repo, _connection = make_repo(results=[[row]])

    result = repo.search_svoe_vino_catalog_items()

    item = result[0]
    assert item["source"] == "svoe_vino"
    assert item["external_id"] == "svoe-1"
    assert item["recognition_key"] == "svoe_vino:svoe-1"
    assert item["recognition_key"] != str(item["local_id"])
    assert item["image"] == {
        "url": None,
        "local_path": None,
        "content_type": None,
        "size_bytes": None,
    }


def test_search_roskachestvo_output_uses_provider_derived_key() -> None:
    repo, _connection = make_repo(results=[[ROSKACHESTVO_ROW]])

    result = repo.search_roskachestvo_catalog_items()

    item = result[0]
    assert item["source"] == "roskachestvo"
    assert item["external_id"] == "rskrf-1"
    assert item["recognition_key"] == "roskachestvo:rskrf-1"
    assert item["recognition_key"] != str(item["local_id"])
    assert item["image"]["local_path"] == "storage/rskrf-1.jpg"


def test_search_catalog_items_unknown_source_raises() -> None:
    repo, _connection = make_repo()

    with pytest.raises(ValueError, match="unknown catalog source"):
        repo.search_catalog_items(source="legacy")


def test_new_catalog_read_model_sql_does_not_use_legacy_table() -> None:
    repo, connection = make_repo(results=[[], [], []])

    repo.search_svoe_vino_catalog_items(query="wine")
    repo.search_roskachestvo_catalog_items(query="wine")
    repo.search_catalog_items(source="all", query="wine")

    for sql, _params in connection.executed:
        assert "roskachestvo_wines" not in sql
