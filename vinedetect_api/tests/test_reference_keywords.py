"""Public reference read-model tests; never run OCR or touch a live catalog."""

from __future__ import annotations

import json

import pytest
from psycopg.types.json import Jsonb
from fastapi.testclient import TestClient

# The existing API config sets safe local test defaults before app import.
from tests.test_api import CONFIG

# isort: split -- CONFIG initializes the existing safe test environment.

from app.api.application import create_app
from app.api.dependencies import get_api_config_dependency, get_repository
from app.reference_keywords import (
    build_keywords,
    parse_token_import,
    refresh_reference_keywords,
)
from app.repositories import ReferenceKeywordsNotReadyError, WineRepository
from tests.test_catalog_read_model import FakeConnection
from tests.test_contest_import import db  # noqa: F401 -- empty DB rollback fixture


@pytest.mark.parametrize(
    ("title", "ocr", "expected"),
    [
        (
            "Fanagoria Cabernet Franc 2021",
            ["CABERNET", "franc", " Reserve ", "", "   ", "2021"],
            ["2021", "cabernet", "fanagoria", "franc", "reserve"],
        ),
        (
            "Фанагория Ёлка — MÉDOC ２０２１ 7",
            ["фанагория", "Елка", "médoc", "7"],
            ["2021", "7", "médoc", "елка", "фанагория"],
        ),
        ("Саперави 2020", [], ["2020", "саперави"]),
        (" ", ["", "\t", "..."], []),
    ],
)
def test_keywords_merge_title_and_saved_ocr(title, ocr, expected):
    assert build_keywords(title, ocr) == expected


def test_keyword_order_does_not_depend_on_ocr_input_order_or_duplicates():
    title = "Фанагория Cabernet 2021"
    first = build_keywords(title, ["FRANC", "2021", " Reserve", "cabernet"])
    assert first == build_keywords(
        title, ["cabernet", " Reserve", "2021", "FRANC", "FRANC"]
    )


def test_public_references_endpoint_returns_arrays_without_machine_details():
    class ReferenceRepository:
        calls = 0

        def list_recognition_references(self):
            self.calls += 1
            return [
                {"slug": "alpha", "keywords": ["2021", "cabernet"]},
                {"slug": "empty", "keywords": []},
            ]

    repo = ReferenceRepository()
    app = create_app(CONFIG)
    app.dependency_overrides[get_api_config_dependency] = lambda: CONFIG
    app.dependency_overrides[get_repository] = lambda: repo
    with TestClient(app) as client:
        response = client.get("/api/v1/recognition/references")
        assert response.status_code == 200
        assert response.json() == {
            "schemaVersion": "references/1",
            "items": [
                {"slug": "alpha", "keywords": ["2021", "cabernet"]},
                {"slug": "empty", "keywords": []},
            ],
        }
        assert client.post("/api/v1/recognition/references").status_code == 405
    assert repo.calls == 1


def test_repository_fetches_the_whole_read_model_with_one_query():
    rows = [
        {"slug": "alpha", "keywords": ["2021", "cabernet"]},
        {"slug": "beta", "keywords": []},
    ]
    connection = FakeConnection(results=[rows])
    assert WineRepository(connection=connection).list_recognition_references() == rows
    assert len(connection.executed) == 1
    query, _ = connection.executed[0]
    assert "order by" in query.lower()


def test_real_migrations_refresh_and_repository_are_deterministic(db):
    db.execute(
        """INSERT INTO svoe_vino.wines
           (slug, title, description, region_name, manufacturer_name)
           VALUES ('z-title-only', 'Мерло 2020', 'excluded description',
                   'excludedregion', 'excludedmaker'),
                  ('a-combined', 'Фанагория Cabernet 2021', 'also excluded',
                   'anotherregion', 'anothermaker')"""
    )
    wine_snapshot = db.execute("SELECT * FROM svoe_vino.wines ORDER BY id").fetchall()
    ocr = {"a-combined": ["CABERNET", "Franc", "2021", "", " "]}
    refresh_reference_keywords(db, imported_tokens=ocr)
    expected = [
        {
            "slug": "a-combined",
            "keywords": ["2021", "cabernet", "franc", "фанагория"],
        },
        {"slug": "z-title-only", "keywords": ["2020", "мерло"]},
    ]
    repo = WineRepository(connection=db)
    assert repo.list_recognition_references() == expected
    refresh_reference_keywords(db, imported_tokens=ocr)
    assert repo.list_recognition_references() == expected
    assert (
        db.execute("SELECT * FROM svoe_vino.wines ORDER BY id").fetchall()
        == wine_snapshot
    )

    app = create_app(CONFIG)
    app.dependency_overrides[get_api_config_dependency] = lambda: CONFIG
    app.dependency_overrides[get_repository] = lambda: repo
    with TestClient(app) as client:
        response = client.get("/api/v1/recognition/references")
    assert response.status_code == 200
    assert response.json() == {"schemaVersion": "references/1", "items": expected}



