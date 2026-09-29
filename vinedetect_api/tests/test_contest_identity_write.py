from __future__ import annotations

import copy
from collections import Counter

import psycopg
import pytest

from app import contest_identity_allocation as allocation
from app import contest_identity_write as writer
from app.contest_identity_state import capture, digest, fingerprint, read_rows
from app.contest_media import json_bytes
from tests.test_contest_import import MIGRATIONS, csv_bytes, run_import, wine
from tests.test_contest_import import db as db

AUTO_SLUG = "chenin-blanc-shenen-blan-oleg-repin"


@pytest.fixture()
def source(db):
    # The real production counts exercise coverage arithmetic, not a smaller
    # fixture whose success could conceal an off-by-248 error.
    db.execute("SET LOCAL TIME ZONE 'UTC'")
    db.execute("""INSERT INTO svoe_vino.wines(id,slug,title,external_id,source)
        SELECT n,'historical-'||n,'Historical '||n,'historical-'||n,'vino-svoe'
        FROM generate_series(1,1866) n""")
    db.execute("ALTER SEQUENCE svoe_vino.wines_id_seq RESTART WITH 3733")
    db.execute("""INSERT INTO svoe_vino.wine_images(id,wine_id,kind,url)
        SELECT n,n,'bottle','https://example.invalid/'||n||'.jpg'
        FROM generate_series(1,1866) n""")
    db.execute("INSERT INTO svoe_vino.grapes(id,name) VALUES (1,'Merlot'),(2,'Muscat')")
    db.execute("CREATE SCHEMA meta")
    db.execute("""CREATE TABLE meta.identity_writer_test_annotation (
        id INTEGER PRIMARY KEY, reviewed JSONB NOT NULL);
        INSERT INTO meta.identity_writer_test_annotation
        VALUES (1,'{"reviewed":true}')""")
    manual_slugs = sorted(s for s in allocation.EXPECTED_RESLUGS if s != AUTO_SLUG)
    manual_slugs += [f"manual-new-{n:03d}" for n in range(33)]
    new_slugs = [f"auto-new-{n:03d}" for n in range(215)]
    all_unresolved = [AUTO_SLUG, *manual_slugs, *new_slugs]
    records = [wine(f"historical-{n}") for n in range(1, 1840)]
    for slug in all_unresolved:
        row = wine(slug, "Official " + slug)
        row[5] = " Merlot ; MUSCAT; Unknown cultivar "
        records.append(row)
    run_import(db, csv_bytes(*records))
    db.execute("""INSERT INTO contest.reference_assets
        (catalog_item_id,original_filename,local_path,sha256,width,height,byte_size,mime_type)
        SELECT id,'ref-'||id||'.jpg','references/'||id||'.jpg',
               repeat('a',64),1,1,10,'image/jpeg'
        FROM contest.catalog_items""")
    state = capture(db)
    by_slug = {r["official_slug"]: r for r in state["catalog_items"]}
    automatic = []
    for slug in sorted(all_unresolved):
        row = by_slug[slug]
        classification = (
            "re_slug"
            if slug == AUTO_SLUG
            else "manual_review"
            if slug in manual_slugs
            else "true_new"
        )
        automatic.append(
            {
                "catalog_item_id": row["id"],
                "official_slug": slug,
                "official_title": row["title"],
                "official_winery": row["winery"],
                "classification": classification,
                "proposed_wine_id": 1088 if slug == AUTO_SLUG else None,
                "proposed_new_wine_data": allocation.new_wine_data(row)
                if classification == "true_new"
                else None,
                "confidence": "high",
                "review_note": "Frozen fixture evidence",
            }
        )
    decisions = [
        {
            "official_slug": slug,
            "decision": "re_slug"
            if slug in allocation.EXPECTED_RESLUGS
            else "true_new",
            "wine_id": allocation.EXPECTED_RESLUGS.get(slug),
            "confidence": "high",
            "note": "Human fixture decision",
        }
        for slug in manual_slugs
    ]
    frozen = {key: copy.deepcopy(state[key]) for key in allocation.FROZEN_KEYS}
    return automatic, decisions, frozen, state


