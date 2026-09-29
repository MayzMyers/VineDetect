from __future__ import annotations

from typing import Any

import pytest

from app.image_storage_migration import (
    ImageStorageMigrationError,
    build_source_roots,
    migrate_image_storage,
    normalize_image_storage_path,
)
from app.repositories import WineRepository


class FakeRepo:
    def __init__(
        self,
        *,
        wine_rows: list[dict[str, Any]] | None = None,
        roskachestvo_rows: list[dict[str, Any]] | None = None,
    ) -> None:
        self.wine_rows = wine_rows or []
        self.roskachestvo_rows = roskachestvo_rows or []
        self.wine_updates: list[tuple[int, str]] = []
        self.roskachestvo_updates: list[tuple[int, str]] = []

    def get_wine_image_storage_rows(self) -> list[dict[str, Any]]:
        return self.wine_rows

    def get_roskachestvo_image_storage_rows(self) -> list[dict[str, Any]]:
        return self.roskachestvo_rows

    def update_wine_image_local_path(
        self,
        image_id: int,
        new_local_path: str,
    ) -> None:
        self.wine_updates.append((image_id, new_local_path))

    def update_roskachestvo_product_image_local_path(
        self,
        product_id: int,
        new_local_path: str,
    ) -> None:
        self.roskachestvo_updates.append((product_id, new_local_path))


@pytest.mark.parametrize(
    ("source", "local_path", "expected"),
    [
        (
            "svoe_vino",
            "data/images/bottle/435/file.webp",
            "svoe_vino/bottle/435/file.webp",
        ),
        (
            "roskachestvo",
            "roskachestvo/products/3946117/original.jpg",
            "roskachestvo/products/3946117/original.jpg",
        ),
        (
            "roskachestvo",
            "storage/roskachestvo/products/3946117/original.jpg",
            "roskachestvo/products/3946117/original.jpg",
        ),
        (
            "svoe_vino",
            "svoe_vino/bottle/435/file.webp",
            "svoe_vino/bottle/435/file.webp",
        ),
        (
            "svoe_vino",
            r"data\images\bottle\435\file.webp",
            "svoe_vino/bottle/435/file.webp",
        ),
    ],
)
def test_normalize_image_storage_path(source, local_path, expected):
    assert normalize_image_storage_path(source, local_path) == expected


@pytest.mark.parametrize(
    "local_path",
    [
        "/abs/path.jpg",
        "../x.jpg",
        "a/../../x.jpg",
        r"C:\abs\path.jpg",
    ],
)
def test_dangerous_paths_rejected(local_path):
    with pytest.raises(ImageStorageMigrationError):
        normalize_image_storage_path("svoe_vino", local_path)


def test_build_source_roots_includes_fallbacks_and_extra_roots(tmp_path):
    roots = build_source_roots(tmp_path, extra_roots=[tmp_path / "extra"])

    assert roots[:4] == [
        tmp_path.resolve(),
        (tmp_path / "storage").resolve(),
        (tmp_path / "vinedetect_api").resolve(),
        (tmp_path / "vinedetect_api" / "storage").resolve(),
    ]
    assert (tmp_path / "extra").resolve() in roots


def test_migrate_image_storage_dry_run_does_not_copy_or_update(tmp_path):
    source_root = tmp_path / "legacy"
    target_root = tmp_path / "target"
    source_file = source_root / "data/images/bottle/435/file.webp"
    source_file.parent.mkdir(parents=True)
    source_file.write_bytes(b"image")
    repo = FakeRepo(
        wine_rows=[
            {
                "source": "svoe_vino",
                "id": 10,
                "owner_id": 435,
                "local_path": "data/images/bottle/435/file.webp",
            },
        ],
    )

    report = migrate_image_storage(
        repo,
        source_root=source_root,
        target_root=target_root,
        dry_run=True,
    )

    assert report.svoe_vino.expected == 1
    assert report.svoe_vino.copied == 1
    assert report.svoe_vino.updated == 1
    assert not (target_root / "svoe_vino/bottle/435/file.webp").exists()
    assert repo.wine_updates == []


def test_migrate_image_storage_real_run_copies_and_updates(tmp_path):
    source_root = tmp_path / "legacy"
    target_root = tmp_path / "target"
    source_file = source_root / "data/images/bottle/435/file.webp"
    source_file.parent.mkdir(parents=True)
    source_file.write_bytes(b"image")
    repo = FakeRepo(
        wine_rows=[
            {
                "source": "svoe_vino",
                "id": 10,
                "owner_id": 435,
                "local_path": "data/images/bottle/435/file.webp",
            },
        ],
    )

    report = migrate_image_storage(
        repo,
        source_root=source_root,
        target_root=target_root,
    )

    target_file = target_root / "svoe_vino/bottle/435/file.webp"
    assert target_file.read_bytes() == b"image"
    assert report.svoe_vino.copied == 1
    assert report.svoe_vino.updated == 1
    assert repo.wine_updates == [(10, "svoe_vino/bottle/435/file.webp")]


