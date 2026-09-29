"""Sequential image download from an explicitly human-confirmed UGC manifest."""

from __future__ import annotations

import argparse
import hashlib
import io
import random
import re
import time
from collections.abc import Callable
from pathlib import Path
from urllib.parse import unquote, urlsplit

import httpx
from PIL import Image, UnidentifiedImageError

from app.irecommend import image_url_priority
from app.irecommend_manifest import confirmed_manifest, read_manifest, write_manifest


class DownloadBlockedError(RuntimeError):
    """The server refused access; stop the entire run without a bypass/retry."""


def _image_metadata(content: bytes) -> dict:
    with Image.open(io.BytesIO(content)) as image:
        image.verify()
    with Image.open(io.BytesIO(content)) as image:
        image.load()
        width, height = image.size
        if width <= 0 or height <= 0:
            raise ValueError("Empty image dimensions")
    return {
        "sha256": hashlib.sha256(content).hexdigest(),
        "byte_size": len(content),
        "width": width,
        "height": height,
    }


def _destination(row: dict, output_dir: Path) -> Path:
    """Validate source URL and identity before permitting any network I/O."""
    identity = row["image_identity"]
    if row["source"] != "irecommend" or not re.fullmatch(
        r"user-images/[0-9]+/[A-Za-z0-9_-]+\.[A-Za-z0-9]+", identity
    ):
        raise ValueError("Expected an IRecommend user-image identity")
    variants = row.get("url_variants", [])
    if row.get("preferred_url") not in variants:
        raise ValueError("Preferred URL must be an observed variant")
    for url in variants:
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or parsed.hostname not in {"irecommend.ru", "cdn-irec.r-99.com"}
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in {None, 443}
            or parsed.fragment
            or not unquote(parsed.path).startswith("/sites/default/files/")
            or not unquote(parsed.path).endswith("/" + identity)
        ):
            raise ValueError(
                "Only observed same-identity IRecommend image URLs are allowed"
            )
    slug = row["official_slug"]
    review_id = row["source_review_id"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", slug) or not re.fullmatch(
        r"[0-9]+", review_id
    ):
        raise ValueError("Unsafe slug or review ID")
    destination = output_dir / slug / f"{review_id}__{identity.rsplit('/', 1)[-1]}"
    if not destination.resolve().is_relative_to(output_dir.resolve()):
        raise ValueError("Image path escapes output directory")
    return destination


def _download_urls(row: dict) -> list[str]:
    urls = list(dict.fromkeys([row["preferred_url"], *row["url_variants"]]))
    if any(re.search(r"/imagecache/copyright1?/", urlsplit(url).path) for url in urls):
        urls = [url for url in urls if "/imagecache/200i/" not in urlsplit(url).path]
    return sorted(urls, key=image_url_priority)


