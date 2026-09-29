"""Database connection helpers."""

from __future__ import annotations

import psycopg
from psycopg.rows import dict_row


def get_connection(database_url: str):
    """Create a PostgreSQL connection using dictionary rows."""

    return psycopg.connect(database_url, row_factory=dict_row)
