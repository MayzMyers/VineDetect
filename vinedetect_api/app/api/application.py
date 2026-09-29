"""FastAPI application factory."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import ApiConfig, get_api_config
from app.repositories import DatabaseUnavailableError

from .routes import auth, catalog, health, recognition, wines


def create_app(config: ApiConfig | None = None) -> FastAPI:
    resolved_config = config or get_api_config()
    application = FastAPI(
        title="Vinedetect Wine Catalog API",
        version="0.1.0",
    )

    if resolved_config.cors_origins:
        application.add_middleware(
            CORSMiddleware,
            allow_origins=resolved_config.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    assets_root = Path(resolved_config.static_assets_root).resolve()
    assets_root.mkdir(parents=True, exist_ok=True)
    application.mount(
        resolved_config.static_assets_url_prefix,
        StaticFiles(directory=assets_root),
        name="static-images",
    )

    @application.exception_handler(DatabaseUnavailableError)
    def database_unavailable_handler(
        request: Request,
        exc: DatabaseUnavailableError,
    ) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"detail": "Database unavailable"},
        )

    application.include_router(health.router)
    application.include_router(auth.router)
    application.include_router(catalog.router)
    application.include_router(recognition.router)
    application.include_router(wines.router)
    return application


app = create_app()