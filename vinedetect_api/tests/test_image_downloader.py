from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.image_downloader import build_image_path, download_images, download_one_image


class FakeRepo:
    def __init__(self, images: list[dict[str, Any]]) -> None:
        self.images = images
        self.downloaded: list[tuple[int, str, str | None, int]] = []
        self.failed: list[tuple[int, str]] = []
        self.calls: list[tuple[int, str | None]] = []

    def get_images_to_download(
        self,
        limit: int = 100,
        kind: str | None = None,
    ) -> list[dict[str, Any]]:
        self.calls.append((limit, kind))
        return self.images[:limit]

    def mark_image_downloaded(
        self,
        image_id: int,
        local_path: str,
        content_type: str | None,
        size_bytes: int,
    ) -> None:
        self.downloaded.append((image_id, local_path, content_type, size_bytes))

    def mark_image_download_failed(self, image_id: int, error: str) -> None:
        self.failed.append((image_id, error))


def image_row(image_id: int, url: str) -> dict[str, Any]:
    return {
        "id": image_id,
        "wine_id": 10,
        "kind": "bottle",
        "url": url,
    }


def response(content: bytes, content_type: str = "image/webp") -> httpx.Response:
    return httpx.Response(
        200,
        headers={"content-type": content_type},
        content=content,
    )


def test_build_image_path_uses_url_extension() -> None:
    url = "https://vino-svoe.ru/uploads/bottle.webp?size=large"

    path = build_image_path(
        output_dir=Path("data/images"),
        image_id=456,
        wine_id=123,
        kind="bottle",
        url=url,
    )

    sha8 = hashlib.sha256(url.encode("utf-8")).hexdigest()[:8]
    assert path == Path("data/images/bottle/123") / f"456_{sha8}.webp"


def test_build_image_path_uses_content_type_extension() -> None:
    path = build_image_path(
        output_dir=Path("data/images"),
        image_id=1,
        wine_id=2,
        kind="bad/kind",
        url="https://vino-svoe.ru/image?id=1",
        content_type="image/jpeg; charset=binary",
    )

    assert path.parent == Path("data/images/bad_kind/2")
    assert path.name.startswith("1_")
    assert path.suffix in {".jpg", ".jpeg"}


def test_download_one_image_writes_file(tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda request: response(b"fake-image"))
    image = image_row(1, "https://vino-svoe.ru/uploads/a.webp")

    with httpx.Client(transport=transport) as client:
        path, content_type, size_bytes = download_one_image(client, image, tmp_path)

    assert path.exists()
    assert path.read_bytes() == b"fake-image"
    assert content_type == "image/webp"
    assert size_bytes == len(b"fake-image")


def test_download_one_image_empty_body_raises(tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda request: response(b""))
    image = image_row(1, "https://vino-svoe.ru/uploads/a.webp")

    with httpx.Client(transport=transport) as client:
        with pytest.raises(ValueError, match="Empty response body"):
            download_one_image(client, image, tmp_path)


def test_download_images_success(tmp_path: Path) -> None:
    repo = FakeRepo(
        [
            image_row(1, "https://vino-svoe.ru/uploads/a.webp"),
            image_row(2, "https://vino-svoe.ru/uploads/b.webp"),
        ]
    )
    transport = httpx.MockTransport(lambda request: response(b"fake-image"))

    stats = download_images(
        repo=repo,
        output_dir=tmp_path,
        limit=2,
        kind="bottle",
        delay_min=0,
        delay_max=0,
        transport=transport,
    )

    assert stats.images_seen == 2
    assert stats.images_downloaded == 2
    assert stats.images_skipped == 0
    assert stats.images_failed == 0
    assert repo.calls == [(2, "bottle")]
    assert [item[0] for item in repo.downloaded] == [1, 2]
    assert repo.failed == []


def test_download_images_continues_after_error(tmp_path: Path) -> None:
    repo = FakeRepo(
        [
            image_row(1, "https://vino-svoe.ru/uploads/missing.webp"),
            image_row(2, "https://vino-svoe.ru/uploads/ok.webp"),
        ]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("missing.webp"):
            return httpx.Response(404, request=request)
        return response(b"fake-image")

    stats = download_images(
        repo=repo,
        output_dir=tmp_path,
        limit=2,
        delay_min=0,
        delay_max=0,
        transport=httpx.MockTransport(handler),
    )

    assert stats.images_seen == 2
    assert stats.images_downloaded == 1
    assert stats.images_failed == 1
    assert [item[0] for item in repo.downloaded] == [2]
    assert repo.failed[0][0] == 1


def test_download_images_non_positive_limit_does_not_call_repo(tmp_path: Path) -> None:
    class FailRepo:
        def get_images_to_download(self, limit: int, kind: str | None) -> list[Any]:
            raise AssertionError("repo should not be called")

    zero_stats = download_images(FailRepo(), output_dir=tmp_path, limit=0)
    negative_stats = download_images(FailRepo(), output_dir=tmp_path, limit=-1)

    assert zero_stats.images_seen == 0
    assert zero_stats.images_downloaded == 0
    assert zero_stats.images_skipped == 0
    assert zero_stats.images_failed == 0
    assert negative_stats.images_seen == 0
    assert negative_stats.images_downloaded == 0
    assert negative_stats.images_skipped == 0
    assert negative_stats.images_failed == 0

def test_download_images_sends_browser_like_headers(tmp_path: Path) -> None:
    repo = FakeRepo([image_row(1, "https://vino-svoe.ru/uploads/a.webp")])
    seen_headers: list[httpx.Headers] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_headers.append(request.headers)
        return response(b"fake-image")

    download_images(
        repo=repo,
        output_dir=tmp_path,
        limit=1,
        delay_min=0,
        delay_max=0,
        transport=httpx.MockTransport(handler),
    )

    assert seen_headers[0]["Referer"] == "https://vino-svoe.ru/"
    assert seen_headers[0]["Origin"] == "https://vino-svoe.ru"
    assert seen_headers[0]["Connection"] == "keep-alive"


def test_download_images_marks_existing_file_as_downloaded(
    tmp_path: Path,
) -> None:
    image = image_row(1, "https://vino-svoe.ru/uploads/a.webp")
    repo = FakeRepo([image])
    path = build_image_path(
        output_dir=tmp_path,
        image_id=image["id"],
        wine_id=image["wine_id"],
        kind=image["kind"],
        url=image["url"],
    )
    path.parent.mkdir(parents=True)
    path.write_bytes(b"already-downloaded")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("existing file should not be downloaded again")

    stats = download_images(
        repo=repo,
        output_dir=tmp_path,
        limit=1,
        delay_min=0,
        delay_max=0,
        transport=httpx.MockTransport(handler),
    )

    assert stats.images_seen == 1
    assert stats.images_downloaded == 0
    assert stats.images_skipped == 1
    assert stats.images_failed == 0
    assert repo.downloaded == [(1, str(path), None, len(b"already-downloaded"))]
    assert repo.failed == []
