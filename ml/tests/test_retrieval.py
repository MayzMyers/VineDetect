from __future__ import annotations

import hashlib
from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from vinedetect_retrieval.artifacts import asset_path, digest, inspect_image, read_json, write_json
from vinedetect_retrieval.embeddings import (
    cache_identity,
    embed_manifest,
    embedding_rows,
    load_bundle,
)
from vinedetect_retrieval.encoder import dtype_for, normalize, select_device
from vinedetect_retrieval.manifests import ambiguities, proxy_rows, validate_gallery
from vinedetect_retrieval.retrieval import evaluate_vectors, rank_scores, self_sanity


@pytest.fixture
def gallery(tmp_path):
    raw_path = tmp_path / "source.png"
    Image.new("RGB", (18, 42), (130, 30, 60)).save(raw_path)
    raw = raw_path.read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    stored = f"contest/lct-rshb-2026-09-15/sha256/{sha[:2]}/{sha}.png"
    target = tmp_path / stored
    target.parent.mkdir(parents=True)
    target.write_bytes(raw)
    rows = [
        {
            "catalog_item_id": i,
            "official_slug": f"wine-{i}",
            "wine_id": 1,
            "reference_path": stored,
            "reference_sha256": sha,
            "width": 18,
            "height": 42,
            "mime_type": "image/png",
            "resolution_method": "shared_reference",
            "reference_provenance": {},
            "link_provenance": {},
            "review_note": None,
            "link_method": "exact_slug",
        }
        for i in (1, 2, 3)
    ]
    return tmp_path, {
        "dataset_type": "official_gallery",
        "sample_only": True,
        "rows": rows,
        "row_count": 3,
    }


class FakeEncoder:
    dimension = 4
    batch_size = 1
    load_seconds = 0
    environment = {"selected_device": "cpu"}
    device = "cpu"
    last_inputs = {"pixel_values": [1, 256, 768]}

    def __init__(self, revision="test-commit", fail_after=None):
        self.config = {
            "dtype": "float32",
            "max_num_patches": 256,
            "model_id": "fixture",
            "resolved_revision": revision,
            "batch_size": 1,
            "processor": "fixture-v1",
        }
        self.calls = 0
        self.fail_after = fail_after

    def encode(self, images):
        if self.fail_after is not None and self.calls >= self.fail_after:
            raise KeyboardInterrupt
        self.calls += len(images)
        return normalize(np.array([[1, 2, 3, 4]] * len(images), dtype=np.float32))

    def memory(self):
        return {"process_peak_rss_bytes": None}


@pytest.mark.parametrize(
    "requested,available,expected",
    [
        ("auto", False, "cpu"),
        ("cpu", False, "cpu"),
        ("auto", True, "cuda"),
        ("cuda", True, "cuda"),
        ("cpu", True, "cpu"),
    ],
)
def test_device_selection_including_mock_rocm(requested, available, expected):
    runtime = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: available),
        version=SimpleNamespace(hip="ROCm" if available else None),
    )
    assert select_device(requested, runtime) == expected


def test_explicit_unavailable_accelerator():
    with pytest.raises(ValueError, match="CUDA/ROCm"):
        select_device("cuda", SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)))


def test_dtype_safety():
    runtime = SimpleNamespace(
        float32="f32",
        float16="f16",
        bfloat16="bf16",
        cuda=SimpleNamespace(is_bf16_supported=lambda: False),
    )
    assert dtype_for("float32", "cpu", runtime) == "f32"
    assert dtype_for("float16", "cuda", runtime) == "f16"
    with pytest.raises(ValueError, match="CPU baseline"):
        dtype_for("float16", "cpu", runtime)
    with pytest.raises(ValueError, match="unsupported"):
        dtype_for("bfloat16", "cuda", runtime)


def test_gallery_duplicates_preserved_and_canonical_order(gallery):
    root, manifest = gallery
    rows = manifest["rows"]
    validated = validate_gallery(list(reversed(rows)), root, 3, 1)
    assert [r["catalog_item_id"] for r in validated] == [1, 2, 3]
    assert len(validated) == 3
    with pytest.raises(ValueError, match="2103"):
        validate_gallery(rows, root)
    with pytest.raises(ValueError, match="unique official"):
        validate_gallery([rows[0]] * 3, root, 3, 1)


def test_missing_corrupt_hash_and_dimension_failures(gallery):
    root, manifest = gallery
    row = manifest["rows"][0]
    with pytest.raises(ValueError, match="SHA-256"):
        inspect_image(root, row["reference_path"], "0" * 64)
    with pytest.raises(ValueError, match="Dimension"):
        inspect_image(root, row["reference_path"], dimensions=(1, 1))
    actual = asset_path(root, row["reference_path"])
    actual.write_bytes(b"broken")
    with pytest.raises(ValueError, match="Unreadable"):
        inspect_image(root, row["reference_path"])
    actual.unlink()
    with pytest.raises(FileNotFoundError):
        inspect_image(root, row["reference_path"])


