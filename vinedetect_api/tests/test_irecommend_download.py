from __future__ import annotations

import hashlib
import io
import socket

import httpx
import pytest
from PIL import Image

from app.irecommend_download import DownloadBlockedError, download_manifest
from app.irecommend_manifest import (
    build_manifest,
    confirmed_manifest,
    read_manifest,
    write_manifest,
)
from tests.test_irecommend_confirmed import FIXTURES, VERIFICATIONS
from tests.test_irecommend_matching import CATALOG_ROWS


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    def fail(*args, **kwargs):
        pytest.fail("Downloader tests must never use real network connections")

    monkeypatch.setattr(socket.socket, "connect", fail)
    monkeypatch.setattr(socket, "create_connection", fail)


@pytest.fixture
def source_rows():
    return confirmed_manifest(
        build_manifest(
            FIXTURES.glob("product*.html"),
            FIXTURES.glob("review*.html"),
            CATALOG_ROWS,
            review_verifications=VERIFICATIONS,
        )
    )[:2]


@pytest.fixture
def jpeg():
    buffer = io.BytesIO()
    Image.new("RGB", (12, 9), "black").save(buffer, format="JPEG")
    return buffer.getvalue()


@pytest.fixture
def run(tmp_path, source_rows):
    manifest = tmp_path / "manifest.confirmed.jsonl"
    results = tmp_path / "results.jsonl"
    output = tmp_path / "images"
    write_manifest(manifest, source_rows)
    delays = []

    def download(handler, **kwargs):
        return download_manifest(
            manifest,
            output,
            results,
            transport=httpx.MockTransport(handler),
            sleep=delays.append,
            **kwargs,
        )

    return download, manifest, results, output, delays


def test_downloader_validates_bytes_preserves_provenance_and_resumes(
    run, source_rows, jpeg
):
    download, manifest, results, output, delays = run
    requests = []
    original = manifest.read_bytes()

    def handler(request):
        requests.append(str(request.url))
        return httpx.Response(200, content=jpeg, headers={"content-type": "image/jpeg"})

    rows = download(handler)
    assert requests == [row["preferred_url"] for row in source_rows]
    assert len(delays) == 1 and 2 <= delays[0] <= 5
    for row, source in zip(rows, source_rows, strict=True):
        assert row["download_status"] == "downloaded"
        assert row["sha256"] == hashlib.sha256(jpeg).hexdigest()
        assert row["byte_size"] == len(jpeg)
        assert (row["width"], row["height"]) == (12, 9)
        assert row["provenance"] == source["provenance"]
        assert row["url_variants"] == source["url_variants"]
        expected = (
            output
            / source["official_slug"]
            / (
                source["source_review_id"]
                + "__"
                + source["image_identity"].rsplit("/", 1)[-1]
            )
        )
        assert row["local_path"] == expected.as_posix()
        assert expected.read_bytes() == jpeg
    first = results.read_bytes()
    assert download(lambda _: pytest.fail("Valid SHA must skip HTTP")) == rows
    assert results.read_bytes() == first
    assert manifest.read_bytes() == original
    assert len(delays) == 1


def test_corrupt_file_is_downloaded_again(run, jpeg):
    download, _, _, output, _ = run
    download(lambda _: httpx.Response(200, content=jpeg))
    path = next(output.rglob("*.jpg"))
    path.write_bytes(b"not an image")
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, content=jpeg)

    rows = download(handler)
    assert len(calls) == 1
    assert path.read_bytes() == jpeg
    assert all(row["download_status"] == "downloaded" for row in rows)


@pytest.mark.parametrize("status", [403, 429, 521])
def test_refused_access_stops_entire_run_without_retry_or_fallback(run, status):
    download, _, results, output, delays = run
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(status, headers={"retry-after": "1"})

    with pytest.raises(DownloadBlockedError, match=str(status)):
        download(handler)
    assert len(calls) == 1
    assert delays == []
    rows = read_manifest(results)
    assert [row["download_status"] for row in rows] == ["blocked", "pending"]
    assert not list(output.rglob("*.jpg"))


@pytest.mark.parametrize("kind", ["503", "timeout"])
def test_transient_failure_has_bounded_retries_and_jitter(run, kind):
    download, manifest, _, _, delays = run
    write_manifest(manifest, read_manifest(manifest)[:1])
    calls = []

    def handler(request):
        calls.append(str(request.url))
        if kind == "timeout":
            raise httpx.ReadTimeout("timeout", request=request)
        return httpx.Response(503)

    rows = download(handler)
    if kind == "timeout":
        assert len(calls) == 3
        assert len(set(calls)) == 1
    else:
        variants = read_manifest(manifest)[0]["url_variants"]
        assert len(calls) == len(set(calls)) == len(variants)
        assert set(calls) == set(variants)
    assert len(delays) == len(calls) - 1
    assert all(2 <= pause <= 5 for pause in delays)
    assert rows[0]["download_status"] == "failed"


