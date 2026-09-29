import json

import numpy as np
import pytest

from app.v5.catalog import Catalog, DINO_REVISION, SIGLIP_ID, SIGLIP_REVISION, sha256


def write_json(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    )


def bundle(tmp_path):
    root, assets = tmp_path / "gallery", tmp_path / "assets"
    root.mkdir()
    assets.mkdir()
    reference = assets / "ref.webp"
    reference.write_bytes(b"immutable reference fixture")
    row = {
        "catalog_item_id": 1,
        "official_slug": "official-one",
        "title": "One",
        "reference_path": "ref.webp",
        "reference_sha256": sha256(reference),
    }
    mapping = [
        {
            "catalog_item_id": 1,
            "official_slug": "official-one",
            "path": "ref.webp",
            "sha256": row["reference_sha256"],
        }
    ]
    vectors = np.zeros((1, 1152), dtype=np.float32)
    vectors[0, 0] = 1.0
    np.save(root / "embeddings.npy", vectors)
    write_json(root / "rows.json", mapping)
    write_json(root / "catalog.json", [row])
    write_json(
        root / "metadata.json",
        {
            "complete": True,
            "config": {
                "requested_model_id": SIGLIP_ID,
                "resolved_revision": SIGLIP_REVISION,
                "max_num_patches": 256,
            },
            "matrix_sha256": sha256(root / "embeddings.npy"),
            "row_mapping_sha256": sha256(root / "rows.json"),
        },
    )
    np.save(root / "dinov3.npy", vectors[:, :768])
    write_json(
        root / "release.json",
        {
            "dinov3Revision": DINO_REVISION,
            "files": {p.name: sha256(p) for p in root.iterdir()},
        },
    )
    return root, assets


def test_official_mapping_and_reference_integrity(tmp_path):
    root, assets = bundle(tmp_path)
    catalog = Catalog(root, assets)
    assert catalog.identity(1)["officialSlug"] == "official-one"
    assert catalog.reference_path(1) == assets / "ref.webp"
    (assets / "ref.webp").write_bytes(b"replaced")
    with pytest.raises(ValueError, match="checksum"):
        catalog.reference_path(1)


def test_siglip_corruption_fails_closed(tmp_path):
    root, assets = bundle(tmp_path)
    (root / "embeddings.npy").write_bytes(b"corrupted")
    with pytest.raises(ValueError, match="checksum"):
        Catalog(root, assets)


def test_missing_dino_gallery_is_auxiliary_abstention(tmp_path, caplog):
    root, assets = bundle(tmp_path)
    (root / "dinov3.npy").unlink()
    catalog = Catalog(root, assets)
    assert catalog.dino_gallery is None
    assert catalog.identity(1)["catalogItemId"] == 1
    assert "DINOv3 gallery unavailable" in caplog.text


def test_gallery_row_order_is_verified_against_embedding_metadata(tmp_path):
    root, assets = bundle(tmp_path)
    mapping = json.loads((root / "rows.json").read_text())
    mapping[0]["catalog_item_id"] = 2
    write_json(root / "rows.json", mapping)
    release = json.loads((root / "release.json").read_text())
    release["files"]["rows.json"] = sha256(root / "rows.json")
    write_json(root / "release.json", release)
    with pytest.raises(ValueError, match="row mapping"):
        Catalog(root, assets)
