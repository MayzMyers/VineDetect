from __future__ import annotations

from types import SimpleNamespace

import app.main as main
from app.repositories import WineRepository

BASE_SNAPSHOT = {
    "wines_total": 10,
    "wines_with_image_url": 8,
    "wines_with_raw_detail_json": 7,
    "wine_images_total": 12,
    "wine_images_with_local_path": 11,
    "roskachestvo_products_total": 20,
    "roskachestvo_with_barcode": 18,
    "roskachestvo_with_detail_json": 17,
    "roskachestvo_with_product_link": 16,
    "roskachestvo_with_image_source_url": 15,
    "roskachestvo_with_image_local_path": 14,
    "roskachestvo_detail_ok": 13,
    "roskachestvo_detail_failed": 1,
    "roskachestvo_page_ok": 12,
    "roskachestvo_page_failed": 2,
    "roskachestvo_image_download_ok": 11,
    "roskachestvo_image_download_failed": 3,
    "roskachestvo_matches_total": 9,
    "roskachestvo_matches_joined_to_products": 9,
    "roskachestvo_matches_not_joined": 0,
    "roskachestvo_barcode_links_total": 6,
    "roskachestvo_barcode_links_joined_to_products": 6,
    "roskachestvo_barcode_links_not_joined": 0,
    "legacy_roskachestvo_wines_exists": False,
}


def snapshot_with(**overrides):
    snapshot = BASE_SNAPSHOT.copy()
    snapshot.update(overrides)
    return snapshot


def test_format_release_snapshot_contains_expected_sections() -> None:
    output = main.format_release_snapshot(BASE_SNAPSHOT)

    for section in [
        "Svoe Vino",
        "Roskachestvo",
        "Matching",
        "Barcodes",
        "Legacy",
        "API",
    ]:
        assert section in output


def test_format_release_snapshot_renders_false_legacy_flag() -> None:
    output = main.format_release_snapshot(
        snapshot_with(legacy_roskachestvo_wines_exists=False),
    )

    assert "public.roskachestvo_wines exists: false" in output
    assert "Warnings:" not in output


def test_format_release_snapshot_renders_implemented_catalog_api() -> None:
    output = main.format_release_snapshot(BASE_SNAPSHOT)

    assert "Read-only catalog API: implemented" in output
    assert "GET /api/v1/catalog?source=all" in output
    assert "GET /api/v1/catalog?source=svoe_vino" in output
    assert "GET /api/v1/catalog?source=roskachestvo" in output
    assert "not implemented yet" not in output
    assert "Planned: GET /api/v1/catalog" not in output


def test_format_release_snapshot_renders_warnings() -> None:
    output = main.format_release_snapshot(
        snapshot_with(
            roskachestvo_matches_not_joined=2,
            roskachestvo_barcode_links_not_joined=3,
            legacy_roskachestvo_wines_exists=True,
        ),
    )

    assert "Warnings:" in output
    assert "Roskachestvo matches not joined to roskachestvo.products: 2" in output
    assert "Roskachestvo barcode links not joined to roskachestvo.products: 3" in output
    assert "public.roskachestvo_wines still exists" in output
    assert "public.roskachestvo_wines exists: true" in output


class FakeCursor:
    def __init__(self) -> None:
        self.query = ""
        self.params = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query, params=None) -> None:
        self.query = query
        self.params = params

    def fetchone(self):
        return BASE_SNAPSHOT


class FakeConnection:
    def __init__(self) -> None:
        self.cursor_instance = FakeCursor()
        self.commits = 0

    def cursor(self):
        return self.cursor_instance

    def commit(self) -> None:
        self.commits += 1


class FakeReleaseSnapshotRepo:
    instances = []

    def __init__(self, database_url) -> None:
        self.database_url = database_url
        self.closed = False
        FakeReleaseSnapshotRepo.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.closed = True

    def get_release_snapshot(self):
        return BASE_SNAPSHOT


def test_get_release_snapshot_sql_shape_is_read_only() -> None:
    connection = FakeConnection()
    repo = WineRepository(connection=connection)

    snapshot = repo.get_release_snapshot()

    sql = connection.cursor_instance.query.lower()
    assert snapshot == BASE_SNAPSHOT
    assert connection.cursor_instance.params == {
        "source": "roskachestvo",
        "legacy_table": "public.roskachestvo_wines",
    }
    assert "from roskachestvo.products" in sql
    assert "svoe_vino.wine_external_matches" in sql
    assert "svoe_vino.wine_barcodes" in sql
    assert "to_regclass" in sql
    assert "insert" not in sql
    assert "update" not in sql
    assert "delete" not in sql
    assert connection.commits == 0


def test_main_dispatches_release_snapshot(monkeypatch, capsys) -> None:
    FakeReleaseSnapshotRepo.instances = []
    monkeypatch.setattr(
        main,
        "get_config",
        lambda: SimpleNamespace(database_url="postgresql://example/db"),
    )
    monkeypatch.setattr(main, "WineRepository", FakeReleaseSnapshotRepo)

    exit_code = main.main(["release-snapshot"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Wine crawler release snapshot" in output
    assert "Read-only catalog API: implemented" in output
    assert "not implemented yet" not in output
    assert len(FakeReleaseSnapshotRepo.instances) == 1
    fake_repo = FakeReleaseSnapshotRepo.instances[0]
    assert fake_repo.database_url == "postgresql://example/db"
    assert fake_repo.closed is True
