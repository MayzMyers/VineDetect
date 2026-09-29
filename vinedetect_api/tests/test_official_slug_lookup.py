"""Exact organizer-slug card lookup, without fuzzy matching or recognition."""

from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from tests.test_api import CONFIG

from app.api.application import create_app
from app.api.dependencies import get_api_config_dependency, get_repository
from app.repositories import WineConflictError, WineNotFoundError, WineRepository


class Cursor:
    def __init__(self, connection):
        self.connection = connection
        self.rows = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def execute(self, query, params):
        self.connection.executed.append((query, params))
        self.rows = self.connection.results.pop(0)

    def fetchall(self):
        return deepcopy(self.rows)

    def fetchone(self):
        return deepcopy(self.rows[0]) if self.rows else None


class Connection:
    def __init__(self, *results):
        self.results = list(results)
        self.executed = []

    def cursor(self):
        return Cursor(self)


def binding(wine_id=7):
    return {
        "wine_id": wine_id,
        "local_path": "contest/frozen/sha256/aa/reference.png",
        "content_type": "image/png",
        "size_bytes": 123,
    }


def wine():
    return {"id": 7, "slug": "different-local-slug", "title": "Saved wine card"}


def make_client(connection):
    app = create_app(CONFIG)
    repo = WineRepository(connection=connection)
    app.dependency_overrides[get_api_config_dependency] = lambda: CONFIG
    app.dependency_overrides[get_repository] = lambda: repo
    return TestClient(app)


def test_repository_uses_only_parameterized_exact_official_binding():
    submitted = "official%' OR 1=1 --"
    connection = Connection([binding()], [wine()])
    result = WineRepository(connection=connection).get_api_wine_by_official_slug(submitted)
    assert result["official_slug"] == submitted
    assert result["slug"] == "different-local-slug"
    assert result["official_reference"]["local_path"] == binding()["local_path"]
    query, params = connection.executed[0]
    assert "item.official_slug = %s" in query
    assert "run.status = 'completed'" in query
    assert "contest.item_links" in query
    assert submitted not in query
    assert params == [submitted]
    assert connection.executed[1][1] == [7]
    assert "w.id = %s" in connection.executed[1][0]
    for query, _ in connection.executed:
        assert "ILIKE" not in query
        assert not any(word in query.upper().split() for word in ("INSERT", "UPDATE", "DELETE"))


@pytest.mark.parametrize("rows", [[], [binding(None)]])
def test_repository_rejects_unknown_or_unlinked_slug_without_fallback(rows):
    connection = Connection(rows)
    with pytest.raises(WineNotFoundError):
        WineRepository(connection=connection).get_api_wine_by_official_slug("unknown")
    assert len(connection.executed) == 1


def test_repository_rejects_ambiguous_saved_binding():
    connection = Connection([binding(7), binding(8)])
    with pytest.raises(WineConflictError):
        WineRepository(connection=connection).get_api_wine_by_official_slug("ambiguous")
    assert len(connection.executed) == 1


def test_public_endpoint_preserves_official_and_local_identity_and_reference():
    connection = Connection([binding()], [wine()])
    with make_client(connection) as client:
        response = client.get("/api/v1/wines/by-official-slug/official-slug")
    assert response.status_code == 200
    data = response.json()
    assert data["official_slug"] == "official-slug"
    assert data["slug"] == "different-local-slug"
    assert data["id"] == 7
    assert data["title"] == "Saved wine card"
    assert data["official_reference"]["url"] == (
        "http://127.0.0.1:8000/static/images/contest/frozen/sha256/aa/reference.png"
    )
    assert data["official_reference"]["content_type"] == "image/png"
    assert connection.executed[0][1] == ["official-slug"]


@pytest.mark.parametrize("slug", ["UNKNOWN", "known-but-not-exact", "slug%25"])
def test_public_endpoint_missing_slug_is_404_without_search(slug):
    connection = Connection([])
    with make_client(connection) as client:
        response = client.get("/api/v1/wines/by-official-slug/" + slug)
    assert response.status_code == 404
    assert len(connection.executed) == 1


def test_public_endpoint_ambiguous_binding_is_409():
    connection = Connection([binding(7), binding(8)])
    with make_client(connection) as client:
        response = client.get("/api/v1/wines/by-official-slug/ambiguous")
    assert response.status_code == 409
