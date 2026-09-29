"""Synchronous HTTP client for vino-svoe.ru API routes."""

from __future__ import annotations

import random
import time
from collections.abc import Mapping
from typing import Any

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}


def is_retryable_exception(exc: BaseException) -> bool:
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in RETRYABLE_STATUS_CODES
    if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
        return True
    return False


class WineHttpClient:
    def __init__(
        self,
        base_url: str,
        user_agent: str,
        timeout: float,
        delay_min: float,
        delay_max: float,
        client: httpx.Client | None = None,
    ) -> None:
        normalized_base_url = base_url.rstrip("/")
        if not normalized_base_url:
            msg = "base_url is required"
            raise ValueError(msg)
        if delay_min < 0:
            msg = "delay_min must be greater than or equal to 0"
            raise ValueError(msg)
        if delay_max < 0:
            msg = "delay_max must be greater than or equal to 0"
            raise ValueError(msg)
        if delay_max < delay_min:
            msg = "delay_max must be greater than or equal to delay_min"
            raise ValueError(msg)

        self.base_url = normalized_base_url
        self.user_agent = user_agent
        self.timeout = timeout
        self.delay_min = delay_min
        self.delay_max = delay_max
        self.client = client or httpx.Client(
            timeout=timeout,
            headers={
                "User-Agent": user_agent,
                "Accept": "application/json,text/plain,*/*",
                "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
            },
            follow_redirects=True,
        )

    def _build_url(self, path: str) -> str:
        if not path:
            msg = "path is required"
            raise ValueError(msg)
        return f"{self.base_url}/{path.lstrip('/')}"

    def polite_sleep(self) -> None:
        time.sleep(random.uniform(self.delay_min, self.delay_max))

    @retry(
        retry=retry_if_exception(is_retryable_exception),
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=1, min=2, max=20),
        reraise=True,
    )
    def get_json(
        self,
        path: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.polite_sleep()
        url = self._build_url(path)
        response = self.client.get(url, params=params)

        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            if retry_after and retry_after.strip().isdigit():
                time.sleep(int(retry_after.strip()))
            else:
                time.sleep(30)
            response.raise_for_status()

        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            msg = "Expected JSON object"
            raise ValueError(msg)
        return payload

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> WineHttpClient:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()
