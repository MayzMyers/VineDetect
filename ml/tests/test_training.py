from copy import deepcopy
from itertools import combinations

import numpy as np
import pytest

from vinedetect_retrieval.artifacts import digest, json_bytes
from vinedetect_retrieval.retrieval import evaluate_vectors
from vinedetect_retrieval.training import (
    DIAGNOSTIC_TYPE,
    TrainingPolicy,
    build_training_dataset,
    load_policy,
    mine_hard_negatives,
)


@pytest.fixture
def gallery():
    return {
        "dataset_type": "official_gallery",
        "contest_version": "lct-rshb-2026-09-15",
        "row_count": 2103,
        "rows": [
            {
                "catalog_item_id": key,
                "official_slug": f"official-{key}",
                "reference_sha256": f"{key:064x}",
                "wine_id": key,
                "link_method": "exact_slug",
            }
            for key in range(1, 2104)
        ],
    }


def proxy(gallery, **flags):
    row = {
        "catalog_item_id": 2,
        "historical_image_id": 12,
        "historical_wine_id": 2,
        "official_reference_sha256": gallery["rows"][1]["reference_sha256"],
        **flags,
    }
    return {
        "dataset_type": "proxy_same_source",
        "gallery_sha256": digest(gallery["rows"]),
        "row_count": 1,
        "rows": [row],
    }


def test_current_identical_sha_groups_are_derived_and_never_sampled(gallery):
    for key in (30, 31, 32):
        gallery["rows"][key - 1]["reference_sha256"] = "a" * 64
    rules = TrainingPolicy(gallery)
    for a, b in combinations((30, 31, 32), 2):
        assert not rules.can_be_negative(a, b)
        assert not rules.can_be_negative(b, a, hard=True)
    sampled = rules.sample_negatives(30, 2100, seed=12)
    assert not {30, 31, 32} & set(sampled)
    assert sampled == rules.sample_negatives(30, 2100, seed=12)
    with pytest.raises(ValueError, match="Not enough"):
        rules.sample_negatives(30, 2101, seed=12)
    gallery["rows"][30]["reference_sha256"] = "b" * 64
    assert TrainingPolicy(gallery).can_be_negative(30, 31)
    assert rules.report()["identical_sha_group_count"] == 1


@pytest.mark.parametrize(
    "kind",
    [
        "visual_equivalent_or_vintage",
        "same_product_alias_or_version",
        "same_product_packaging_variant",
    ],
)
def test_every_reviewed_vintage_alias_and_packaging_pair_is_forbidden(gallery, kind):
    rules = TrainingPolicy(gallery)
    for group in load_policy()["relationships"]:
        if group["type"] == kind:
            for a, b in combinations(group["catalog_item_ids"], 2):
                assert not rules.can_be_negative(a, b)
                assert not rules.can_be_negative(a, b, hard=True)
                assert a not in rules.negative_candidates(b)
                assert b not in rules.sample_negatives(a, len(rules.negative_candidates(a)), seed=7)


def test_diagnostic_group_hard_only_unless_current_sha_is_identical(gallery):
    rules = TrainingPolicy(gallery)
    assert rules.can_be_negative(1842, 1843)
    assert not rules.can_be_negative(1842, 1843, hard=True)
    assert rules.report()["diagnostic_groups"][0]["type"] == DIAGNOSTIC_TYPE
    gallery["rows"][1842]["reference_sha256"] = gallery["rows"][1841]["reference_sha256"]
    assert not TrainingPolicy(gallery).can_be_negative(1842, 1843)
    # Explicit overlapping relationships do not invent additional relationships.
    assert rules.can_be_negative(1841, 1848, hard=True)


def test_packaging_groups_never_become_automatic_visual_positives(gallery):
    data = build_training_dataset(gallery, proxy(gallery))
    assert not data["policy"]["automatic_cross_identity_visual_positives"]
    assert data["historical_positive_rows"] == proxy(gallery)["rows"]
    assert data["official_reference_rows"] == gallery["rows"]


