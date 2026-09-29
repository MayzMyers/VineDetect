"""Reference preflight validation; every filesystem fixture is temporary."""

from __future__ import annotations

import copy
import json
from functools import partial

import pytest

from app import contest_reference_plan as preflight
from app.contest_media import json_bytes, resolve_catalog, scan_media
from app.contest_media_review import build_review
from tests.test_contest_media import catalog, make_image


def refresh(case):
    case["manifest"] = scan_media(case["root"])
    case["resolution"] = resolve_catalog(case["manifest"], case["catalog"])
    case["review"] = build_review(
        case["manifest"], case["catalog"], case["resolution"], case["resolution"]
    )
    return case


@pytest.fixture
def case(tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    make_image(root, "det_a49f44e398.png")
    make_image(root, "a/Amb_a49f44e398.png")
    make_image(root, "b/Amb_b49f44e398.png", "blue")
    make_image(root, "history/Rare_a49f44e398.png", "blue")
    source = catalog("det.png", "Amb.png", "missing.png")
    for index, row in enumerate(source["items"], 1):
        row.update(catalog_item_id=index, title="Wine", winery="Winery")
    source["items"][2].update(
        linked_wine_id=42,
        linked_wine_slug="old",
        historical_images=[
            {
                "image_id": 1,
                "wine_id": 42,
                "url": "https://host/uploads/Rare_a49f44e398.png",
            }
        ],
    )
    return refresh(
        {
            "root": root,
            "catalog": source,
            "manual": {
                "schema_version": "assistant-media-review/1",
                "ambiguous_recommendations": [
                    {
                        "official_slug": "wine-1",
                        "recommended_relative_path": "Amb_a49f44e398.png",
                        "review_class": "confirmed_visual",
                        "note": "Reviewed bottle",
                        "confidence": "high",
                    }
                ],
                "missing_recommendations": [
                    {
                        "official_slug": "wine-2",
                        "recommended_relative_path": "Rare_a49f44e398.png",
                        "review_class": "manual_historical_fallback",
                        "note": "Keep manual historical provenance",
                    }
                ],
            },
        }
    )


def run(case, expected_items=3):
    return preflight.build_plan(
        case["manifest"],
        case["catalog"],
        case["resolution"],
        case["review"],
        case["manual"],
        case["root"],
        expected_items=expected_items,
    )


def test_merge_preserves_deterministic_and_manual_provenance(case):
    plan = run(case)
    rows = plan["assignments"]
    assert [r["relative_path"] for r in rows] == [
        "det_a49f44e398.png",
        "a/Amb_a49f44e398.png",
        "history/Rare_a49f44e398.png",
    ]
    assert [r["resolution_method"] for r in rows] == [
        "normalized_unique",
        "confirmed_visual",
        "manual_historical_fallback",
    ]
    assert rows[0]["review_note"] is None
    assert rows[1]["review_note"] == "Reviewed bottle"
    assert rows[2]["review_note"] == "Keep manual historical provenance"
    assert plan["summary"]["selected_reference_assignments"] == 3
    assert plan["summary"]["unresolved"] == 0
    assert plan["summary"]["validation_failures"] == []


def test_candidate_scoped_basename_does_not_guess_globally(case):
    # This file really exists, but belongs to a different item, not this scope.
    case["manual"]["ambiguous_recommendations"][0]["recommended_relative_path"] = (
        "det_a49f44e398.png"
    )
    with pytest.raises(ValueError, match="global basename fallback is prohibited"):
        run(case)


def test_complete_relative_path_must_also_belong_to_candidate_scope(case):
    case["manual"]["ambiguous_recommendations"][0]["recommended_relative_path"] = (
        "history/Rare_a49f44e398.png"
    )
    with pytest.raises(ValueError, match="0 matches"):
        run(case)


def test_basename_collision_fails_even_if_one_candidate_is_at_root():
    candidates = [
        {"relative_path": "same.png"},
        {"relative_path": "nested/same.png"},
    ]
    with pytest.raises(ValueError, match="2 matches"):
        preflight.selected_path("same.png", candidates)
    assert preflight.selected_path("nested/same.png", candidates) == "nested/same.png"


def test_duplicate_physical_file_is_allowed_across_items(case):
    duplicate = copy.deepcopy(case["catalog"]["items"][0])
    duplicate.update(catalog_item_id=4, official_slug="wine-3")
    case["catalog"]["items"].append(duplicate)
    refresh(case)
    plan = run(case, expected_items=4)
    assert plan["summary"]["selected_reference_assignments"] == 4
    assert plan["summary"]["unique_physical_files"] == 3
    assert plan["summary"]["shared_file_groups"] == 1
    assert plan["shared_file_groups"][0]["official_slugs"] == ["wine-0", "wine-3"]


def test_distinct_paths_with_identical_sha_are_reported(case):
    plan = run(case)
    assert plan["summary"]["unique_physical_files"] == 3
    assert plan["summary"]["unique_sha256_content"] == 2
    assert plan["summary"]["duplicate_selected_file_sha_groups"] == 1
    assert plan["duplicate_selected_file_sha_groups"][0]["relative_paths"] == [
        "a/Amb_a49f44e398.png",
        "det_a49f44e398.png",
    ]


def test_changed_file_sha_fails(case):
    make_image(case["root"], "det_a49f44e398.png", "blue")
    with pytest.raises(ValueError, match="sha256 mismatch"):
        run(case)


def test_missing_file_fails(case):
    (case["root"] / "a/Amb_a49f44e398.png").unlink()
    with pytest.raises(ValueError, match="does not exist"):
        run(case)


def test_manifest_dimension_mismatch_fails(case):
    asset = copy.deepcopy(case["manifest"]["files"][0])
    asset["width"] += 1
    with pytest.raises(ValueError, match="width mismatch"):
        preflight.validate_asset(case["root"], asset)


def test_non_raster_selection_fails(case):
    asset = copy.deepcopy(case["manifest"]["files"][0])
    asset.update(is_raster=False, decode_status="non_raster")
    with pytest.raises(ValueError, match="Non-raster"):
        preflight.validate_asset(case["root"], asset)


def test_changed_corrupt_raster_fails_header_check(case):
    (case["root"] / "det_a49f44e398.png").write_bytes(b"invalid png")
    with pytest.raises(ValueError, match="not header-readable"):
        run(case)


def test_duplicate_catalog_item_assignment_fails(case):
    case["catalog"]["items"][1]["catalog_item_id"] = 1
    with pytest.raises(ValueError, match="duplicate catalog_item_id"):
        run(case)


def test_missing_catalog_assignment_fails(case):
    case["resolution"]["items"].pop()
    with pytest.raises(ValueError, match="missing or extra catalog items"):
        run(case)


def test_expected_full_coverage_is_enforced(case):
    with pytest.raises(ValueError, match="requires 2103"):
        run(case, expected_items=2103)


def test_missing_manual_decision_fails(case):
    case["manual"]["missing_recommendations"] = []
    with pytest.raises(ValueError, match="cover exactly the unresolved"):
        run(case)


def test_manual_override_of_resolved_item_is_rejected(case):
    decision = copy.deepcopy(case["manual"]["ambiguous_recommendations"][0])
    decision["official_slug"] = "wine-0"
    case["manual"]["ambiguous_recommendations"].append(decision)
    with pytest.raises(ValueError, match="overrides are forbidden"):
        run(case)


def test_duplicate_manual_assignment_is_rejected(case):
    case["manual"]["ambiguous_recommendations"] *= 2
    with pytest.raises(ValueError, match="duplicate official_slug"):
        run(case)


def test_review_candidate_metadata_must_agree_with_manifest(case):
    case["review"]["ambiguous_items"][0]["candidates"][0]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="Review candidate/manifest mismatch"):
        run(case)


