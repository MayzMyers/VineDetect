from __future__ import annotations

import csv
import hashlib
import io
import json
import os
from pathlib import Path

import psycopg
import pytest
from psycopg.rows import dict_row

from app.contest_import import (
    FIELDS,
    ImportVersionConflict,
    import_catalog,
    main,
    parse_catalog,
)

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


def csv_bytes(*rows, headers=None):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(headers or FIELDS)
    for row in rows:
        writer.writerow(row)
    return stream.getvalue().encode("utf-8-sig")


def wine(slug="official", title="Official title"):
    return [
        slug,
        title,
        "Dry",
        "Red",
        "Kuban",
        "Merlot; Cabernet",
        "Description\nwith a second line",
        "Winery",
        "bottle.jpg",
    ]


def run_import(db, source=None, version="lct-test-v1", **kwargs):
    return import_catalog(
        db,
        source or csv_bytes(wine()),
        version=version,
        source_filename="official.csv",
        **kwargs,
    )


@pytest.fixture()
def db():
    """Apply real migrations transactionally only to an EMPTY dedicated test DB.

    Nothing is truncated. Closing the connection rolls back schema and test data.
    Use a separate URL so existing destructive repository fixtures cannot run here.
    """
    url = os.environ.get("CONTEST_TEST_DATABASE_URL")
    if not url:
        pytest.skip("CONTEST_TEST_DATABASE_URL is not set")
    conn = psycopg.connect(url, row_factory=dict_row)
    try:
        if not conn.info.dbname.endswith("_test"):
            raise RuntimeError("Contest database name must end with _test")
        objects = conn.execute(
            """SELECT nspname FROM pg_namespace
               WHERE nspname NOT IN ('public', 'information_schema')
                 AND nspname NOT LIKE 'pg_%'
               UNION ALL
               SELECT tablename FROM pg_tables WHERE schemaname = 'public'"""
        ).fetchall()
        if objects:
            raise RuntimeError("Contest migration tests require an empty database")
        for path in sorted(MIGRATIONS.glob("[0-9][0-9][0-9]_*.sql")):
            conn.execute(path.read_text(encoding="utf-8-sig"))
        yield conn
    finally:
        conn.rollback()
        conn.close()


def test_parser_preserves_duplicates_unknown_fields_and_whitespace():
    row = wine(title="  Вино, особое  ") + ["Unknown value  "]
    source = csv_bytes(row, row, headers=[*FIELDS, "organizer_extra"])
    parsed = parse_catalog(source)
    assert len(parsed.rows) == 2
    assert parsed.rows[0].raw == parsed.rows[1].raw
    assert parsed.rows[0].sha256 == parsed.rows[1].sha256
    assert parsed.rows[0].fields["title"] == "  Вино, особое  "
    assert parsed.rows[0].raw["organizer_extra"] == "Unknown value  "
    assert [row.number for row in parsed.rows] == [1, 2]
    assert [row.line_end for row in parsed.rows] == [3, 5]
    assert parsed.metadata["canonical_items"] == 1


def test_parser_reports_conflicts_and_does_not_normalize_slugs():
    parsed = parse_catalog(
        csv_bytes(wine("A"), wine("A", "Different"), wine("a"), wine(" A "))
    )
    assert parsed.metadata["conflicting_slugs"] == ["A"]
    assert parsed.metadata["canonical_items"] == 3


def test_explicit_column_map_and_dialect():
    source = csv_bytes(wine(), headers=["official_key", *FIELDS[1:]])
    parsed = parse_catalog(source, column_map={"slug": "official_key"})
    assert parsed.rows[0].raw["official_key"] == "official"
    assert parsed.config["column_map"]["slug"] == "official_key"
    semicolon = source.replace(b",", b"|")
    assert (
        parse_catalog(semicolon, delimiter="|", column_map={"slug": "official_key"})
        .rows[0]
        .fields["slug"]
    )


