from __future__ import annotations

import copy
from pathlib import Path

import pytest
from psycopg.types.json import Jsonb

from app import contest_identity_corrections as correction
from app.contest_identity_state import capture, digest, fingerprint
from tests.test_contest_import import db as db


HISTORICAL_MANIFEST = Path(__file__).parent / "fixtures/dq2_superseded/identity-603.json"


def historical_manifest():
    """Explicit historical fixture; never the active organizer-truth input."""
    return correction.load_manifest(HISTORICAL_MANIFEST)


@pytest.fixture
def source(db):
    decision = historical_manifest()
    db.execute("""INSERT INTO svoe_vino.wines(id,slug,title,external_id,source)
        SELECT n,'historical-'||n,'Historical '||n,'historical-'||n,'vino-svoe'
        FROM generate_series(1,2114) n""")
    db.execute(
        "UPDATE svoe_vino.wines SET slug=%s,external_id=%s,alcohol=12.7 WHERE id=791",
        (decision["control"]["official_slug"], decision["control"]["official_slug"]),
    )
    db.execute("ALTER SEQUENCE svoe_vino.wines_id_seq RESTART WITH 3981")
    db.execute("""INSERT INTO svoe_vino.wine_images(id,wine_id,kind,url)
        SELECT n,n,'bottle','https://example.invalid/'||n||'.jpg'
        FROM generate_series(1,1866) n""")
    db.execute("INSERT INTO svoe_vino.grapes(id,name) VALUES (1,'Сильванер')")
    db.execute("""INSERT INTO contest.import_runs
        (id,version,source_filename,source_sha256,source_bytes,parser_config,status,completed_at)
        VALUES(1,'lct-rshb-2026-09-15','official.csv',repeat('a',64),'fixture','{}','completed',now())""")
    db.execute(
        """INSERT INTO contest_raw.catalog_rows
        (import_run_id,source_row_number,source_line_end,official_slug,raw_row,row_sha256)
        SELECT 1,n,n+1,CASE n WHEN 603 THEN %s WHEN 605 THEN %s ELSE 'official-'||n END,
        '{}',repeat('a',64) FROM generate_series(1,2103) n""",
        (decision["official_slug"], decision["control"]["official_slug"]),
    )
    db.execute(
        """INSERT INTO contest.catalog_items
        (id,import_run_id,source_row_number,official_slug,title,category,color,
         region,grapes,description,winery,photo_name)
        SELECT source_row_number,1,source_row_number,official_slug,
        CASE source_row_number WHEN 603 THEN %s ELSE official_slug END,
        'Белое','Светло-соломенный','Крым','Сильванер',
        'Official description','Vibes','source.webp'
        FROM contest_raw.catalog_rows""",
        (decision["expected_catalog"]["title"],),
    )
    db.execute("""INSERT INTO contest.reference_assets
        (catalog_item_id,original_filename,local_path,sha256,width,height,byte_size,mime_type)
        SELECT id,'ref-'||id||'.jpg','references/'||id||'.jpg',
        repeat('a',64),1,1,10,'image/jpeg'
        FROM contest.catalog_items""")
    db.execute("""INSERT INTO contest.item_links
        (catalog_item_id,wine_id,method,provenance)
        SELECT id,CASE WHEN id IN (603,605) THEN 791 ELSE id END,
        CASE WHEN id=603 OR id BETWEEN 1841 AND 1855 THEN 're_slug'
             WHEN id>=1856 THEN 'materialized_official' ELSE 'exact_slug' END,
        '{"fixture":"previous evidence"}'
        FROM contest.catalog_items""")
    db.execute("CREATE SCHEMA meta")
    db.execute("CREATE TABLE meta.correction_test (id integer, value text)")
    db.execute("INSERT INTO meta.correction_test VALUES (1,'preserve')")
    state = capture(db)
    return decision, state, correction.build_plan(decision, state)


def test_reviewed_canonical_identity_correction():
    decision = historical_manifest()
    assert decision["catalog_item_id"] == 603
    assert decision["expected_link"] == {"wine_id": 791, "method": "re_slug"}
    assert decision["control"]["catalog_item_id"] == 605
    assert decision["status"] == "materialization_confirmed"