def build(source):
    return allocation.build_allocation(
        *source,
        input_hashes={
            "identity_plan_sha256": "1" * 64,
            "human_decisions_sha256": "2" * 64,
            "frozen_snapshot_sha256": "3" * 64,
        },
    )


def rehash(plan):
    plan.pop("plan_sha256", None)
    plan["plan_sha256"] = digest(plan)


def test_merge_counts_human_override_and_determinism(source):
    before = copy.deepcopy(source)
    plan = build(source)
    assert plan["summary"]["re_slug"] == 16
    assert plan["summary"]["true_new"] == 248
    assert plan["summary"]["unresolved"] == 0
    assert source == before
    assert json_bytes(build(source)) == json_bytes(plan)
    mapped = {r["official_slug"]: r for r in plan["allocations"]}
    assert mapped["vibes-silvaner-barrel-fermented-2022"]["wine_id"] == 791
    assert (
        mapped[AUTO_SLUG]["preserved_identity"]["source_item_id"] == "historical-1088"
    )
    assert Counter(r["method"] for r in plan["allocations"]) == {
        "re_slug": 16,
        "materialized_official": 248,
    }
    new = mapped["manual-new-000"]
    assert new["new_wine"]["raw_detail_json"]["organizer_catalog"]["grapes"] == (
        " Merlot ; MUSCAT; Unknown cultivar "
    )
    assert len(new["grape_enrichment"]["relations"]) == 2
    assert len(new["grape_enrichment"]["unresolved"]) == 1
    assert new["grape_enrichment"]["dictionary_inserts"] == 0


@pytest.mark.parametrize(
    "change",
    ["null", "wrong_id", "true_new_with_id", "duplicate", "missing", "third_decision"],
)
def test_invalid_final_manual_decisions_rejected(source, change):
    decisions = source[1]
    row = decisions[0]
    if change == "null":
        row["decision"] = None
    elif change == "wrong_id":
        row["wine_id"] = 999999
    elif change == "true_new_with_id":
        row["decision"] = "true_new"
    elif change == "duplicate":
        decisions[1] = copy.deepcopy(decisions[0])
    elif change == "missing":
        decisions.pop()
    else:
        row["decision"] = "manual_review"
    with pytest.raises(ValueError):
        build(source)


@pytest.mark.parametrize("key", allocation.FROZEN_KEYS)
def test_stale_phase3b1_sources_rejected(source, key):
    source[3][key].append({"unexpected": "row"})
    with pytest.raises(ValueError, match="Stale Phase 3B1"):
        build(source)


def test_alias_collisions_cover_all_detail_lookup_aliases():
    historical = [
        {"id": 1, "external_id": "existing-external", "slug": "existing-slug"}
    ]

    def row(slug, wid=2):
        return {
            "decision": "true_new",
            "wine_id": wid,
            "new_wine": {"slug": slug, "external_id": slug},
        }

    for value in ["existing-external", "existing-slug", "1", "99999"]:
        with pytest.raises(ValueError, match="collision"):
            allocation.check_aliases(historical, [row(value)])
    with pytest.raises(ValueError, match="collision"):
        allocation.check_aliases(historical, [row("duplicate", 2), row("duplicate", 3)])
    historical[0]["external_id"] = "2"
    with pytest.raises(ValueError, match="allocation-time numeric alias collision"):
        allocation.check_aliases(historical, [row("fresh", 2)])
    assert allocation.check_aliases([], [row("fresh", 2)])["collisions"] == []


def test_grape_case_spacing_and_ambiguous_normalization():
    dictionary = [{"id": 1, "name": "Merlot"}, {"id": 2, "name": "Cabernet  Sauvignon"}]
    result = allocation.grape_relations(
        " merlot ; CABERNET SAUVIGNON; Novel", dictionary
    )
    assert [r["grape_id"] for r in result["relations"]] == [1, 2]
    assert result["unresolved"][0]["raw_token"] == " Novel"
    dictionary.append({"id": 3, "name": " MERLOT "})
    result = allocation.grape_relations("Merlot", dictionary)
    assert result["relations"] == []
    assert result["unresolved"][0]["reason"] == "ambiguous_normalization"
    assert result["dictionary_inserts"] == 0


