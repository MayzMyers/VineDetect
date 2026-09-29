from __future__ import annotations

from typing import Any

from app.repositories import WineRepository


class FakeCursor:
    def __init__(self, connection: FakeConnection) -> None:
        self.connection = connection
        self.result = connection.results.pop(0) if connection.results else None
        self.rowcount = connection.rowcount

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def execute(self, query: str, params: Any = None) -> None:
        self.connection.executed.append((query, params))

    def fetchone(self) -> dict[str, Any]:
        if isinstance(self.result, dict):
            return self.result
        if isinstance(self.result, list) and self.result:
            return self.result[0]
        return {"id": 1}

    def fetchall(self) -> list[dict[str, Any]]:
        if isinstance(self.result, list):
            return self.result
        return []


class FakeConnection:
    def __init__(
        self,
        results: list[Any] | None = None,
        rowcount: int = 0,
    ) -> None:
        self.results = list(results or [])
        self.rowcount = rowcount
        self.executed: list[tuple[str, Any]] = []
        self.commits = 0

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def close(self) -> None:
        return None


def make_repo(
    results: list[Any] | None = None,
    rowcount: int = 0,
) -> tuple[WineRepository, FakeConnection]:
    connection = FakeConnection(results=results, rowcount=rowcount)
    return WineRepository(connection=connection), connection


def compact(sql: str) -> str:
    return " ".join(sql.split())


def last_sql(connection: FakeConnection) -> str:
    return compact(connection.executed[-1][0])


def test_upsert_roskachestvo_product_from_list_item_uses_products_upsert() -> None:
    repo, connection = make_repo(results=[{"id": 42}])

    product_id = repo.upsert_roskachestvo_product_from_list_item(
        {"id": "p1", "name": "Wine", "barcode": "4601", "rating": "4.2"},
    )

    sql = last_sql(connection)
    assert product_id == 42
    assert "INSERT INTO roskachestvo.products" in sql
    assert "ON CONFLICT (rskrf_product_id)" in sql
    assert "roskachestvo_wines" not in sql
    assert connection.executed[-1][1][0] == "p1"
    assert connection.commits == 1


def test_update_roskachestvo_product_detail_marks_ok_and_writes_raw_json() -> None:
    repo, connection = make_repo()

    repo.update_roskachestvo_product_detail(
        "p1",
        {
            "title": "Detail Wine",
            "rating": "4.4",
            "description": "Text",
            "link": "https://rskrf.example/products/p1",
            "category_name": "Wine",
            "manufacturer": {"name": "Winery"},
            "characteristics": {"color": "red"},
        },
    )

    sql = last_sql(connection)
    params = connection.executed[-1][1]
    assert "UPDATE roskachestvo.products" in sql
    assert "detail_status = 'ok'" in sql
    assert "detail_error = NULL" in sql
    assert "raw_detail_json = %s" in sql
    assert "roskachestvo_wines" not in sql
    assert params[0] == "Detail Wine"
    assert params[6] == "Winery"
    assert params[-1] == "p1"
    assert connection.commits == 1


def test_failed_methods_set_target_status_and_error() -> None:
    repo, connection = make_repo()

    repo.mark_roskachestvo_product_detail_failed("p1", "detail bad")
    repo.mark_roskachestvo_product_page_failed("p2", "page bad")
    repo.mark_roskachestvo_product_image_download_failed("p3", "image bad")

    statements = [compact(query) for query, _params in connection.executed]
    assert "detail_status = 'failed'" in statements[0]
    assert "detail_error = %s" in statements[0]
    assert "page_status = 'failed'" in statements[1]
    assert "page_error = %s" in statements[1]
    assert "image_download_status = 'failed'" in statements[2]
    assert "image_download_error = %s" in statements[2]
    assert all("roskachestvo.products" in statement for statement in statements)
    assert all("roskachestvo_wines" not in statement for statement in statements)
    assert connection.commits == 3


