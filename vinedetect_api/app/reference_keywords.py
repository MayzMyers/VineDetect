"""Prepare API-only reference keywords from existing text; never run OCR/ML."""

from __future__ import annotations

import argparse
import json
import unicodedata
from collections import defaultdict
from collections.abc import Iterable
from pathlib import Path

from psycopg.types.json import Jsonb

from app.config import get_config
from app.db import get_connection
from app.matching import normalize_match_text

PROFILE_VERSION = "reference-keywords/1"


def build_keywords(title: str, texts: Iterable[str] = ()) -> list[str]:
    """Use the catalog normalizer, retaining numbers and one-character tokens."""
    return sorted({
        token
        for text in (title, *texts)
        for token in normalize_match_text(unicodedata.normalize("NFKC", text)).split()
    })


def _exists(connection, relation: str) -> bool:
    return connection.execute(
        "SELECT to_regclass(%s) IS NOT NULL AS present", (relation,)
    ).fetchone()["present"]


def _observation_texts(data: dict) -> list[str]:
    """Explicit OCR payload fields only; never traverse unrelated metadata."""
    if not isinstance(data, dict):
        return []
    texts = [
        value for key in ("normalized_text", "raw_text", "text")
        if isinstance(value := data.get(key), str)
    ]
    tokens = data.get("tokens")
    if isinstance(tokens, list):
        texts.extend(value for value in tokens if isinstance(value, str))
    return texts


def parse_token_import(path: Path) -> dict[str, list[str]]:
    """Import saved reference tokens by slug, with no local numeric IDs."""
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    if (not isinstance(payload, dict)
            or payload.get("schemaVersion") != "reference-tokens/1"):
        raise ValueError("Expected schemaVersion reference-tokens/1")
    if not isinstance(payload.get("items"), list):
        raise ValueError("items must be an array")
    result = {}
    for item in payload["items"]:
        if not isinstance(item, dict):
            raise ValueError("Each imported item must be an object")
        slug, tokens = item.get("slug"), item.get("tokens")
        if not isinstance(slug, str) or not slug.strip() or slug != slug.strip():
            raise ValueError("A nonempty exact wine slug is required")
        if slug in result:
            raise ValueError(f"Duplicate slug: {slug}")
        if not isinstance(tokens, list) or not all(isinstance(t, str) for t in tokens):
            raise ValueError(f"tokens must be a string array: {slug}")
        result[slug] = tokens
    return result


