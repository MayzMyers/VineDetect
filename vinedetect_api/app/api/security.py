"""JWT and password verification helpers for the API."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from pwdlib import PasswordHash

from app.config import ApiConfig

from .dependencies import get_api_config_dependency

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/token")
_password_hash = PasswordHash.recommended()
_DUMMY_HASH = (
    "$argon2id$v=19$m=65536,t=3,p=4$"
    "sWazRExylJkmYXDJvPJx2Q$"
    "Iu+u0fCR8Zm3qx5+i5+hGe41XTlCWN21Jxp7OLcZbOk"
)

AuthRole = Literal["admin", "annotator", "ml-service"]


@dataclass(frozen=True)
class AuthPrincipal:
    username: str
    role: AuthRole

    @property
    def actor_type(self) -> Literal["human", "ml-agent"]:
        return "ml-agent" if self.role == "ml-service" else "human"


def auth_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def authenticate_account(
    username: str,
    password: str,
    config: ApiConfig,
) -> AuthPrincipal | None:
    accounts: tuple[tuple[str | None, str | None, AuthRole], ...] = (
        (config.admin_username, config.admin_password_hash, "admin"),
        (config.annotator_username, config.annotator_password_hash, "annotator"),
        (config.ml_service_username, config.ml_service_password_hash, "ml-service"),
    )
    matched = next(
        (
            (account_username, password_hash, role)
            for account_username, password_hash, role in accounts
            if account_username and password_hash and username == account_username
        ),
        None,
    )
    hash_to_verify = matched[1] if matched else _DUMMY_HASH
    try:
        password_matches = _password_hash.verify(password, hash_to_verify)
    except Exception:
        password_matches = False
    if not matched or not password_matches:
        return None
    return AuthPrincipal(username=matched[0], role=matched[2])


def verify_admin_password(username: str, password: str, config: ApiConfig) -> bool:
    """Compatibility helper retained for callers that require the admin role."""
    principal = authenticate_account(username, password, config)
    return principal is not None and principal.role == "admin"


def create_access_token(
    config: ApiConfig, principal: AuthPrincipal | None = None
) -> str:
    principal = principal or AuthPrincipal(config.admin_username, "admin")
    issued_at = datetime.now(UTC)
    expires_at = issued_at + timedelta(minutes=config.jwt_expire_minutes)
    payload: dict[str, Any] = {
        "sub": principal.username,
        "role": principal.role,
        "actor_type": principal.actor_type,
        "iat": issued_at,
        "exp": expires_at,
    }
    return jwt.encode(payload, config.jwt_secret, algorithm=config.jwt_algorithm)


def require_principal(
    token: Annotated[str, Depends(oauth2_scheme)],
    config: Annotated[ApiConfig, Depends(get_api_config_dependency)],
) -> AuthPrincipal:
    try:
        payload = jwt.decode(
            token,
            config.jwt_secret,
            algorithms=[config.jwt_algorithm],
            options={"require": ["exp", "sub", "role"]},
        )
    except jwt.InvalidTokenError as exc:
        raise auth_error() from exc

    role = payload.get("role")
    username = payload.get("sub")
    configured_accounts = {
        "admin": config.admin_username,
        "annotator": config.annotator_username,
        "ml-service": config.ml_service_username,
    }
    if (
        role not in configured_accounts
        or not isinstance(username, str)
        or configured_accounts[role] != username
    ):
        raise auth_error()

    return AuthPrincipal(username=username, role=role)


def require_admin(
    principal: Annotated[AuthPrincipal, Depends(require_principal)],
) -> AuthPrincipal:
    if principal.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role is required"
        )

    return principal