@pytest.mark.parametrize(
    "source",
    [
        b"",
        csv_bytes(),
        csv_bytes(wine()[:-1]),
        csv_bytes(wine(" ")),
        csv_bytes(wine(title="\t")),
        csv_bytes(wine(), headers=["slug"] * 9),
        csv_bytes(wine(), headers=[" ", *FIELDS[1:]]),
        csv_bytes(wine()).replace(b"Official title", b"bad\x00title"),
        csv_bytes(wine()) + b'"unterminated',
        csv_bytes(wine()) + b"\r\n",
    ],
)
def test_parser_rejects_invalid_records_instead_of_losing_data(source):
    with pytest.raises(ValueError):
        parse_catalog(source)


def test_dry_run_needs_no_database(tmp_path, monkeypatch, capsys):
    path = tmp_path / "official.csv"
    path.write_bytes(csv_bytes(wine(), wine()))
    monkeypatch.delenv("DATABASE_URL", raising=False)
    main([str(path), "--version", "v1", "--dry-run"])
    output = json.loads(capsys.readouterr().out)
    assert output["metadata"]["raw_rows"] == 2
    assert output["source_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()


def test_full_migration_chain_applies(db):
    names = db.execute(
        "SELECT tablename FROM pg_tables WHERE schemaname IN ('contest', 'contest_raw')"
    ).fetchall()
    assert {row["tablename"] for row in names} == {
        "import_runs",
        "catalog_rows",
        "catalog_items",
        "item_links",
        "reference_assets",
        "metadata_overrides",
    }
    assert db.execute("SELECT to_regclass('svoe_vino.wines') AS name").fetchone()[
        "name"
    ]


def test_lossless_raw_canonical_provenance_and_idempotency(db):
    source = csv_bytes(wine(), wine(), wine(title="Conflicting official title"))
    first = run_import(db, source)
    again = run_import(db, source)
    assert first.import_run_id == again.import_run_id
    assert again.reused and not first.reused
    assert (again.raw_rows, again.canonical_items) == (3, 1)
    run = db.execute("SELECT * FROM contest.import_runs").fetchone()
    assert bytes(run["source_bytes"]) == source
    assert run["source_sha256"] == hashlib.sha256(source).hexdigest()
    assert run["status"] == "completed" and run["completed_at"] is not None
    assert run["metadata"]["conflicting_slugs"] == ["official"]
    rows = db.execute(
        "SELECT * FROM contest_raw.catalog_rows ORDER BY source_row_number"
    ).fetchall()
    assert len(rows) == 3
    assert rows[0]["row_sha256"] == rows[1]["row_sha256"]
    assert rows[0]["raw_row"]["description"] == wine()[6]
    item = db.execute("SELECT * FROM contest.catalog_items").fetchone()
    assert item["source_row_number"] == 1 and item["title"] == "Official title"
    assert item["photo_name"] == "bottle.jpg"
    assert (
        db.execute("SELECT count(*) AS n FROM contest.item_links").fetchone()["n"] == 1
    )


def test_new_versions_and_version_collision(db):
    first = run_import(db)
    second = run_import(db, version="v2")
    assert first.import_run_id != second.import_run_id
    for options in (
        {"source": csv_bytes(wine(title="Changed"))},
        {"encoding": "utf-8"},
    ):
        # utf-8 without BOM handling fails parsing before a version can be changed.
        with pytest.raises(ValueError):
            run_import(db, **options)
    with pytest.raises(ImportVersionConflict):
        import_catalog(
            db, csv_bytes(wine()), version="lct-test-v1", source_filename="renamed.csv"
        )
    assert (
        db.execute("SELECT count(*) AS n FROM contest.catalog_items").fetchone()["n"]
        == 2
    )


def test_reslug_and_exact_links_preserve_historical_identity_and_assets(db):
    wine_id = db.execute(
        """INSERT INTO svoe_vino.wines (slug, title, source, external_id)
           VALUES ('old-slug', 'Historical title', 'vino-svoe', 'stable-key')
           RETURNING id"""
    ).fetchone()["id"]
    db.execute(
        """INSERT INTO svoe_vino.wine_images (wine_id, kind, url, local_path)
           VALUES (%s, 'bottle', 'https://example.test/old.jpg', 'history/old.jpg')""",
        (wine_id,),
    )
    before_wines = db.execute("SELECT * FROM svoe_vino.wines").fetchall()
    before_images = db.execute("SELECT * FROM svoe_vino.wine_images").fetchall()
    source = csv_bytes(wine("old-slug"), wine("new-official-slug"), wine("new-wine"))
    run_import(db, source)
    exact = db.execute(
        "SELECT * FROM contest.item_links WHERE method = 'exact_slug'"
    ).fetchone()
    assert exact["wine_id"] == wine_id and exact["confidence"] == 1
    item_id = db.execute(
        "SELECT id FROM contest.catalog_items WHERE official_slug = 'new-official-slug'"
    ).fetchone()["id"]
    # Explicit reviewed decision; no Phase 2 inference algorithm is involved.
    db.execute(
        """UPDATE contest.item_links SET wine_id = %s, method = 're_slug',
           confidence = 0.99,
           provenance = '{"reviewer":"fixture","evidence":"same wine"}'
           WHERE catalog_item_id = %s""",
        (wine_id, item_id),
    )
    db.execute(
        """INSERT INTO contest.reference_assets
           (catalog_item_id, original_filename, local_path, sha256,
            width, height, byte_size, mime_type)
           VALUES (%s, 'old.jpg', 'contest/v1/item/old.jpg', %s, 100, 200, 500,
                   'image/jpeg')""",
        (item_id, "a" * 64),
    )
    links = db.execute(
        "SELECT * FROM contest.item_links ORDER BY catalog_item_id"
    ).fetchall()
    assets = db.execute("SELECT * FROM contest.reference_assets").fetchall()
    assert run_import(db, source).reused
    assert (
        db.execute(
            "SELECT * FROM contest.item_links ORDER BY catalog_item_id"
        ).fetchall()
        == links
    )
    assert db.execute("SELECT * FROM contest.reference_assets").fetchall() == assets
    assert db.execute("SELECT * FROM svoe_vino.wines").fetchall() == before_wines
    assert db.execute("SELECT * FROM svoe_vino.wine_images").fetchall() == before_images
    assert (
        db.execute(
            "SELECT official_slug FROM contest.catalog_items WHERE id = %s", (item_id,)
        ).fetchone()["official_slug"]
        == "new-official-slug"
    )
    unmatched = db.execute(
        "SELECT * FROM contest.item_links WHERE wine_id IS NULL"
    ).fetchone()
    assert unmatched["method"] == "unmatched" and unmatched["confidence"] is None
    db.execute(
        """UPDATE contest.item_links SET method = 'new_official_item'
           WHERE catalog_item_id = %s""",
        (unmatched["catalog_item_id"],),
    )


def test_failure_rolls_back_partial_import_and_can_retry(db):
    db.execute("""
        CREATE FUNCTION contest.reject_link() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated failure'; END $$;
        CREATE TRIGGER reject_link BEFORE INSERT ON contest.item_links
        FOR EACH ROW EXECUTE FUNCTION contest.reject_link();
    """)
    with pytest.raises(psycopg.errors.RaiseException):
        run_import(db)
    for table in (
        "contest.import_runs",
        "contest_raw.catalog_rows",
        "contest.catalog_items",
    ):
        assert db.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"] == 0
    db.execute("DROP TRIGGER reject_link ON contest.item_links")
    assert not run_import(db).reused


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE contest.catalog_items SET official_slug = '   '",
        "UPDATE contest.catalog_items SET source_row_number = 99",
        "UPDATE contest.catalog_items SET import_run_id = 99999",
        "UPDATE contest.item_links SET method = 'manual'",
        "UPDATE contest.item_links SET wine_id = 99999, method = 'manual'",
        "UPDATE contest.item_links SET confidence = 1.1",
        "UPDATE contest_raw.catalog_rows SET row_sha256 = 'invalid'",
        "UPDATE contest.import_runs SET status = 'unknown'",
        "UPDATE contest.import_runs SET metadata = '[]'",
    ],
)
def test_database_rejects_invalid_provenance_and_links(db, statement):
    run_import(db)
    with pytest.raises(psycopg.IntegrityError), db.transaction():
        db.execute(statement)


