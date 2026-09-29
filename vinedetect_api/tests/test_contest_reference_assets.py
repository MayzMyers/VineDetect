from __future__ import annotations

import copy
import hashlib

import psycopg
import pytest
from PIL import Image

from app import contest_reference_assets as assets
from app.contest_reference_plan import INCONSISTENT_SLUG, RELATED_SLUG
from tests.test_contest_import import csv_bytes, run_import, wine
from tests.test_contest_import import db as db


@pytest.fixture
def data(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    rows = []
    # PNG bytes behind .jpg prove the stored extension follows the actual format.
    for index, color in enumerate(("red", "red", "blue")):
        name = f"image-{index}.jpg"
        path = source / name
        Image.new("RGB", (12, 18), color).save(path, format="PNG")
        rows.append(
            {
                "catalog_item_id": index + 1,
                "official_slug": f"wine-{index}",
                "photo_name": "bottle.jpg",
                "relative_path": name,
                "source_filename": name,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "width": 12,
                "height": 18,
                "bytes": path.stat().st_size,
                "mime_type": "image/png",
                "resolution_method": "normalized_unique",
                "review_note": None,
                "flags": [],
            }
        )
    plan = {
        "schema_version": "contest-reference-plan/1",
        "import_run": {"id": 1, "version": "lct-test-v1", "source_sha256": "0" * 64},
        "provenance": {"manifest_sha256": "1" * 64},
        "summary": {
            "catalog_items": 3,
            "selected_reference_assignments": 3,
            "unresolved": 0,
            "validation_failures": [],
            "unique_sha256_content": 2,
        },
        "assignments": rows,
        "source_data_inconsistencies": [],
    }
    return plan, source, tmp_path / "store"


def materialize(data):
    plan, source, store = data
    return assets.materialize(
        plan, source, store, expected_items=3, expected_contents=2
    )


def bind_catalog(db, data):
    plan, _, _ = data
    run_import(
        db, csv_bytes(*(wine(row["official_slug"]) for row in plan["assignments"]))
    )
    plan["import_run"] = db.execute(
        "SELECT id, version, source_sha256, status FROM contest.import_runs"
    ).fetchone()
    ids = {
        row["official_slug"]: row["id"]
        for row in db.execute(
            "SELECT id, official_slug FROM contest.catalog_items"
        ).fetchall()
    }
    for row in plan["assignments"]:
        row["catalog_item_id"] = ids[row["official_slug"]]
    materialize(data)


def write(db, data, dry_run=False):
    return assets.write_references(
        db, data[0], data[2], dry_run=dry_run, expected_items=3, expected_contents=2
    )


def reference_count(db):
    return db.execute("SELECT count(*) AS n FROM contest.reference_assets").fetchone()[
        "n"
    ]


def test_materialization_exact_bytes_content_addressing_dedup_and_replay(data):
    plan, source, store = data
    result = materialize(data)
    assert result["created_files"] == result["distinct_sha256"] == 2
    files = sorted(store.rglob("*.png"))
    assert len(files) == 2
    for row in plan["assignments"]:
        relative = assets.managed_path(plan["import_run"]["version"], row)
        assert relative.endswith(f"/{row['sha256']}.png")
        assert (store / relative).read_bytes() == (
            source / row["relative_path"]
        ).read_bytes()
    before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in files}
    again = materialize(data)
    assert again["created_files"] == 0 and again["reused_files"] == 2
    assert before == {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in files}
    assert not list(store.rglob(".contest-*"))


def test_destination_mismatch_never_overwrites(data):
    plan, _, store = data
    materialize(data)
    target = store / assets.managed_path(
        plan["import_run"]["version"], plan["assignments"][0]
    )
    Image.new("RGB", (12, 18), "green").save(target)
    wrong_bytes = target.read_bytes()
    with pytest.raises(ValueError, match="sha256 mismatch"):
        materialize(data)
    assert target.read_bytes() == wrong_bytes


def test_source_sha_mismatch_prevents_materialization(data):
    plan, source, store = data
    Image.new("RGB", (12, 18), "green").save(
        source / plan["assignments"][0]["relative_path"], format="PNG"
    )
    with pytest.raises(ValueError, match="sha256 mismatch"):
        materialize(data)
    assert not store.exists()


