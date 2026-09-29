"""FastAPI dependency helpers."""

from __future__ import annotations

from collections.abc import Generator
from typing import Annotated

import psycopg
from fastapi import Depends, Request

from app.config import ApiConfig, get_api_config
from app.repositories import DatabaseUnavailableError, WineRepository

MUTATION_METHODS = {"POST", "PATCH", "DELETE"}


def get_api_config_dependency() -> ApiConfig:
    return get_api_config()


def get_repository(
    request: Request,
    config: Annotated[ApiConfig, Depends(get_api_config_dependency)],
) -> Generator[WineRepository, None, None]:
    try:
        repo = WineRepository(database_url=config.database_url)
    except psycopg.Error as exc:
        raise DatabaseUnavailableError from exc

    try:
        yield repo
    except Exception:
        repo.connection.rollback()
        raise
    else:
        if request.method in MUTATION_METHODS:
            repo.connection.commit()
    finally:
        repo.close()