def test_canonical_provenance_cannot_cross_versions_or_slugs(db):
    run_import(db, csv_bytes(wine("first"), wine("second")))
    other = run_import(db, csv_bytes(wine("other")), version="other")
    with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
        db.execute(
            "UPDATE contest.catalog_items SET source_row_number = 2 "
            "WHERE official_slug = 'first'"
        )
    with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
        db.execute(
            "UPDATE contest.catalog_items SET import_run_id = %s "
            "WHERE official_slug = 'first'",
            (other.import_run_id,),
        )


@pytest.mark.parametrize(
    "width,sha,mime",
    [
        (0, "a" * 64, "image/jpeg"),
        (1, "bad", "image/jpeg"),
        (1, "a" * 64, "text/plain"),
    ],
)
def test_asset_metadata_validity(db, width, sha, mime):
    run_import(db)
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute(
            """INSERT INTO contest.reference_assets
               (catalog_item_id, original_filename, local_path, sha256,
                width, height, byte_size, mime_type)
               SELECT id, 'bottle.jpg', 'contest/v1/bottle.jpg', %s, %s, 2, 3, %s
               FROM contest.catalog_items""",
            (sha, width, mime),
        )


def test_official_header_mapping_parser_and_cli(tmp_path, monkeypatch, capsys):
    column_map_path = (
        Path(__file__).resolve().parents[1] / "config/lct_rshb_2026_columns.json"
    )
    columns = json.loads(column_map_path.read_text(encoding="utf-8"))
    headers = [
        "Slug",
        "Название вина",
        "Категория",
        "Цвет",
        "Регион",
        "Сорт винограда",
        "Описание",
        "Винодельня",
        "Название фото",
    ]
    values = [
        "official-wine",
        "Вино особое",
        "Сухое",
        "Красное",
        "Кубань",
        "Мерло",
        "Описание вина",
        "Винодельня",
        "shared.jpg",
    ]
    source = csv_bytes(values, values, headers=headers)
    parsed = parse_catalog(source, column_map=columns)
    assert parsed.rows[0].fields == dict(zip(FIELDS, values, strict=True))
    assert parsed.rows[0].raw == dict(zip(headers, values, strict=True))

    path = tmp_path / "strapi_output0709.csv"
    path.write_bytes(source)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    main(
        [
            str(path),
            "--version",
            "lct-rshb-2026-v1",
            "--column-map",
            str(column_map_path),
            "--dry-run",
        ]
    )
    output = json.loads(capsys.readouterr().out)
    assert output["parser_config"]["column_map"] == columns
    assert output["source_sha256"] == hashlib.sha256(source).hexdigest()
    assert output["metadata"] == {
        "raw_rows": 2,
        "canonical_items": 1,
        "duplicate_slug_rows": 1,
        "conflicting_slugs": [],
    }


