"""Provision a checksummed runtime bundle, never model caches or evaluation images."""

import argparse
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.v5.catalog import Catalog, DINO_REVISION, sha256, validate_gallery


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--siglip-gallery", type=Path, required=True)
    parser.add_argument("--catalog-manifest", type=Path, required=True)
    parser.add_argument("--dinov3-gallery", type=Path, required=True)
    parser.add_argument("--asset-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("Output exists; use a new versioned release directory")
    validate_gallery(args.siglip_gallery)
    args.output.mkdir(parents=True)
    files = {}
    for name, source in {
        "embeddings.npy": args.siglip_gallery / "embeddings.npy",
        "rows.json": args.siglip_gallery / "rows.json",
        "metadata.json": args.siglip_gallery / "metadata.json",
        "catalog.json": args.catalog_manifest,
        "dinov3.npy": args.dinov3_gallery,
    }.items():
        shutil.copyfile(source, args.output / name)
        files[name] = sha256(args.output / name)
    release = {
        "architecture": "V5-RC1",
        "dinov3Revision": DINO_REVISION,
        "files": files,
    }
    (args.output / "release.json").write_text(json.dumps(release, indent=2) + "\n")
    catalog = Catalog(args.output, args.asset_root)
    if catalog.dino_gallery is None:
        raise ValueError("Cannot provision a release with an invalid DINOv3 gallery")
    for cid in catalog.by_id:
        catalog.reference_path(cid)
    print(f"Verified {len(catalog.rows)} official references: {args.output}")


if __name__ == "__main__":
    main()