def test_historical_fallback_requires_linked_item_evidence(case):
    case["review"]["remaining_missing"][0]["linked_wine_id"] = None
    with pytest.raises(ValueError, match="lacks item-scoped historical evidence"):
        run(case)


@pytest.mark.parametrize(
    "path", ["../escape.png", "/absolute.png", r"a\test.png", "a/./b.png"]
)
def test_unsafe_paths_are_rejected(path):
    with pytest.raises(ValueError, match="Unsafe relative path"):
        preflight.selected_path(path, [{"relative_path": path}])


def test_artifact_provenance_mismatch_fails(case):
    case["resolution"]["manifest_sha256"] = "0" * 64
    with pytest.raises(
        ValueError, match="Artifact provenance manifest_sha256 mismatch"
    ):
        run(case)


def test_source_inconsistency_is_preserved_and_flagged(case):
    source = case["catalog"]
    source["items"] = [
        {
            "official_slug": slug,
            "catalog_item_id": index,
            "photo_name": "Amb.png",
            "title": "Source title",
        }
        for index, slug in enumerate(
            (preflight.RELATED_SLUG, preflight.INCONSISTENT_SLUG), 1
        )
    ]
    case["manual"]["missing_recommendations"] = []
    case["manual"]["ambiguous_recommendations"] = [
        {
            "official_slug": row["official_slug"],
            "recommended_relative_path": "Amb_a49f44e398.png",
            "review_class": method,
            "note": "Preserve organizer source",
        }
        for row, method in zip(
            source["items"],
            ("manual_equivalent", "source_preserving_shared"),
            strict=True,
        )
    ]
    refresh(case)
    plan = run(case, expected_items=2)
    assert plan["summary"]["source_data_inconsistencies"] == 1
    flagged = next(
        r
        for r in plan["assignments"]
        if r["official_slug"] == preflight.INCONSISTENT_SLUG
    )
    assert flagged["flags"] == ["organizer_photo_title_inconsistency"]
    case["manual"]["ambiguous_recommendations"][1]["recommended_relative_path"] = (
        "Amb_b49f44e398.png"
    )
    with pytest.raises(ValueError, match="inconsistency was not preserved"):
        run(case, expected_items=2)


