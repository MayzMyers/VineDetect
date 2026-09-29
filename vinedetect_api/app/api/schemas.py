"""Pydantic schemas for the HTTP catalog API."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str
    role: Literal["admin", "annotator", "ml-service"]


class AuthPrincipalResponse(BaseModel):
    username: str
    role: Literal["admin", "annotator", "ml-service"]
    actor_type: Literal["human", "ml-agent"]


class HealthResponse(BaseModel):
    status: str
    service: str
    database: str


class WineImageResponse(BaseModel):
    id: int
    kind: str
    url: str
    local_path: str | None = None
    download_status: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None


class WineSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    slug: str
    title: str
    category_name: str | None = None
    manufacturer_name: str | None = None
    region_name: str | None = None
    public_rating: Decimal | None = None
    image_url: str | None = None
    color: str | None = None
    alcohol: Decimal | None = None
    source: str | None = None
    external_id: str | None = None


class WineDetail(WineSummary):
    manufacturer_slug: str | None = None
    temperature: str | None = None
    description: str | None = None
    image_alt: str | None = None
    source_url: str | None = None
    source_updated_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    grapes: list[str] = Field(default_factory=list)
    dishes: list[str] = Field(default_factory=list)
    barcodes: list[str] = Field(default_factory=list)
    images: list[WineImageResponse] = Field(default_factory=list)


class WineListResponse(BaseModel):
    items: list[WineSummary]
    total: int
    limit: int
    offset: int


class CatalogImage(BaseModel):
    url: str | None = None
    local_path: str | None = None
    source_url: str | None = None
    content_type: str | None = None
    size_bytes: int | None = None


class OfficialWineDetail(WineDetail):
    official_slug: str
    official_reference: CatalogImage | None = None


class CatalogItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    source: str
    external_id: str
    recognition_key: str = Field(alias="recognitionKey")
    local_id: int | None = None
    title: str | None = None
    manufacturer: str | None = None
    category: str | None = None
    region: str | None = None
    year: int | None = None
    rating: str | None = None
    barcode: str | None = None
    description: str | None = None
    source_url: str | None = None
    image: CatalogImage

    @field_validator("rating", mode="before")
    @classmethod
    def stringify_rating(cls, value):
        if value is None:
            return None
        return str(value)


class CatalogResponse(BaseModel):
    items: list[CatalogItem]
    source: str
    limit: int
    offset: int
    count: int


class WineBaseInput(BaseModel):
    category_name: str | None = None
    manufacturer_name: str | None = None
    manufacturer_slug: str | None = None
    region_name: str | None = None
    alcohol: Annotated[Decimal | None, Field(ge=0)] = None
    temperature: str | None = None
    color: str | None = None
    description: str | None = None
    public_rating: Annotated[Decimal | None, Field(ge=0, le=100)] = None
    image_url: str | None = None
    image_alt: str | None = None
    source: str | None = None
    external_id: str | None = None
    source_url: str | None = None
    source_updated_at: datetime | None = None
    grapes: list[str] | None = None
    dishes: list[str] | None = None
    barcodes: list[str] | None = None

    @field_validator(
        "category_name",
        "manufacturer_name",
        "manufacturer_slug",
        "region_name",
        "temperature",
        "color",
        "description",
        "image_url",
        "image_alt",
        "source",
        "external_id",
        "source_url",
        mode="before",
    )
    @classmethod
    def strip_optional_string(cls, value):
        if value is None:
            return None
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value

    @field_validator("grapes", "dishes", mode="before")
    @classmethod
    def normalize_relation_names(cls, value):
        if value is None:
            return None
        return _normalize_non_empty_strings(value, "relation name")

    @field_validator("barcodes", mode="before")
    @classmethod
    def normalize_barcodes(cls, value):
        if value is None:
            return None
        normalized = _normalize_non_empty_strings(value, "barcode")
        for barcode in normalized:
            validate_barcode(barcode)
        return normalized


class WineCreate(WineBaseInput):
    slug: str
    title: str
    source: str | None = "manual"
    grapes: list[str] | None = Field(default_factory=list)
    dishes: list[str] | None = Field(default_factory=list)
    barcodes: list[str] | None = Field(default_factory=list)

    @field_validator("slug", "title", mode="before")
    @classmethod
    def strip_required_string(cls, value):
        if isinstance(value, str):
            value = value.strip()
        if not value:
            msg = "value must be a non-empty string"
            raise ValueError(msg)
        return value


class WineUpdate(WineBaseInput):
    slug: str | None = None
    title: str | None = None

    @field_validator("slug", "title", mode="before")
    @classmethod
    def strip_optional_required_string(cls, value):
        if value is None:
            return None
        if isinstance(value, str):
            value = value.strip()
        if not value:
            msg = "value must be a non-empty string"
            raise ValueError(msg)
        return value


def validate_barcode(barcode: str) -> None:
    if not barcode.isdigit() or len(barcode) not in {8, 12, 13, 14}:
        msg = "barcode must contain 8, 12, 13, or 14 digits"
        raise ValueError(msg)


def _normalize_non_empty_strings(value, item_name: str) -> list[str]:
    if not isinstance(value, list):
        msg = f"{item_name} list is required"
        raise ValueError(msg)

    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            msg = f"{item_name} must be a string"
            raise ValueError(msg)
        stripped = item.strip()
        if not stripped:
            msg = f"empty {item_name} is not allowed"
            raise ValueError(msg)
        key = stripped.casefold()
        if key not in seen:
            seen.add(key)
            result.append(stripped)
    return result


class RecognitionReference(BaseModel):
    slug: str
    keywords: list[str]


class RecognitionReferencesResponse(BaseModel):
    schemaVersion: Literal["references/1"] = "references/1"
    items: list[RecognitionReference]
