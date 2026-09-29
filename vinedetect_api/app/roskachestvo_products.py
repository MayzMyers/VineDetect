"""Import helpers for the Roskachestvo products schema."""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

ROSKACHESTVO_BASE_URL = "https://rskrf.ru"
ROSKACHESTVO_WINES_PATH = "/rest/1/products/wine"


@dataclass(frozen=True)
class RoskachestvoProductsImportStats:
    products_seen: int
    products_saved: int
    products_skipped: int
    products_failed: int


@dataclass(frozen=True)
class RoskachestvoProductDetailsImportStats:
    products_seen: int
    details_saved: int
    details_skipped: int
    details_failed: int


@dataclass(frozen=True)
class RoskachestvoProductImageUrlImportStats:
    products_seen: int
    image_urls_saved: int
    pages_skipped: int
    pages_failed: int


@dataclass(frozen=True)
class RoskachestvoProductImageDownloadStats:
    products_seen: int
    images_downloaded: int
    images_skipped: int
    images_failed: int


@dataclass(frozen=True)
class RoskachestvoProductAuditStats:
    products_total: int
    detail_ok: int
    detail_failed: int
    page_ok: int
    page_failed: int
    image_download_ok: int
    image_download_failed: int
    image_local_path_filled: int
    files_existing: int
    files_missing: int
    files_zero_size: int
    files_size_mismatch: int
    db_size_total: int
    disk_size_total: int