def test_get_roskachestvo_products_for_matching_reads_products_shape() -> None:
    rows = [
        {
            "rskrf_product_id": "p1",
            "name": "Wine",
            "barcode": "4601",
            "rating": "4.1",
            "raw_json": {"id": "p1"},
        }
    ]
    repo, connection = make_repo(results=[rows])

    result = repo.get_roskachestvo_products_for_matching(limit=5)

    sql = last_sql(connection)
    assert result == rows
    assert "FROM roskachestvo.products" in sql
    assert "COALESCE(title, list_name) AS name" in sql
    assert "COALESCE(total_rating, list_rating) AS rating" in sql
    assert "COALESCE(raw_detail_json, raw_list_json) AS raw_json" in sql
    assert "roskachestvo_wines" not in sql
    assert connection.executed[-1][1] == [5]


def test_get_roskachestvo_product_audit_rows_selects_image_and_status_fields() -> None:
    rows = [
        {
            "rskrf_product_id": "p1",
            "detail_status": "ok",
            "page_status": "ok",
            "image_download_status": "ok",
            "image_processing_status": "pending",
            "image_local_path": "storage/p1/original.jpg",
            "image_size_bytes": 100,
        }
    ]
    repo, connection = make_repo(results=[rows])

    result = repo.get_roskachestvo_product_audit_rows()

    sql = last_sql(connection)
    assert result == rows
    assert "image_local_path" in sql
    assert "image_size_bytes" in sql
    assert "detail_status" in sql
    assert "page_status" in sql
    assert "image_download_status" in sql
    assert "image_processing_status" in sql
    assert "FROM roskachestvo.products" in sql


def test_reset_list_errors_only_touches_list_status_and_error() -> None:
    repo, connection = make_repo(rowcount=3)

    updated_count = repo.reset_roskachestvo_product_list_errors()

    sql = last_sql(connection)
    assert updated_count == 3
    assert "list_status = 'pending'" in sql
    assert "list_error = NULL" in sql
    assert "detail_status" not in sql
    assert "page_status" not in sql
    assert "image_download_status" not in sql
    assert "image_processing_status" not in sql
    assert "roskachestvo_wines" not in sql
    assert connection.commits == 1


def test_client_fetch_wine_products_parses_list_response() -> None:
    import httpx

    from app.roskachestvo_products import RoskachestvoProductsClient

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/rest/1/products/wine"
        return httpx.Response(
            200,
            json={"response": [{"id": "1", "name": "Wine"}, "bad"]},
        )

    client = RoskachestvoProductsClient(transport=httpx.MockTransport(handler))

    assert client.fetch_wine_products() == [{"id": "1", "name": "Wine"}]


def test_client_fetch_product_detail_builds_detail_url() -> None:
    import httpx

    from app.roskachestvo_products import RoskachestvoProductsClient

    seen_paths = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        return httpx.Response(200, json={"response": {"id": "abc", "title": "Wine"}})

    client = RoskachestvoProductsClient(transport=httpx.MockTransport(handler))

    assert client.fetch_product_detail("abc")["title"] == "Wine"
    assert seen_paths == ["/rest/1/product/abc/"]


def test_extract_image_url_finds_target_container_href() -> None:
    from app.roskachestvo_products import extract_roskachestvo_product_image_url

    html = (
        '<div class="x p-photo--single p-photo">'
        '<a href="/upload/pic.webp">img</a></div>'
    )

    assert (
        extract_roskachestvo_product_image_url(html)
        == "https://rskrf.ru/upload/pic.webp"
    )


def test_extract_image_url_rejects_login_and_non_image_links() -> None:
    from app.roskachestvo_products import extract_roskachestvo_product_image_url

    html = (
        '<div class="p-photo p-photo--single">'
        '<a href="#loginRegister">login</a>'
        '<a href="/goods/wine/1/">goods</a></div>'
    )

    assert extract_roskachestvo_product_image_url(html) is None


def test_extract_image_url_handles_relative_upload_jpg() -> None:
    from app.roskachestvo_products import extract_roskachestvo_product_image_url

    html = '<div class="p-photo p-photo--single"><a href="/upload/a.jpg">img</a></div>'

    assert (
        extract_roskachestvo_product_image_url(html) == "https://rskrf.ru/upload/a.jpg"
    )