def test_retry_can_recover(run, jpeg):
    download, manifest, _, _, _ = run
    write_manifest(manifest, read_manifest(manifest)[:1])
    responses = iter([httpx.Response(500), httpx.Response(200, content=jpeg)])
    assert download(lambda _: next(responses))[0]["download_status"] == "downloaded"


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, content=b"<html>error / CAPTCHA</html>"),
        httpx.Response(200, content=b"broken", headers={"content-type": "image/jpeg"}),
        httpx.Response(
            302, headers={"location": "https://irecommend.ru/content/review"}
        ),
        httpx.Response(404),
    ],
)
def test_invalid_image_or_redirect_is_never_saved_or_followed(run, response):
    download, manifest, _, output, _ = run
    write_manifest(manifest, read_manifest(manifest)[:1])
    calls = []

    def handler(request):
        calls.append(request)
        return response

    rows = download(handler)
    assert len(calls) == 1
    assert rows[0]["download_status"] == "failed"
    assert rows[0]["sha256"] is None
    assert not list(output.rglob("*.jpg"))


@pytest.mark.parametrize(
    "change",
    [
        {"verification_status": "auto"},
        {"match_status": "unmatched"},
        {"official_slug": "../escape"},
        {"source_review_id": "../123"},
        {"preferred_url": "https://irecommend.ru/content/review"},
        {"preferred_url": "https://example.com/image.jpg"},
        {"source": "otzovik"},
    ],
)
def test_invalid_or_unconfirmed_input_fails_before_any_http(run, change):
    download, manifest, _, _, _ = run
    rows = read_manifest(manifest)
    rows[-1].update(change)
    write_manifest(manifest, rows)
    with pytest.raises(ValueError):
        download(lambda _: pytest.fail("Input must be validated before requests"))


def test_results_cannot_overwrite_source_manifest(run):
    _, manifest, _, output, _ = run
    with pytest.raises(ValueError, match="overwrite"):
        download_manifest(manifest, output, manifest)


def test_valid_image_with_wrong_recorded_sha_is_not_trusted(run, jpeg):
    download, _, results, _, _ = run
    download(lambda _: httpx.Response(200, content=jpeg))
    previous = read_manifest(results)
    previous[0]["sha256"] = "0" * 64
    write_manifest(results, previous)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, content=jpeg)

    rows = download(handler)
    assert len(calls) == 1
    assert rows[0]["sha256"] == hashlib.sha256(jpeg).hexdigest()


def test_blocked_retry_preserves_other_downloaded_image_checkpoints(run, jpeg):
    download, _, results, output, _ = run
    first = download(lambda _: httpx.Response(200, content=jpeg))
    path = (
        output
        / first[0]["official_slug"]
        / (
            first[0]["source_review_id"]
            + "__"
            + first[0]["image_identity"].rsplit("/", 1)[-1]
        )
    )
    path.write_bytes(b"corrupt")
    with pytest.raises(DownloadBlockedError):
        download(lambda _: httpx.Response(429))
    checkpoint = read_manifest(results)
    assert checkpoint[0]["download_status"] == "blocked"
    assert checkpoint[1] == first[1]
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, content=jpeg)

    assert download(handler) == first
    assert len(calls) == 1


@pytest.mark.parametrize("status", [403, 429, 521])
def test_fallback_stops_immediately_on_access_refusal(run, status):
    download, manifest, results, _, _ = run
    write_manifest(manifest, read_manifest(manifest)[:1])
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(503 if len(calls) == 1 else status)

    with pytest.raises(DownloadBlockedError):
        download(handler)
    assert len(calls) == len(set(calls)) == 2
    assert read_manifest(results)[0]["download_url"] == calls[-1]


def test_fallback_uses_known_identity_once_and_never_thumbnail(run, jpeg):
    download, manifest, results, _, _ = run
    row = read_manifest(manifest)[0]
    thumbnail = row["preferred_url"].replace("/copyright1/", "/200i/")
    row["url_variants"] += [thumbnail, row["preferred_url"]]
    write_manifest(manifest, [row])
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(503 if len(calls) == 1 else 200, content=jpeg)

    result = download(handler)[0]
    assert len(calls) == len(set(calls)) == 2
    assert calls[0] == row["preferred_url"]
    assert all(url in row["url_variants"] for url in calls)
    assert thumbnail not in calls
    assert result["download_url"] == calls[-1]
    assert result["preferred_url"] == row["preferred_url"]
    assert result["image_identity"] == row["image_identity"]
    assert result["download_status"] == "downloaded"
    assert (
        download(lambda _: pytest.fail("Resume must reuse fallback download"))[0]
        == result
    )
    # All-5xx pass visits known non-thumbnail variants exactly once.
    results.unlink()
    calls.clear()

    def unavailable(request):
        calls.append(str(request.url))
        return httpx.Response(503)

    assert download(unavailable)[0]["download_status"] == "failed"
    assert set(calls) == set(row["url_variants"]) - {thumbnail}
    assert len(calls) == len(set(calls))


def test_foreign_identity_in_fallback_is_rejected_before_http(run):
    download, manifest, _, _, _ = run
    row = read_manifest(manifest)[0]
    row["url_variants"].append(
        row["preferred_url"].replace(row["image_identity"], "user-images/999/other.jpg")
    )
    write_manifest(manifest, [row])
    with pytest.raises(ValueError, match="same-identity"):
        download(lambda _: pytest.fail("Foreign identity must never be fetched"))
