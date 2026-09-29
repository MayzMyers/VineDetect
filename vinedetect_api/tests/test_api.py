from __future__ import annotations

import os
import tempfile
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import jwt
import pytest
from httpx import ASGITransport, AsyncClient
from pwdlib import PasswordHash

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost/wines")
os.environ.setdefault("ADMIN_USERNAME", "admin")
os.environ.setdefault("ADMIN_PASSWORD_HASH", PasswordHash.recommended().hash("secret"))
os.environ.setdefault("JWT_SECRET", "test-secret-with-at-least-32-bytes")
os.environ.setdefault("STATIC_ASSETS_ROOT", "/tmp/vinedetect-api-test-images")

from app.api.application import create_app  # noqa: E402
from app.api.dependencies import get_api_config_dependency, get_repository  # noqa: E402
from app.config import ApiConfig, get_api_config, get_config  # noqa: E402
from app.repositories import WineConflictError, WineNotFoundError  # noqa: E402

pytestmark = pytest.mark.anyio

CONFIG = ApiConfig(
    database_url="postgresql://postgres:postgres@localhost/wines",
    admin_username="admin",
    admin_password_hash=PasswordHash.recommended().hash("secret"),
    jwt_secret="test-secret-with-at-least-32-bytes",
    jwt_algorithm="HS256",
    jwt_expire_minutes=60,
    cors_origins=["http://localhost:5173"],
    api_host="0.0.0.0",
    api_port=8000,
    static_assets_root=os.path.join(
        tempfile.gettempdir(), "vinedetect-api-test-images"
    ),
    static_assets_url_prefix="/static/images",
    public_api_base_url="http://127.0.0.1:8000",
    annotator_username="annotator",
    annotator_password_hash=PasswordHash.recommended().hash("annotator-secret"),
    ml_service_username="ml-service",
    ml_service_password_hash=PasswordHash.recommended().hash("ml-secret"),
)


