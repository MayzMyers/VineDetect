"""Public, read-only reference keyword snapshots for frontend consumers."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app.repositories import ReferenceKeywordsNotReadyError, WineRepository

from ..dependencies import get_repository
from ..schemas import RecognitionReferencesResponse

router = APIRouter(prefix="/api/v1/recognition", tags=["recognition"])


@router.get("/references", response_model=RecognitionReferencesResponse)
def get_references(
    repo: Annotated[WineRepository, Depends(get_repository)],
) -> RecognitionReferencesResponse:
    try:
        items = repo.list_recognition_references()
    except ReferenceKeywordsNotReadyError as exc:
        raise HTTPException(
            status_code=503,
            detail="Reference keywords are not ready; refresh the reference read-model",
        ) from exc
    return RecognitionReferencesResponse(items=items)
