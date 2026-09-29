"""Identity planning uses synthetic records and temporary files; no DB access."""

from __future__ import annotations

from copy import deepcopy

import pytest

from app.contest_identity_plan import (
    add_image_hashes,
    build_plan,
    json_bytes,
    main,
    write_artifacts,
)


def official(number=1, **changes):
    return {
        "id": number,
        "import_run_id": 1,
        "official_slug": f"official-{number}",
        "title": "Estate Reserve",
        "winery": "Estate",
        "category": "White",
        "color": "Golden",
        "region": "Kuban",
        "grapes": "Chardonnay",
        "description": "Bright orchard fruit.",
        "photo_name": "bottle.webp",
        **changes,
    }


def historical(number=11, **changes):
    return {
        "id": number,
        "slug": f"old-{number}",
        "external_id": f"stable-{number}",
        "title": "Estate Reserve",
        "manufacturer_name": "Estate",
        "category_name": "White",
        "color": "Golden",
        "region_name": "Kuban",
        "description": "Bright orchard fruit.",
        **changes,
    }


def snapshot(items=None, wines=None, *, media=False):
    items = items or [official()]
    wines = wines or [historical()]
    return {
        "catalog_items": items,
        "wines": wines,
        "item_links": [
            {"catalog_item_id": x["id"], "wine_id": None, "method": "unmatched"}
            for x in items
        ],
        "reference_assets": [
            {
                "id": x["id"] + 100,
                "catalog_item_id": x["id"],
                "sha256": "a" * 64,
                "original_filename": "bottle_0123456789.webp",
                "local_path": "contest/bottle.webp",
                "provenance": {
                    "source_relative_path": "uploads/bottle_0123456789.webp"
                },
                "review_note": None,
            }
            for x in items
        ],
        "wine_images": [
            {
                "id": w["id"],
                "wine_id": w["id"],
                "url": "https://host/uploads/"
                + ("bottle_0123456789.webp" if media else f"different_{w['id']}.webp"),
                "local_path": f"historical/{w['id']}.webp",
            }
            for w in wines
        ],
        "wine_grapes": [{"wine_id": w["id"], "name": "Chardonnay"} for w in wines],
    }


def plan(data):
    return build_plan(
        data,
        expected_unmatched=sum(x["method"] == "unmatched" for x in data["item_links"]),
    )


def test_exact_media_reslug_preserves_all_stable_identity_fields():
    data = snapshot([official(title="Estate Reserve (new presentation)")], media=True)
    rows, summary = plan(data)
    row = rows[0]
    assert summary["re_slug"] == 1
    assert row["proposed_wine_id"] == 11
    assert row["existing_wine_slug"] == "old-11"
    assert row["existing_wine_external_id"] == "stable-11"
    assert any(e["rule"] == "media_exact" and e["strong"] for e in row["evidence"])


def test_metadata_confirmed_reslug_without_media():
    rows, _ = plan(snapshot([official(title=" estate — RESERVE ")]))
    assert rows[0]["classification"] == "re_slug"
    assert any(
        e["rule"] == "exact_title_winery_supported_metadata"
        for e in rows[0]["evidence"]
    )


def test_fuzzy_only_never_automatically_reslugs():
    rows, _ = plan(
        snapshot([official(title="Estate Reserv", description="Other text")])
    )
    assert rows[0]["classification"] == "manual_review"
    assert all(not c["automatic_eligible"] for c in rows[0]["candidates"])


@pytest.mark.parametrize(
    "changes,field",
    [
        ({"grapes": "Merlot"}, "grapes"),
        ({"winery": "Different Winery"}, "winery"),
        ({"category": "Red"}, "category"),
        ({"color": "Ruby"}, "color_family"),
        ({"title": "Estate Reserve 2024"}, "year"),
    ],
)
def test_conflicting_media_metadata_requires_review(changes, field):
    data = snapshot(
        [official(**changes)], [historical(title="Estate Reserve 2023")], media=True
    )
    rows, _ = plan(data)
    assert rows[0]["classification"] == "manual_review"
    assert field in rows[0]["candidates"][0]["contradictions"]