@pytest.mark.parametrize(
    "flags",
    [
        {"historical_image_mismatch": True},
        {"historical_image_status": "mismatch"},
        {"review_status": "mismatch"},
    ],
)
def test_explicit_historical_mismatches_cannot_become_positives(gallery, flags):
    data = build_training_dataset(gallery, proxy(gallery, **flags))
    assert data["historical_positive_count"] == 0
    assert data["excluded_historical_positive_count"] == 1
    assert (
        data["excluded_historical_positive_rows"][0]["training_exclusion_reason"]
        == "explicit_historical_image_mismatch"
    )


def test_canonical_historical_exclusions_and_wrong_owner_rejected(gallery):
    policy = load_policy()
    policy["historical_image_exclusions"] = [
        {
            "catalog_item_id": 2,
            "historical_image_id": 12,
            "reason": "mismatch",
            "provenance": "human_reviewed_dq2",
        }
    ]
    assert build_training_dataset(gallery, proxy(gallery), policy)["historical_positive_count"] == 0
    wrong = proxy(gallery, historical_wine_id=791)
    data = build_training_dataset(gallery, wrong)
    assert data["historical_positive_count"] == 0
    assert (
        data["excluded_historical_positive_rows"][0]["training_exclusion_reason"]
        == "historical_wine_identity_mismatch"
    )


def test_unrelated_visually_identical_vectors_still_become_hard_negatives(gallery):
    matrix = np.tile(np.array([[1, 0]], dtype=np.float32), (2103, 1))
    rows = [
        {
            "catalog_item_id": r["catalog_item_id"],
            "official_slug": r["official_slug"],
            "sha256": r["reference_sha256"],
            "row_id": str(r["catalog_item_id"]),
        }
        for r in gallery["rows"]
    ]
    result = mine_hard_negatives(matrix, rows, gallery, top_k=2)
    assert result["row_count"] == 2103
    assert result["rows"][0]["hard_negatives"][0]["catalog_item_id"] == 2
    assert result["rows"][675]["hard_negatives"][0]["catalog_item_id"] == 1
    assert 2 not in [r["catalog_item_id"] for r in result["rows"][675]["hard_negatives"]]
    rules = TrainingPolicy(gallery)
    for row in result["rows"]:
        assert all(
            rules.can_be_negative(row["catalog_item_id"], n["catalog_item_id"], hard=True)
            for n in row["hard_negatives"]
        )
    # Retrieval remains unmasked: even the final identity retains its individual rank/slug.
    evaluated = evaluate_vectors(matrix[-1:], matrix, [rows[-1]], rows)
    assert evaluated["results"][0]["strict_rank"] == 2103
    assert evaluated["results"][0]["expected_official_slug"] == "official-2103"
    assert [r["catalog_item_id"] for r in evaluated["results"][0]["top_10"]] == list(range(1, 11))
    assert len(rules.report()["inference_official_slugs"]) == 2103


def test_report_deterministic_gallery_unchanged_and_stale_snapshots_rejected(gallery):
    before = deepcopy(gallery)
    assert json_bytes(TrainingPolicy(gallery).report()) == json_bytes(
        TrainingPolicy(gallery).report()
    )
    build_training_dataset(gallery, proxy(gallery))
    assert gallery == before
    stale = proxy(gallery)
    stale["gallery_sha256"] = "0" * 64
    with pytest.raises(ValueError, match="snapshot"):
        build_training_dataset(gallery, stale)
    policy = load_policy()
    policy["relationships"][0]["catalog_item_ids"] = [2, 9999]
    with pytest.raises(ValueError, match="relationship"):
        TrainingPolicy(gallery, policy)
    gallery["rows"].pop()
    gallery["row_count"] -= 1
    with pytest.raises(ValueError, match="complete"):
        TrainingPolicy(gallery)