class FakeRepo:
    def __init__(self, fail_health: bool = False) -> None:
        self.fail_health = fail_health
        self.deleted: list[int] = []
        self.catalog_calls: list[dict[str, Any]] = []
        self.next_id = 2
        self.wines: dict[int, dict[str, Any]] = {
            1: self._wine(
                wine_id=1,
                slug="wine-one",
                title="Wine One",
                region_name="Kuban",
                category_name="Red dry",
                manufacturer_name="Winery",
                barcodes=["4601234567890"],
            )
        }

    def search_catalog_items(
        self,
        source: str = "all",
        query: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        self.catalog_calls.append(
            {
                "source": source,
                "query": query,
                "limit": limit,
                "offset": offset,
            }
        )
        return [
            {
                "source": source if source != "all" else "svoe_vino",
                "external_id": "catalog-1",
                "recognition_key": "svoe_vino:catalog-1",
                "local_id": 1,
                "title": "Catalog Wine",
                "manufacturer": "Catalog Winery",
                "category": "Red dry",
                "region": "Kuban",
                "year": None,
                "rating": Decimal("4.2"),
                "barcode": "4601234567890",
                "description": "Catalog item",
                "source_url": "https://example.test/catalog-1",
                "image": {
                    "url": "https://example.test/catalog-1.jpg",
                    "local_path": "storage/catalog-1.jpg",
                    "content_type": "image/jpeg",
                    "size_bytes": 123,
                },
            }
        ]

    def check_database(self) -> None:
        if self.fail_health:
            from app.repositories import DatabaseUnavailableError

            raise DatabaseUnavailableError

    def list_api_wines(self, **filters):
        items = list(self.wines.values())
        query = filters.get("query")
        if query:
            needle = query.casefold()
            items = [w for w in items if needle in w["title"].casefold()]
        for param, field in [
            ("region", "region_name"),
            ("category", "category_name"),
            ("manufacturer", "manufacturer_name"),
        ]:
            value = filters.get(param)
            if value:
                items = [w for w in items if w.get(field) == value]
        total = len(items)
        offset = filters.get("offset", 0)
        limit = filters.get("limit", 20)
        return [self._summary(w) for w in items[offset : offset + limit]], total

    def get_api_wine(self, wine_id: int):
        if wine_id not in self.wines:
            raise WineNotFoundError
        return deepcopy(self.wines[wine_id])

    def get_api_wine_by_barcode(self, barcode: str):
        for wine in self.wines.values():
            if barcode in wine["barcodes"]:
                return deepcopy(wine)
        raise WineNotFoundError

    def create_api_wine(self, values: dict[str, Any]):
        self._raise_on_conflict(values)
        wine_id = self.next_id
        self.next_id += 1
        wine = self._wine(
            wine_id=wine_id,
            slug=values["slug"],
            title=values["title"],
            category_name=values.get("category_name"),
            manufacturer_name=values.get("manufacturer_name"),
            region_name=values.get("region_name"),
            source=values.get("source") or "manual",
            external_id=values.get("external_id"),
            grapes=values.get("grapes") or [],
            dishes=values.get("dishes") or [],
            barcodes=values.get("barcodes") or [],
        )
        self.wines[wine_id] = wine
        return deepcopy(wine)

    def update_api_wine(self, wine_id: int, values: dict[str, Any]):
        if wine_id not in self.wines:
            raise WineNotFoundError
        self._raise_on_conflict(values, wine_id=wine_id)
        wine = self.wines[wine_id]
        for key, value in values.items():
            wine[key] = value
        return deepcopy(wine)

    def delete_api_wine(self, wine_id: int) -> None:
        if wine_id not in self.wines:
            raise WineNotFoundError
        self.deleted.append(wine_id)
        del self.wines[wine_id]

    def _raise_on_conflict(
        self,
        values: dict[str, Any],
        wine_id: int | None = None,
    ) -> None:
        for existing_id, wine in self.wines.items():
            if existing_id == wine_id:
                continue
            if values.get("slug") and values["slug"] == wine["slug"]:
                raise WineConflictError("slug already exists")
            if (
                values.get("source")
                and values.get("external_id")
                and values["source"] == wine.get("source")
                and values["external_id"] == wine.get("external_id")
            ):
                raise WineConflictError("source/external_id already exists")
            if set(values.get("barcodes") or []) & set(wine.get("barcodes") or []):
                raise WineConflictError("barcode already exists")

    @staticmethod
    def _summary(wine: dict[str, Any]) -> dict[str, Any]:
        keys = {
            "id",
            "slug",
            "title",
            "category_name",
            "manufacturer_name",
            "region_name",
            "public_rating",
            "image_url",
            "color",
            "alcohol",
            "source",
            "external_id",
        }
        return {key: wine.get(key) for key in keys}

    @staticmethod
    def _wine(
        wine_id: int,
        slug: str,
        title: str,
        category_name: str | None = None,
        manufacturer_name: str | None = None,
        region_name: str | None = None,
        source: str | None = "manual",
        external_id: str | None = None,
        grapes: list[str] | None = None,
        dishes: list[str] | None = None,
        barcodes: list[str] | None = None,
    ) -> dict[str, Any]:
        return {
            "id": wine_id,
            "slug": slug,
            "title": title,
            "category_name": category_name,
            "manufacturer_name": manufacturer_name,
            "manufacturer_slug": None,
            "region_name": region_name,
            "alcohol": Decimal("13.5"),
            "temperature": "16-18",
            "color": "Red",
            "description": "Description",
            "public_rating": Decimal("90.0"),
            "image_url": "https://example.test/bottle.webp",
            "image_alt": "Bottle",
            "source": source,
            "external_id": external_id,
            "source_url": None,
            "source_updated_at": None,
            "created_at": None,
            "updated_at": None,
            "grapes": grapes or ["Merlot"],
            "dishes": dishes or ["Cheese"],
            "barcodes": barcodes or [],
            "images": [],
        }


@pytest.fixture()
def anyio_backend():
    return "asyncio"


@pytest.fixture()
def repo():
    return FakeRepo()


@pytest.fixture()
async def client(repo):
    app = create_app(CONFIG)
    app.dependency_overrides[get_api_config_dependency] = lambda: CONFIG
    app.dependency_overrides[get_repository] = lambda: repo
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as async_client:
        yield async_client


async def auth_headers(client: AsyncClient) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/token",
        data={"username": "admin", "password": "secret"},
    )
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def signed_token(payload: dict[str, Any]) -> str:
    return jwt.encode(payload, CONFIG.jwt_secret, algorithm=CONFIG.jwt_algorithm)