def test_reference_assets_allow_shared_path_and_sha_across_items(db):
    run_import(db, csv_bytes(wine("first"), wine("second")))
    shared_path = "contest/lct-rshb-2026-v1/shared.jpg"
    shared_sha = "b" * 64
    db.execute(
        """INSERT INTO contest.reference_assets
           (catalog_item_id, original_filename, local_path, sha256,
            width, height, byte_size, mime_type)
           SELECT id, 'shared.jpg', %s, %s, 100, 200, 500, 'image/jpeg'
           FROM contest.catalog_items""",
        (shared_path, shared_sha),
    )
    assets = db.execute("SELECT * FROM contest.reference_assets").fetchall()
    assert len(assets) == 2
    assert len({asset["catalog_item_id"] for asset in assets}) == 2
    assert {asset["local_path"] for asset in assets} == {shared_path}
    assert {asset["sha256"] for asset in assets} == {shared_sha}

    # The same item/path pair cannot be inserted again, even with other metadata.
    with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
        db.execute(
            """INSERT INTO contest.reference_assets
               (catalog_item_id, original_filename, local_path, sha256,
                width, height, byte_size, mime_type)
               VALUES (%s, 'renamed.jpg', %s, %s, 100, 200, 500, 'image/jpeg')""",
            (assets[0]["catalog_item_id"], shared_path, "c" * 64),
        )
