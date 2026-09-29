"""Read-only snapshots and fingerprints for the controlled contest identity writer."""

from __future__ import annotations

import hashlib

from psycopg import sql

from app.contest_media import json_bytes

TABLES = {
    "catalog_items": "contest.catalog_items",
    "reference_assets": "contest.reference_assets",
    "item_links": "contest.item_links",
    "wines": "svoe_vino.wines",
    "wine_images": "svoe_vino.wine_images",
    "grapes": "svoe_vino.grapes",
    "wine_grape_relations": "svoe_vino.wine_grapes",
}


def digest(value):
    return hashlib.sha256(json_bytes(value)).hexdigest()


def fingerprint(rows):
    return {"count": len(rows), "sha256": digest(sorted(rows, key=json_bytes))}


def read_rows(connection, relation):
    return connection.execute(
        sql.SQL(
            "SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM {} t"
        ).format(sql.Identifier(*relation.split(".")))
    ).fetchone()["rows"]


def meta_tables(connection):
    return [
        r["tablename"]
        for r in connection.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'meta' "
            "ORDER BY tablename"
        ).fetchall()
    ]


def meta_fingerprints(connection):
    return {
        name: fingerprint(read_rows(connection, "meta." + name))
        for name in meta_tables(connection)
    }


def sequence_state(connection):
    sequence = connection.execute(
        "SELECT pg_get_serial_sequence('svoe_vino.wines', 'id') AS name"
    ).fetchone()["name"]
    if sequence != "svoe_vino.wines_id_seq":
        raise ValueError("Unexpected wine ID sequence; inspect schema")
    value = connection.execute(
        "SELECT last_value, is_called FROM svoe_vino.wines_id_seq"
    ).fetchone()
    settings = connection.execute(
        "SELECT increment_by, min_value, max_value, cache_size, cycle "
        "FROM pg_sequences WHERE schemaname = 'svoe_vino' "
        "AND sequencename = 'wines_id_seq'"
    ).fetchone()
    if (settings["increment_by"], settings["cache_size"], settings["cycle"]) != (
        1,
        1,
        False,
    ):
        raise ValueError("Wine sequence must be ascending, CACHE 1, NO CYCLE")
    return {"name": sequence, **value, **settings}


def schema_state(connection):
    columns = connection.execute(
        "SELECT table_schema, table_name, column_name, data_type, is_nullable, "
        "column_default FROM information_schema.columns "
        "WHERE (table_schema = 'svoe_vino' AND table_name IN "
        "('wines','wine_images','grapes','wine_grapes')) "
        "OR (table_schema = 'contest' AND table_name = 'item_links') "
        "ORDER BY table_schema,table_name,ordinal_position"
    ).fetchall()
    constraints = connection.execute(
        "SELECT conname, pg_get_constraintdef(oid) AS definition "
        "FROM pg_constraint WHERE conrelid = 'contest.item_links'::regclass "
        "ORDER BY conname"
    ).fetchall()
    indexes = connection.execute(
        "SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes "
        "WHERE (schemaname = 'svoe_vino' AND tablename IN "
        "('wines','grapes','wine_grapes')) OR "
        "(schemaname='contest' AND tablename='item_links') "
        "ORDER BY schemaname,tablename,indexname"
    ).fetchall()
    triggers = connection.execute(
        "SELECT n.nspname AS schema, c.relname AS relation, t.tgname, "
        "pg_get_triggerdef(t.oid) AS definition "
        "FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid "
        "JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE NOT t.tgisinternal AND n.nspname IN ('contest','svoe_vino') "
        "ORDER BY 1,2,3"
    ).fetchall()
    return {
        "columns": columns,
        "link_constraints": constraints,
        "indexes": indexes,
        "triggers": triggers,
    }


def capture(connection):
    state = {key: read_rows(connection, table) for key, table in TABLES.items()}
    names = {g["id"]: g["name"] for g in state["grapes"]}
    state["wine_grapes"] = [
        {"wine_id": r["wine_id"], "name": names[r["grape_id"]]}
        for r in state["wine_grape_relations"]
    ]
    state["meta"] = meta_fingerprints(connection)
    state["sequence"] = sequence_state(connection)
    state["schema"] = schema_state(connection)
    return state