def test_copied_sha_is_verified_before_atomic_publication(data, monkeypatch):
    def corrupt_copy(source, destination, length):
        Image.new("RGB", (12, 18), "green").save(destination, format="PNG")

    monkeypatch.setattr(assets.shutil, "copyfileobj", corrupt_copy)
    with pytest.raises(ValueError, match="sha256 mismatch"):
        materialize(data)
    assert not list(data[2].rglob("*.png"))


def test_failed_publication_cleans_up_staging(data, monkeypatch):
    def fail_link(*args):
        raise OSError("injected publication failure")

    monkeypatch.setattr(assets.os, "link", fail_link)
    with pytest.raises(OSError, match="injected"):
        materialize(data)
    assert not list(data[2].rglob(".contest-*"))


def test_identical_concurrent_destination_is_verified_and_reused(data, monkeypatch):
    link = assets.os.link

    def concurrent_link(source, destination):
        link(source, destination)
        raise FileExistsError("concurrent winner")

    monkeypatch.setattr(assets.os, "link", concurrent_link)
    report = materialize(data)
    assert report["reused_files"] == 2 and report["created_files"] == 0


def test_duplicate_plan_assignment_and_missing_plan_item_fail(data):
    plan = copy.deepcopy(data[0])
    plan["assignments"][1]["catalog_item_id"] = plan["assignments"][0][
        "catalog_item_id"
    ]
    with pytest.raises(ValueError, match="duplicate catalog_item_id"):
        assets.validate_plan(plan, expected_items=3, expected_contents=2)
    plan = copy.deepcopy(data[0])
    plan["assignments"].pop()
    with pytest.raises(ValueError, match="exactly 3"):
        assets.validate_plan(plan, expected_items=3, expected_contents=2)


def test_schema_writer_replay_sharing_and_provenance(db, data):
    bind_catalog(db, data)
    plan = data[0]
    plan["assignments"][0].update(
        resolution_method="confirmed_visual",
        review_note="Human decision retained",
        review_confidence="high",
    )
    dry = write(db, data, dry_run=True)
    assert dry["intended_inserts"] == 3 and dry["inserted_rows"] == 0
    assert reference_count(db) == 0
    result = write(db, data)
    assert result["inserted_rows"] == 3 and result["distinct_sha256"] == 2
    rows = db.execute(
        "SELECT * FROM contest.reference_assets ORDER BY catalog_item_id"
    ).fetchall()
    assert rows[0]["local_path"] == rows[1]["local_path"]
    assert rows[0]["resolution_method"] == "confirmed_visual"
    assert rows[0]["review_note"] == "Human decision retained"
    assert rows[0]["provenance"]["review_confidence"] == "high"
    assert rows[0]["provenance"]["plan_sha256"] == assets.digest(plan)
    replay = write(db, data)
    assert replay["inserted_rows"] == 0 and replay["existing_identical_rows"] == 3
    assert (
        rows
        == db.execute(
            "SELECT * FROM contest.reference_assets ORDER BY catalog_item_id"
        ).fetchall()
    )


@pytest.mark.parametrize(
    "field,value", [("official_slug", "wrong-slug"), ("catalog_item_id", 999999)]
)
def test_catalog_correspondence_fails_before_any_write(db, data, field, value):
    bind_catalog(db, data)
    data[0]["assignments"][0][field] = value
    with pytest.raises(ValueError, match="Plan/catalog correspondence mismatch"):
        write(db, data)
    assert reference_count(db) == 0


def test_missing_managed_asset_fails_before_any_write(db, data):
    bind_catalog(db, data)
    plan, _, store = data
    (
        store
        / assets.managed_path(plan["import_run"]["version"], plan["assignments"][0])
    ).unlink()
    with pytest.raises(ValueError, match="Missing or non-regular"):
        write(db, data)
    assert reference_count(db) == 0


@pytest.mark.parametrize(
    "field,value",
    [("width", 13), ("height", 19), ("bytes", 1), ("mime_type", "image/webp")],
)
def test_asset_metadata_mismatch_before_any_write(db, data, field, value):
    bind_catalog(db, data)
    for row in data[0]["assignments"]:
        row[field] = value
    with pytest.raises(ValueError, match="mismatch|Missing"):
        write(db, data)
    assert reference_count(db) == 0


