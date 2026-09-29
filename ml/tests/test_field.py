from __future__ import annotations

import hashlib
import json
from copy import deepcopy

import numpy as np
import pytest
from PIL import Image
from test_retrieval import FakeEncoder

from vinedetect_retrieval.artifacts import digest, write_json
from vinedetect_retrieval.embeddings import embed_manifest, load_bundle
from vinedetect_retrieval.field_cli import guard_field_outputs
from vinedetect_retrieval.field_data import (
    STATUSES,
    build_field_manifest,
    empty_labels,
    ensure_labels,
    field_path,
    inspect_field_image,
    validate_labels,
)
from vinedetect_retrieval.field_retrieval import (
    evaluate_field,
    evaluate_field_vectors,
    load_field_pair,
    proxy_errors,
    retrieve_field,
    retrieve_vectors,
)
from vinedetect_retrieval.field_review import build_review


@pytest.fixture
def field_case(tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    Image.new("RGB", (20, 50), (90, 20, 70)).save(raw / "a.jpg")
    (raw / "z.JPG").write_bytes((raw / "a.jpg").read_bytes())
    assets = tmp_path / "assets"
    sha = hashlib.sha256((raw / "a.jpg").read_bytes()).hexdigest()
    path = f"contest/lct-rshb-2026-09-15/sha256/{sha[:2]}/{sha}.jpg"
    file = assets / path
    file.parent.mkdir(parents=True)
    file.write_bytes((raw / "a.jpg").read_bytes())
    gallery = {
        "dataset_type": "official_gallery",
        "row_count": 12,
        "rows": [
            {
                "catalog_item_id": i,
                "official_slug": f"wine-{i}",
                "reference_path": path,
                "reference_sha256": sha,
                "title": "Wine <script> & title",
                "winery": "Winery",
                "width": 20,
                "height": 50,
            }
            for i in range(1, 13)
        ],
    }
    manifest = build_field_manifest(raw, gallery)
    return raw, assets, gallery, manifest


def test_manifest_deterministic_duplicates_and_immutable(field_case):
    raw, _, gallery, manifest = field_case
    before = {p.name: p.read_bytes() for p in raw.iterdir()}
    assert manifest == build_field_manifest(raw, gallery, 2)
    assert manifest["row_count"] == manifest["successfully_decoded"] == 2
    assert len(manifest["duplicate_sha256_groups"]) == 1
    assert len({r["field_image_id"] for r in manifest["rows"]}) == 2
    assert all(
        r["sha256"] == hashlib.sha256(before[r["original_filename"]]).hexdigest()
        for r in manifest["rows"]
    )
    assert all(
        r["expected_slug"] is None and r["label_status"] == "unreviewed" for r in manifest["rows"]
    )
    assert before == {p.name: p.read_bytes() for p in raw.iterdir()}
    with pytest.raises(ValueError, match="count"):
        build_field_manifest(raw, gallery, 322)
    (raw / "broken.png").write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="broken.png"):
        build_field_manifest(raw, gallery)


@pytest.mark.parametrize("path", ["../a.jpg", "/a.jpg", "a/../b", "a\\b", "a//b", "C:/a.jpg"])
def test_field_traversal_rejected(tmp_path, path):
    with pytest.raises(ValueError):
        field_path(tmp_path, path)


def test_field_symlink_and_change_rejected(field_case, tmp_path):
    raw, _, _, manifest = field_case
    (raw / "escape.jpg").symlink_to(tmp_path / "outside.jpg")
    with pytest.raises(ValueError, match="escapes"):
        field_path(raw, "escape.jpg")
    with pytest.raises(ValueError, match="SHA"):
        inspect_field_image(raw, "a.jpg", "0" * 64)
    with pytest.raises(ValueError, match="Dimension"):
        inspect_field_image(raw, "a.jpg", dimensions=(1, 1))


