from __future__ import annotations

import copy

import numpy as np
import pytest

from vinedetect_retrieval.reference_audit import (
    applied_override_catalog_ids,
    build_audit_rows,
    changed_sha_catalog_ids,
    guard_audit_output,
    historical_diagnostics,
    prompt_diagnostics,
    v2_reuse_plan,
    validate_override_manifest,
    write_csv_file,
)


def unit_rows():
    return [
        {
            "catalog_item_id": 1681,
            "official_slug": "rozovoe-polusladkoe-2",
            "title": "Розовое полусладкое",
            "winery": "Абрау-Дюрсо",
            "wine_id": 3899,
            "reference_asset_id": 11,
            "path": "contest/x.webp",
            "sha256": "a" * 64,
            "width": 1184,
            "height": 864,
            "resolution_method": "normalized_unique",
            "reference_provenance": {"source_relative_path": "Generated_Image_x.webp"},
            "review_note": None,
            "description": "",
        },
        {
            "catalog_item_id": 2,
            "official_slug": "bottle",
            "title": "Bottle",
            "winery": "Winery",
            "wine_id": 2,
            "reference_asset_id": 12,
            "path": "contest/y.webp",
            "sha256": "b" * 64,
            "width": 300,
            "height": 900,
            "resolution_method": "normalized_unique",
            "reference_provenance": {},
            "review_note": None,
            "description": "",
        },
    ]


def test_text_image_diagnostic_scoring():
    images = np.array([[1, 0], [0, 1]], dtype=np.float32)
    positive = np.array([[1, 0], [1, 0]], dtype=np.float32)
    negative = np.array([[0, 1], [0, 1]], dtype=np.float32)
    result = prompt_diagnostics(images, positive, negative)
    np.testing.assert_allclose(result["contrast"], [1, -1])
    assert result["product"].shape == result["non_product"].shape == (2, 2)
    with pytest.raises(ValueError, match="dimensions"):
        prompt_diagnostics(images, np.ones((1, 3)), negative)


def test_historical_consistency_and_expected_rank():
    gallery = np.eye(2, dtype=np.float32)
    queries = np.array([[0.8, 0.6]], dtype=np.float32)
    query_rows = [
        {
            "row_id": "2:9",
            "catalog_item_id": 2,
            "historical_image_id": 9,
            "path": "svoe_vino/9.webp",
            "sha256": "c" * 64,
        }
    ]
    evaluation = {
        "results": [
            {
                "query_row_id": "2:9",
                "strict_rank": 7,
                "diagnostic_visual_equivalence_rank": 6,
            }
        ]
    }
    result = historical_diagnostics(gallery, unit_rows(), queries, query_rows, evaluation)
    assert result[2]["self_similarity_min"] == pytest.approx(0.6)
    assert result[2]["expected_rank_worst"] == 7


def test_deterministic_suspicious_sorting_and_known_bad_pin():
    rows = unit_rows()
    scores = {
        "product": np.array([[0.1] * 3, [0.9] * 3]),
        "non_product": np.array([[0.9] * 10, [0.1] * 10]),
        "product_mean": np.array([0.1, 0.9]),
        "product_max": np.array([0.1, 0.9]),
        "non_product_mean": np.array([0.9, 0.1]),
        "non_product_max": np.array([0.9, 0.1]),
        "contrast": np.array([-0.8, 0.8]),
    }
    first = build_audit_rows(copy.deepcopy(rows), scores, {})
    second = build_audit_rows(
        list(reversed(copy.deepcopy(rows))),
        {
            key: value[::-1] if isinstance(value, np.ndarray) else value
            for key, value in scores.items()
        },
        {},
    )
    assert first == second
    assert first[0]["catalog_item_id"] == 1681
    assert first[0]["priority_level"] == "high"
    assert "likely_bad_reference" in first[0]["diagnostic_categories"]