def test_migrate_image_storage_updates_roskachestvo_rows(tmp_path):
    source_root = tmp_path / "legacy"
    target_root = tmp_path / "target"
    source_file = source_root / "storage/roskachestvo/products/3946117/original.jpg"
    source_file.parent.mkdir(parents=True)
    source_file.write_bytes(b"jpg")
    repo = FakeRepo(
        roskachestvo_rows=[
            {
                "source": "roskachestvo",
                "id": 20,
                "owner_id": "3946117",
                "local_path": "storage/roskachestvo/products/3946117/original.jpg",
            },
        ],
    )

    report = migrate_image_storage(
        repo,
        source_root=source_root,
        target_root=target_root,
    )

    assert (
        target_root / "roskachestvo/products/3946117/original.jpg"
    ).read_bytes() == b"jpg"
    assert report.roskachestvo.copied == 1
    assert repo.roskachestvo_updates == [
        (20, "roskachestvo/products/3946117/original.jpg"),
    ]


def test_migrate_image_storage_rerun_counts_existing_and_unchanged(tmp_path):
    source_root = tmp_path / "legacy"
    target_root = tmp_path / "target"
    target_file = target_root / "svoe_vino/bottle/435/file.webp"
    target_file.parent.mkdir(parents=True)
    target_file.write_bytes(b"image")
    repo = FakeRepo(
        wine_rows=[
            {
                "source": "svoe_vino",
                "id": 10,
                "owner_id": 435,
                "local_path": "svoe_vino/bottle/435/file.webp",
            },
        ],
    )

    report = migrate_image_storage(
        repo,
        source_root=source_root,
        target_root=target_root,
    )

    assert report.svoe_vino.existing == 1
    assert report.svoe_vino.unchanged == 1
    assert report.svoe_vino.copied == 0
    assert not (target_root / "svoe_vino/bottle/435/svoe_vino").exists()
    assert repo.wine_updates == []


def test_migrate_image_storage_missing_source_does_not_update(tmp_path):
    repo = FakeRepo(
        wine_rows=[
            {
                "source": "svoe_vino",
                "id": 10,
                "owner_id": 435,
                "local_path": "data/images/bottle/435/missing.webp",
            },
        ],
    )

    report = migrate_image_storage(
        repo,
        source_root=tmp_path / "legacy",
        target_root=tmp_path / "target",
    )

    assert report.svoe_vino.missing == 1
    assert report.has_missing is True
    assert repo.wine_updates == []


def test_migrate_image_storage_finds_files_in_extra_root(tmp_path):
    extra_root = tmp_path / "extra"
    source_file = extra_root / "data/images/bottle/435/file.webp"
    source_file.parent.mkdir(parents=True)
    source_file.write_bytes(b"image")
    repo = FakeRepo(
        wine_rows=[
            {
                "source": "svoe_vino",
                "id": 10,
                "owner_id": 435,
                "local_path": "data/images/bottle/435/file.webp",
            },
        ],
    )

    report = migrate_image_storage(
        repo,
        source_root=tmp_path / "empty",
        target_root=tmp_path / "target",
        extra_roots=[extra_root],
    )

    assert report.svoe_vino.copied == 1
    assert (tmp_path / "target/svoe_vino/bottle/435/file.webp").exists()


class FakeCursor:
    def __init__(self) -> None:
        self.executed: list[tuple[str, Any]] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query, params=None) -> None:
        self.executed.append((query, params))

    def fetchall(self):
        return []


class FakeConnection:
    def __init__(self) -> None:
        self.cursor_obj = FakeCursor()
        self.commits = 0

    def cursor(self):
        return self.cursor_obj

    def commit(self) -> None:
        self.commits += 1


def test_repository_image_storage_sql_shape():
    connection = FakeConnection()
    repo = WineRepository(connection=connection)

    repo.get_wine_image_storage_rows()
    repo.get_roskachestvo_image_storage_rows()
    repo.update_wine_image_local_path(1, "svoe_vino/bottle/1/file.webp")
    repo.update_roskachestvo_product_image_local_path(
        2,
        "roskachestvo/products/2/original.jpg",
    )

    queries = [query for query, _params in connection.cursor_obj.executed]
    assert "FROM svoe_vino.wine_images" in queries[0]
    assert "local_path" in queries[0]
    assert "FROM roskachestvo.products" in queries[1]
    assert "image_local_path AS local_path" in queries[1]
    assert "UPDATE svoe_vino.wine_images" in queries[2]
    assert "SET local_path = %s" in queries[2]
    assert "UPDATE roskachestvo.products" in queries[3]
    assert "SET image_local_path = %s" in queries[3]
    assert connection.commits == 2