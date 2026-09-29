"""Health endpoint."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.repositories import DatabaseUnavailableError, WineRepository

from ..dependencies import get_repository
from ..schemas import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health(repo: Annotated[WineRepository, Depends(get_repository)]) -> HealthResponse:
    try:
        repo.check_database()
    except DatabaseUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable",
        ) from exc
    return HealthResponse(status="ok", service="vinedetect_api", database="ok")