@pytest.mark.parametrize(
    "stored",
    [
        "../private",
        "svoe_vino/../private",
        "/svoe_vino/a",
        "svoe_vino\\a",
        "contest/anything",
        "contest/lct-rshb-2026-09-15-reference-overrides-v0/sha256/aa/" + "a" * 64 + ".png",
        "contest/arbitrary-reference-overrides-v1/sha256/aa/" + "a" * 64 + ".png",
        "svoe_vino//a",
    ],
)
def test_asset_traversal_rejection(tmp_path, stored):
    with pytest.raises(ValueError):
        asset_path(tmp_path, stored)


def test_versioned_reference_override_asset_namespace(tmp_path):
    sha = "a" * 64
    stored = f"contest/lct-rshb-2026-09-15-reference-overrides-v1/sha256/{sha[:2]}/{sha}.png"
    assert asset_path(tmp_path, stored) == tmp_path / stored


def test_symlink_escape(tmp_path):
    outside = tmp_path.parent / (tmp_path.name + "-outside")
    outside.mkdir()
    (tmp_path / "svoe-vino").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="escapes"):
        asset_path(tmp_path, "svoe_vino/test.png")


def test_ambiguity_manifest_all_physical_and_source_flags(gallery):
    _, manifest = gallery
    rows = deepcopy(manifest["rows"])
    rows[2]["resolution_method"] = "source_preserving_shared"
    rows[2]["reference_provenance"] = {"source_data_inconsistencies": ["wrong organizer label"]}
    result = ambiguities(rows)
    assert result == ambiguities(list(reversed(rows)))
    assert result["group_count"] == 1
    assert result["groups"][0]["catalog_item_ids"] == [1, 2, 3]
    assert set(result["groups"][0]["reasons"]) >= {
        "duplicate_sha256",
        "shared_physical_path",
        "shared_reference",
        "source_preserving_shared",
        "organizer_source_inconsistency",
    }


def test_proxy_same_source_metadata_and_unusable_exclusion(gallery):
    root, manifest = gallery
    image = root / "svoe-vino/bottle/1/image.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(asset_path(root, manifest["rows"][0]["reference_path"]).read_bytes())
    historical = [
        {
            "catalog_item_id": 1,
            "historical_image_id": 10,
            "historical_wine_id": 1,
            "historical_local_path": "svoe_vino/bottle/1/image.png",
        },
        {
            "catalog_item_id": 2,
            "historical_image_id": 11,
            "historical_wine_id": 1,
            "historical_local_path": "svoe_vino/missing.png",
        },
    ]
    queries, excluded = proxy_rows(manifest["rows"], historical, root)
    assert len(queries) == len(excluded) == 1
    assert queries[0]["byte_identical"] is True
    assert queries[0]["dataset_type"] == "proxy_same_source"
    manifest["rows"][0]["link_method"] = "re_slug"
    with pytest.raises(ValueError, match="exact_slug"):
        proxy_rows(manifest["rows"], historical, root)


def test_normalization_and_invalid_vectors():
    vectors = normalize([[3, 4], [5, 12]])
    np.testing.assert_allclose(np.linalg.norm(vectors, axis=1), 1)
    for bad in ([[0, 0]], [[float("nan"), 1]], [1, 2]):
        with pytest.raises(ValueError):
            normalize(bad)


def test_row_mapping_and_resume_checkpoint_after_interrupt(gallery):
    root, manifest = gallery
    out, cache = root / "bundle", root / "checkpoints"
    first = FakeEncoder(fail_after=1)
    with pytest.raises(KeyboardInterrupt):
        embed_manifest(manifest, first, root, out, cache, show_progress=False)
    assert len(list(cache.rglob("*.npz"))) == 1
    with pytest.raises(ValueError, match="incomplete"):
        load_bundle(out)
    resumed = FakeEncoder()
    _, benchmark = embed_manifest(manifest, resumed, root, out, cache, show_progress=False)
    assert resumed.calls == 2 and benchmark["reused"] == 1
    matrix, rows, metadata = load_bundle(out)
    assert matrix.shape == (3, 4)
    assert [r["catalog_item_id"] for r in rows] == [1, 2, 3]
    assert metadata["row_count"] == 3
    original = {
        name: (out / name).read_bytes() for name in ("embeddings.npy", "metadata.json", "rows.json")
    }
    replay = FakeEncoder()
    embed_manifest(manifest, replay, root, out, cache, show_progress=False)
    assert replay.calls == 0
    assert original == {name: (out / name).read_bytes() for name in original}