def test_refresh_reads_latest_completed_existing_ocr_with_exact_slug_binding(db):
    wine_id = db.execute(
        """INSERT INTO svoe_vino.wines (slug, title)
           VALUES ('stable-slug', 'Каберне 2021') RETURNING id"""
    ).fetchone()["id"]
    db.execute("CREATE SCHEMA meta")
    db.execute(
        """CREATE TABLE meta.ocr_runs (
            id BIGSERIAL PRIMARY KEY, source TEXT, source_item_id TEXT,
            status TEXT, normalized_text TEXT, raw_text TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )"""
    )
    for source, source_item_id, status, normalized, raw in [
        ("svoe_vino", "stable-slug", "completed", "obsolete", "ignoredraw"),
        ("svoe_vino", "stable-slug", "completed", "  ", "Cabernet FRANC"),
        ("svoe_vino", "stable-slug", "failed", "failednoise", "failednoise"),
        ("svoe_vino", str(wine_id), "completed", "numericidnoise", ""),
        ("roskachestvo", "stable-slug", "completed", "othersourcenoise", ""),
    ]:
        db.execute(
            """INSERT INTO meta.ocr_runs
               (source, source_item_id, status, normalized_text, raw_text)
               VALUES (%s, %s, %s, %s, %s)""",
            (source, source_item_id, status, normalized, raw),
        )
    asset_id = db.execute(
        """INSERT INTO svoe_vino.recognition_assets (wine_id, asset_type)
           VALUES (%s, 'reference') RETURNING id""", (wine_id,)
    ).fetchone()["id"]
    for status, data in [
        ("completed", {"tokens": ["obsoletefoundation"]}),
        ("completed", {"tokens": ["Reserve", "CABERNET", "2021"],
                       "description": "excludeddescription"}),
        ("failed", {"tokens": ["failedfoundation"]}),
    ]:
        db.execute(
            """INSERT INTO svoe_vino.ocr_observations
               (asset_id, engine, status, observation_data)
               VALUES (%s, 'saved-fixture', %s, %s)""",
            (asset_id, status, Jsonb(data)),
        )
    before = db.execute("SELECT * FROM meta.ocr_runs ORDER BY id").fetchall()
    refresh_reference_keywords(db)
    assert WineRepository(connection=db).list_recognition_references() == [{
        "slug": "stable-slug",
        "keywords": ["2021", "cabernet", "franc", "reserve", "каберне"],
    }]
    assert db.execute("SELECT * FROM meta.ocr_runs ORDER BY id").fetchall() == before


@pytest.mark.parametrize("state", ["missing", "stale"])
def test_api_rejects_incomplete_or_stale_read_model_without_silent_omission(db, state):
    db.execute(
        "INSERT INTO svoe_vino.wines (slug, title) VALUES ('wine', 'Wine 2021')"
    )
    if state == "stale":
        refresh_reference_keywords(db)
        db.execute("UPDATE svoe_vino.wines SET title = 'Wine 2022'")
    repo = WineRepository(connection=db)
    with pytest.raises(ReferenceKeywordsNotReadyError):
        repo.list_recognition_references()
    app = create_app(CONFIG)
    app.dependency_overrides[get_api_config_dependency] = lambda: CONFIG
    app.dependency_overrides[get_repository] = lambda: repo
    with TestClient(app) as client:
        response = client.get("/api/v1/recognition/references")
    assert response.status_code == 503
    assert "refresh" in response.json()["detail"].lower()


def test_import_rejects_unknown_slug_and_preserves_other_profile_versions(db):
    wine_id = db.execute(
        "INSERT INTO svoe_vino.wines (slug, title) VALUES ('wine', 'Wine 2021') "
        "RETURNING id"
    ).fetchone()["id"]
    db.execute(
        """INSERT INTO svoe_vino.recognition_profiles
           (wine_id, profile_version, schema_version, profile_data)
           VALUES (%s, 'unrelated/1', 'unrelated/1', '{"untouched":true}')""",
        (wine_id,),
    )
    unrelated = db.execute(
        "SELECT * FROM svoe_vino.recognition_profiles"
    ).fetchall()
    with pytest.raises(ValueError, match="Unknown wine slugs"):
        refresh_reference_keywords(db, imported_tokens={"missing": ["token"]})
    assert (
        db.execute("SELECT * FROM svoe_vino.recognition_profiles").fetchall()
        == unrelated
    )
    refresh_reference_keywords(db, imported_tokens={"wine": ["Saved"]})
    refresh_reference_keywords(db)
    assert WineRepository(connection=db).list_recognition_references() == [
        {"slug": "wine", "keywords": ["2021", "saved", "wine"]}
    ]
    assert db.execute(
        "SELECT * FROM svoe_vino.recognition_profiles "
        "WHERE profile_version = 'unrelated/1'"
    ).fetchall() == unrelated


@pytest.mark.parametrize("items", [
    [{"slug": "wine", "tokens": "not-an-array"}],
    [{"slug": "wine", "tokens": [123]}],
    [{"slug": " wine ", "tokens": []}],
    [{"slug": "wine", "tokens": []}, {"slug": "wine", "tokens": []}],
])
def test_saved_token_import_rejects_invalid_or_duplicate_rows(tmp_path, items):
    path = tmp_path / "reference-tokens.json"
    path.write_text(json.dumps({"schemaVersion": "reference-tokens/1", "items": items}))
    with pytest.raises(ValueError):
        parse_token_import(path)


def test_saved_token_import_preserves_original_text_for_normalizer(tmp_path):
    path = tmp_path / "reference-tokens.json"
    path.write_text(json.dumps({
        "schemaVersion": "reference-tokens/1",
        "items": [{"slug": "wine", "tokens": [" Ёлка ", "Cabernet", "2021"]}],
    }))
    assert parse_token_import(path) == {"wine": [" Ёлка ", "Cabernet", "2021"]}