def test_extract_image_url_handles_protocol_relative_upload_jpg() -> None:
    from app.roskachestvo_products import extract_roskachestvo_product_image_url

    html = (
        '<div class="p-photo p-photo--single">'
        '<a href="//rskrf.ru/upload/a.jpg">img</a></div>'
    )

    assert (
        extract_roskachestvo_product_image_url(html) == "https://rskrf.ru/upload/a.jpg"
    )


def test_guess_image_extension_prefers_content_type_over_url() -> None:
    from app.roskachestvo_products import guess_image_extension

    assert (
        guess_image_extension("image/webp", "https://rskrf.ru/upload/a.jpg") == ".webp"
    )


def test_guess_image_extension_falls_back_to_url_extension() -> None:
    from app.roskachestvo_products import guess_image_extension

    assert guess_image_extension(None, "https://rskrf.ru/upload/a.png") == ".png"


def test_build_relative_image_path_uses_product_id_and_extension() -> None:
    from app.roskachestvo_products import build_roskachestvo_product_image_relative_path

    assert (
        build_roskachestvo_product_image_relative_path("p1", ".jpg")
        == "roskachestvo/products/p1/original.jpg"
    )


class FakeProductsServiceRepo:
    def __init__(self) -> None:
        self.saved_list = []
        self.failed_list = []
        self.reset_called = 0
        self.detail_products = []
        self.saved_details = []
        self.failed_details = []
        self.page_products = []
        self.saved_image_urls = []
        self.failed_pages = []
        self.download_products = []
        self.saved_downloads = []
        self.failed_downloads = []
        self.audit_rows = []

    def reset_roskachestvo_product_list_errors(self) -> int:
        self.reset_called += 1
        return 0

    def upsert_roskachestvo_product_from_list_item(self, product):
        self.saved_list.append(product)
        return len(self.saved_list)

    def mark_roskachestvo_product_list_failed(self, product_id, error):
        self.failed_list.append((product_id, error))

    def get_roskachestvo_products_for_detail_import(self, **kwargs):
        return self.detail_products

    def update_roskachestvo_product_detail(self, product_id, detail):
        self.saved_details.append((product_id, detail))

    def mark_roskachestvo_product_detail_failed(self, product_id, error):
        self.failed_details.append((product_id, error))

    def get_roskachestvo_products_for_image_url_import(self, **kwargs):
        return self.page_products

    def update_roskachestvo_product_image_source_url(
        self, product_id, image_url, source_page_url=None
    ):
        self.saved_image_urls.append((product_id, image_url, source_page_url))

    def mark_roskachestvo_product_page_failed(self, product_id, error):
        self.failed_pages.append((product_id, error))

    def get_roskachestvo_products_for_image_download(self, **kwargs):
        return self.download_products

    def update_roskachestvo_product_image_download(
        self, product_id, image_local_path, image_content_type, image_size_bytes
    ):
        self.saved_downloads.append(
            (product_id, image_local_path, image_content_type, image_size_bytes)
        )

    def mark_roskachestvo_product_image_download_failed(self, product_id, error):
        self.failed_downloads.append((product_id, error))

    def get_roskachestvo_product_audit_rows(self):
        return self.audit_rows


class FakeProductsServiceClient:
    def __init__(self) -> None:
        self.products = []
        self.details = {}
        self.pages = {}
        self.images = {}

    def fetch_wine_products(self):
        return self.products

    def fetch_product_detail(self, product_id):
        return self.details[product_id]

    def fetch_product_page(self, product_link):
        return self.pages[product_link]

    def download_product_image(self, image_source_url):
        return self.images[image_source_url]


def test_import_products_service_calls_repo_upsert() -> None:
    from app.roskachestvo_products import import_roskachestvo_products_to_db

    repo = FakeProductsServiceRepo()
    client = FakeProductsServiceClient()
    client.products = [{"id": "1", "name": "Wine"}]

    stats = import_roskachestvo_products_to_db(repo, client, reset_list_errors=True)

    assert stats.products_saved == 1
    assert repo.saved_list == client.products
    assert repo.reset_called == 1


