from __future__ import annotations

import copy
from pathlib import Path

import pytest

from app import contest_metadata_overrides as overrides
from app.contest_identity_state import read_rows
from app.repositories import WineRepository
from tests.test_contest_import import csv_bytes, run_import
from tests.test_contest_import import db as db


HISTORICAL_MANIFEST = Path(__file__).parent / "fixtures/dq2_superseded/metadata-2079.json"


def historical_manifest():
    """Explicit historical fixture; never the active organizer-truth input."""
    return overrides.load_manifest(HISTORICAL_MANIFEST)


@pytest.fixture
def source(db):
    manifest = historical_manifest()
    entry = manifest["entries"][0]
    db.execute("ALTER SEQUENCE contest.catalog_items_id_seq RESTART WITH 2079")
    db.execute(
        """INSERT INTO svoe_vino.wines
                  (id,slug,title,category_name,color,alcohol,source,external_id)
                  VALUES(328,%s,%s,%s,%s,10.5,'vino-svoe',%s),
                  (329,'control','Control','Розовое','Розовый',12,'vino-svoe','control')""",
        (
            entry["official_slug"],
            entry["expected_catalog"]["title"],
            entry["expected_wine"]["category_name"],
            entry["expected_wine"]["color"],
            entry["official_slug"],
        ),
    )
    expected = entry["expected_catalog"]
    row = [
        entry["official_slug"],
        expected["title"],
        expected["category"],
        expected["color"],
        "Дагестан",
        expected["grapes"],
        "светлый соломенно-золотистый оттенок",
        expected["winery"],
        "bottle.webp",
    ]
    control = [
        "control",
        "Control",
        "Розовое",
        "Розовый",
        "Region",
        "Grape",
        "Description",
        "Winery",
        "control.webp",
    ]
    run_import(db, csv_bytes(row, control), version=manifest["contest_version"])
    db.execute("""INSERT INTO contest.reference_assets
                  (catalog_item_id,original_filename,local_path,sha256,width,height,byte_size,mime_type)
                  SELECT id,photo_name,'contest/'||photo_name,
                  repeat('a',64),1,1,1,'image/webp'
                  FROM contest.catalog_items""")
    db.execute(
        "INSERT INTO svoe_vino.wine_images(wine_id,kind,url) VALUES(328,'bottle','https://example.invalid/image')"
    )
    return manifest


def test_canonical_human_review_is_exact():
    entry = historical_manifest()["entries"][0]
    assert entry["catalog_item_id"] == 2079 and entry["wine_id"] == 328
    assert entry["replacement"] == {"category": "Белое", "color": "Светло-лимонный"}
    assert entry["expected_catalog"]["category"] == "Розовое"
    assert entry["provenance"]["reason"] == "upstream_source_inconsistency"
    assert entry["provenance"]["verification"] == "human_verified_against_producer"


def test_dry_apply_replay_raw_preservation_and_api_metadata(db, source):
    before = overrides.protected_state(db)
    old_catalog = read_rows(db, "contest.effective_catalog_items")
    old_wines = read_rows(db, "contest.effective_wines")
    dry = overrides.write_overrides(db, source, dry_run=True, expected_count=2)
    assert dry == overrides.write_overrides(db, source, dry_run=True, expected_count=2)
    assert dry["would_insert"] == 1 and dry["inserted"] == 0
    assert overrides.protected_state(db) == before
    assert read_rows(db, "contest.metadata_overrides") == []
    result = overrides.write_overrides(
        db,
        source,
        dry_run=False,
        expected_count=2,
        expected_plan_sha256=dry["plan_sha256"],
    )
    assert result["inserted"] == 1 and result["changed_catalog_item_ids"] == [2079]
    assert overrides.protected_state(db) == before
    new_catalog = {r["id"]: r for r in read_rows(db, "contest.effective_catalog_items")}
    new_wines = {r["id"]: r for r in read_rows(db, "contest.effective_wines")}
    for row in old_catalog:
        expected = (
            {**row, **source["entries"][0]["replacement"]} if row["id"] == 2079 else row
        )
        assert new_catalog[row["id"]] == expected
    for row in old_wines:
        expected = (
            {**row, "category_name": "Белое", "color": "Светло-лимонный"}
            if row["id"] == 328
            else row
        )
        assert new_wines[row["id"]] == expected
    repository = WineRepository(connection=db)
    detail = repository.get_api_wine(328)
    assert (detail["category_name"], detail["color"]) == ("Белое", "Светло-лимонный")
    assert str(detail["alcohol"]) == "10.5"
    rows, count = repository.list_api_wines(category="Белое")
    assert count == 1 and [r["id"] for r in rows] == [328]
    rows, count = repository.list_api_wines(category="Розовое")
    assert count == 1 and [r["id"] for r in rows] == [329]
    after = read_rows(db, "contest.metadata_overrides")
    replay = overrides.write_overrides(
        db,
        source,
        dry_run=False,
        expected_count=2,
        expected_plan_sha256=dry["plan_sha256"],
    )
    assert replay["inserted"] == 0 and replay["already_applied"] == 1
    assert replay["changed_catalog_item_ids"] == []
    assert read_rows(db, "contest.metadata_overrides") == after
    assert overrides.protected_state(db) == before


