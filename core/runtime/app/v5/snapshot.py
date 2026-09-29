"""Verify the exact DINOv3 runtime artifacts; never contact the Hub."""

import json
from pathlib import Path

from .catalog import DINO_ID, DINO_REVISION, sha256

# Bytes from the frozen model revision, including the unchanged image processor.
DINO_FILES = {
    "config.json": "3c9cc418f4622fd6d5587fd142b6f3cba0ba6a69f67ced907d8b7f26118451ec",
    "preprocessor_config.json": "960c41d1f3a7778b936365769a2d90550b318a6c0a53a0296957adacfe5e0dd7",
    "model.safetensors": "9a21ac3df0c63839d62612dda6f454d816c25611cc7a52966ed5a5a94921dc8b",
}
MANIFEST = "snapshot.json"
DEFAULT_DIRECTORY = f".runtime/models/dinov3-vitb16-{DINO_REVISION}"


def verify_snapshot(directory):
    root = Path(directory).resolve()
    try:
        manifest = json.loads((root / MANIFEST).read_text(encoding="utf-8"))
        if (
            manifest.get("modelId") != DINO_ID
            or manifest.get("revision") != DINO_REVISION
            or manifest.get("snapshotIdentity") != f"{DINO_ID}@{DINO_REVISION}"
            or manifest.get("files") != DINO_FILES
        ):
            raise ValueError("model identity, revision or file manifest mismatch")
        if {p.name for p in root.iterdir()} != {*DINO_FILES, MANIFEST}:
            raise ValueError("snapshot contains missing or unexpected files")
        for name, expected in DINO_FILES.items():
            path = root / name
            if path.is_symlink() or not path.is_file() or sha256(path) != expected:
                raise ValueError(f"checksum or regular-file check failed: {name}")
    except (OSError, ValueError, TypeError, AttributeError) as error:
        raise RuntimeError(
            f"DINOv3 local snapshot missing or invalid at {root}: {error}. "
            "Run vision-service/scripts/provision_dinov3.py before startup."
        ) from error
    return root, manifest
