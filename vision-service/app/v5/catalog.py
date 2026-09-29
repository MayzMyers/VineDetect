"""Immutable release gallery and official catalog mapping."""

import hashlib
import json
import logging
from pathlib import Path

import numpy as np

SIGLIP_ID = "google/siglip2-so400m-patch16-naflex"
SIGLIP_REVISION = "cc24074f717b612951c2dead130904ab9b65a81e"
DINO_ID = "facebook/dinov3-vitb16-pretrain-lvd1689m"
DINO_REVISION = "5931719e67bbdb9737e363e781fb0c67687896bc"


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rows(value):
    return value["rows"] if isinstance(value, dict) else value


def validate_gallery(root):
    root = Path(root)
    metadata = json.loads((root / "metadata.json").read_text())
    config = metadata["config"]
    if (
        not metadata["complete"]
        or config["requested_model_id"] != SIGLIP_ID
        or config["resolved_revision"] != SIGLIP_REVISION
        or config["max_num_patches"] != 256
    ):
        raise ValueError("Gallery does not match frozen SigLIP provenance")
    if sha256(root / "embeddings.npy") != metadata["matrix_sha256"]:
        raise ValueError("SigLIP matrix checksum mismatch")
    # Frozen exporter hashes canonical row JSON, not file whitespace.
    mapping = rows(json.loads((root / "rows.json").read_text()))
    canonical = (
        json.dumps(
            mapping, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False
        )
        + "\n"
    ).encode("utf-8")
    if hashlib.sha256(canonical).hexdigest() != metadata["row_mapping_sha256"]:
        raise ValueError("SigLIP row mapping checksum mismatch")
    matrix = np.load(root / "embeddings.npy", mmap_mode="r")
    if matrix.shape != (len(mapping), 1152) or matrix.dtype != np.float32:
        raise ValueError("Invalid SigLIP matrix shape/dtype")
    if not np.isfinite(matrix).all() or not np.allclose(
        np.linalg.norm(matrix, axis=1), 1, atol=2e-6, rtol=0
    ):
        raise ValueError("Invalid SigLIP vectors")
    return mapping


class Catalog:
    def __init__(self, root, asset_root):
        self.root, self.asset_root = Path(root), Path(asset_root).resolve()
        release = json.loads((self.root / "release.json").read_text())
        for name, checksum in release["files"].items():
            if name == "dinov3.npy":
                continue
            if Path(name).name != name or sha256(self.root / name) != checksum:
                raise ValueError(f"Release checksum mismatch: {name}")
        mapping = validate_gallery(self.root)
        self.rows = rows(json.loads((self.root / "catalog.json").read_text()))
        if len(self.rows) != len(mapping):
            raise ValueError("Catalog/gallery length mismatch")
        self.by_id = {}
        for item, ref in zip(self.rows, mapping):
            cid = int(item["catalog_item_id"])
            if (
                cid != int(ref["catalog_item_id"])
                or item["official_slug"] != ref["official_slug"]
                or item["reference_path"] != ref["path"]
                or item["reference_sha256"] != ref["sha256"]
            ):
                raise ValueError(f"Catalog/gallery identity mismatch: {cid}")
            if cid in self.by_id or not item.get("title") or not item["official_slug"]:
                raise ValueError(f"Invalid official identity: {cid}")
            self.by_id[cid] = item
        self.dino_gallery = None
        if "dinov3.npy" in release["files"]:
            try:
                if sha256(self.root / "dinov3.npy") != release["files"]["dinov3.npy"]:
                    raise ValueError("DINOv3 gallery checksum mismatch")
                if release.get("dinov3Revision") != DINO_REVISION:
                    raise ValueError("DINOv3 gallery revision mismatch")
                matrix = np.load(self.root / "dinov3.npy", mmap_mode="r")
                if (
                    matrix.shape != (len(self.rows), 768)
                    or matrix.dtype != np.float32
                    or not np.isfinite(matrix).all()
                    or not np.allclose(
                        np.linalg.norm(matrix, axis=1), 1, atol=2e-6, rtol=0
                    )
                ):
                    raise ValueError("Invalid DINOv3 gallery")
                self.dino_gallery = matrix
            except (OSError, ValueError):
                logging.getLogger(__name__).exception(
                    "DINOv3 gallery unavailable; evidence will abstain"
                )

    def reference_path(self, cid):
        row = self.by_id[cid]
        path = (self.asset_root / row["reference_path"]).resolve()
        if not path.is_relative_to(self.asset_root):
            raise ValueError("Reference path escapes asset root")
        if sha256(path) != row["reference_sha256"]:
            raise ValueError(f"Reference checksum mismatch: {cid}")
        return path

    def identity(self, cid):
        row = self.by_id[cid]
        return {
            "catalogItemId": cid,
            "officialSlug": row["official_slug"],
            "title": row["title"],
        }
