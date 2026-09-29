"""Lossless, transactional Phase 1 import of an official competition CSV.

No writes to svoe_vino or meta, and no image filesystem operations.
"""

from __future__ import annotations

import argparse
import codecs
import csv
import hashlib
import io
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from psycopg import Connection
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from app.db import get_connection

FIELDS = (
    "slug",
    "title",
    "category",
    "color",
    "region",
    "grapes",
    "description",
    "winery",
    "photo_name",
)
PARSER_VERSION = "contest-csv/1"


@dataclass(frozen=True)
class CatalogRow:
    number: int
    line_end: int
    raw: dict[str, str]
    fields: dict[str, str]
    sha256: str


@dataclass(frozen=True)
class ParsedCatalog:
    rows: list[CatalogRow]
    config: dict[str, Any]
    metadata: dict[str, Any]


@dataclass(frozen=True)
class ImportResult:
    import_run_id: int
    version: str
    source_sha256: str
    raw_rows: int
    canonical_items: int
    reused: bool


class ImportVersionConflict(ValueError):
    """A version already names different source bytes or parser settings."""


def parse_catalog(
    source_bytes: bytes,
    *,
    column_map: dict[str, str] | None = None,
    encoding: str = "utf-8-sig",
    delimiter: str = ",",
) -> ParsedCatalog:
    """Preserve values verbatim; reject ambiguous/malformed input explicitly.

    Source row numbers are 1-based logical records after the header. Physical
    ending line numbers also identify records containing quoted newlines.
    """
    columns = {field: field for field in FIELDS}
    if column_map is not None:
        if set(column_map) - set(FIELDS):
            raise ValueError("Unknown canonical fields in column map")
        columns.update(column_map)
    if any(not isinstance(v, str) or not v.strip() for v in columns.values()):
        raise ValueError("Column names must be non-blank strings")
    if len(set(columns.values())) != len(columns):
        raise ValueError("Each canonical field must map to a distinct CSV column")
    if len(delimiter) != 1 or delimiter in '\r\n"':
        raise ValueError("Delimiter must be one character other than newline or quote")
    encoding = codecs.lookup(encoding).name
    source_text = source_bytes.decode(encoding, errors="strict")
    if "\x00" in source_text:
        raise ValueError("CSV contains NUL, which PostgreSQL text cannot preserve")
    reader = csv.reader(
        io.StringIO(source_text, newline=""), delimiter=delimiter, strict=True
    )
    try:
        header = next(reader, None)
        if not header or any(not key.strip() for key in header):
            raise ValueError("CSV must have a non-blank header")
        if len(header) != len(set(header)):
            raise ValueError("Duplicate CSV headers are ambiguous")
        missing = set(columns.values()) - set(header)
        if missing:
            raise ValueError(f"Missing CSV columns: {sorted(missing)}")
        rows = []
        first_by_slug: dict[str, CatalogRow] = {}
        conflicting_slugs = set()
        for number, values in enumerate(reader, 1):
            if len(values) != len(header):
                raise ValueError(f"CSV record {number} has the wrong field count")
            raw = dict(zip(header, values, strict=True))
            fields = {field: raw[column] for field, column in columns.items()}
            if not fields["slug"].strip() or not fields["title"].strip():
                raise ValueError(f"CSV record {number} has a blank slug or title")
            serialized = json.dumps(
                raw, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
            row = CatalogRow(
                number,
                reader.line_num,
                raw,
                fields,
                hashlib.sha256(serialized).hexdigest(),
            )
            rows.append(row)
            first = first_by_slug.setdefault(fields["slug"], row)
            if first.fields != row.fields:
                conflicting_slugs.add(fields["slug"])
    except csv.Error as exc:
        raise ValueError(f"Malformed CSV near physical line {reader.line_num}") from exc
    if not rows:
        raise ValueError("CSV must contain at least one catalog record")
    return ParsedCatalog(
        rows=rows,
        config={
            "parser_version": PARSER_VERSION,
            "encoding": encoding,
            "delimiter": delimiter,
            "column_map": columns,
            "headers": header,
            "canonical_policy": "first-source-record",
        },
        metadata={
            "raw_rows": len(rows),
            "canonical_items": len(first_by_slug),
            "duplicate_slug_rows": len(rows) - len(first_by_slug),
            "conflicting_slugs": sorted(conflicting_slugs),
        },
    )


def import_catalog(
    connection: Connection,
    source_bytes: bytes,
    *,
    version: str,
    source_filename: str,
    column_map: dict[str, str] | None = None,
    encoding: str = "utf-8-sig",
    delimiter: str = ",",
) -> ImportResult:
    """Import atomically, or reuse a completed immutable version.

    A caller-owned open transaction remains caller-owned (psycopg savepoint).
    With an idle connection, this method commits or rolls back the whole import.
    The unique version key serializes concurrent retries. A retry never rewrites
    catalog fields, reference assets, or reconciliation decisions.
    """
    if not version.strip() or not source_filename.strip():
        raise ValueError("Version and source filename must be non-blank")
    parsed = parse_catalog(
        source_bytes, column_map=column_map, encoding=encoding, delimiter=delimiter
    )
    source_hash = hashlib.sha256(source_bytes).hexdigest()
    with connection.transaction(), connection.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """INSERT INTO contest.import_runs
                   (version, source_filename, source_sha256, source_bytes,
                    parser_config, metadata)
               VALUES (%s, %s, %s, %s, %s, %s)
               ON CONFLICT (version) DO NOTHING RETURNING id""",
            (
                version,
                source_filename,
                source_hash,
                source_bytes,
                Jsonb(parsed.config),
                Jsonb(parsed.metadata),
            ),
        )
        inserted = cur.fetchone()
        if inserted is None:
            cur.execute(
                "SELECT * FROM contest.import_runs WHERE version = %s", (version,)
            )
            existing = cur.fetchone()
            if (
                existing["source_sha256"] != source_hash
                or bytes(existing["source_bytes"]) != source_bytes
                or existing["parser_config"] != parsed.config
                or existing["source_filename"] != source_filename
            ):
                raise ImportVersionConflict(
                    f"Version {version!r} already names different input/settings; "
                    "choose a new version"
                )
            if existing["status"] != "completed":
                raise ImportVersionConflict(f"Version {version!r} is not completed")
            return ImportResult(
                existing["id"],
                version,
                source_hash,
                existing["metadata"]["raw_rows"],
                existing["metadata"]["canonical_items"],
                True,
            )
        run_id = inserted["id"]
        cur.executemany(
            """INSERT INTO contest_raw.catalog_rows
                   (import_run_id, source_row_number, source_line_end,
                    official_slug, raw_row, row_sha256)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            [
                (
                    run_id,
                    row.number,
                    row.line_end,
                    row.fields["slug"],
                    Jsonb(row.raw),
                    row.sha256,
                )
                for row in parsed.rows
            ],
        )
        canonical: dict[str, CatalogRow] = {}
        for row in parsed.rows:
            canonical.setdefault(row.fields["slug"], row)
        cur.executemany(
            """INSERT INTO contest.catalog_items
                   (import_run_id, source_row_number, official_slug, title,
                    category, color, region, grapes, description, winery, photo_name)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            [
                (run_id, row.number, *(row.fields[field] for field in FIELDS))
                for row in canonical.values()
            ],
        )
        cur.execute(
            """INSERT INTO contest.item_links
                   (catalog_item_id, wine_id, method, confidence, provenance)
               SELECT item.id, wine.id,
                      CASE WHEN wine.id IS NULL THEN 'unmatched'
                           ELSE 'exact_slug' END,
                      CASE WHEN wine.id IS NULL THEN NULL ELSE 1 END,
                      jsonb_build_object('importer', %s::text,
                                         'official_slug', item.official_slug,
                                         'rule', 'literal-slug-equality')
               FROM contest.catalog_items item
               LEFT JOIN svoe_vino.wines wine ON wine.slug = item.official_slug
               WHERE item.import_run_id = %s""",
            (PARSER_VERSION, run_id),
        )
        cur.execute(
            """UPDATE contest.import_runs
               SET status = 'completed', completed_at = clock_timestamp()
               WHERE id = %s""",
            (run_id,),
        )
    return ImportResult(
        run_id, version, source_hash, len(parsed.rows), len(canonical), False
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--encoding", default="utf-8-sig")
    parser.add_argument("--delimiter", default=",")
    parser.add_argument(
        "--column-map",
        type=Path,
        help="JSON object: canonical field -> exact CSV header",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    source = args.csv_path.read_bytes()
    columns = None
    if args.column_map:
        columns = json.loads(args.column_map.read_text(encoding="utf-8-sig"))
        if not isinstance(columns, dict):
            parser.error("--column-map must contain a JSON object")
    options = {
        "column_map": columns,
        "encoding": args.encoding,
        "delimiter": args.delimiter,
    }
    if args.dry_run:
        parsed = parse_catalog(source, **options)
        print(
            json.dumps(
                {
                    "source_sha256": hashlib.sha256(source).hexdigest(),
                    "parser_config": parsed.config,
                    "metadata": parsed.metadata,
                },
                ensure_ascii=False,
            )
        )
        return
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL must be set for an import")
    with get_connection(database_url) as connection:
        result = import_catalog(
            connection,
            source,
            version=args.version,
            source_filename=args.csv_path.name,
            **options,
        )
    print(json.dumps(asdict(result), ensure_ascii=False))


if __name__ == "__main__":
    main()