def test_full_apply_exact_replay_preserves_history_images_meta_and_links(db, source):
    plan = build(source)
    before = capture(db)
    dry = writer.write_allocations(db, plan, dry_run=True)
    assert dry["pending_wine_inserts"] == 248 and dry["inserted_wines"] == 0
    assert before == capture(db)
    result = writer.write_allocations(db, plan)
    assert result["inserted_wines"] == 248 and result["updated_links"] == 264
    assert result["inserted_grape_relations"] == 496
    after = capture(db)
    assert len(after["wines"]) == 2114
    assert len(after["wine_images"]) == 1866
    assert sum(r["wine_id"] is not None for r in after["item_links"]) == 2103
    for key in ("meta", "wine_images", "reference_assets", "catalog_items", "grapes"):
        assert (
            fingerprint(before[key]) == fingerprint(after[key])
            if isinstance(before[key], list)
            else before[key] == after[key]
        )
    assert (
        fingerprint([r for r in after["item_links"] if r["method"] == "exact_slug"])
        == plan["baseline"]["exact_links"]
    )
    replay = writer.write_allocations(db, plan)
    assert (
        replay["inserted_wines"]
        == replay["updated_links"]
        == replay["inserted_grape_relations"]
        == 0
    )
    assert replay["already_identical_allocations"] == 264
    assert capture(db) == after


def test_failure_rolls_back_wines_links_relations_and_sequence(db, source):
    plan = build(source)
    last = plan["allocations"][-1]["catalog_item_id"]
    db.execute(f"""CREATE FUNCTION contest.reject_last_link() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN IF NEW.catalog_item_id={last} THEN
        RAISE EXCEPTION 'injected final link failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_last_link BEFORE UPDATE ON contest.item_links
        FOR EACH ROW EXECUTE FUNCTION contest.reject_last_link();""")
    source[3]["schema"] = capture(db)["schema"]
    plan = build(source)
    before = capture(db)
    with pytest.raises(psycopg.Error, match="injected final link failure"):
        writer.write_allocations(db, plan)
    assert capture(db) == before
    assert len(read_rows(db, "svoe_vino.wines")) == 1866


def test_meta_side_effect_detected_and_rolled_back(db, source):
    db.execute("""CREATE FUNCTION svoe_vino.unwanted_meta_write() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
        UPDATE meta.identity_writer_test_annotation SET reviewed='{"reviewed":false}';
        RETURN NEW; END $$;
        CREATE TRIGGER unwanted_meta_write AFTER INSERT ON svoe_vino.wines
        FOR EACH ROW EXECUTE FUNCTION svoe_vino.unwanted_meta_write();""")
    source[3]["schema"] = capture(db)["schema"]
    plan = build(source)
    before = capture(db)
    with pytest.raises(ValueError, match="annotation/meta"):
        writer.write_allocations(db, plan)
    assert capture(db) == before


@pytest.mark.parametrize(
    "change",
    [
        "official",
        "historical",
        "meta",
        "exact_link",
        "unresolved_link",
        "sequence",
        "new_numeric_alias",
    ],
)
def test_current_state_conflicts_fail_before_wine_insertion(db, source, change):
    plan = build(source)
    if change == "official":
        db.execute("UPDATE contest.catalog_items SET title='changed' WHERE id=2100")
    elif change == "historical":
        db.execute("UPDATE svoe_vino.wines SET external_id='changed' WHERE id=1088")
    elif change == "meta":
        db.execute("UPDATE meta.identity_writer_test_annotation SET reviewed='{}'")
    elif change == "exact_link":
        db.execute(
            "UPDATE contest.item_links SET provenance='{"
            + '"changed":true'
            + "}' WHERE method='exact_slug'"
        )
    elif change == "unresolved_link":
        db.execute(
            "UPDATE contest.item_links SET wine_id=1,method='manual' "
            "WHERE catalog_item_id=%s",
            (plan["allocations"][0]["catalog_item_id"],),
        )
    elif change == "sequence":
        db.execute("ALTER SEQUENCE svoe_vino.wines_id_seq RESTART WITH 4000")
    else:
        db.execute("UPDATE svoe_vino.wines SET external_id='3733' WHERE id=1")
    before = capture(db)
    with pytest.raises(ValueError):
        writer.write_allocations(db, plan)
    assert capture(db) == before