def test_deterministic_cli_artifacts_no_db_or_source_writes(
    case, tmp_path, monkeypatch
):
    import psycopg

    def forbid_db(*args, **kwargs):
        pytest.fail("Preflight must not connect to PostgreSQL")

    monkeypatch.setattr(psycopg, "connect", forbid_db)
    # The production CLI keeps its fixed 2103 invariant; use a 3-row test fixture.
    monkeypatch.setattr(
        preflight, "build_plan", partial(preflight.build_plan, expected_items=3)
    )
    argv = ["--media-root", str(case["root"])]
    for field, flag in (
        ("manifest", "manifest-json"),
        ("catalog", "catalog-json"),
        ("resolution", "resolution-json"),
        ("review", "review-json"),
        ("manual", "manual-json"),
    ):
        path = tmp_path / f"{field}.json"
        path.write_bytes(json_bytes(case[field]))
        argv += [f"--{flag}", str(path)]
    before = {p: p.read_bytes() for p in case["root"].rglob("*") if p.is_file()}
    outputs = []
    for name in ("first", "replay"):
        output = tmp_path / name
        preflight.main([*argv, "--output-dir", str(output)])
        outputs.append({p.name: p.read_bytes() for p in output.iterdir()})
    assert outputs[0] == outputs[1]
    assert before == {p: p.read_bytes() for p in case["root"].rglob("*") if p.is_file()}
    artifact = json.loads(outputs[0]["reference-plan.json"])
    assert len(artifact["assignments"]) == 3
    with pytest.raises(SystemExit):
        preflight.main([*argv, "--output-dir", str(case["root"] / "bad")])
    with pytest.raises(SystemExit):
        preflight.main([*argv, "--output-dir", str(tmp_path / "first")])
