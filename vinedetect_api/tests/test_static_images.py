from __future__ import annotations

import os
from pathlib import Path

import pytest

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:postgres@localhost/wines")
os.environ.setdefault("ADMIN_USERNAME", "admin")
os.environ.setdefault("ADMIN_PASSWORD_HASH", "$argon2id$test")
os.environ.setdefault("JWT_SECRET", "test-secret-with-at-least-32-bytes")
os.environ.setdefault("STATIC_ASSETS_ROOT", "/tmp/vinedetect-api-test-images")

from app.api.application import create_app  # noqa: E402
from app.api.routes.catalog import build_static_image_url  # noqa: E402
from app.config import ApiConfig  # noqa: E402


def _api_config(static_assets_root: Path) -> ApiConfig:
    return ApiConfig(
        database_url="postgresql://postgres:postgres@localhost/wines",
        admin_username="admin",
        admin_password_hash="$argon2id$test",
        jwt_secret="test-secret-with-at-least-32-bytes",
        jwt_algorithm="HS256",
        jwt_expire_minutes=60,
        cors_origins=[],
        api_host="0.0.0.0",
        api_port=8000,
        static_assets_root=str(static_assets_root),
        static_assets_url_prefix="/static/images",
        public_api_base_url="http://127.0.0.1:8000",
    )


def test_create_app_mounts_static_images_route(tmp_path):
    app = create_app(_api_config(tmp_path / "images"))

    assert any(
        getattr(route, "path", None) == "/static/images"
        and getattr(route, "name", None) == "static-images"
        for route in app.routes
    )


def test_create_app_creates_missing_static_root(tmp_path):
    static_root = tmp_path / "missing" / "images"
    assert not static_root.exists()

    create_app(_api_config(static_root))

    assert static_root.is_dir()


@pytest.mark.parametrize(
    ("local_path", "expected"),
    [
        (None, None),
        ("", None),
        ("   ", None),
        (
            "roskachestvo/products/3965039/original.jpg",
            "http://127.0.0.1:8000/static/images/roskachestvo/products/3965039/original.jpg",
        ),
        (
            "/roskachestvo/products/3965039/original.jpg",
            "http://127.0.0.1:8000/static/images/roskachestvo/products/3965039/original.jpg",
        ),
        (
            "roskachestvo\\products\\3965039\\original.jpg",
            "http://127.0.0.1:8000/static/images/roskachestvo/products/3965039/original.jpg",
        ),
    ],
)
def test_build_static_image_url(local_path, expected):
    assert (
        build_static_image_url(
            local_path,
            public_api_base_url="http://127.0.0.1:8000",
            static_assets_url_prefix="/static/images",
        )
        == expected
    )


def test_build_static_image_url_normalizes_base_and_prefix_slashes():
    assert build_static_image_url(
        "/a/b.jpg",
        public_api_base_url="http://127.0.0.1:8000/",
        static_assets_url_prefix="static/images/",
    ) == "http://127.0.0.1:8000/static/images/a/b.jpg"
