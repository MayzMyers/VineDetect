"""Project configuration loaded from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:  # pragma: no cover

    def load_dotenv() -> bool:
        return False


DEFAULT_BASE_URL = "https://vino-svoe.ru"
DEFAULT_PER_PAGE = 16
DEFAULT_DELAY_MIN = 0.8
DEFAULT_DELAY_MAX = 2.5
DEFAULT_TIMEOUT = 20.0
DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; WineResearchBot/1.0; +local-development)"
DEFAULT_JWT_ALGORITHM = "HS256"
DEFAULT_JWT_EXPIRE_MINUTES = 60
DEFAULT_API_HOST = "0.0.0.0"
DEFAULT_API_PORT = 8000
DEFAULT_STATIC_ASSETS_ROOT = "storage/images"
DEFAULT_STATIC_ASSETS_URL_PREFIX = "/static/images"
DEFAULT_PUBLIC_API_BASE_URL = "http://127.0.0.1:8000"
SUPPORTED_JWT_ALGORITHMS = {"HS256"}


@dataclass(frozen=True)
class Config:
    database_url: str
    base_url: str
    per_page: int
    delay_min: float
    delay_max: float
    timeout: float
    user_agent: str


@dataclass(frozen=True)
class ApiConfig:
    database_url: str
    admin_username: str
    admin_password_hash: str
    jwt_secret: str
    jwt_algorithm: str
    jwt_expire_minutes: int
    cors_origins: list[str]
    api_host: str
    api_port: int
    static_assets_root: str
    static_assets_url_prefix: str
    public_api_base_url: str
    annotator_username: str | None = None
    annotator_password_hash: str | None = None
    ml_service_username: str | None = None
    ml_service_password_hash: str | None = None


def _required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        msg = f"{name} is required"
        raise RuntimeError(msg)
    return value


def _required_stripped_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        msg = f"{name} is required"
        raise RuntimeError(msg)
    return value


def _required_argon2_hash_env(name: str) -> str:
    value = _required_stripped_env(name)
    if not value.startswith("$argon2"):
        msg = f"{name} must be an Argon2 password hash"
        raise RuntimeError(msg)
    return value


def _optional_argon2_hash_env(name: str, default: str) -> str:
    value = os.getenv(name, default).strip() or default
    if not value.startswith("$argon2"):
        msg = f"{name} must be an Argon2 password hash"
        raise RuntimeError(msg)
    return value


def _positive_int_env(name: str, default: int) -> int:
    raw_value = os.getenv(name, str(default)).strip()
    try:
        value = int(raw_value)
    except ValueError as exc:
        msg = f"{name} must be an integer"
        raise RuntimeError(msg) from exc
    if value <= 0:
        msg = f"{name} must be greater than 0"
        raise RuntimeError(msg)
    return value


def _jwt_algorithm_env(name: str, default: str) -> str:
    value = os.getenv(name, default).strip() or default
    if value not in SUPPORTED_JWT_ALGORITHMS:
        supported = ", ".join(sorted(SUPPORTED_JWT_ALGORITHMS))
        msg = f"{name} must be one of: {supported}"
        raise RuntimeError(msg)
    return value


def _parse_cors_origins(raw_value: str | None) -> list[str]:
    if not raw_value:
        return []
    return [origin.strip() for origin in raw_value.split(",") if origin.strip()]


def _stripped_env(name: str, default: str) -> str:
    return os.getenv(name, default).strip() or default


def _url_path_prefix_env(name: str, default: str) -> str:
    value = _stripped_env(name, default).rstrip("/") or default
    if not value.startswith("/"):
        value = f"/{value}"
    return value


def get_config() -> Config:
    """Load application configuration from .env and the process environment."""

    load_dotenv()

    return Config(
        database_url=_required_env("DATABASE_URL"),
        base_url=os.getenv("BASE_URL", DEFAULT_BASE_URL),
        per_page=int(os.getenv("PER_PAGE", str(DEFAULT_PER_PAGE))),
        delay_min=float(os.getenv("REQUEST_DELAY_MIN", str(DEFAULT_DELAY_MIN))),
        delay_max=float(os.getenv("REQUEST_DELAY_MAX", str(DEFAULT_DELAY_MAX))),
        timeout=float(os.getenv("HTTP_TIMEOUT", str(DEFAULT_TIMEOUT))),
        user_agent=os.getenv("USER_AGENT", DEFAULT_USER_AGENT),
    )


def get_api_config() -> ApiConfig:
    """Load HTTP API configuration without changing crawler CLI config."""

    load_dotenv()

    admin_username = _required_stripped_env("ADMIN_USERNAME")
    admin_password_hash = _required_argon2_hash_env("ADMIN_PASSWORD_HASH")
    return ApiConfig(
        database_url=_required_env("DATABASE_URL"),
        admin_username=admin_username,
        admin_password_hash=admin_password_hash,
        jwt_secret=_required_stripped_env("JWT_SECRET"),
        jwt_algorithm=_jwt_algorithm_env("JWT_ALGORITHM", DEFAULT_JWT_ALGORITHM),
        jwt_expire_minutes=_positive_int_env(
            "JWT_EXPIRE_MINUTES",
            DEFAULT_JWT_EXPIRE_MINUTES,
        ),
        cors_origins=_parse_cors_origins(os.getenv("CORS_ORIGINS")),
        api_host=os.getenv("API_HOST", DEFAULT_API_HOST).strip() or DEFAULT_API_HOST,
        api_port=_positive_int_env("API_PORT", DEFAULT_API_PORT),
        static_assets_root=_stripped_env(
            "STATIC_ASSETS_ROOT",
            DEFAULT_STATIC_ASSETS_ROOT,
        ),
        static_assets_url_prefix=_url_path_prefix_env(
            "STATIC_ASSETS_URL_PREFIX",
            DEFAULT_STATIC_ASSETS_URL_PREFIX,
        ),
        public_api_base_url=_stripped_env(
            "PUBLIC_API_BASE_URL",
            DEFAULT_PUBLIC_API_BASE_URL,
        ),
        annotator_username=_stripped_env("ANNOTATOR_USERNAME", "annotator"),
        annotator_password_hash=_optional_argon2_hash_env(
            "ANNOTATOR_PASSWORD_HASH",
            admin_password_hash,
        ),
        ml_service_username=_stripped_env("ML_SERVICE_USERNAME", "ml-service"),
        ml_service_password_hash=_optional_argon2_hash_env(
            "ML_SERVICE_PASSWORD_HASH",
            admin_password_hash,
        ),
    )