def test_new_numeric_alias_rejected_during_frozen_merge(source):
    for snapshot in (source[2], source[3]):
        snapshot["wines"][0]["external_id"] = "3733"
    with pytest.raises(ValueError, match="allocation-time numeric alias collision"):
        build(source)


def test_migration015_required_and_null_semantics(db, source):
    plan = build(source)
    original = plan["baseline"]["schema"]["link_constraints"]
    definition = next(
        c["definition"] for c in original if c["conname"] == "item_links_method_check"
    )
    old = definition.replace(", 'materialized_official'::text", "")
    db.execute(
        "ALTER TABLE contest.item_links DROP CONSTRAINT item_links_method_check, "
        "ADD CONSTRAINT item_links_method_check " + old
    )
    source[3]["schema"] = capture(db)["schema"]
    plan = build(source)
    dry = writer.write_allocations(db, plan, dry_run=True)
    assert dry["required_migrations"] == [writer.MIGRATION]
    assert dry["validation_passed"] and not dry["ready_for_apply"]
    with pytest.raises(ValueError, match="required before"):
        writer.write_allocations(db, plan)
    db.execute((MIGRATIONS / writer.MIGRATION).read_text(encoding="utf-8-sig"))
    assert writer.write_allocations(db, plan, dry_run=True)["ready_for_apply"]
    cid = plan["allocations"][0]["catalog_item_id"]
    for method, wid in [
        ("materialized_official", None),
        ("new_official_item", 1),
        ("re_slug", None),
    ]:
        with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
            db.execute(
                "UPDATE contest.item_links SET method=%s,wine_id=%s "
                "WHERE catalog_item_id=%s",
                (method, wid, cid),
            )
    writer.write_allocations(db, plan)


def test_plan_tampering_and_immutable_output(source, tmp_path):
    plan = build(source)
    path = tmp_path / "plan.json"
    writer.save_immutable(path, plan)
    writer.save_immutable(path, plan)
    plan["allocations"][0]["wine_id"] = 123
    with pytest.raises(ValueError, match="hash/schema"):
        allocation.validate_final_plan(plan)
    with pytest.raises(ValueError, match="Immutable artifact differs"):
        writer.save_immutable(path, plan)


def test_replay_rejects_changed_materialized_row_and_relation(db, source):
    plan = build(source)
    writer.write_allocations(db, plan)
    wid = next(r["wine_id"] for r in plan["allocations"] if r["decision"] == "true_new")
    with db.transaction(force_rollback=True):
        db.execute("UPDATE svoe_vino.wines SET title='edited' WHERE id=%s", (wid,))
        with pytest.raises(ValueError, match="materialized wine"):
            writer.write_allocations(db, plan)
    with db.transaction(force_rollback=True):
        db.execute("DELETE FROM svoe_vino.wine_grapes WHERE wine_id=%s", (wid,))
        with pytest.raises(ValueError, match="grape relations"):
            writer.write_allocations(db, plan)


def test_cli_apply_requires_reviewed_hash_before_connecting(tmp_path, monkeypatch):
    monkeypatch.setattr(
        writer.psycopg, "connect", lambda *a, **k: pytest.fail("must not connect")
    )
    with pytest.raises(SystemExit):
        writer.main(["--apply", "--output-dir", str(tmp_path)])