def test_dry_run_apply_replay_preserves_all_other_data(db, source):
    decision, before, plan = source
    assert plan == correction.build_plan(decision, before)
    dry = correction.write_correction(db, plan, dry_run=True)
    assert dry["would_insert_wines"] == dry["would_update_links"] == 1
    assert capture(db) == before
    assert "alcohol" not in plan["new_wine"]
    result = correction.write_correction(db, plan)
    assert result["inserted_wines"] == result["updated_links"] == 1
    after = capture(db)
    new = next(w for w in after["wines"] if w["id"] == 3981)
    assert new["alcohol"] is None
    assert new["source"] == "vino-svoe"
    assert new["slug"] == new["external_id"] == decision["official_slug"]
    assert new["title"] == decision["expected_catalog"]["title"]
    for field in (
        "category_name",
        "manufacturer_name",
        "region_name",
        "color",
        "description",
    ):
        assert new[field] == plan["new_wine"][field]
    assert new["raw_detail_json"]["organizer_catalog"]["grapes"] == "Сильванер"
    assert len(after["wines"]) == len(before["wines"]) + 1
    assert fingerprint([w for w in after["wines"] if w["id"] != 3981]) == fingerprint(
        before["wines"]
    )
    old_links = {r["catalog_item_id"]: r for r in before["item_links"]}
    new_links = {r["catalog_item_id"]: r for r in after["item_links"]}
    assert [key for key in old_links if old_links[key] != new_links[key]] == [603]
    assert new_links[603]["wine_id"] == 3981
    assert new_links[603]["method"] == "materialized_official"
    assert new_links[603]["provenance"]["previous_link"] == old_links[603]
    assert new_links[605] == old_links[605]
    assert new_links[605]["wine_id"] == 791
    assert new_links[605]["method"] == "exact_slug"
    for key in (
        "catalog_items",
        "reference_assets",
        "wine_images",
        "grapes",
        "meta",
        "schema",
    ):
        assert after[key] == before[key]
    assert len(after["item_links"]) == len(after["reference_assets"]) == 2103
    assert all(r["wine_id"] is not None for r in after["item_links"])
    assert {"wine_id": 3981, "grape_id": 1} in after["wine_grape_relations"]
    replay = correction.write_correction(db, plan)
    assert replay["already_applied"]
    assert replay["inserted_wines"] == replay["updated_links"] == 0
    assert capture(db) == after


@pytest.mark.parametrize(
    "mutation", ["control", "reference", "historical", "sequence", "link"]
)
def test_stale_state_fails_without_partial_writes(db, source, mutation):
    _, _, plan = source
    statements = {
        "control": (
            "UPDATE contest.item_links SET wine_id=792 WHERE catalog_item_id=605"
        ),
        "reference": (
            "UPDATE contest.reference_assets SET width=2 WHERE catalog_item_id=603"
        ),
        "historical": "UPDATE svoe_vino.wines SET title='changed' WHERE id=791",
        "sequence": "ALTER SEQUENCE svoe_vino.wines_id_seq RESTART WITH 3982",
        "link": "UPDATE contest.item_links SET wine_id=792 WHERE catalog_item_id=603",
    }
    db.execute(statements[mutation])
    before = capture(db)
    with pytest.raises(ValueError):
        correction.write_correction(db, plan)
    assert capture(db) == before


def test_alias_collision_blocks_materialization(db, source):
    decision, _, _ = source
    db.execute(
        "UPDATE svoe_vino.wines SET external_id=%s WHERE id=792",
        (decision["official_slug"],),
    )
    before = capture(db)
    with pytest.raises(ValueError, match="alias collision"):
        correction.build_plan(decision, before)
    assert capture(db) == before


def test_plan_cannot_invent_abv_or_change_official_fields(db, source):
    _, before, original = source
    for field, value in (("alcohol", 12.7), ("title", "Invented title")):
        plan = copy.deepcopy(original)
        plan["new_wine"][field] = value
        plan["plan_sha256"] = digest(
            {k: v for k, v in plan.items() if k != "plan_sha256"}
        )
        with pytest.raises(ValueError, match="materialization mapping"):
            correction.write_correction(db, plan)
        assert capture(db) == before


def test_late_failure_rolls_back_wine_link_and_sequence(db, source, monkeypatch):
    _, before, plan = source
    validate = correction.validate_current

    def fail_after_insert(plan, state):
        if len(state["wines"]) > len(before["wines"]):
            raise ValueError("forced post-write failure")
        return validate(plan, state)

    monkeypatch.setattr(correction, "validate_current", fail_after_insert)
    with pytest.raises(ValueError, match="forced post-write"):
        correction.write_correction(db, plan)
    assert capture(db) == before


def test_replay_rejects_changed_new_wine(db, source):
    _, _, plan = source
    correction.write_correction(db, plan)
    db.execute(
        "UPDATE svoe_vino.wines SET raw_list_json=%s WHERE id=3981",
        (Jsonb({"unexpected": True}),),
    )
    before = capture(db)
    with pytest.raises(ValueError, match="Conflicting correction link"):
        correction.write_correction(db, plan)
    assert capture(db) == before


def test_cli_apply_requires_reviewed_plan_and_hash(tmp_path):
    with pytest.raises(SystemExit, match="2"):
        correction.main(
            [
                "--apply",
                "--plan",
                str(tmp_path / "absent.json"),
                "--report",
                str(tmp_path / "report.json"),
            ]
        )


def test_cli_reports_cannot_overwrite_plan_or_manifest(tmp_path):
    plan = tmp_path / "plan.json"
    with pytest.raises(SystemExit, match="2"):
        correction.main(["--dry-run", "--plan", str(plan), "--report", str(plan)])


def test_current_603_correction_is_explicitly_disabled():
    with pytest.raises(ValueError, match="superseded.*replay disabled"):
        correction.load_manifest()