def download_manifest(
    manifest: Path,
    output_dir: Path,
    results_path: Path,
    *,
    timeout: float = 30.0,
    max_retries: int = 2,
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> list[dict]:
    """Download preferred URLs with a single pass over known variants on 5xx.

    All input rows must already be matched + human_confirmed. Redirects are
    disabled; only 5xx permits moving to the next same-identity variant.
    Requests (including retries) are separated by 2-5s.
    No automatic matcher decision authorizes a download.
    """
    if timeout <= 0 or type(max_retries) is not int or not 0 <= max_retries <= 3:
        raise ValueError("Require positive timeout and 0-3 retries")
    if manifest.resolve() == results_path.resolve():
        raise ValueError("Results must not overwrite the confirmed manifest")
    input_rows = read_manifest(manifest)
    rows = confirmed_manifest(input_rows)
    if any(
        row["match_status"] != "matched"
        or row["verification_status"] != "human_confirmed"
        for row in input_rows
    ):
        raise ValueError("Downloader requires an entirely human-confirmed manifest")
    destinations = [_destination(row, output_dir) for row in rows]
    if any(
        path.resolve() in {manifest.resolve(), results_path.resolve()}
        for path in destinations
    ):
        raise ValueError("Image path must not overwrite a manifest")
    previous = {}
    if results_path.exists():
        for row in read_manifest(results_path):
            identity = row["image_identity"]
            if identity in previous:
                raise ValueError("Duplicate image identity in download results")
            previous[identity] = row
    results = [
        {
            **row,
            "local_path": path.as_posix(),
            "sha256": None,
            "byte_size": None,
            "download_status": "pending",
        }
        for row, path in zip(rows, destinations, strict=True)
    ]
    attempted = False
    image_errors = (
        OSError,
        ValueError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
    )
    # Validate all cached files before checkpoints can replace the old journal.
    for result, path in zip(results, destinations, strict=True):
        old = previous.get(result["image_identity"], {})
        if (
            old.get("download_status") == "downloaded"
            and old.get("download_url", old.get("preferred_url"))
            in result["url_variants"]
            and old.get("local_path") == result["local_path"]
            and path.is_file()
        ):
            try:
                metadata = _image_metadata(path.read_bytes())
                if metadata["sha256"] == old.get("sha256"):
                    result.update(metadata, download_status="downloaded")
                    result["download_url"] = old.get(
                        "download_url", old["preferred_url"]
                    )
                    if "http_status" in old:
                        result["http_status"] = old["http_status"]
                    continue
            except image_errors:
                pass  # Missing/corrupt/unverified bytes must be downloaded again.
    write_manifest(results_path, results)
    with httpx.Client(
        timeout=timeout, follow_redirects=False, trust_env=False, transport=transport
    ) as client:
        for result, path in zip(results, destinations, strict=True):
            if result["download_status"] == "downloaded":
                continue
            response = None
            urls = iter(_download_urls(result))
            url = next(urls)
            transport_retries = 0
            while True:
                if attempted:
                    sleep(random.uniform(2.0, 5.0))
                attempted = True
                response = None
                result["download_url"] = url
                try:
                    response = client.get(url)
                except httpx.TransportError as exc:
                    result.update(download_status="failed", download_error=str(exc))
                    if transport_retries < max_retries:
                        transport_retries += 1
                        continue
                    break
                result["http_status"] = response.status_code
                if response.status_code in {403, 429, 521}:
                    result.update(
                        download_status="blocked",
                        download_error="Server refused access",
                    )
                    write_manifest(results_path, results)
                    raise DownloadBlockedError(
                        f"HTTP {response.status_code}: stopped; no retry"
                    )
                if 500 <= response.status_code < 600:
                    next_url = next(urls, None)
                    if next_url is not None:
                        url = next_url
                        continue
                break
            if response is not None:
                if response.is_success:
                    try:
                        metadata = _image_metadata(response.content)
                    except image_errors as exc:
                        result.update(
                            download_status="failed",
                            download_error=f"Invalid image: {exc}",
                        )
                    else:
                        path.parent.mkdir(parents=True, exist_ok=True)
                        temporary = path.with_name(path.name + ".tmp")
                        try:
                            temporary.write_bytes(response.content)
                            temporary.replace(path)
                        finally:
                            temporary.unlink(missing_ok=True)
                        result.pop("download_error", None)
                        result.update(metadata, download_status="downloaded")
                else:
                    result.update(
                        download_status="failed",
                        download_error=f"HTTP {response.status_code}",
                    )
            write_manifest(results_path, results)
    write_manifest(results_path, results)
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("data/irecommend/manifest.confirmed.jsonl"),
    )
    parser.add_argument(
        "--output-dir", type=Path, default=Path("data/irecommend/images")
    )
    parser.add_argument(
        "--results", type=Path, default=Path("data/irecommend/download_results.jsonl")
    )
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--max-retries", type=int, default=2)
    args = parser.parse_args(argv)
    try:
        rows = download_manifest(
            args.manifest,
            args.output_dir,
            args.results,
            timeout=args.timeout,
            max_retries=args.max_retries,
        )
    except (OSError, ValueError, KeyError, TypeError, DownloadBlockedError) as exc:
        parser.exit(1, f"Download stopped: {exc}\n")
    count = sum(row["download_status"] == "downloaded" for row in rows)
    print(f"{count}/{len(rows)} images ready -> {args.results}")
    return 0 if count == len(rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