def test_model_and_config_invalidate_cache(gallery):
    root, manifest = gallery
    out, cache = root / "bundle", root / "checkpoints"
    embed_manifest(manifest, FakeEncoder(), root, out, cache, show_progress=False)
    changed = FakeEncoder(revision="different-commit")
    embed_manifest(manifest, changed, root, out, cache, show_progress=False)
    assert changed.calls == 3
    changed = FakeEncoder()
    changed.config["max_num_patches"] = 512
    embed_manifest(manifest, changed, root, out, cache, show_progress=False)
    assert changed.calls == 3
    row = embedding_rows(manifest)[0]
    original = cache_identity(changed.config, "official_gallery", row)
    assert original != cache_identity(
        changed.config, "official_gallery", {**row, "sha256": "b" * 64}
    )
    assert original != cache_identity(changed.config, "official_gallery", {**row, "row_id": "99"})


def test_cache_hit_still_verifies_source_bytes(gallery):
    root, manifest = gallery
    out, cache = root / "bundle", root / "checkpoints"
    embed_manifest(manifest, FakeEncoder(), root, out, cache, show_progress=False)
    asset_path(root, manifest["rows"][0]["reference_path"]).write_bytes(b"changed")
    with pytest.raises(ValueError, match="SHA-256"):
        embed_manifest(manifest, FakeEncoder(), root, out, cache, show_progress=False)


def test_matrix_mapping_corruption_rejected(gallery):
    root, manifest = gallery
    out = root / "bundle"
    embed_manifest(manifest, FakeEncoder(), root, out, root / "cache", show_progress=False)
    rows = read_json(out / "rows.json")
    rows[0]["catalog_item_id"] = 42
    write_json(out / "rows.json", rows)
    with pytest.raises(ValueError, match="checksum"):
        load_bundle(out)


def test_noncanonical_order_rejected(gallery):
    _, manifest = gallery
    manifest["rows"].reverse()
    with pytest.raises(ValueError, match="canonically ordered"):
        embedding_rows(manifest)


def test_exact_ranking_tie_breaks_on_catalog_id():
    assert rank_scores([0.5, 0.9, 0.9], [1, 3, 2]).tolist() == [2, 1, 0]
    assert rank_scores([0.5, 0.9, 0.90000001], [1, 2, 3]).tolist() == [2, 1, 0]


def test_strict_vs_visual_equivalence_and_unambiguous_metrics():
    rows = [
        {
            "catalog_item_id": i,
            "row_id": str(i),
            "official_slug": f"wine-{i}",
            "sha256": "same" if i < 3 else "other",
        }
        for i in (1, 2, 3)
    ]
    matrix = np.array([[1, 0], [1, 0], [0, 1]], dtype=np.float32)
    result = evaluate_vectors(matrix[1:], matrix, rows[1:], rows)
    assert result["strict"]["top_1_accuracy"] == 0.5
    assert result["strict"]["top_3_accuracy"] == 1
    assert result["strict"]["mrr"] == 0.75
    assert result["strict"]["mean_rank"] == 1.5
    assert result["diagnostic_visual_equivalence"]["top_1_accuracy"] == 1
    assert result["strict_excluding_multi_identity_identical_reference"]["count"] == 1
    amb = {"duplicate_sha256_groups": [{"catalog_item_ids": [1, 2]}]}
    assert self_sanity(matrix, rows, amb)["passed"]
    assert not self_sanity(matrix, rows, {"duplicate_sha256_groups": []})["passed"]
    rows[1]["sha256"] = "unexplained"
    assert not self_sanity(matrix, rows, amb)["passed"]


def test_no_database_mutations_in_manifest_query_surface():
    from vinedetect_retrieval.manifests import GALLERY_SQL, HISTORICAL_SQL

    for sql in (GALLERY_SQL, HISTORICAL_SQL):
        assert sql.strip().startswith("SELECT")
        assert not any(
            word in sql.upper().split()
            for word in ("INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP")
        )


def test_deterministic_json_encoding():
    assert digest({"b": 2, "a": 1}) == digest({"a": 1, "b": 2})


def test_proxy_rejects_historical_wine_791_as_positive_for_603(gallery):
    root, manifest = gallery
    rows = deepcopy(manifest["rows"][:2])
    rows[0].update(catalog_item_id=603, wine_id=3981, link_method="materialized_official")
    rows[1].update(catalog_item_id=605, wine_id=791, link_method="exact_slug")
    image = root / "svoe-vino/bottle/791/image.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(asset_path(root, rows[1]["reference_path"]).read_bytes())
    historical = {
        "catalog_item_id": 605,
        "historical_image_id": 791,
        "historical_wine_id": 791,
        "historical_local_path": "svoe_vino/bottle/791/image.png",
    }
    queries, excluded = proxy_rows(rows, [historical], root)
    assert excluded == []
    assert queries[0]["expected_catalog_item_id"] == 605
    assert queries[0]["wine_id"] == queries[0]["historical_wine_id"] == 791
    historical["catalog_item_id"] = 603
    with pytest.raises(ValueError, match="exact_slug"):
        proxy_rows(rows, [historical], root)
    # Even a stale/incorrect eligibility flag cannot hide a mismatched owner.
    rows[0]["link_method"] = "exact_slug"
    with pytest.raises(ValueError, match="wine identity differs"):
        proxy_rows(rows, [historical], root)
