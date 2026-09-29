"""Wine catalog endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import (
    APIRouter,
    Body,
    Depends,
    HTTPException,
    Path,
    Query,
    Response,
    status,
)

from app.config import ApiConfig
from app.repositories import WineConflictError, WineNotFoundError, WineRepository

from ..dependencies import get_api_config_dependency, get_repository
from ..schemas import (
    OfficialWineDetail,
    WineCreate,
    WineDetail,
    WineListResponse,
    WineUpdate,
    validate_barcode,
)
from ..security import require_admin
from .catalog import build_static_image_url

router = APIRouter(prefix="/api/v1/wines", tags=["wines"])


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Wine not found")


def _conflict(exc: WineConflictError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


@router.get("", response_model=WineListResponse)
def list_wines(
    query: str | None = Query(default=None),
    region: str | None = Query(default=None),
    category: str | None = Query(default=None),
    manufacturer: str | None = Query(default=None),
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
    repo: Annotated[WineRepository, Depends(get_repository)] = None,
) -> WineListResponse:
    items, total = repo.list_api_wines(
        query=query.strip() if query else None,
        region=region.strip() if region else None,
        category=category.strip() if category else None,
        manufacturer=manufacturer.strip() if manufacturer else None,
        limit=limit,
        offset=offset,
    )
    return WineListResponse(items=items, total=total, limit=limit, offset=offset)


@router.get("/by-barcode/{barcode}", response_model=WineDetail)
def get_wine_by_barcode(
    barcode: str,
    repo: Annotated[WineRepository, Depends(get_repository)] = None,
) -> dict:
    try:
        validate_barcode(barcode)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    try:
        return repo.get_api_wine_by_barcode(barcode)
    except WineNotFoundError as exc:
        raise _not_found() from exc


@router.get("/by-official-slug/{official_slug}", response_model=OfficialWineDetail)
def get_wine_by_official_slug(
    official_slug: str,
    config: Annotated[ApiConfig, Depends(get_api_config_dependency)],
    repo: Annotated[WineRepository, Depends(get_repository)],
) -> dict:
    try:
        wine = repo.get_api_wine_by_official_slug(official_slug)
    except WineNotFoundError as exc:
        raise _not_found() from exc
    except WineConflictError as exc:
        raise _conflict(exc) from exc
    reference = wine.get("official_reference")
    if reference:
        wine = {**wine, "official_reference": {
            **reference,
            "url": build_static_image_url(
                reference.get("local_path"),
                public_api_base_url=config.public_api_base_url,
                static_assets_url_prefix=config.static_assets_url_prefix,
            ),
        }}
    return wine


@router.get("/{wine_id}", response_model=WineDetail)
def get_wine(
    wine_id: Annotated[int, Path(gt=0)],
    repo: Annotated[WineRepository, Depends(get_repository)] = None,
) -> dict:
    try:
        return repo.get_api_wine(wine_id)
    except WineNotFoundError as exc:
        raise _not_found() from exc


@router.post(
    "",
    response_model=WineDetail,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_admin)],
)
def create_wine(
    payload: Annotated[WineCreate, Body()],
    repo: Annotated[WineRepository, Depends(get_repository)] = None,
) -> dict:
    try:
        return repo.create_api_wine(payload.model_dump())
    except WineConflictError as exc:
        raise _conflict(exc) from exc


@router.patch(
    "/{wine_id}",
    response_model=WineDetail,
    dependencies=[Depends(require_admin)],
)
def update_wine(
    wine_id: Annotated[int, Path(gt=0)],
    payload: Annotated[WineUpdate, Body()],
    repo: Annotated[WineRepository, Depends(get_repository)] = None,
) -> dict:
    values = payload.model_dump(exclude_unset=True)
    try:
        return repo.update_api_wine(wine_id, values)
    except WineNotFoundError as exc:
        raise _not_found() from exc
    except WineConflictError as exc:
        raise _conflict(exc) from exc


@router.delete(
    "/{wine_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_admin)],
)
def delete_wine(
    wine_id: Annotated[int, Path(gt=0)],
    repo: Annotated[WineRepository, Depends(get_repository)] = None,
) -> Response:
    try:
        repo.delete_api_wine(wine_id)
    except WineNotFoundError as exc:
        raise _not_found() from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)