def test_transaction_failure_rolls_back_all_inserts(db, data):
    bind_catalog(db, data)
    last_id = data[0]["assignments"][-1]["catalog_item_id"]
    db.execute(
        f"""CREATE FUNCTION contest.fail_last_reference() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.catalog_item_id = {last_id} THEN
                RAISE EXCEPTION 'injected last reference failure';
            END IF;
            RETURN NEW; END $$;
            CREATE TRIGGER fail_last_reference BEFORE INSERT ON contest.reference_assets
            FOR EACH ROW EXECUTE FUNCTION contest.fail_last_reference();"""
    )
    with pytest.raises(psycopg.Error, match="injected last reference failure"):
        write(db, data)
    assert reference_count(db) == 0


def test_conflicting_existing_row_is_never_replaced(db, data):
    bind_catalog(db, data)
    write(db, data)
    db.execute(
        "UPDATE contest.reference_assets SET review_note = 'Existing review' "
        "WHERE catalog_item_id = %s",
        (data[0]["assignments"][0]["catalog_item_id"],),
    )
    before = db.execute("SELECT * FROM contest.reference_assets ORDER BY id").fetchall()
    with pytest.raises(ValueError, match="Conflicting existing reference"):
        write(db, data)
    assert (
        before
        == db.execute("SELECT * FROM contest.reference_assets ORDER BY id").fetchall()
    )


def test_known_source_inconsistency_persists(db, data):
    plan = data[0]
    plan["assignments"][0]["official_slug"] = RELATED_SLUG
    row = plan["assignments"][1]
    row.update(
        official_slug=INCONSISTENT_SLUG,
        resolution_method="source_preserving_shared",
        review_note="Organizer image conflicts with title; preserve source",
        flags=["organizer_photo_title_inconsistency"],
    )
    plan["source_data_inconsistencies"] = [
        {
            "official_slug": INCONSISTENT_SLUG,
            "related_official_slug": RELATED_SLUG,
            "reason": "Organizer title and photo disagree",
        }
    ]
    bind_catalog(db, data)
    write(db, data)
    actual = db.execute(
        "SELECT * FROM contest.reference_assets WHERE catalog_item_id = %s",
        (row["catalog_item_id"],),
    ).fetchone()
    assert actual["resolution_method"] == "source_preserving_shared"
    assert actual["provenance"]["flags"] == row["flags"]
    assert (
        actual["provenance"]["source_data_inconsistencies"]
        == plan["source_data_inconsistencies"]
    )
    assert actual["review_note"] == row["review_note"]


def test_dry_run_without_014_reports_required_migration(db, data):
    bind_catalog(db, data)
    # Simulate the untouched pre-014 local schema in this isolated transaction.
    db.execute(
        "ALTER TABLE contest.reference_assets "
        "DROP COLUMN resolution_method CASCADE, DROP COLUMN provenance CASCADE, "
        "DROP COLUMN review_note CASCADE"
    )
    result = write(db, data, dry_run=True)
    assert result["intended_inserts"] == 3 and result["ready_for_import"] is False
    assert result["required_migrations"] == ["014_contest_reference_provenance.sql"]
    assert reference_count(db) == 0
    with pytest.raises(ValueError, match="Migration 014 is required"):
        write(db, data)


@pytest.mark.parametrize(
    "expression",
    [
        "resolution_method = ''",
        "review_note = ' '",
        "provenance = '[]'::jsonb",
        "provenance = '{}'::jsonb",
        "local_path = '/home/staging/image.png'",
    ],
)
def test_provenance_constraints(db, data, expression):
    bind_catalog(db, data)
    write(db, data)
    with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
        db.execute(f"UPDATE contest.reference_assets SET {expression}")


@pytest.mark.parametrize("location", ["plan", "source", "store"])
def test_cli_report_cannot_overwrite_inputs_or_asset_files(data, tmp_path, location):
    plan, source, store = data
    plan_path = tmp_path / "plan.json"
    plan_path.write_bytes(assets.json_bytes(plan))
    report = {
        "plan": plan_path,
        "source": source / plan["assignments"][0]["relative_path"],
        "store": store / "report.json",
    }[location]
    before = plan_path.read_bytes()
    with pytest.raises(SystemExit):
        assets.main(
            [
                "materialize",
                "--plan-json",
                str(plan_path),
                "--source-root",
                str(source),
                "--asset-root",
                str(store),
                "--report-json",
                str(report),
            ]
        )
    assert plan_path.read_bytes() == before
    assert not store.exists()