def test_bootstrap_is_dry_then_transactional_and_replayable(db, source):
    db.execute(
        "DROP VIEW contest.effective_wines,contest.effective_catalog_items,"
        "contest.active_metadata_overrides"
    )
    db.execute("DROP TABLE contest.metadata_overrides")
    dry = overrides.write_overrides(db, source, dry_run=True, expected_count=2)
    assert not overrides.has_layer(db)
    with pytest.raises(ValueError, match="plan SHA"):
        overrides.write_overrides(
            db, source, dry_run=False, expected_count=2, expected_plan_sha256="0" * 64
        )
    assert not overrides.has_layer(db)
    overrides.write_overrides(
        db,
        source,
        dry_run=False,
        expected_count=2,
        expected_plan_sha256=dry["plan_sha256"],
    )
    assert overrides.has_layer(db)
    replay = overrides.write_overrides(
        db,
        source,
        dry_run=False,
        expected_count=2,
        expected_plan_sha256=dry["plan_sha256"],
    )
    assert replay["already_applied"] == 1


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE contest.catalog_items SET category='changed' WHERE id=2079",
        "UPDATE contest.item_links SET wine_id=329 WHERE catalog_item_id=2079",
        "UPDATE svoe_vino.wines SET color='changed' WHERE id=328",
        "UPDATE contest.item_links SET wine_id=328 WHERE catalog_item_id=2080",
    ],
)
def test_stale_source_or_shared_identity_rejected_without_writes(db, source, statement):
    db.execute(statement)
    before = overrides.protected_state(db)
    with pytest.raises(ValueError, match="source/identity"):
        overrides.write_overrides(db, source, dry_run=True, expected_count=2)
    assert overrides.protected_state(db) == before
    assert read_rows(db, "contest.metadata_overrides") == []


def test_conflicting_existing_override_rejected(db, source):
    dry = overrides.write_overrides(db, source, dry_run=True, expected_count=2)
    overrides.write_overrides(
        db,
        source,
        dry_run=False,
        expected_count=2,
        expected_plan_sha256=dry["plan_sha256"],
    )
    db.execute("UPDATE contest.metadata_overrides SET provenance='{}'")
    with pytest.raises(ValueError, match="Conflicting applied"):
        overrides.write_overrides(db, source, dry_run=True, expected_count=2)


@pytest.mark.parametrize("field", ["title", "grapes", "alcohol", "official_slug"])
def test_unapproved_field_corrections_rejected(field):
    manifest = copy.deepcopy(historical_manifest())
    manifest["entries"][0]["replacement"][field] = "invented"
    with pytest.raises(ValueError, match="replacement"):
        overrides.validate_manifest(manifest)


def test_current_metadata_manifest_has_no_active_repairs():
    assert overrides.load_manifest()["entries"] == []
    assert overrides.records(overrides.load_manifest()) == []


def test_empty_metadata_manifest_is_a_noop(db, source):
    before = overrides.protected_state(db)
    current = overrides.load_manifest()
    dry = overrides.write_overrides(db, current, dry_run=True, expected_count=2)
    applied = overrides.write_overrides(db, current, dry_run=False, expected_count=2, expected_plan_sha256=dry["plan_sha256"])
    assert applied["inserted"] == 0
    assert overrides.protected_state(db) == before
    assert read_rows(db, "contest.metadata_overrides") == []
