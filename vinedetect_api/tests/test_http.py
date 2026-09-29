from __future__ import annotations

import httpx
import pytest

from app.http import RETRYABLE_STATUS_CODES, WineHttpClient, is_retryable_exception


def make_client(transport: httpx.MockTransport | None = None) -> WineHttpClient:
    raw_client = httpx.Client(transport=transport) if transport else None
    return WineHttpClient(
        base_url="https://vino-svoe.ru",
        user_agent="test-agent",
        timeout=5,
        delay_min=0,
        delay_max=0,
        client=raw_client,
    )


def make_http_status_error(status_code):
    request = httpx.Request("GET", "https://vino-svoe.ru/api/wines")
    response = httpx.Response(status_code, request=request)
    return httpx.HTTPStatusError(
        message=f"HTTP {status_code}",
        request=request,
        response=response,
    )


def disable_retry_sleep():
    def no_sleep(seconds):
        return None

    WineHttpClient.get_json.retry.sleep = no_sleep


def test_build_url_accepts_paths_with_and_without_leading_slash():
    client = make_client()

    assert client._build_url("/api/wines") == "https://vino-svoe.ru/api/wines"
    assert client._build_url("api/wines") == "https://vino-svoe.ru/api/wines"

    with pytest.raises(ValueError):
        client._build_url("")

    client.close()


def test_delay_validation():
    with pytest.raises(ValueError):
        WineHttpClient(
            base_url="https://vino-svoe.ru",
            user_agent="test-agent",
            timeout=5,
            delay_min=-1,
            delay_max=1,
        )

    with pytest.raises(ValueError):
        WineHttpClient(
            base_url="https://vino-svoe.ru",
            user_agent="test-agent",
            timeout=5,
            delay_min=2,
            delay_max=1,
        )


def test_get_json_returns_dict_payload():
    seen_paths = []

    def handler(request):
        seen_paths.append(request.url.path)
        return httpx.Response(200, json={"items": [], "currentPage": 1})

    client = make_client(httpx.MockTransport(handler))

    payload = client.get_json("/api/wines", params={"page": 1, "perPage": 16})

    assert payload["currentPage"] == 1
    assert payload["items"] == []
    assert seen_paths == ["/api/wines"]

    client.close()


def test_get_json_raises_value_error_for_json_list():
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=[]))
    client = make_client(transport)

    with pytest.raises(ValueError):
        client.get_json("/api/wines")

    client.close()


def test_close_closes_inner_httpx_client():
    raw_client = httpx.Client()
    client = WineHttpClient(
        base_url="https://vino-svoe.ru",
        user_agent="test-agent",
        timeout=5,
        delay_min=0,
        delay_max=0,
        client=raw_client,
    )

    client.close()

    assert raw_client.is_closed


def test_context_manager_closes_client():
    with make_client() as client:
        raw_client = client.client

    assert raw_client.is_closed


def test_is_retryable_exception_returns_true_for_timeout_exception():
    exc = httpx.TimeoutException("timeout")

    assert is_retryable_exception(exc) is True


def test_is_retryable_exception_returns_true_for_transport_error():
    exc = httpx.TransportError("network error")

    assert is_retryable_exception(exc) is True


@pytest.mark.parametrize("status_code", sorted(RETRYABLE_STATUS_CODES))
def test_is_retryable_exception_returns_true_for_retryable_statuses(status_code):
    exc = make_http_status_error(status_code)

    assert is_retryable_exception(exc) is True


@pytest.mark.parametrize("status_code", [400, 401, 403, 404])
def test_is_retryable_exception_returns_false_for_non_retryable_statuses(status_code):
    exc = make_http_status_error(status_code)

    assert is_retryable_exception(exc) is False


def test_get_json_does_not_retry_404():
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(404, request=request)

    client = make_client(httpx.MockTransport(handler))

    with pytest.raises(httpx.HTTPStatusError):
        client.get_json("/api/wines/missing")

    assert calls == 1

    client.close()


def test_get_json_retries_500(monkeypatch):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        if calls < 3:
            return httpx.Response(500, request=request)
        return httpx.Response(200, json={"ok": True})

    disable_retry_sleep()
    monkeypatch.setattr("app.http.time.sleep", lambda seconds: None)
    client = make_client(httpx.MockTransport(handler))

    payload = client.get_json("/api/wines")

    assert payload == {"ok": True}
    assert calls == 3

    client.close()


def test_get_json_429_respects_retry_after(monkeypatch):
    calls = 0
    sleeps = []

    def handler(request):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(
                429,
                headers={"Retry-After": "1"},
                request=request,
            )
        return httpx.Response(200, json={"ok": True})

    disable_retry_sleep()
    monkeypatch.setattr("app.http.time.sleep", lambda seconds: sleeps.append(seconds))
    client = make_client(httpx.MockTransport(handler))

    payload = client.get_json("/api/wines")

    assert payload == {"ok": True}
    assert 1 in sleeps

    client.close()
