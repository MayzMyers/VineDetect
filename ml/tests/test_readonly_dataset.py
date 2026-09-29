"""Optional integration: SELECT-only snapshots of the configured local dataset."""

import os
from pathlib import Path

import psycopg
import pytest
from psycopg import sql

from vinedetect_retrieval.artifacts import read_json
from vinedetect_retrieval.manifests import build_manifests

DSN = os.environ.get("SIGLIP_READ_ONLY_TEST_DATABASE_URL")
ROOT = Path(__file__).resolve().parents[2]


def fingerprint():
    with psycopg.connect(DSN, options="-c default_transaction_read_only=on") as db:
        db.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        assert db.execute("SHOW transaction_read_only").fetchone()[0] == "on"
        tables = db.execute(
            "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('contest','svoe_vino','meta') ORDER BY 1,2"
        ).fetchall()
        return {
            f"{schema}.{table}": db.execute(
                sql.SQL(
                    "SELECT count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' ORDER BY to_jsonb(t)::text),'')) FROM {} t"
                ).format(sql.Identifier(schema, table))
            ).fetchone()
            for schema, table in tables
        }


@pytest.mark.skipif(
    not DSN, reason="Set SIGLIP_READ_ONLY_TEST_DATABASE_URL for read-only integration"
)
def test_2103_gallery_1839_proxy_all_assets_and_no_database_writes(tmp_path, monkeypatch):
    before = fingerprint()
    original = psycopg.connect
    options_used = []

    def connect(*args, **kwargs):
        options_used.append(kwargs.get("options"))
        return original(*args, **kwargs)

    monkeypatch.setattr(psycopg, "connect", connect)
    summary = build_manifests(DSN, ROOT / "asset-store", tmp_path)
    assert summary["gallery_rows"] == 2103
    assert summary["physical_sha_identities"] == 2074
    assert summary["proxy_queries"] == 1839
    assert summary["excluded_proxy_images"] == 0
    assert summary["ambiguity_groups"] == 29
    first = {p.name: p.read_bytes() for p in tmp_path.glob("*.json")}
    build_manifests(DSN, ROOT / "asset-store", tmp_path)
    assert first == {p.name: p.read_bytes() for p in tmp_path.glob("*.json")}
    assert before == fingerprint()
    assert all(option == "-c default_transaction_read_only=on" for option in options_used)
    rows = read_json(tmp_path / "gallery-manifest.json")["rows"]
    assert [r["catalog_item_id"] for r in rows] == sorted(r["catalog_item_id"] for r in rows)
    by_id = {r["catalog_item_id"]: r for r in rows}
    assert by_id[193]["source_item_id"] == "oleg-repin-shenen-blan-beloe-suhoe-125"
    assert by_id[2]["source_item_id"] == by_id[2]["official_slug"]
    assert by_id[1]["source_item_id"] == by_id[1]["official_slug"]

    assert by_id[603]["link_method"] == "re_slug"
    assert by_id[603]["source_item_id"] == "vibes-vermentino-viognier-barrel-fermented-2022"
    assert by_id[603]["wine_id"] == 791
    assert by_id[605]["wine_id"] == 791
    assert by_id[605]["link_method"] == "exact_slug"
    queries = read_json(tmp_path / "proxy-query-manifest.json")["rows"]
    assert not any(r["catalog_item_id"] == 603 for r in queries)
    assert {r["catalog_item_id"] for r in queries if r["historical_wine_id"] == 791} == {605}

    for target, control in ((61, 65), (106, 107), (566, 515), (597, 464), (1185, 899)):
        assert by_id[target]["reference_sha256"] == by_id[control]["reference_sha256"]
    assert len({by_id[key]["reference_sha256"] for key in (1842, 1843, 1848)}) == 1

    assert by_id[2079]["category"] == "Розовое"
    assert by_id[2079]["color"] == "Нежно-розовый"
    assert by_id[2079]["wine_id"] == 328
    with original(DSN, options="-c default_transaction_read_only=on") as db:
        raw = db.execute(
            "SELECT category,color FROM contest.catalog_items WHERE id=2079"
        ).fetchone()
    assert raw == ("Розовое", "Нежно-розовый")

    training = read_json(tmp_path / "training-dataset.json")
    assert training["official_reference_rows"] == rows
    assert training["policy"]["inference_identity_count"] == 2103
    assert training["policy"]["identical_sha_group_count"] == 28
    assert training["policy"]["curated_relationship_group_count"] == 17


@pytest.mark.skipif(not DSN, reason="Set read-only dataset URL")
def test_organizer_truth_runtime_projection_without_dataset_rebuild():
    from psycopg.rows import dict_row
    from vinedetect_retrieval.manifests import GALLERY_SQL, validate_gallery

    with psycopg.connect(DSN, row_factory=dict_row,
                        options="-c default_transaction_read_only=on") as db:
        assert db.execute("SHOW transaction_read_only").fetchone()["transaction_read_only"] == "on"
        rows = db.execute(GALLERY_SQL, ("lct-rshb-2026-09-15",)).fetchall()
        by_id = {r["catalog_item_id"]: r for r in rows}
        assert len(rows) == 2103
        assert (by_id[603]["wine_id"], by_id[603]["link_method"]) == (791, "re_slug")
        assert (by_id[605]["wine_id"], by_id[605]["link_method"]) == (791, "exact_slug")
        assert db.execute("SELECT count(*) AS n FROM svoe_vino.wines WHERE id=3981").fetchone()["n"] == 0
        assert db.execute("SELECT count(*) AS n FROM contest.metadata_overrides WHERE catalog_item_id=2079").fetchone()["n"] == 0
        raw = db.execute("SELECT category,color FROM contest.catalog_items WHERE id=2079").fetchone()
        assert {k: by_id[2079][k] for k in ("category", "color")} == raw
    # Integrity-only image decode/hash checks; no model, GT/proxy/training export.
    assert len(validate_gallery(rows, ROOT / "asset-store")) == 2103