def test_field_resume_and_no_gallery_generation(field_case, tmp_path, monkeypatch):
    raw, assets, gallery, manifest = field_case
    gallery_dir, queries = tmp_path / "gallery", tmp_path / "queries"
    embed_manifest(
        gallery, FakeEncoder(), assets, gallery_dir, tmp_path / "gc", show_progress=False
    )
    before = {p.name: p.read_bytes() for p in gallery_dir.iterdir()}
    with pytest.raises(KeyboardInterrupt):
        embed_manifest(
            manifest, FakeEncoder(fail_after=1), raw, queries, tmp_path / "qc", show_progress=False
        )
    _, benchmark = embed_manifest(
        manifest, FakeEncoder(), raw, queries, tmp_path / "qc", show_progress=False
    )
    assert benchmark["generated"] == benchmark["reused"] == 1

    def forbidden(*args, **kwargs):
        raise AssertionError("Retrieval must not use the database or encoder")

    import psycopg

    import vinedetect_retrieval.encoder as encoder

    monkeypatch.setattr(psycopg, "connect", forbidden)
    monkeypatch.setattr(encoder, "SiglipEncoder", forbidden)
    report, _ = retrieve_field(gallery_dir, queries, gallery, manifest)
    assert report["query_count"] == 2
    assert [r["catalog_item_id"] for r in report["results"][0]["top_10"]] == list(range(1, 11))
    labels = empty_labels(manifest)
    assert (
        evaluate_field(gallery_dir, queries, gallery, manifest, labels)["exact_confirmed_count"]
        == 0
    )
    assert before == {p.name: p.read_bytes() for p in gallery_dir.iterdir()}
    changed = deepcopy(manifest)
    changed["rows"][0]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="snapshot"):
        load_field_pair(gallery_dir, queries, gallery, changed)
    assert load_bundle(queries)[0].shape == (2, 4)


def test_rank_mapping_margins_and_duplicate_assignments(field_case):
    _, _, gallery, manifest = field_case
    targets = list(reversed(gallery["rows"]))
    matrix = np.array([[i / 12, 1] for i in range(12)], dtype=np.float32)
    queries = np.array([[1, 0], [0, 1]], dtype=np.float32)
    results, _ = retrieve_vectors(queries, matrix, manifest["rows"], targets)
    assert results == retrieve_vectors(queries, matrix, manifest["rows"], targets)[0]
    assert results[0]["top_10"][0]["catalog_item_id"] == 1
    assert results[0]["top_10"][0]["official_slug"] == "wine-1"
    assert results[0]["margin"] == pytest.approx(1 / 12)
    assert results[0]["top_5_spread"] == pytest.approx(4 / 12)
    assert [r["catalog_item_id"] for r in results[1]["top_10"]] == list(range(1, 11))
    assert results[1]["margin"] == 0


def test_labels_never_derive_from_prediction_and_preserve_edits(field_case, tmp_path):
    _, _, gallery, manifest = field_case
    path = tmp_path / "labels.json"
    labels = ensure_labels(path, manifest, gallery)
    assert all(
        r["status"] == "unreviewed" and r["catalog_item_id"] is None and r["tags"] == []
        for r in labels["rows"]
    )
    row = labels["rows"][0]
    row.update(
        status="exact_confirmed", catalog_item_id=12, official_slug="wine-12", note="Human choice"
    )
    write_json(path, labels)
    assert ensure_labels(path, manifest, gallery) == labels
    row["official_slug"] = "wine-1"
    with pytest.raises(ValueError, match="same gallery row"):
        validate_labels(labels, manifest, gallery)
    row["catalog_item_id"] = 999
    with pytest.raises(ValueError, match="same gallery row"):
        validate_labels(labels, manifest, gallery)


@pytest.mark.parametrize(
    "mutation",
    [
        {"status": "auto_confirmed"},
        {"status": "unusable", "catalog_item_id": 1},
        {"tags": ["machine_inferred"]},
        {"candidate_catalog_ids": [999]},
        {"note": 32},
        {"status": "exact_confirmed", "catalog_item_id": True, "official_slug": "wine-1"},
    ],
)
def test_label_schema_rejects_invalid(field_case, mutation):
    _, _, gallery, manifest = field_case
    labels = empty_labels(manifest)
    labels["rows"][0].update(mutation)
    with pytest.raises(ValueError):
        validate_labels(labels, manifest, gallery)