def refresh_reference_keywords(
    connection, imported_tokens: dict[str, list[str]] | None = None
) -> dict:
    """Batch refresh in the caller's transaction; write only our profile version.

    Take latest completed machine OCR per wine, latest verified manual OCR per
    wine, and latest completed foundation OCR per active asset. Imported tokens
    persist across refreshes; an explicit [] clears a wine's imported tokens.
    """
    wines = connection.execute(
        'SELECT id, slug, title FROM svoe_vino.wines ORDER BY slug COLLATE "C"'
    ).fetchall()
    slugs = {wine["slug"] for wine in wines}
    imported_tokens = imported_tokens or {}
    unknown = sorted(set(imported_tokens) - slugs)
    if unknown:
        raise ValueError(f"Unknown wine slugs: {', '.join(unknown)}")
    for slug, tokens in imported_tokens.items():
        if not isinstance(tokens, list) or not all(isinstance(t, str) for t in tokens):
            raise ValueError(f"tokens must be a string array: {slug}")

    texts: dict[str, list[str]] = defaultdict(list)
    source_counts = {}
    available = []
    if _exists(connection, "meta.ocr_runs"):
        available.append("meta.ocr_runs")
        rows = connection.execute("""
            SELECT DISTINCT ON (wine.slug) wine.slug,
                   COALESCE(NULLIF(btrim(ocr.normalized_text), ''), ocr.raw_text) AS text
            FROM svoe_vino.wines AS wine
            JOIN meta.ocr_runs AS ocr
              ON ocr.source = 'svoe_vino' AND ocr.source_item_id = wine.slug
            WHERE ocr.status = 'completed'
            ORDER BY wine.slug, ocr.created_at DESC, ocr.id DESC
        """).fetchall()
        for row in rows:
            if isinstance(row["text"], str):
                texts[row["slug"]].append(row["text"])
        source_counts["meta.ocr_runs"] = len(rows)

    if (_exists(connection, "meta.annotation_ocr")
            and _exists(connection, "meta.annotation_packages")):
        available.append("meta.annotation_ocr")
        rows = connection.execute("""
            SELECT DISTINCT ON (wine.slug) wine.slug, ocr.transcription AS text
            FROM svoe_vino.wines AS wine
            JOIN meta.annotation_packages AS package
              ON package.source = 'svoe_vino' AND package.source_item_id = wine.slug
            JOIN meta.annotation_ocr AS ocr ON ocr.package_id = package.id
            WHERE package.deleted_at IS NULL AND ocr.deleted_at IS NULL
              AND ocr.transcription_status = 'verified'
            ORDER BY wine.slug, ocr.updated_at DESC, ocr.created_at DESC, ocr.id DESC
        """).fetchall()
        for row in rows:
            if isinstance(row["text"], str):
                texts[row["slug"]].append(row["text"])
        source_counts["meta.annotation_ocr"] = len(rows)

    if (_exists(connection, "svoe_vino.ocr_observations")
            and _exists(connection, "svoe_vino.recognition_assets")):
        available.append("svoe_vino.ocr_observations")
        rows = connection.execute("""
            SELECT DISTINCT ON (asset.id) wine.slug, ocr.observation_data
            FROM svoe_vino.wines AS wine
            JOIN svoe_vino.recognition_assets AS asset ON asset.wine_id = wine.id
            JOIN svoe_vino.ocr_observations AS ocr ON ocr.asset_id = asset.id
            WHERE asset.status = 'active' AND ocr.status = 'completed'
            ORDER BY asset.id, ocr.created_at DESC, ocr.id DESC
        """).fetchall()
        for row in rows:
            texts[row["slug"]].extend(_observation_texts(row["observation_data"]))
        source_counts["svoe_vino.ocr_observations"] = len(rows)

    previous = connection.execute("""
        SELECT wine.slug, profile.profile_data
        FROM svoe_vino.wines AS wine
        JOIN svoe_vino.recognition_profiles AS profile ON profile.wine_id = wine.id
        WHERE profile.profile_version = %s
    """, (PROFILE_VERSION,)).fetchall()
    saved_imports = {
        row["slug"]: row["profile_data"].get("importedTokens", []) for row in previous
    }
    saved_imports.update(imported_tokens)
    prepared = []
    with_ocr = 0
    for wine in wines:
        imported = build_keywords("", saved_imports.get(wine["slug"], []))
        source_texts = [*texts[wine["slug"]], *imported]
        with_ocr += bool(build_keywords("", source_texts))
        data = {
            "title": wine["title"],
            "keywords": build_keywords(wine["title"], source_texts),
            "importedTokens": imported,
        }
        prepared.append((wine["id"], PROFILE_VERSION, Jsonb(data)))
    with connection.cursor() as cursor:
        cursor.executemany("""
            INSERT INTO svoe_vino.recognition_profiles
                (wine_id, profile_version, schema_version, status, profile_data)
            VALUES (%s, %s, 'references/1', 'ready', %s)
            ON CONFLICT (wine_id, profile_version) DO UPDATE SET
                schema_version = EXCLUDED.schema_version,
                status = EXCLUDED.status,
                profile_data = EXCLUDED.profile_data,
                updated_at = now()
            WHERE recognition_profiles.profile_data
                      IS DISTINCT FROM EXCLUDED.profile_data
               OR recognition_profiles.status IS DISTINCT FROM EXCLUDED.status
               OR recognition_profiles.schema_version
                      IS DISTINCT FROM EXCLUDED.schema_version
        """, prepared)
    return {
        "wines": len(wines),
        "withOcrOrImportedTokens": with_ocr,
        "titleOnly": len(wines) - with_ocr,
        "availableOcrSources": available,
        "selectedSourceRows": source_counts,
        "importedSlugs": len(imported_tokens),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tokens-json", type=Path, help="Saved reference-tokens/1 JSON")
    args = parser.parse_args(argv)
    imported = parse_token_import(args.tokens_json) if args.tokens_json else None
    with get_connection(get_config().database_url) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        summary = refresh_reference_keywords(connection, imported)
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
