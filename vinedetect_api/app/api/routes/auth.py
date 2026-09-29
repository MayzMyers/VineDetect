"""Authentication endpoints."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.security import OAuth2PasswordRequestForm

from app.config import ApiConfig

from ..dependencies import get_api_config_dependency
from ..schemas import AuthPrincipalResponse, TokenResponse
from ..security import (
    AuthPrincipal,
    auth_error,
    authenticate_account,
    create_access_token,
    require_principal,
)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/token", response_model=TokenResponse)
def login(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    config: Annotated[ApiConfig, Depends(get_api_config_dependency)],
) -> TokenResponse:
    principal = authenticate_account(form_data.username, form_data.password, config)
    if principal is None:
        raise auth_error()
    return TokenResponse(
        access_token=create_access_token(config, principal),
        username=principal.username,
        role=principal.role,
    )


@router.get("/me", response_model=AuthPrincipalResponse)
def me(
    principal: Annotated[AuthPrincipal, Depends(require_principal)],
) -> AuthPrincipalResponse:
    return AuthPrincipalResponse(
        username=principal.username,
        role=principal.role,
        actor_type=principal.actor_type,
    )
