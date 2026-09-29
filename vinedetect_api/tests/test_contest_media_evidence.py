from __future__ import annotations

import copy
import json

import pytest

from app.contest_media import (
    historical_basename,
    json_bytes,
    main,
    resolve_catalog,
    scan_media,
)
from tests.test_contest_media import catalog, make_image


def with_history(*basenames, linked=True):
    source = catalog("Wine.png")
    item = source["items"][0]
    item.update(
        title="Official title",
        winery="Official winery",
        linked_wine_id=42 if linked else None,
        historical_images=[
            {"image_id": index, "wine_id": 42, "url": f"https://host/uploads/{name}"}
            for index, name in enumerate(basenames)
        ],
    )
    return source


def two_candidates(root):
    make_image(root, "Wine_a49f44e398.png", "red")
    make_image(root, "Wine_b49f44e398.png", "blue")
    return scan_media(root)


@pytest.mark.parametrize(
    "value,expected",
    [
        (
            "https://host/resize/uploads/Wine%20A_a49f44e398.png?size=200#x",
            "Wine A_a49f44e398.png",
        ),
        (r"C:\cache\Wine_a49f44e398.png", "Wine_a49f44e398.png"),
        ("storage/wine.png", "wine.png"),
        (None, ""),
    ],
)
def test_historical_basename(value, expected):
    assert historical_basename(value) == expected


def test_sha_equality_precedes_conflicting_historical_names(tmp_path):
    make_image(tmp_path, "Wine_a49f44e398.png")
    make_image(tmp_path, "Wine_b49f44e398.png")
    source = with_history("Wine_b49f44e398.png")
    row = resolve_catalog(scan_media(tmp_path), source)["items"][0]
    assert row["match_class"] == "sha_equivalent"
    assert row["selected_relative_path"] == "Wine_a49f44e398.png"
    assert row["resolution_evidence"]["strength_rank"] == 3


def test_exact_historical_url_resolves_only_existing_candidate(tmp_path):
    manifest = two_candidates(tmp_path)
    source = with_history("Wine_b49f44e398.png")
    row = resolve_catalog(manifest, source)["items"][0]
    assert row["match_class"] == "historical_asset_exact"
    assert row["selected_relative_path"] == "Wine_b49f44e398.png"
    assert len(row["candidate_paths"]) == 2
    assert row["resolution_evidence"]["matched_candidates"][0][
        "historical_sources"
    ] == [{"image_id": 0, "source_field": "url", "basename": "Wine_b49f44e398.png"}]


def test_historical_local_path_is_supported(tmp_path):
    source = with_history()
    source["items"][0]["historical_images"] = [
        {"image_id": 2, "wine_id": 42, "local_path": "uploads/Wine_b49f44e398.png"}
    ]
    row = resolve_catalog(two_candidates(tmp_path), source)["items"][0]
    assert row["match_class"] == "historical_asset_exact"
    assert (
        row["resolution_evidence"]["matched_candidates"][0]["historical_sources"][0][
            "source_field"
        ]
        == "local_path"
    )


def test_historical_normalized_identity_retains_hash_and_is_lower_rank(tmp_path):
    manifest = two_candidates(tmp_path)
    exact = resolve_catalog(manifest, with_history("Wine_b49f44e398.png"))["items"][0]
    normalized = resolve_catalog(manifest, with_history("WINE-B49F44E398.PNG"))[
        "items"
    ][0]
    assert normalized["match_class"] == "historical_asset_normalized"
    assert normalized["selected_relative_path"] == "Wine_b49f44e398.png"
    assert (
        normalized["resolution_evidence"]["strength_rank"]
        < exact["resolution_evidence"]["strength_rank"]
    )


def test_conflicting_historical_evidence_stays_ambiguous(tmp_path):
    row = resolve_catalog(
        two_candidates(tmp_path),
        with_history("Wine_a49f44e398.png", "Wine_b49f44e398.png"),
    )["items"][0]
    assert row["match_class"] == "ambiguous"
    assert row["selected_relative_path"] is None
    assert row["resolution_evidence"]["conflict"] is True


def test_exact_evidence_precedes_normalized_evidence(tmp_path):
    row = resolve_catalog(
        two_candidates(tmp_path),
        with_history("Wine_a49f44e398.png", "WINE-B49F44E398.PNG"),
    )["items"][0]
    assert row["match_class"] == "historical_asset_exact"
    assert row["selected_relative_path"] == "Wine_a49f44e398.png"


