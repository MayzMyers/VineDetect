"""Unified read-only catalog endpoints."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.config import ApiConfig
from app.repositories import WineRepository

from ..dependencies import get_api_config_dependency, get_repository
from ..schemas import CatalogResponse

CatalogSource = Literal["all", "svoe_vino", "roskachestvo"]

router = APIRouter(prefix="/api/v1/catalog", tags=["catalog"])


@router.get("", response_model=CatalogResponse)
def search_catalog(
    source: Annotated[CatalogSource, Query()] = "all",
    q: str | None = Query(default=None),
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    config: Annotated[ApiConfig, Depends(get_api_config_dependency)] = None,
    repo: Annotated[WineRepository, Depends(get_repository)] = None,
) -> CatalogResponse:
    try:
        items = repo.search_catalog_items(
            source=source,
            query=q.strip() if q else None,
            limit=limit,
            offset=offset,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    return CatalogResponse(
        items=[
            map_catalog_item_image(
                item,
                public_api_base_url=config.public_api_base_url,
                static_assets_url_prefix=config.static_assets_url_prefix,
            )
            for item in items
        ],
        source=source,
        limit=limit,
        offset=offset,
        count=len(items),
    )


def build_static_image_url(
    local_path: str | None,
    *,
    public_api_base_url: str,
    static_assets_url_prefix: str,
) -> str | None:
    if not local_path or not local_path.strip():
        return None

    normalized_local_path = local_path.strip().replace("\\", "/").lstrip("/")
    normalized_prefix = static_assets_url_prefix.strip().replace("\\", "/")
    normalized_prefix = f"/{normalized_prefix.lstrip('/')}".rstrip("/")
    base_url = public_api_base_url.strip().rstrip("/")
    return f"{base_url}{normalized_prefix}/{normalized_local_path}"


def map_catalog_item_image(
    item: dict,
    *,
    public_api_base_url: str,
    static_assets_url_prefix: str,
) -> dict:
    mapped_item = dict(item)
    image = mapped_item.get("image")
    if not isinstance(image, dict):
        image = {}

    source_url = image.get("source_url") or image.get("url")
    static_url = build_static_image_url(
        image.get("local_path"),
        public_api_base_url=public_api_base_url,
        static_assets_url_prefix=static_assets_url_prefix,
    )
    mapped_item["image"] = {
        **image,
        "url": static_url or source_url,
        "source_url": source_url,
    }
    return mapped_item