async def post_wine_with_token(
    client: AsyncClient,
    token: str,
    slug: str = "created",
):
    return await client.post(
        "/api/v1/wines",
        json={"slug": slug, "title": "Created"},
        headers={"Authorization": f"Bearer {token}"},
    )


async def test_health_success(client):
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "vinedetect_api",
        "database": "ok",
    }


async def test_health_database_failure():
    app = create_app(CONFIG)
    app.dependency_overrides[get_api_config_dependency] = lambda: CONFIG
    app.dependency_overrides[get_repository] = lambda: FakeRepo(fail_health=True)
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://testserver",
    ) as client:
        response = await client.get("/health")

    assert response.status_code == 503


async def test_valid_login(client):
    response = await client.post(
        "/api/v1/auth/token",
        data={"username": "admin", "password": "secret"},
    )

    assert response.status_code == 200
    assert response.json()["token_type"] == "bearer"
    assert response.json()["username"] == "admin"
    assert response.json()["role"] == "admin"
    assert response.json()["access_token"]


@pytest.mark.parametrize(
    ("username", "password", "role", "actor_type"),
    [
        ("annotator", "annotator-secret", "annotator", "human"),
        ("ml-service", "ml-secret", "ml-service", "ml-agent"),
    ],
)
async def test_role_accounts_receive_signed_identity(
    client, username, password, role, actor_type
):
    response = await client.post(
        "/api/v1/auth/token",
        data={"username": username, "password": password},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["username"] == username
    assert body["role"] == role
    me = await client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {body['access_token']}"},
    )
    assert me.status_code == 200
    assert me.json() == {"username": username, "role": role, "actor_type": actor_type}


async def test_annotator_cannot_mutate_admin_catalog(client):
    login = await client.post(
        "/api/v1/auth/token",
        data={"username": "annotator", "password": "annotator-secret"},
    )
    response = await post_wine_with_token(client, login.json()["access_token"])
    assert response.status_code == 403


async def test_invalid_username(client):
    response = await client.post(
        "/api/v1/auth/token",
        data={"username": "other", "password": "secret"},
    )

    assert response.status_code == 401


async def test_invalid_password(client):
    response = await client.post(
        "/api/v1/auth/token",
        data={"username": "admin", "password": "wrong"},
    )

    assert response.status_code == 401


async def test_valid_jwt_allows_protected_endpoint(client):
    response = await client.post(
        "/api/v1/wines",
        json={"slug": "created", "title": "Created"},
        headers=await auth_headers(client),
    )

    assert response.status_code == 201


async def test_signed_jwt_with_role_allows_protected_endpoint(client):
    token = signed_token(
        {
            "sub": "admin",
            "role": "admin",
            "exp": datetime.now(UTC) + timedelta(minutes=5),
        }
    )

    response = await post_wine_with_token(client, token)

    assert response.status_code == 201


async def test_legacy_signed_jwt_without_role_is_rejected(client):
    token = signed_token(
        {"sub": "admin", "exp": datetime.now(UTC) + timedelta(minutes=5)}
    )

    response = await post_wine_with_token(client, token)
    assert response.status_code == 401


async def test_jwt_without_exp_returns_401(client):
    token = signed_token({"sub": "admin"})

    response = await post_wine_with_token(client, token)

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


async def test_jwt_without_sub_returns_401(client):
    token = signed_token({"exp": datetime.now(UTC) + timedelta(minutes=5)})

    response = await post_wine_with_token(client, token)

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


async def test_jwt_with_wrong_sub_returns_401(client):
    token = signed_token(
        {"sub": "other", "exp": datetime.now(UTC) + timedelta(minutes=5)}
    )

    response = await post_wine_with_token(client, token)

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


