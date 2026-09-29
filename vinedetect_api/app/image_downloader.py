"""Download image assets from wine_images to local storage."""

from __future__ import annotations

import hashlib
import mimetypes
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

ALLOWED_URL_EXTENSIONS = {".webp", ".jpg", ".jpeg", ".png"}


@dataclass(frozen=True)
class ImageDownloadStats:
    images_seen: int
    images_downloaded: int
    images_skipped: int
    images_failed: int


def build_image_path(
    output_dir: Path,
    image_id: int,
    wine_id: int,
    kind: str,
    url: str,
    content_type: str | None = None,
) -> Path:
    sha8 = hashlib.sha256(url.encode("utf-8")).hexdigest()[:8]
    safe_kind = _safe_path_part(kind)
    extension = _extension_from_url(url) or _extension_from_content_type(content_type)
    filename = f"{image_id}_{sha8}{extension or '.bin'}"
    return output_dir / safe_kind / str(wine_id) / filename


def download_one_image(
    client: httpx.Client,
    image: dict[str, Any],
    output_dir: Path,
) -> tuple[Path, str | None, int]:
    existing_path = build_image_path(
        output_dir=output_dir,
        image_id=image["id"],
        wine_id=image["wine_id"],
        kind=image["kind"],
        url=image["url"],
    )
    if existing_path.exists() and existing_path.stat().st_size > 0:
        return existing_path, None, existing_path.stat().st_size

    response = client.get(image["url"])
    response.raise_for_status()

    content = response.content
    if not content:
        msg = f"Empty response body for image {image['id']}"
        raise ValueError(msg)

    content_type = response.headers.get("content-type")
    path = build_image_path(
        output_dir=output_dir,
        image_id=image["id"],
        wine_id=image["wine_id"],
        kind=image["kind"],
        url=image["url"],
        content_type=content_type,
    )
    if path.exists() and path.stat().st_size > 0:
        return path, content_type, path.stat().st_size

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path, content_type, len(content)


def download_images(
    repo: Any,
    output_dir: str | Path = "data/images",
    limit: int = 100,
    kind: str | None = None,
    delay_min: float = 0.5,
    delay_max: float = 2.0,
    timeout: float = 30,
    user_agent: str = "Mozilla/5.0",
    transport: httpx.BaseTransport | None = None,
) -> ImageDownloadStats:
    if limit <= 0:
        return ImageDownloadStats(
            images_seen=0,
            images_downloaded=0,
            images_skipped=0,
            images_failed=0,
        )

    images = repo.get_images_to_download(limit=limit, kind=kind)
    output_path = Path(output_dir)
    downloaded = 0
    skipped = 0
    failed = 0

    headers = {
        "User-Agent": user_agent,
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        "Referer": "https://vino-svoe.ru/",
        "Origin": "https://vino-svoe.ru",
        "Connection": "keep-alive",
    }
    with httpx.Client(
        headers=headers,
        timeout=timeout,
        transport=transport,
        follow_redirects=True,
    ) as client:
        for image in images:
            sleep_for = _sleep_seconds(delay_min, delay_max)
            if sleep_for > 0:
                time.sleep(sleep_for)

            try:
                expected_path = build_image_path(
                    output_dir=output_path,
                    image_id=image["id"],
                    wine_id=image["wine_id"],
                    kind=image["kind"],
                    url=image["url"],
                )
                existed = expected_path.exists() and expected_path.stat().st_size > 0
                path, content_type, size_bytes = download_one_image(
                    client=client,
                    image=image,
                    output_dir=output_path,
                )
                repo.mark_image_downloaded(
                    image_id=image["id"],
                    local_path=str(path),
                    content_type=content_type,
                    size_bytes=size_bytes,
                )
                if existed:
                    skipped += 1
                else:
                    downloaded += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                repo.mark_image_download_failed(image_id=image["id"], error=str(exc))

    return ImageDownloadStats(
        images_seen=len(images),
        images_downloaded=downloaded,
        images_skipped=skipped,
        images_failed=failed,
    )


def _safe_path_part(value: str) -> str:
    safe = (
        "".join(
            char if char.isalnum() or char in {"_", "-"} else "_"
            for char in value
        )
    )
    return safe or "unknown"


def _extension_from_url(url: str) -> str | None:
    suffix = Path(urlparse(url).path).suffix.lower()
    if suffix in ALLOWED_URL_EXTENSIONS:
        return suffix
    return None


def _extension_from_content_type(content_type: str | None) -> str | None:
    if not content_type:
        return None
    clean_content_type = content_type.split(";", 1)[0].strip().lower()
    return mimetypes.guess_extension(clean_content_type)


def _sleep_seconds(delay_min: float, delay_max: float) -> float:
    if delay_min <= 0 and delay_max <= 0:
        return 0
    if delay_max < delay_min:
        delay_min, delay_max = delay_max, delay_min
    return random.uniform(max(delay_min, 0), max(delay_max, 0))