class RoskachestvoProductsClient:
    def __init__(
        self,
        base_url: str = ROSKACHESTVO_BASE_URL,
        timeout: float = 30,
        user_agent: str = "Mozilla/5.0",
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.base_url = base_url
        self.timeout = timeout
        self.user_agent = user_agent
        self.transport = transport

    def fetch_wine_products(self) -> list[dict[str, Any]]:
        headers = {
            "User-Agent": self.user_agent,
            "Accept": "application/json",
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        }

        with httpx.Client(
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
            transport=self.transport,
            follow_redirects=True,
        ) as client:
            response = client.get(ROSKACHESTVO_WINES_PATH)
            response.raise_for_status()
            payload = response.json()

        if not isinstance(payload, dict):
            msg = "Roskachestvo response payload must be a JSON object"
            raise ValueError(msg)

        items = payload.get("response")
        if not isinstance(items, list):
            msg = "Roskachestvo response field must be a list"
            raise ValueError(msg)

        return [item for item in items if isinstance(item, dict)]

    def fetch_product_detail(self, product_id: str) -> dict[str, Any]:
        headers = {
            "User-Agent": self.user_agent,
            "Accept": "application/json",
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        }

        with httpx.Client(
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
            transport=self.transport,
            follow_redirects=True,
        ) as client:
            response = client.get(f"/rest/1/product/{product_id}/")
            response.raise_for_status()
            payload = response.json()

        if not isinstance(payload, dict):
            msg = "Roskachestvo product detail payload must be a JSON object"
            raise ValueError(msg)

        nested_response = payload.get("response")
        if isinstance(nested_response, dict):
            return nested_response

        if _looks_like_product_detail(payload):
            return payload

        msg = "Roskachestvo product detail payload does not contain product fields"
        raise ValueError(msg)

    def fetch_product_page(self, product_link: str) -> str:
        headers = {
            "User-Agent": self.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        }

        with httpx.Client(
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
            transport=self.transport,
            follow_redirects=True,
        ) as client:
            response = client.get(product_link)
            response.raise_for_status()
            return response.text

    def download_product_image(
        self,
        image_source_url: str,
    ) -> tuple[bytes, str | None]:
        headers = {
            "User-Agent": self.user_agent,
            "Accept": (
                "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
            ),
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        }

        with httpx.Client(
            base_url=self.base_url,
            headers=headers,
            timeout=self.timeout,
            transport=self.transport,
            follow_redirects=True,
        ) as client:
            response = client.get(image_source_url)
            response.raise_for_status()
            content = response.content
            content_type = response.headers.get("Content-Type")

        if not content:
            msg = "Downloaded image body is empty"
            raise ValueError(msg)
        if content_type and not content_type.lower().startswith("image/"):
            msg = f"Downloaded image content type is not image: {content_type}"
            raise ValueError(msg)

        return content, content_type


def import_roskachestvo_products_to_db(
    repo,
    client,
    limit: int | None = None,
    reset_list_errors: bool = False,
) -> RoskachestvoProductsImportStats:
    if reset_list_errors:
        repo.reset_roskachestvo_product_list_errors()

    products = client.fetch_wine_products()

    if limit is not None and limit > 0:
        products = products[:limit]

    products_saved = 0
    products_skipped = 0
    products_failed = 0

    for product in products:
        product_id = _product_id(product)
        if product_id is None:
            products_skipped += 1
            continue

        try:
            repo.upsert_roskachestvo_product_from_list_item(product)
        except Exception as exc:
            products_failed += 1
            repo.mark_roskachestvo_product_list_failed(product_id, str(exc))
        else:
            products_saved += 1

    return RoskachestvoProductsImportStats(
        products_seen=len(products),
        products_saved=products_saved,
        products_skipped=products_skipped,
        products_failed=products_failed,
    )


def import_roskachestvo_product_details_to_db(
    repo,
    client,
    limit: int | None = None,
    failed_only: bool = False,
    force: bool = False,
) -> RoskachestvoProductDetailsImportStats:
    products = repo.get_roskachestvo_products_for_detail_import(
        limit=limit,
        failed_only=failed_only,
        force=force,
    )

    details_saved = 0
    details_skipped = 0
    details_failed = 0

    for product in products:
        product_id = product["rskrf_product_id"]
        if (
            not force
            and product["detail_status"] == "ok"
            and product["raw_detail_json"] is not None
        ):
            details_skipped += 1
            continue

        try:
            detail = client.fetch_product_detail(product_id)
            repo.update_roskachestvo_product_detail(product_id, detail)
        except Exception as exc:
            repo.mark_roskachestvo_product_detail_failed(product_id, str(exc))
            details_failed += 1
        else:
            details_saved += 1

    return RoskachestvoProductDetailsImportStats(
        products_seen=len(products),
        details_saved=details_saved,
        details_skipped=details_skipped,
        details_failed=details_failed,
    )


def collect_roskachestvo_product_image_urls(
    repo,
    client,
    limit: int | None = None,
    failed_only: bool = False,
    force: bool = False,
) -> RoskachestvoProductImageUrlImportStats:
    products = repo.get_roskachestvo_products_for_image_url_import(
        limit=limit,
        failed_only=failed_only,
        force=force,
    )

    image_urls_saved = 0
    pages_skipped = 0
    pages_failed = 0

    for product in products:
        product_id = product["rskrf_product_id"]
        product_link = product["product_link"]
        if not product_link:
            pages_skipped += 1
            continue
        if not force and product["page_status"] == "ok" and product["image_source_url"]:
            pages_skipped += 1
            continue

        try:
            html = client.fetch_product_page(product_link)
            image_url = extract_roskachestvo_product_image_url(html)
            repo.update_roskachestvo_product_image_source_url(
                product_id,
                image_url,
                source_page_url=product_link,
            )
        except Exception as exc:
            repo.mark_roskachestvo_product_page_failed(product_id, str(exc))
            pages_failed += 1
        else:
            image_urls_saved += 1

    return RoskachestvoProductImageUrlImportStats(
        products_seen=len(products),
        image_urls_saved=image_urls_saved,
        pages_skipped=pages_skipped,
        pages_failed=pages_failed,
    )


def download_roskachestvo_product_images_to_storage(
    repo,
    client,
    storage_root: Path,
    limit: int | None = None,
    failed_only: bool = False,
    force: bool = False,
) -> RoskachestvoProductImageDownloadStats:
    products = repo.get_roskachestvo_products_for_image_download(
        limit=limit,
        failed_only=failed_only,
        force=force,
    )

    images_downloaded = 0
    images_skipped = 0
    images_failed = 0

    for product in products:
        product_id = product["rskrf_product_id"]
        image_source_url = product["image_source_url"]
        image_local_path = product.get("image_local_path")
        image_download_status = product.get("image_download_status")

        if not image_source_url:
            images_skipped += 1
            continue

        if not force and image_download_status == "ok" and image_local_path:
            existing_path = resolve_roskachestvo_product_image_path(
                storage_root,
                image_local_path,
            )
            if existing_path.exists() and existing_path.stat().st_size > 0:
                images_skipped += 1
                continue

        try:
            content, content_type = client.download_product_image(image_source_url)
            extension = guess_image_extension(content_type, image_source_url)
            relative_path = build_roskachestvo_product_image_relative_path(
                product_id,
                extension,
            )
            full_path = resolve_roskachestvo_product_image_path(
                storage_root,
                relative_path,
            )
            full_path.parent.mkdir(parents=True, exist_ok=True)

            tmp_path = full_path.with_suffix(full_path.suffix + ".tmp")
            tmp_path.write_bytes(content)
            tmp_path.replace(full_path)

            size_bytes = full_path.stat().st_size
            if size_bytes <= 0:
                msg = "Downloaded image file is empty"
                raise ValueError(msg)

            repo.update_roskachestvo_product_image_download(
                product_id,
                image_local_path=relative_path,
                image_content_type=content_type,
                image_size_bytes=size_bytes,
            )
        except Exception as exc:
            repo.mark_roskachestvo_product_image_download_failed(product_id, str(exc))
            images_failed += 1
        else:
            images_downloaded += 1

    return RoskachestvoProductImageDownloadStats(
        products_seen=len(products),
        images_downloaded=images_downloaded,
        images_skipped=images_skipped,
        images_failed=images_failed,
    )


def audit_roskachestvo_products(
    repo,
    storage_root: Path,
) -> tuple[
    RoskachestvoProductAuditStats,
    list[dict[str, Any]],
    list[dict[str, Any]],
]:
    rows = repo.get_roskachestvo_product_audit_rows()

    products_total = len(rows)
    detail_ok = _count_status(rows, "detail_status", "ok")
    detail_failed = _count_status(rows, "detail_status", "failed")
    page_ok = _count_status(rows, "page_status", "ok")
    page_failed = _count_status(rows, "page_status", "failed")
    image_download_ok = _count_status(rows, "image_download_status", "ok")
    image_download_failed = _count_status(rows, "image_download_status", "failed")
    image_local_path_filled = 0
    files_existing = 0
    files_missing = 0
    files_zero_size = 0
    files_size_mismatch = 0
    db_size_total = 0
    disk_size_total = 0
    missing_files: list[dict[str, Any]] = []
    size_mismatch_files: list[dict[str, Any]] = []

    for row in rows:
        image_size_bytes = row.get("image_size_bytes")
        if image_size_bytes is not None:
            db_size_total += int(image_size_bytes)

        image_local_path = row.get("image_local_path")
        if not image_local_path:
            continue

        image_local_path_filled += 1
        full_path = resolve_roskachestvo_product_image_path(
            storage_root,
            image_local_path,
        )
        problem = {
            "rskrf_product_id": row["rskrf_product_id"],
            "image_local_path": image_local_path,
            "image_size_bytes": image_size_bytes,
        }

        if not full_path.exists():
            files_missing += 1
            missing_files.append(problem)
            continue

        files_existing += 1
        disk_size_bytes = full_path.stat().st_size
        disk_size_total += disk_size_bytes
        if disk_size_bytes <= 0:
            files_zero_size += 1

        if image_size_bytes is not None and disk_size_bytes != int(image_size_bytes):
            files_size_mismatch += 1
            size_mismatch_files.append(
                {
                    **problem,
                    "disk_size_bytes": disk_size_bytes,
                },
            )

    stats = RoskachestvoProductAuditStats(
        products_total=products_total,
        detail_ok=detail_ok,
        detail_failed=detail_failed,
        page_ok=page_ok,
        page_failed=page_failed,
        image_download_ok=image_download_ok,
        image_download_failed=image_download_failed,
        image_local_path_filled=image_local_path_filled,
        files_existing=files_existing,
        files_missing=files_missing,
        files_zero_size=files_zero_size,
        files_size_mismatch=files_size_mismatch,
        db_size_total=db_size_total,
        disk_size_total=disk_size_total,
    )
    return stats, missing_files, size_mismatch_files


_IMAGE_EXTENSION_BY_CONTENT_TYPE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
_SUPPORTED_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")


def _count_status(rows: list[dict[str, Any]], key: str, status: str) -> int:
    return sum(1 for row in rows if row.get(key) == status)


def _product_id(item: dict[str, Any]) -> str | None:
    raw_product_id = item.get("id")
    if raw_product_id is None:
        return None

    product_id = str(raw_product_id).strip()
    return product_id or None


def _looks_like_product_detail(payload: dict[str, Any]) -> bool:
    detail_keys = {
        "id",
        "title",
        "name",
        "total_rating",
        "rating",
        "description",
        "product_link",
        "link",
        "url",
        "category_name",
        "manufacturer",
        "characteristics",
    }
    return any(key in payload for key in detail_keys)


class _RoskachestvoProductImageSourceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.found_target_container = False
        self.hrefs: list[str] = []
        self._inside_target_container = False
        self._target_container_depth = 0

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        attr_map = dict(attrs)
        if self._inside_target_container:
            self._target_container_depth += 1
            if tag == "a":
                href = attr_map.get("href")
                if href:
                    self.hrefs.append(href)
            return

        class_value = attr_map.get("class") or ""
        classes = set(class_value.split())
        if {"p-photo", "p-photo--single"}.issubset(classes):
            self.found_target_container = True
            self._inside_target_container = True
            self._target_container_depth = 1

    def handle_endtag(self, tag: str) -> None:
        if not self._inside_target_container:
            return

        self._target_container_depth -= 1
        if self._target_container_depth <= 0:
            self._inside_target_container = False
            self._target_container_depth = 0


# Roskachestvo product helpers.
ROSKACHESTVO_DETAIL_CHARACTERISTICS_KEYS = (
    "characteristics",
    "properties",
    "attrs",
    "params",
)
ROSKACHESTVO_DETAIL_EXCLUDED_CHARACTERISTICS_KEYS = {
    "id",
    "title",
    "name",
    "total_rating",
    "rating",
    "description",
    "product_link",
    "link",
    "url",
    "category_name",
    "manufacturer",
}


def build_roskachestvo_product_image_relative_path(
    product_id: str,
    extension: str,
) -> str:
    normalized_extension = extension if extension.startswith(".") else f".{extension}"
    return (
        f"roskachestvo/products/{str(product_id).strip()}"
        f"/original{normalized_extension}"
    )


def resolve_roskachestvo_product_image_path(
    storage_root: Path,
    relative_path: str,
) -> Path:
    return storage_root / relative_path


def guess_image_extension(
    content_type: str | None,
    image_source_url: str | None = None,
) -> str:
    if content_type:
        media_type = content_type.split(";", 1)[0].strip().lower()
        mapped_extension = _IMAGE_EXTENSION_BY_CONTENT_TYPE.get(media_type)
        if mapped_extension is not None:
            return mapped_extension

    lower_path = urlparse(image_source_url or "").path.lower()
    for extension in _SUPPORTED_IMAGE_EXTENSIONS:
        if lower_path.endswith(extension):
            return extension

    return ".bin"


def extract_roskachestvo_product_image_url(
    html: str,
    base_url: str = ROSKACHESTVO_BASE_URL,
) -> str | None:
    parser = _RoskachestvoProductImageSourceParser()
    parser.feed(html)
    parser.close()

    if not parser.found_target_container:
        return None

    for href in parser.hrefs:
        if _is_roskachestvo_image_href(href, base_url):
            return urljoin(base_url, href.strip())

    return None


def _is_roskachestvo_image_href(href: str, base_url: str) -> bool:
    href = href.strip()
    if not href:
        return False

    lower_href = href.lower()
    if (
        lower_href.startswith("#")
        or "#loginregister" in lower_href
        or lower_href.startswith("javascript:")
        or lower_href.startswith("mailto:")
    ):
        return False

    absolute = urljoin(base_url, href)
    parsed = urlparse(absolute)
    hostname = (parsed.hostname or "").lower()
    if hostname not in {"rskrf.ru", "www.rskrf.ru"}:
        return False

    lower_path = parsed.path.lower()
    return lower_path.startswith("/upload/") and lower_path.endswith(
        (".jpg", ".jpeg", ".png", ".webp"),
    )


def extract_roskachestvo_product_detail_fields(
    detail: dict[str, Any],
) -> dict[str, Any]:
    product_link = _first_present_detail_value(detail, "product_link", "link", "url")
    return {
        "title": _text_or_none(_first_present_detail_value(detail, "title", "name")),
        "total_rating": _first_present_detail_value(
            detail,
            "total_rating",
            "rating",
        ),
        "description": _text_or_none(detail.get("description")),
        "product_link": _text_or_none(product_link),
        "source_page_url": _text_or_none(product_link),
        "category_name": _text_or_none(detail.get("category_name")),
        "manufacturer": _text_or_none(detail.get("manufacturer")),
        "characteristics": _extract_roskachestvo_product_characteristics(detail),
    }


def _first_present_detail_value(detail: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = detail.get(key)
        if value not in (None, ""):
            return value
    return None


def _text_or_none(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, dict):
        nested_value = _first_present_detail_value(value, "title", "name")
        return _text_or_none(nested_value)
    if isinstance(value, list):
        return None

    text = str(value).strip()
    return text or None


def _extract_roskachestvo_product_characteristics(detail: dict[str, Any]) -> Any:
    for key in ROSKACHESTVO_DETAIL_CHARACTERISTICS_KEYS:
        value = detail.get(key)
        if isinstance(value, dict | list):
            return value

    return {
        key: value
        for key, value in detail.items()
        if key not in ROSKACHESTVO_DETAIL_EXCLUDED_CHARACTERISTICS_KEYS
    }
