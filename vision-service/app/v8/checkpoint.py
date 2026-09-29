"""Durable, content-validated checkpoints and one writer across every run phase."""

import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path


def canonical(value):
    if isinstance(value, dict):
        return {str(k): canonical(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [canonical(v) for v in value]
    return value


def digest(value):
    return hashlib.sha256(
        json.dumps(
            canonical(value),
            sort_keys=True,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf8") as f:
            json.dump(value, f, ensure_ascii=False, sort_keys=True, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def save(path, payload, provenance):
    atomic_json(
        path,
        dict(
            schema="v8-checkpoint/2",
            provenance=provenance,
            payload=payload,
            sha256=digest(payload),
        ),
    )


def read(path, provenance):
    try:
        record = json.loads(Path(path).read_text())
        if record["schema"] not in ("v8-checkpoint/1", "v8-checkpoint/2") or digest(
            record["provenance"]
        ) != digest(provenance):
            return None
        if record["sha256"] != digest(record["payload"]):
            if record["schema"] != "v8-checkpoint/1":
                return None
            # Version 1 hashed integer evidence keys before JSON converted them to strings.
            # Reconstruct that documented schema and require its original checksum.
            legacy = json.loads(json.dumps(record["payload"]))
            if "trace" in legacy and "evidence" in legacy["trace"]:
                legacy["trace"]["evidence"] = {
                    int(k): v for k, v in legacy["trace"]["evidence"].items()
                }
            original_hash = hashlib.sha256(
                json.dumps(
                    legacy,
                    sort_keys=True,
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest()
            if record["sha256"] != original_hash:
                return None
        if record["schema"] == "v8-checkpoint/1":
            save(path, record["payload"], provenance)
        return record["payload"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


@contextmanager
def writer_lock(root):
    import fcntl

    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".writer.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
