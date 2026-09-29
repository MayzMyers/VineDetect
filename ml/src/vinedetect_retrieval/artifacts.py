"""Deterministic artifacts and narrowly scoped asset loading."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import tempfile
from contextlib import contextmanager
from pathlib import Path

from PIL import Image

CONTEST = "lct-rshb-2026-09-15"
OFFICIAL_PATH = re.compile(
    r"contest/lct-rshb-2026-09-15"
    r"(?:-reference-overrides-v[1-9][0-9]*)?"
    r"/sha256/([a-f0-9]{2})/([a-f0-9]{64})\.(webp|png|jpg|jpeg)\Z"
)


def json_bytes(value):
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    ).encode("utf-8")


def digest(value):
    return hashlib.sha256(json_bytes(value)).hexdigest()


def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="." + path.name, suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def write_json(path, value):
    atomic_write(Path(path), json_bytes(value))


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


@contextmanager
def exclusive_lock(directory: Path):
    """OS-owned lock releases on Ctrl+C, process death, or reboot."""
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".lock").open("a+b") as stream:
        if os.name == "nt":
            import msvcrt

            stream.seek(0)
            stream.write(b"0")
            stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def asset_path(root: Path, stored: str) -> Path:
    if "\\" in stored or any(p in ("", ".", "..") for p in stored.split("/")):
        raise ValueError(f"Unsafe asset path: {stored}")
    if stored.startswith("contest/"):
        match = OFFICIAL_PATH.fullmatch(stored)
        if not match or not match[2].startswith(match[1]):
            raise ValueError(f"Invalid managed reference: {stored}")
        relative = stored
    elif stored.startswith("svoe_vino/"):
        relative = "svoe-vino/" + stored.removeprefix("svoe_vino/")
    else:
        raise ValueError(f"Unsupported asset namespace: {stored}")
    base = root.resolve()
    result = (base / relative).resolve()
    if not result.is_relative_to(base):
        raise ValueError(f"Asset escapes root: {stored}")
    return result


def inspect_image(root: Path, stored: str, sha=None, dimensions=None):
    path = asset_path(root, stored)
    raw = path.read_bytes()  # Fail on missing assets; never skip gallery rows.
    actual_sha = hashlib.sha256(raw).hexdigest()
    if sha is not None and actual_sha != sha:
        raise ValueError(f"SHA-256 mismatch: {stored}")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            width, height = image.size
            mime = Image.MIME.get(image.format)
            rgb = image.convert("RGB")
    except (OSError, ValueError) as error:
        raise ValueError(f"Unreadable image: {stored}") from error
    if dimensions is not None and (width, height) != tuple(dimensions):
        raise ValueError(f"Dimension mismatch: {stored}")
    return {"sha256": actual_sha, "width": width, "height": height, "mime_type": mime}, rgb