@pytest.mark.parametrize(
    "key,field",
    [("stable-11", "external_id"), ("old-11", "slug"), ("11", "numeric_id")],
)
def test_alias_collision_across_all_source_lookup_paths(key, field):
    rows, summary = plan(snapshot([official(official_slug=key)]))
    assert rows[0]["classification"] == "manual_review"
    assert summary["alias_collision_count"] == 1
    assert summary["alias_collisions"][0]["alias_field"] == field


def test_alias_collision_between_proposed_new_wines():
    data = snapshot(
        [
            official(1, official_slug="new", title="Unrelated A", winery="New A"),
            official(2, official_slug="new", title="Unrelated B", winery="New B"),
        ]
    )
    rows, summary = plan(data)
    assert summary["alias_collision_count"] == 2
    assert all(x["classification"] == "manual_review" for x in rows)


def test_multiple_existing_candidates_requires_review_even_with_one_media_match():
    data = snapshot(wines=[historical(11), historical(12)], media=True)
    data["wine_images"][1]["url"] = "https://host/other.webp"
    rows, _ = plan(data)
    assert rows[0]["classification"] == "manual_review"
    assert rows[0]["plausible_wine_ids"] == [11, 12]


def test_true_new_contains_only_available_organizer_data():
    data = snapshot(
        [
            official(
                title="Completely Different Cuvee",
                winery="Other Producer",
                description="",
                region="",
            )
        ]
    )
    rows, summary = plan(data)
    assert summary["true_new"] == 1
    new = rows[0]["proposed_new_wine_data"]
    assert new["slug"] == new["external_id"] == "official-1"
    assert new["source"] == "vino-svoe"
    assert new["description"] is None and new["region_name"] is None
    assert "id" not in new and "alcohol" not in new and "image_url" not in new
    assert new["raw_detail_json"]["organizer_catalog"]["grapes"] == "Chardonnay"


def test_many_to_one_includes_already_linked_official_items():
    data = snapshot(
        [official(1), official(2, description="Different description")], media=True
    )
    data["item_links"][1].update(method="exact_slug", wine_id=11)
    rows, summary = plan(data)
    assert rows[0]["classification"] == "manual_review"
    assert summary["many_to_one_candidate_count"] == 1
    group = summary["many_to_one_candidates"][0]
    assert group["catalog_item_ids"] == [1, 2]
    assert group["classification"] == "ambiguous_identity"
    assert group["already_linked_catalog_item_ids"] == [2]


def test_identical_organizer_duplicate_is_explicit_not_silent():
    rows, summary = plan(snapshot([official(1), official(2)], media=True))
    assert summary["re_slug"] == 2
    assert (
        summary["many_to_one_candidates"][0]["classification"]
        == "legitimate_duplicate_organizer_metadata"
    )
    assert all(row["many_to_one"] for row in rows)


def test_same_title_with_conflicting_grapes_is_not_declared_new():
    rows, _ = plan(snapshot([official(grapes="Merlot")]))
    assert rows[0]["classification"] == "manual_review"


def test_hash_stripping_only_is_not_strong_media_proof():
    data = snapshot([official(title="Unknown", winery="Other")], media=True)
    data["reference_assets"][0]["original_filename"] = "bottle_aaaaaaaaaa.webp"
    data["reference_assets"][0]["provenance"] = {}
    rows, _ = plan(data)
    assert rows[0]["classification"] == "manual_review"
    assert not any(c["strong_media"] for c in rows[0]["candidates"])


def test_exact_sha_is_evidence_even_when_filenames_differ():
    data = snapshot([official(title="Estate Reserve edition")])
    data["historical_image_hashes"] = {"11": "a" * 64}
    rows, _ = plan(data)
    assert rows[0]["classification"] == "re_slug"
    assert any(e["rule"] == "media_sha256" for e in rows[0]["evidence"])


def test_reference_provenance_inconsistency_forces_review():
    data = snapshot(media=True)
    data["reference_assets"][0]["provenance"]["source_data_inconsistencies"] = [
        {"issue": "wrong photo"}
    ]
    rows, _ = plan(data)
    assert rows[0]["classification"] == "manual_review"


