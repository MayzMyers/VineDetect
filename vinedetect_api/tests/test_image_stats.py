from __future__ import annotations

from pathlib import Path
from typing import Any

from app.image_stats import ImageStats, collect_image_stats, format_image_stats


class FakeRepo:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def get_image_rows_for_stats(
        self,
        kind: str | None = "bottle",
    ) -> list[dict[str, Any]]:
        if kind is None:
            return self.rows
        return [row for row in self.rows if row["kind"] == kind]


def image_row(
    image_id: int,
    local_path: str | None,
    download_status: str | None = "ok",
    size_bytes: int | None = None,
    kind: str = "bottle",
) -> dict[str, Any]:
    return {
        "id": image_id,
        "wine_id": image_id + 100,
        "kind": kind,
        "url": f"https://example.com/{image_id}.webp",
        "local_path": local_path,
        "download_status": download_status,
        "download_error": None,
        "content_type": "image/webp",
        "size_bytes": size_bytes,
        "downloaded_at": None,
    }


def test_collect_image_stats_all_ok(tmp_path: Path) -> None:
    first = tmp_path / "data/images/bottle/101/1.webp"
    second = tmp_path / "data/images/bottle/102/2.webp"
    first.parent.mkdir(parents=True)
    second.parent.mkdir(parents=True)
    first.write_bytes(b"first")
    second.write_bytes(b"second-image")
    rows = [
        image_row(1, "data/images/bottle/101/1.webp", size_bytes=5),
        image_row(2, "data/images/bottle/102/2.webp", size_bytes=12),
    ]

    stats = collect_image_stats(FakeRepo(rows), base_dir=tmp_path)

    assert stats.images_total == 2
    assert stats.status_counts == {"ok": 2}
    assert stats.files_existing == 2
    assert stats.files_missing == 0
    assert stats.files_zero_size == 0
    assert stats.local_path_filled == 2
    assert stats.db_size_total == 17
    assert stats.disk_size_total == 17
    assert stats.size_min == 5
    assert stats.size_max == 12
    assert stats.size_avg == 8.5


def test_collect_image_stats_missing_file(tmp_path: Path) -> None:
    rows = [image_row(10, "data/images/missing.webp", size_bytes=10)]

    stats = collect_image_stats(FakeRepo(rows), base_dir=tmp_path)

    assert stats.files_missing == 1
    assert stats.missing_files[0]["id"] == 10


def test_collect_image_stats_zero_size_file(tmp_path: Path) -> None:
    file_path = tmp_path / "data/images/zero.webp"
    file_path.parent.mkdir(parents=True)
    file_path.write_bytes(b"")
    rows = [image_row(11, "data/images/zero.webp", size_bytes=0)]

    stats = collect_image_stats(FakeRepo(rows), base_dir=tmp_path)

    assert stats.files_zero_size == 1
    assert stats.zero_size_files[0]["id"] == 11
    assert stats.files_existing == 0


def test_collect_image_stats_pending_status(tmp_path: Path) -> None:
    rows = [image_row(12, None, download_status=None, size_bytes=None)]

    stats = collect_image_stats(FakeRepo(rows), base_dir=tmp_path)

    assert stats.status_counts == {"pending": 1}
    assert stats.files_missing == 0
    assert stats.local_path_filled == 0


def test_collect_image_stats_filters_kind(tmp_path: Path) -> None:
    bottle = tmp_path / "bottle.webp"
    bottle.write_bytes(b"bottle")
    rows = [
        image_row(1, "bottle.webp", kind="bottle"),
        image_row(2, "region.webp", kind="region"),
    ]

    stats = collect_image_stats(FakeRepo(rows), base_dir=tmp_path, kind="bottle")

    assert stats.images_total == 1
    assert stats.files_existing == 1


def test_format_image_stats() -> None:
    stats = ImageStats(
        images_total=2,
        status_counts={"ok": 2},
        local_path_filled=2,
        files_existing=2,
        files_missing=0,
        files_zero_size=0,
        db_size_total=100,
        disk_size_total=100,
        size_min=40,
        size_max=60,
        size_avg=50.0,
        missing_files=[],
        zero_size_files=[],
    )

    output = format_image_stats(stats)

    assert "Image stats" in output
    assert "Images total: 2" in output
    assert "Files existing: 2" in output
    assert "Download statuses:" in output
    assert "ok: 2" in output
    assert "no data" in output