async def test_expired_jwt_returns_401(client):
    token = jwt.encode(
        {"sub": "admin", "exp": datetime.now(UTC) - timedelta(minutes=1)},
        CONFIG.jwt_secret,
        algorithm=CONFIG.jwt_algorithm,
    )

    response = await client.post(
        "/api/v1/wines",
        json={"slug": "created", "title": "Created"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


async def test_malformed_jwt_returns_401(client):
    response = await client.post(
        "/api/v1/wines",
        json={"slug": "created", "title": "Created"},
        headers={"Authorization": "Bearer not-a-token"},
    )

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


async def test_catalog_default_source_is_public(client, repo):
    response = await client.get("/api/v1/catalog")

    assert response.status_code == 200
    payload = response.json()
    assert payload["source"] == "all"
    assert payload["limit"] == 50
    assert payload["offset"] == 0
    assert payload["count"] == 1
    assert repo.catalog_calls == [
        {"source": "all", "query": None, "limit": 50, "offset": 0}
    ]


async def test_catalog_svoe_vino_source_passes_to_repo(client, repo):
    response = await client.get("/api/v1/catalog?source=svoe_vino")

    assert response.status_code == 200
    assert repo.catalog_calls[-1] == {
        "source": "svoe_vino",
        "query": None,
        "limit": 50,
        "offset": 0,
    }


async def test_catalog_roskachestvo_query_pagination_passes_to_repo(client, repo):
    response = await client.get(
        "/api/v1/catalog",
        params={
            "source": "roskachestvo",
            "q": "?????",
            "limit": 20,
            "offset": 5,
        },
    )

    assert response.status_code == 200
    assert repo.catalog_calls[-1] == {
        "source": "roskachestvo",
        "query": "?????",
        "limit": 20,
        "offset": 5,
    }


async def test_catalog_item_response_contains_recognition_key_and_image(client):
    response = await client.get("/api/v1/catalog")

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["source"] == "svoe_vino"
    assert item["external_id"] == "catalog-1"
    assert item["recognitionKey"] == "svoe_vino:catalog-1"
    assert item["recognitionKey"] != str(item["local_id"])
    assert item["rating"] == "4.2"
    assert item["image"] == {
        "url": "http://127.0.0.1:8000/static/images/storage/catalog-1.jpg",
        "local_path": "storage/catalog-1.jpg",
        "source_url": "https://example.test/catalog-1.jpg",
        "content_type": "image/jpeg",
        "size_bytes": 123,
    }


async def test_catalog_image_url_falls_back_to_remote_when_local_path_is_missing(
    client,
    repo,
):
    def search_catalog_items(**kwargs):
        return [
            {
                "source": "roskachestvo",
                "external_id": "catalog-2",
                "recognition_key": "roskachestvo:catalog-2",
                "local_id": 2,
                "title": "Remote Only Wine",
                "image": {
                    "url": "https://example.test/remote-only.jpg",
                    "local_path": None,
                    "content_type": "image/jpeg",
                    "size_bytes": 456,
                },
            }
        ]

    repo.search_catalog_items = search_catalog_items

    response = await client.get("/api/v1/catalog")

    assert response.status_code == 200
    image = response.json()["items"][0]["image"]
    assert image == {
        "url": "https://example.test/remote-only.jpg",
        "local_path": None,
        "source_url": "https://example.test/remote-only.jpg",
        "content_type": "image/jpeg",
        "size_bytes": 456,
    }


async def test_catalog_unknown_source_returns_422(client):
    response = await client.get("/api/v1/catalog?source=legacy")

    assert response.status_code == 422


@pytest.mark.parametrize("params", ["limit=0", "limit=101", "offset=-1"])
async def test_catalog_bounds_return_422(client, params):
    response = await client.get(f"/api/v1/catalog?{params}")

    assert response.status_code == 422


async def test_catalog_does_not_require_jwt_but_wine_post_still_does(client):
    catalog_response = await client.get("/api/v1/catalog")
    post_response = await client.post(
        "/api/v1/wines",
        json={"slug": "x", "title": "X"},
    )

    assert catalog_response.status_code == 200
    assert post_response.status_code == 401


async def test_list_wines(client):
    response = await client.get("/api/v1/wines")

    assert response.status_code == 200
    assert response.json()["items"][0]["slug"] == "wine-one"


async def test_list_pagination(client, repo):
    repo.wines[2] = repo._wine(2, "wine-two", "Wine Two")

    response = await client.get("/api/v1/wines?limit=1&offset=1")

    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert len(response.json()["items"]) == 1


async def test_query_filter(client):
    response = await client.get("/api/v1/wines?query=One")

    assert response.status_code == 200
    assert response.json()["total"] == 1


async def test_region_filter(client):
    response = await client.get("/api/v1/wines?region=Kuban")

    assert response.json()["total"] == 1


async def test_category_filter(client):
    response = await client.get("/api/v1/wines?category=Red%20dry")

    assert response.json()["total"] == 1


async def test_manufacturer_filter(client):
    response = await client.get("/api/v1/wines?manufacturer=Winery")

    assert response.json()["total"] == 1


async def test_get_wine_by_id(client):
    response = await client.get("/api/v1/wines/1")

    assert response.status_code == 200
    assert response.json()["id"] == 1
    assert response.json()["grapes"] == ["Merlot"]


async def test_wine_not_found(client):
    response = await client.get("/api/v1/wines/404")

    assert response.status_code == 404


async def test_get_wine_by_barcode(client):
    response = await client.get("/api/v1/wines/by-barcode/4601234567890")

    assert response.status_code == 200
    assert response.json()["slug"] == "wine-one"


async def test_barcode_not_found(client):
    response = await client.get("/api/v1/wines/by-barcode/4600000000000")

    assert response.status_code == 404


async def test_invalid_barcode(client):
    response = await client.get("/api/v1/wines/by-barcode/bad")

    assert response.status_code == 422


async def test_post_without_token_returns_401(client):
    response = await client.post("/api/v1/wines", json={"slug": "x", "title": "X"})

    assert response.status_code == 401


async def test_patch_without_token_returns_401(client):
    response = await client.patch("/api/v1/wines/1", json={"title": "New"})

    assert response.status_code == 401


async def test_delete_without_token_returns_401(client):
    response = await client.delete("/api/v1/wines/1")

    assert response.status_code == 401


async def test_post_with_token_returns_201(client):
    response = await client.post(
        "/api/v1/wines",
        json={"slug": "new", "title": "New", "barcodes": ["4600000000000"]},
        headers=await auth_headers(client),
    )

    assert response.status_code == 201
    assert response.json()["source"] == "manual"


async def test_patch_with_token_returns_200(client):
    response = await client.patch(
        "/api/v1/wines/1",
        json={"title": "Updated"},
        headers=await auth_headers(client),
    )

    assert response.status_code == 200
    assert response.json()["title"] == "Updated"


async def test_patch_omitted_fields_remain_unchanged(client):
    response = await client.patch(
        "/api/v1/wines/1",
        json={"title": "Updated"},
        headers=await auth_headers(client),
    )

    assert response.json()["description"] == "Description"


async def test_patch_explicit_null_clears_nullable_scalar(client):
    response = await client.patch(
        "/api/v1/wines/1",
        json={"description": None},
        headers=await auth_headers(client),
    )

    assert response.status_code == 200
    assert response.json()["description"] is None


async def test_patch_empty_grapes_clears_relations(client):
    response = await client.patch(
        "/api/v1/wines/1",
        json={"grapes": []},
        headers=await auth_headers(client),
    )

    assert response.status_code == 200
    assert response.json()["grapes"] == []


async def test_patch_omitted_grapes_leaves_relations_unchanged(client):
    response = await client.patch(
        "/api/v1/wines/1",
        json={"title": "Updated"},
        headers=await auth_headers(client),
    )

    assert response.json()["grapes"] == ["Merlot"]


async def test_delete_with_token_returns_204(client, repo):
    response = await client.delete(
        "/api/v1/wines/1",
        headers=await auth_headers(client),
    )

    assert response.status_code == 204
    assert repo.deleted == [1]


async def test_duplicate_slug_returns_409(client):
    response = await client.post(
        "/api/v1/wines",
        json={"slug": "wine-one", "title": "Duplicate"},
        headers=await auth_headers(client),
    )

    assert response.status_code == 409


async def test_duplicate_source_external_id_returns_409(client):
    response = await client.post(
        "/api/v1/wines",
        json={
            "slug": "other",
            "title": "Other",
            "source": "manual",
            "external_id": None,
        },
        headers=await auth_headers(client),
    )

    assert response.status_code == 201
    response = await client.post(
        "/api/v1/wines",
        json={
            "slug": "third",
            "title": "Third",
            "source": "manual",
            "external_id": "same",
        },
        headers=await auth_headers(client),
    )
    assert response.status_code == 201
    response = await client.post(
        "/api/v1/wines",
        json={
            "slug": "fourth",
            "title": "Fourth",
            "source": "manual",
            "external_id": "same",
        },
        headers=await auth_headers(client),
    )

    assert response.status_code == 409


async def test_duplicate_barcode_returns_409(client):
    response = await client.post(
        "/api/v1/wines",
        json={
            "slug": "other",
            "title": "Other",
            "barcodes": ["4601234567890"],
        },
        headers=await auth_headers(client),
    )

    assert response.status_code == 409


async def test_invalid_request_returns_422(client):
    response = await client.post(
        "/api/v1/wines",
        json={"slug": " ", "title": "New"},
        headers=await auth_headers(client),
    )

    assert response.status_code == 422


async def test_openapi_contains_required_paths(client):
    response = await client.get("/openapi.json")
    paths = response.json()["paths"]

    assert "/health" in paths
    assert "/api/v1/auth/token" in paths
    assert "/api/v1/catalog" in paths
    assert "/api/v1/wines" in paths
    assert "/api/v1/wines/{wine_id}" in paths
    assert "/api/v1/wines/by-barcode/{barcode}" in paths


async def test_api_config_validation(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://example")
    monkeypatch.setenv("ADMIN_USERNAME", "admin")
    password_hash = PasswordHash.recommended().hash("secret")
    monkeypatch.setenv("ADMIN_PASSWORD_HASH", password_hash)
    monkeypatch.setenv("JWT_SECRET", "secret")
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")
    monkeypatch.setenv("JWT_EXPIRE_MINUTES", "15")
    monkeypatch.setenv("CORS_ORIGINS", " http://one.test, http://two.test ")

    config = get_api_config()

    assert config.jwt_algorithm == "HS256"
    assert config.jwt_expire_minutes == 15
    assert config.cors_origins == ["http://one.test", "http://two.test"]


async def test_default_jwt_algorithm_is_hs256(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://example")
    monkeypatch.setenv("ADMIN_USERNAME", "admin")
    password_hash = PasswordHash.recommended().hash("secret")
    monkeypatch.setenv("ADMIN_PASSWORD_HASH", password_hash)
    monkeypatch.setenv("JWT_SECRET", "secret")
    monkeypatch.delenv("JWT_ALGORITHM", raising=False)

    config = get_api_config()

    assert config.jwt_algorithm == "HS256"


async def test_unsupported_jwt_algorithm_fails_fast(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://example")
    monkeypatch.setenv("ADMIN_USERNAME", "admin")
    password_hash = PasswordHash.recommended().hash("secret")
    monkeypatch.setenv("ADMIN_PASSWORD_HASH", password_hash)
    monkeypatch.setenv("JWT_SECRET", "secret")
    monkeypatch.setenv("JWT_ALGORITHM", "RS256")

    with pytest.raises(RuntimeError, match="JWT_ALGORITHM must be one of: HS256"):
        get_api_config()


async def test_missing_api_config_does_not_affect_crawler_config(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://example")
    monkeypatch.setenv("ADMIN_USERNAME", "")
    monkeypatch.setenv("ADMIN_PASSWORD_HASH", "")
    monkeypatch.setenv("JWT_SECRET", "")

    crawler_config = get_config()

    assert crawler_config.database_url == "postgresql://example"
    with pytest.raises(RuntimeError, match="ADMIN_USERNAME is required"):
        get_api_config()


async def test_cors_header_for_configured_origin(client):
    response = await client.options(
        "/api/v1/wines",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