def test_deterministic_replay_and_input_order_independence(tmp_path):
    data = snapshot([official(1), official(2, title="Unknown", winery="Other")])
    original = deepcopy(data)
    rows, summary = plan(data)
    hashes = write_artifacts(rows, summary, tmp_path / "first")
    for value in data.values():
        if isinstance(value, list):
            value.reverse()
    rows2, summary2 = plan(data)
    assert hashes == write_artifacts(rows2, summary2, tmp_path / "second")
    for name in hashes:
        assert (tmp_path / "first" / name).read_bytes() == (
            tmp_path / "second" / name
        ).read_bytes()
    # build_plan does not mutate caller-owned rows.
    assert original["catalog_items"][0]["title"] == "Estate Reserve"


def test_reject_wrong_input_count_missing_reference_duplicate_id():
    data = snapshot()
    with pytest.raises(ValueError, match="Expected 264"):
        build_plan(data)
    data["reference_assets"] = []
    with pytest.raises(ValueError, match="lacks exactly one"):
        plan(data)
    data = snapshot()
    data["catalog_items"].append(deepcopy(data["catalog_items"][0]))
    with pytest.raises(ValueError, match="Duplicate id"):
        plan(data)


def test_hash_read_does_not_modify_image_bytes_and_rejects_escape(tmp_path):
    data = snapshot()
    path = tmp_path / "historical" / "11.webp"
    path.parent.mkdir()
    content = b"exact original bytes"
    path.write_bytes(content)
    enriched = add_image_hashes(data, tmp_path)
    assert len(enriched["historical_image_hashes"]["11"]) == 64
    assert path.read_bytes() == content
    assert "historical_image_hashes" not in data
    data["wine_images"][0]["local_path"] = "../escape.webp"
    with pytest.raises(ValueError, match="escapes root"):
        add_image_hashes(data, tmp_path)


def test_cli_writes_exact_three_requested_artifacts(tmp_path):
    path = tmp_path / "input.json"
    path.write_bytes(json_bytes(snapshot()))
    main(
        [
            "--snapshot",
            str(path),
            "--output-dir",
            str(tmp_path / "out"),
            "--expected-unmatched",
            "1",
        ]
    )
    assert {p.name for p in (tmp_path / "out").iterdir()} == {
        "identity-plan.json",
        "identity-summary.json",
        "IDENTITY_REVIEW.md",
    }


def test_sweetness_contradiction_is_semantic_not_category_normalization():
    data = snapshot(
        [official(category="White sweet")],
        [historical(category_name="White dry")],
        media=True,
    )
    rows, _ = plan(data)
    assert rows[0]["classification"] == "manual_review"
    assert "sweetness" in rows[0]["candidates"][0]["contradictions"]


def test_missing_sweetness_is_not_a_contradiction():
    rows, _ = plan(
        snapshot([official(category="White")], [historical(category_name="White dry")])
    )
    assert rows[0]["classification"] == "re_slug"


def test_same_organizer_metadata_different_photos_not_automatic_duplicate():
    data = snapshot([official(1), official(2)], media=True)
    data["reference_assets"][1]["sha256"] = "b" * 64
    rows, summary = plan(data)
    assert all(r["classification"] == "manual_review" for r in rows)
    assert (
        summary["many_to_one_candidates"][0]["classification"] == "ambiguous_identity"
    )


def test_source_flag_alone_requires_manual_review():
    data = snapshot(media=True)
    data["reference_assets"][0]["provenance"]["flags"] = [
        "organizer_photo_title_inconsistency"
    ]
    rows, _ = plan(data)
    assert rows[0]["classification"] == "manual_review"


def test_missing_winery_cannot_resolve_identical_title_as_true_new():
    rows, _ = plan(snapshot([official(winery="")]))
    assert rows[0]["classification"] == "manual_review"


def test_true_new_records_exhaustive_negative_evidence():
    rows, _ = plan(snapshot([official(title="Unrelated", winery="Elsewhere")]))
    row = rows[0]
    assert row["classification"] == "true_new"
    assert row["evidence"][0]["historical_wines_compared"] == 1
    assert row["evidence"][0]["strong_media_candidate_wine_ids"] == []
    assert row["evidence"][0]["alias_collision_count"] == 0