def test_detail_import_service_calls_repo_update() -> None:
    from app.roskachestvo_products import import_roskachestvo_product_details_to_db

    repo = FakeProductsServiceRepo()
    client = FakeProductsServiceClient()
    repo.detail_products = [
        {"rskrf_product_id": "1", "detail_status": "pending", "raw_detail_json": None}
    ]
    client.details = {"1": {"id": "1", "title": "Wine"}}

    stats = import_roskachestvo_product_details_to_db(repo, client)

    assert stats.details_saved == 1
    assert repo.saved_details == [("1", client.details["1"])]


def test_image_url_collection_service_calls_repo_update() -> None:
    from app.roskachestvo_products import collect_roskachestvo_product_image_urls

    repo = FakeProductsServiceRepo()
    client = FakeProductsServiceClient()
    product_link = "https://rskrf.ru/goods/wine/1/"
    repo.page_products = [
        {
            "rskrf_product_id": "1",
            "product_link": product_link,
            "page_status": "pending",
            "image_source_url": None,
        }
    ]
    client.pages = {
        product_link: (
            '<div class="p-photo p-photo--single">'
            '<a href="/upload/a.webp">img</a></div>'
        )
    }

    stats = collect_roskachestvo_product_image_urls(repo, client)

    assert stats.image_urls_saved == 1
    assert repo.saved_image_urls == [
        ("1", "https://rskrf.ru/upload/a.webp", product_link)
    ]


def test_image_download_service_writes_file_and_stores_relative_path(tmp_path) -> None:
    from app.roskachestvo_products import (
        download_roskachestvo_product_images_to_storage,
    )

    repo = FakeProductsServiceRepo()
    client = FakeProductsServiceClient()
    image_url = "https://rskrf.ru/upload/a.jpg"
    repo.download_products = [
        {
            "rskrf_product_id": "1",
            "image_source_url": image_url,
            "image_local_path": None,
            "image_download_status": "pending",
        }
    ]
    client.images = {image_url: (b"image-bytes", "image/webp")}

    stats = download_roskachestvo_product_images_to_storage(repo, client, tmp_path)

    expected_relative = "roskachestvo/products/1/original.webp"
    assert stats.images_downloaded == 1
    assert (tmp_path / expected_relative).read_bytes() == b"image-bytes"
    assert repo.saved_downloads == [("1", expected_relative, "image/webp", 11)]


def test_audit_roskachestvo_products_detects_file_problems(tmp_path) -> None:
    from app.roskachestvo_products import audit_roskachestvo_products

    repo = FakeProductsServiceRepo()
    zero = tmp_path / "roskachestvo/products/zero/original.jpg"
    mismatch = tmp_path / "roskachestvo/products/mismatch/original.jpg"
    zero.parent.mkdir(parents=True)
    mismatch.parent.mkdir(parents=True)
    zero.write_bytes(b"")
    mismatch.write_bytes(b"abc")
    repo.audit_rows = [
        {
            "rskrf_product_id": "missing",
            "detail_status": "ok",
            "page_status": "ok",
            "image_download_status": "ok",
            "image_local_path": "roskachestvo/products/missing/original.jpg",
            "image_size_bytes": 5,
        },
        {
            "rskrf_product_id": "zero",
            "detail_status": "ok",
            "page_status": "ok",
            "image_download_status": "ok",
            "image_local_path": "roskachestvo/products/zero/original.jpg",
            "image_size_bytes": 0,
        },
        {
            "rskrf_product_id": "mismatch",
            "detail_status": "failed",
            "page_status": "failed",
            "image_download_status": "failed",
            "image_local_path": "roskachestvo/products/mismatch/original.jpg",
            "image_size_bytes": 10,
        },
    ]

    stats, missing, mismatches = audit_roskachestvo_products(repo, tmp_path)

    assert stats.files_missing == 1
    assert stats.files_zero_size == 1
    assert stats.files_size_mismatch == 1
    assert missing[0]["rskrf_product_id"] == "missing"
    assert mismatches[0]["disk_size_bytes"] == 3


def test_roskachestvo_products_service_module_does_not_reference_legacy_table() -> None:
    from pathlib import Path

    module_path = Path(__file__).parents[1] / "app/roskachestvo_products.py"
    module_text = module_path.read_text(encoding="utf-8")

    assert "roskachestvo_wines" not in module_text