def test_unlinked_history_and_unrelated_history_cannot_resolve(tmp_path):
    manifest = two_candidates(tmp_path)
    for source in (
        with_history("Wine_b49f44e398.png", linked=False),
        with_history("unrelated_b49f44e398.png"),
    ):
        assert (
            resolve_catalog(manifest, source)["items"][0]["match_class"] == "ambiguous"
        )


def test_partial_sha_equality_is_not_enough(tmp_path):
    make_image(tmp_path, "Wine_a49f44e398.png")
    make_image(tmp_path, "Wine_b49f44e398.png")
    make_image(tmp_path, "Wine_c49f44e398.png", "blue")
    assert (
        resolve_catalog(scan_media(tmp_path), catalog("Wine.png"))["items"][0][
            "match_class"
        ]
        == "ambiguous"
    )


def test_history_for_wrong_wine_is_rejected(tmp_path):
    source = with_history("Wine_b49f44e398.png")
    source["items"][0]["historical_images"][0]["wine_id"] = 999
    with pytest.raises(ValueError, match="different linked wine"):
        resolve_catalog(two_candidates(tmp_path), source)


def test_missing_analysis_lists_metadata_and_nearest_prefix_without_selecting(tmp_path):
    make_image(tmp_path, "longprefix.png")
    make_image(tmp_path, "longprefix_reserve_2020_a49f44e398.png")
    source = with_history("longprefix_reserve_2020_a49f44e398.png")
    source["items"][0]["photo_name"] = "longprefix-reserve-2021.png"
    report = resolve_catalog(scan_media(tmp_path), source)
    assert report["items"][0]["match_class"] == "missing"
    assert report["items"][0]["selected_relative_path"] is None
    analysis = report["missing_analysis"][0]
    assert analysis["title"] == "Official title"
    assert analysis["winery"] == "Official winery"
    assert analysis["linked_historical_wine_exists"] is True
    assert analysis["normalized_photo_key"] == ["longprefixreserve2021", ".png"]
    assert analysis["closest_deterministic_candidates"][0]["relative_path"] == (
        "longprefix_reserve_2020_a49f44e398.png"
    )
    assert len(analysis["closest_deterministic_candidates"]) == 1
    assert len(analysis["historical_archive_matches"]) == 1
    assert analysis["automatic_selection"] is False


def test_duplicate_names_and_physical_assets_are_separate(tmp_path):
    make_image(tmp_path, "Wine_a49f44e398.png")
    make_image(tmp_path, "Wine_b49f44e398.png")
    report = resolve_catalog(scan_media(tmp_path), catalog("Wine.png", "Wine.png"))
    assert report["summary"]["match_classes"]["sha_equivalent"] == 2
    assert report["summary"]["selected_physical_assets"] == 1
    assert report["duplicate_photo_name_audit"] == {
        "catalog_items": 2,
        "unique_photo_names": 1,
        "duplicate_name_groups": 1,
        "items_in_duplicate_name_groups": 2,
        "extra_items_beyond_unique_names": 1,
        "group_outcomes": {"same_asset": 1},
    }


def test_evidence_order_and_input_objects_are_stable(tmp_path):
    manifest = two_candidates(tmp_path)
    source = with_history("unrelated.png", "Wine_b49f44e398.png")
    untouched = copy.deepcopy(source)
    first = resolve_catalog(manifest, source)
    assert source == untouched
    source["items"][0]["historical_images"].reverse()
    manifest["files"].reverse()
    assert json_bytes(first) == json_bytes(resolve_catalog(manifest, source))


def test_evidence_cli_replay_includes_full_review(tmp_path, capsys):
    root = tmp_path / "media"
    root.mkdir()
    two_candidates(root)
    source = tmp_path / "source.json"
    source.write_bytes(json_bytes(with_history("Wine_b49f44e398.png")))
    out = tmp_path / "report"
    main(
        [
            "--media-root",
            str(root),
            "--catalog-json",
            str(source),
            "--output-dir",
            str(out),
        ]
    )
    replay = tmp_path / "replay"
    main(
        [
            "--manifest-json",
            str(out / "media-manifest.json"),
            "--catalog-json",
            str(out / "catalog-items.json"),
            "--output-dir",
            str(replay),
        ]
    )
    capsys.readouterr()
    for file in out.iterdir():
        assert file.read_bytes() == (replay / file.name).read_bytes()
    report = json.loads((out / "media-resolution.json").read_bytes())
    assert report["before_after"]["after"]["historical_asset_exact"] == 1
    review = (out / "media-review.md").read_text()
    assert "All unresolved ambiguous items" in review
    assert "All missing items" in review
    assert "\n## Before / after\n" in review
