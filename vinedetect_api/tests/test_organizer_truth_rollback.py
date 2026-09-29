"""Compensating rollback tests on an isolated, transactionally rolled-back DB."""
from pathlib import Path

import pytest

from app import contest_metadata_overrides as overrides
from app.contest_identity_state import read_rows
from tests.test_contest_import import db as db
from tests.test_contest_metadata_overrides import source as source

MIGRATION = Path(__file__).resolve().parents[1] / "migrations/017_organizer_truth_remove_2079_override.sql"


def apply_historical(db, manifest):
    dry = overrides.write_overrides(db, manifest, dry_run=True, expected_count=2)
    overrides.write_overrides(db, manifest, dry_run=False, expected_count=2,
                              expected_plan_sha256=dry["plan_sha256"])


def test_compensation_removes_only_2079_and_preserves_raw_api_metadata(db, source):
    apply_historical(db, source)
    # Unrelated valid overlay proves the migration does not truncate the layer.
    control = db.execute("SELECT id FROM contest.catalog_items WHERE official_slug='control'").fetchone()["id"]
    db.execute("""INSERT INTO contest.metadata_overrides
      (catalog_item_id,contest_version,official_slug,wine_id,expected_catalog,
       expected_wine,replacement,provenance,manifest_sha256)
      VALUES (%s,'lct-rshb-2026-09-15','control',329,'{}','{}',
              '{"category":"Control category","color":"Control color"}','{}',repeat('a',64))""", (control,))
    before = overrides.protected_state(db)
    other = db.execute("SELECT * FROM contest.metadata_overrides WHERE catalog_item_id=%s", (control,)).fetchone()
    db.execute(MIGRATION.read_text(encoding="utf-8-sig"))
    assert overrides.protected_state(db) == before
    assert db.execute("SELECT * FROM contest.metadata_overrides WHERE catalog_item_id=2079").fetchone() is None
    assert db.execute("SELECT * FROM contest.metadata_overrides WHERE catalog_item_id=%s", (control,)).fetchone() == other
    assert db.execute("SELECT category,color FROM contest.effective_catalog_items WHERE id=2079").fetchone() == {
        "category": "Розовое", "color": "Нежно-розовый"}
    assert db.execute("SELECT category_name,color FROM contest.effective_wines WHERE id=328").fetchone() == {
        "category_name": "Розовое брют", "color": "Нежно-розовый"}
    after = read_rows(db, "contest.metadata_overrides")
    db.execute(MIGRATION.read_text(encoding="utf-8-sig"))
    assert read_rows(db, "contest.metadata_overrides") == after


def test_compensation_rejects_drift_without_deleting_overlay(db, source):
    apply_historical(db, source)
    db.execute("""UPDATE contest.metadata_overrides SET replacement =
                  '{"category":"Unexpected","color":"Unexpected"}' WHERE catalog_item_id=2079""")
    before = read_rows(db, "contest.metadata_overrides")
    with pytest.raises(Exception, match="STOP"):
        with db.transaction():
            db.execute(MIGRATION.read_text(encoding="utf-8-sig"))
    assert read_rows(db, "contest.metadata_overrides") == before

