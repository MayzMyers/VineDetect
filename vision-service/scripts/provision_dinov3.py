#!/usr/bin/env python3
"""One-time provisioning; HF authentication is never a runtime requirement."""

import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.v5.catalog import DINO_ID, DINO_REVISION  # noqa: E402
from app.v5.snapshot import (  # noqa: E402
    DEFAULT_DIRECTORY, DINO_FILES, MANIFEST, verify_snapshot,
)


def provision(output, *, cache_dir=None, local_files_only=False):
    output = Path(output).absolute()
    if output.exists():
        root, _ = verify_snapshot(output)
        return root
    from huggingface_hub import snapshot_download

    source = Path(snapshot_download(
        repo_id=DINO_ID,
        revision=DINO_REVISION,
        allow_patterns=list(DINO_FILES),
        cache_dir=cache_dir,
        local_files_only=local_files_only,
        token=False if local_files_only else os.environ.get("HF_TOKEN"),
    ))
    if source.name != DINO_REVISION:
        raise RuntimeError("Downloaded snapshot identity differs from pinned revision")
    output.parent.mkdir(parents=True, exist_ok=True)
    # Stage beside the destination; publish only a complete, verified snapshot.
    with tempfile.TemporaryDirectory(prefix=".dinov3-provision-", dir=output.parent) as stage:
        root = Path(stage) / "snapshot"
        root.mkdir()
        for name in DINO_FILES:
            shutil.copyfile(source / name, root / name, follow_symlinks=True)
        manifest = {
            "modelId": DINO_ID,
            "revision": DINO_REVISION,
            "snapshotIdentity": f"{DINO_ID}@{DINO_REVISION}",
            "sourceSnapshot": str(source),
            "files": DINO_FILES,
        }
        (root / MANIFEST).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        verify_snapshot(root)
        root.rename(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(DEFAULT_DIRECTORY))
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--local-files-only", action="store_true",
                        help="Provision from an existing exact cached snapshot without auth/network")
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    try:
        root = (verify_snapshot(args.output)[0] if args.verify_only else provision(
            args.output, cache_dir=args.cache_dir, local_files_only=args.local_files_only,
        ))
    except Exception as error:
        # Do not render third-party HTTP exceptions, URLs, headers or credentials.
        print(f"DINOv3 provisioning failed ({type(error).__name__}). Check access/license, "
              "pinned cache files and output directory; runtime snapshot was not published.",
              file=sys.stderr)
        return 1
    print(json.dumps({"modelId": DINO_ID, "revision": DINO_REVISION,
                      "snapshotPath": str(root), "verified": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
