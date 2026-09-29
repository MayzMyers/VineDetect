from __future__ import annotations

import re
from pathlib import Path

APP_OWNED_TABLES = [
    "wines",
    "grapes",
    "dishes",
    "wine_grapes",
    "wine_dishes",
    "crawl_pages",
    "crawl_wines",
    "wine_images",
    "wine_rating_snapshots",
    "wine_external_matches",
    "wine_barcodes",
    "recognition_profiles",
    "recognition_aliases",
    "recognition_assets",
    "recognition_annotations",
    "ocr_observations",
    "visual_features",
    "asset_processing_jobs",
]

SQL_VERBS = ["FROM", "JOIN", "UPDATE", "INSERT INTO", "DELETE FROM", "REFERENCES"]


ROOT = Path(__file__).resolve().parents[1]
MIGRATION_012 = ROOT / "migrations/012_move_public_tables_to_svoe_vino_schema.sql"


def test_migration_012_moves_public_tables_to_svoe_vino_schema() -> None:
    sql = MIGRATION_012.read_text()

    assert "CREATE SCHEMA IF NOT EXISTS svoe_vino;" in sql
    for table in APP_OWNED_TABLES:
        old_table = f"public.{table}"
        assert f"to_regclass('{old_table}')" in sql
        assert f"ALTER TABLE {old_table} SET SCHEMA svoe_vino;" in sql

    assert "DROP SCHEMA IF EXISTS public;" in sql
    assert "DROP SCHEMA public CASCADE" not in sql
    assert "ALTER SCHEMA public RENAME" not in sql
    assert "rs" + "hb" not in sql
    assert "svoe" + "-" + "vino" not in sql
    assert "ALTER TABLE roskachestvo.products" not in sql
    assert "public.roskachestvo_wines" not in sql


def test_active_app_sql_uses_svoe_vino_schema_for_app_tables() -> None:
    sources = [
        ROOT / "app/repositories.py",
    ]
    table_pattern = "|".join(re.escape(table) for table in APP_OWNED_TABLES)
    unqualified_pattern = re.compile(
        rf"\b(?:{'|'.join(SQL_VERBS)})\s+(?!svoe_vino\.)(?:{table_pattern})\b",
        re.IGNORECASE,
    )

    for source in sources:
        text = source.read_text()
        assert "public." + "wines" not in text
        assert "public." + "wine_images" not in text
        assert "rs" + "hb" not in text
        assert "svoe" + "-" + "vino" not in text
        assert unqualified_pattern.search(text) is None