def test_deterministic_audit_csv_output(tmp_path):
    scores = {
        "product": np.array([[0.1] * 3, [0.9] * 3]),
        "non_product": np.array([[0.9] * 10, [0.1] * 10]),
        "product_mean": np.array([0.1, 0.9]),
        "product_max": np.array([0.1, 0.9]),
        "non_product_mean": np.array([0.9, 0.1]),
        "non_product_max": np.array([0.9, 0.1]),
        "contrast": np.array([-0.8, 0.8]),
    }
    rows = build_audit_rows(unit_rows(), scores, {})
    first = tmp_path / "first.csv"
    second = tmp_path / "second.csv"
    write_csv_file(first, rows)
    write_csv_file(second, copy.deepcopy(rows))
    assert first.read_bytes() == second.read_bytes()


def test_applied_override_status_requires_matching_complete_report():
    entry = {
        "catalog_item_id": 1,
        "official_slug": "wine",
        "status": "replacement_confirmed",
        "expected_current": {
            "reference_asset_id": 1,
            "path": "contest/old.webp",
            "sha256": "a" * 64,
            "width": 10,
            "height": 20,
            "provenance": {},
        },
        "replacement": {
            "source_authority": "human",
            "source_path": "new.webp",
            "sha256": "b" * 64,
            "width": 10,
            "height": 20,
            "byte_size": 30,
            "mime_type": "image/webp",
        },
    }
    manifest = {
        "schema_version": "contest-reference-overrides/1",
        "contest_version": "lct-test",
        "entries": [entry],
    }
    from vinedetect_retrieval.artifacts import digest

    report = {
        "dry_run": False,
        "manifest_sha256": digest(manifest),
        "updated": 1,
        "already_applied": 0,
        "diffs": [{"catalog_item_id": 1, "state": "updated"}],
    }
    assert applied_override_catalog_ids(manifest, report) == [1]
    assert applied_override_catalog_ids(manifest, {**report, "dry_run": True}) == []
    with pytest.raises(ValueError, match="does not match"):
        applied_override_catalog_ids(
            manifest, {**report, "manifest_sha256": "0" * 64}
        )


def test_override_schema_and_confirmation_gate():
    entry = {
        "catalog_item_id": 1,
        "official_slug": "wine",
        "status": "pending_review",
        "expected_current": {
            "reference_asset_id": 1,
            "path": "contest/old.webp",
            "sha256": "a" * 64,
            "width": 10,
            "height": 20,
            "provenance": {},
        },
        "replacement": None,
    }
    manifest = {
        "schema_version": "contest-reference-overrides/1",
        "contest_version": "lct-rshb-2026-09-15",
        "entries": [entry],
    }
    assert validate_override_manifest(manifest) == [entry]
    entry["replacement"] = {
        "source_authority": "official",
        "source_path": "new.webp",
        "sha256": "b" * 64,
        "width": 10,
        "height": 20,
        "byte_size": 30,
        "mime_type": "image/webp",
    }
    with pytest.raises(ValueError, match="Unconfirmed"):
        validate_override_manifest(manifest)
    entry["status"] = "replacement_confirmed"
    assert validate_override_manifest(manifest) == [entry]


def test_changed_sha_and_v2_reuse_plan_keep_v1_inputs_immutable():
    old = [
        {"catalog_item_id": 1, "sha256": "a"},
        {"catalog_item_id": 2, "sha256": "b"},
    ]
    new = copy.deepcopy(old)
    new[1]["sha256"] = "c"
    frozen = copy.deepcopy(old)
    assert changed_sha_catalog_ids(old, new) == [2]
    plan = v2_reuse_plan(old, new, np.zeros((2, 4)), model_config_sha256="config")
    assert plan["reused_catalog_item_ids"] == [1]
    assert plan["inference_required_catalog_item_ids"] == [2]
    assert old == frozen
    with pytest.raises(ValueError, match="identity set"):
        changed_sha_catalog_ids(old, new[:1])


def test_audit_output_cannot_overlap_immutable_v1(tmp_path):
    frozen = tmp_path / "gallery-256"
    frozen.mkdir()
    (frozen / "metadata.json").write_text("{}")
    before = (frozen / "metadata.json").read_bytes()
    with pytest.raises(ValueError, match="immutable Phase 4A"):
        guard_audit_output(frozen / "audit", [frozen])
    with pytest.raises(ValueError, match="immutable Phase 4A"):
        guard_audit_output(tmp_path, [frozen])
    assert (frozen / "metadata.json").read_bytes() == before