def test_exact_only_metrics_and_rank_outside_top10(field_case):
    _, _, gallery, manifest = field_case
    # Exercise every excluded status, plus an exact identity ranked twelfth.
    manifest = deepcopy(manifest)
    manifest["rows"] = [
        {
            **manifest["rows"][0],
            "field_image_id": f"field-{i}",
            "relative_source_path": f"field-{i}.jpg",
        }
        for i in range(7)
    ]
    manifest["row_count"] = 7
    labels = empty_labels(manifest)
    for row, status in zip(labels["rows"], STATUSES, strict=True):
        row["status"] = status
        if status == "exact_confirmed":
            row.update(catalog_item_id=12, official_slug="wine-12", tags=["glare"])
    # Identical vectors across all 12 assignments: tie-break uses ID, no deduplication.
    queries = np.ones((7, 4), dtype=np.float32) / 2
    matrix = np.ones((12, 4), dtype=np.float32) / 2
    result = evaluate_field_vectors(queries, matrix, manifest, gallery, labels)
    assert result["exact_confirmed_count"] == result["strict"]["count"] == 1
    assert result["strict"]["mean_rank"] == 12
    assert result["strict"]["top_10_accuracy"] == 0
    assert result["strict"]["mrr"] == pytest.approx(1 / 12)
    assert result["diagnostic_visual_equivalence"]["top_1_accuracy"] == 1
    assert result["failures"][0]["expected_rank"] == 12
    assert result["failures"][0]["expected_score"] == 1
    assert result["failures"][0]["reviewer_tags"] == ["glare"]
    assert result["status_counts"] == dict.fromkeys(STATUSES, 1)
    unlabeled = evaluate_field_vectors(queries, matrix, manifest, gallery, empty_labels(manifest))
    assert unlabeled["strict"]["top_1_accuracy"] is None
    assert unlabeled["failures"] == []


def test_review_static_safe_deterministic_and_initially_unlabeled(field_case, tmp_path):
    raw, assets, gallery, manifest = field_case
    matrix = np.ones((12, 4), dtype=np.float32) / 2
    rows, _ = retrieve_vectors(matrix[:2], matrix, manifest["rows"], gallery["rows"])
    retrieval = {
        "manifest_sha256": digest(manifest),
        "gallery_sha256": digest(gallery["rows"]),
        "results": rows,
    }
    output = tmp_path / "review"
    labels = empty_labels(manifest)
    before = deepcopy(labels)
    result = build_review(manifest, gallery, retrieval, labels, raw, assets, output)
    assert result["review_count"] == 2 and result["unique_gallery_previews"] == 1
    page = (output / "index.html").read_bytes()
    assert b"Top1\xe2\x88\x92Top5" in page
    assert b"Wine <script>" not in page
    assert b"fetch(" not in page
    payload = (
        page.decode().split('<script id="data" type="application/json">')[1].split("</script>")[0]
    )
    data = json.loads(payload)
    assert data["labels"] == labels == before
    for row in data["records"]:
        assert (output / row["preview"]).exists()
        assert len(row["top_10"]) == 10
        assert all((output / c["preview"]).exists() for c in row["top_10"])
    build_review(manifest, gallery, retrieval, labels, raw, assets, output)
    assert (output / "index.html").read_bytes() == page


def test_outputs_cannot_mutate_inputs_or_baseline(tmp_path):
    base = tmp_path / "backups/lct/field_phase4a2"
    for bad in (
        base / "raw/a.json",
        tmp_path / "backups/lct/siglip_phase4a/output",
        base,
        tmp_path,
    ):
        with pytest.raises(ValueError):
            guard_field_outputs(tmp_path, [bad])
    guard_field_outputs(tmp_path, [base / "review"])
    with pytest.raises(ValueError):
        guard_field_outputs(tmp_path, [base / "embeddings"], [base / "embeddings/frozen"])


def test_proxy_only_failures_and_actual_identical_sha(field_case):
    _, _, gallery, _ = field_case
    gallery = deepcopy(gallery)
    gallery["rows"][2]["reference_sha256"] = "different"
    results = [
        {
            "strict_rank": rank,
            "query_row_id": str(i),
            "expected_catalog_item_id": 1,
            "expected_official_slug": "wine-1",
            "top_10": [{"catalog_item_id": predicted, "official_slug": f"wine-{predicted}"}],
        }
        for i, (rank, predicted) in enumerate([(1, 1), (2, 2), (3, 3)])
    ]
    report = proxy_errors(
        {"dataset_type": "proxy_same_source", "results": results},
        gallery,
        {"gallery_sha256": digest(gallery["rows"])},
    )
    assert report["failure_count"] == 2
    assert report["classification_counts"] == {
        "identical-reference ambiguity": 1,
        "non-ambiguity failure": 1,
    }
