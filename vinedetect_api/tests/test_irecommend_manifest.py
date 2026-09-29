from __future__ import annotations

import hashlib
import json
import socket
from copy import deepcopy
from pathlib import Path

import pytest

from app.irecommend_manifest import (
    build_manifest,
    confirmed_manifest,
    main,
    write_manifest,
)
from app.irecommend_matching import (
    IRecommendCatalogCandidate,
    IRecommendMatchResult,
)
from tests.test_irecommend_matching import CATALOG_ROWS

FIXTURES = Path(__file__).parent / "fixtures" / "irecommend"


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    def fail(*args, **kwargs):
        pytest.fail("Manifest pipeline must not open network connections")

    monkeypatch.setattr(socket, "create_connection", fail)
    monkeypatch.setattr(socket.socket, "connect", fail)
    monkeypatch.setattr(socket.socket, "connect_ex", fail)


@pytest.fixture
def rows():
    return build_manifest(
        [FIXTURES / "product.html", FIXTURES / "product_cru_lermont_merlo.html"],
        [FIXTURES / "review.html"],
        CATALOG_ROWS,
    )


@pytest.fixture
def auto_matched_rows(tmp_path):
    # Synthetic pairing for the confirmation gate, NOT real Cru Lermont evidence.
    html = (FIXTURES / "review.html").read_text(encoding="utf-8")
    html = html.replace("4726923", "156562").replace(
        "Вино Фанагория F-Style Мерло", "Вино Фанагория Мерло CRU LERMONT"
    )
    review = tmp_path / "synthetic_review.html"
    review.write_text(html, encoding="utf-8")
    return build_manifest(
        [FIXTURES / "product_cru_lermont_merlo.html"], [review], CATALOG_ROWS
    )


def test_manifest_has_eight_unique_review_images_and_provenance(rows):
    assert len(rows) == 8
    assert len({row["image_identity"] for row in rows}) == 8
    for row in rows:
        assert row["source"] == "irecommend"
        assert row["source_product_id"] == "4726923"
        assert row["source_review_id"] == "4726974"
        assert row["image_identity"].startswith("user-images/530444/")
        assert len(row["url_variants"]) == 3
        assert row["preferred_url"] in row["url_variants"]
        assert "/copyright1/" in row["preferred_url"]
        assert row["verification_status"] == "auto"
        assert row["year_candidates"] == ["2016"]
        provenance = row["provenance"]
        assert (
            provenance["product_html"]["sha256"]
            == hashlib.sha256((FIXTURES / "product.html").read_bytes()).hexdigest()
        )
        assert (
            provenance["review_html"]["sha256"]
            == hashlib.sha256((FIXTURES / "review.html").read_bytes()).hexdigest()
        )
        assert provenance["publication_date"] == "2018-05-05"
        assert provenance["review_author"] == "Бутафория"
        assert provenance["parser_version"]
        assert provenance["matcher_version"]


def test_no_product_avatar_or_recommendation_images(rows):
    identities = {row["image_identity"] for row in rows}
    assert "user-images/530444/BAFWUWIQYYrMJxwZFxIuA.jpg" in identities
    assert "user-images/530444/f2gvnbHgtOlb1XDL77hDcQ.jpg" not in identities
    for row in rows:
        for url in row["url_variants"]:
            assert "/product-images/" not in url
            assert "picture-" not in url
            assert "/user-images/280391/" not in url
            assert "/user-images/32155/" not in url


def test_f_style_unmatched_keeps_top_candidate_only_in_evidence(rows):
    assert confirmed_manifest(rows) == []
    for row in rows:
        assert row["match_status"] == "unmatched"
        assert row["catalog_item_id"] is None
        assert row["official_slug"] is None
        assert row["match_score"] == 0.25
        evidence = row["match_evidence"]
        assert evidence["candidates"][0]["catalog_item_id"] == 199
        assert evidence["candidates"][0]["score"] == 0.25
        assert evidence["thresholds"]["matched"] == 0.85
        assert evidence["catalog_items_count"] == 4
        assert len(evidence["catalog_sha256"]) == 64
    edited = deepcopy(rows)
    for row in edited:
        row["verification_status"] = "human_confirmed"
    assert confirmed_manifest(edited) == []


def test_auto_match_is_not_confirmed(auto_matched_rows):
    assert all(row["match_status"] == "matched" for row in auto_matched_rows)
    assert all(row["catalog_item_id"] == 199 for row in auto_matched_rows)
    assert all(row["match_score"] == 1 for row in auto_matched_rows)
    assert confirmed_manifest(auto_matched_rows) == []


def test_confirmation_is_per_image_and_does_not_mutate_input(auto_matched_rows):
    edited = deepcopy(auto_matched_rows)
    edited[0]["verification_status"] = "human_confirmed"
    edited[1]["verification_status"] = "human_rejected"
    before = deepcopy(edited)
    confirmed = confirmed_manifest(edited)
    assert len(confirmed) == 1
    assert confirmed[0]["image_identity"] == edited[0]["image_identity"]
    assert confirmed[0]["catalog_item_id"] == 199
    assert edited == before
    for row in edited:
        row["verification_status"] = "human_confirmed"
    assert len(confirmed_manifest(edited)) == 8
    assert confirmed_manifest(auto_matched_rows) == []


@pytest.mark.parametrize("status", ["needs_review", "unmatched"])
def test_weak_match_never_becomes_positive_by_verification_alone(
    auto_matched_rows, status
):
    rows = deepcopy(auto_matched_rows)
    for row in rows:
        row["match_status"] = status
        row["verification_status"] = "human_confirmed"
    assert confirmed_manifest(rows) == []


def test_explicit_human_confirmation_can_resolve_weak_top_candidate(
    monkeypatch,
):
    candidate = IRecommendCatalogCandidate(
        catalog_item_id=199,
        official_slug=CATALOG_ROWS[0]["official_slug"],
        score=0.26,
        status="unmatched",
        evidence={"applied_caps": ["missing_discriminative_identity"]},
    )
    monkeypatch.setattr(
        "app.irecommend_manifest.find_irecommend_matches",
        lambda *args, **kwargs: IRecommendMatchResult(
            status="unmatched",
            candidates=[candidate],
        ),
    )
    rows = build_manifest(
        [FIXTURES / "product.html"],
        [FIXTURES / "review.html"],
        [CATALOG_ROWS[0]],
        review_verifications=[
            {
                "source_review_id": "4726974",
                "catalog_item_id": 199,
                "verification_status": "human_confirmed",
            }
        ],
    )

    assert len(rows) == 8
    assert len(confirmed_manifest(rows)) == 8
    assert all(row["catalog_item_id"] == 199 for row in rows)
    assert all(row["match_status"] == "matched" for row in rows)
    assert all(row["verification_status"] == "human_confirmed" for row in rows)
    assert all(row["match_evidence"]["status"] == "unmatched" for row in rows)


def test_build_and_write_are_deterministic_and_never_append(rows, tmp_path):
    products = [FIXTURES / "product_cru_lermont_merlo.html", FIXTURES / "product.html"]
    reviews = [FIXTURES / "review.html"]
    repeated = build_manifest(products * 2, reviews * 2, reversed(CATALOG_ROWS))
    assert repeated == rows
    path = tmp_path / "manifest.jsonl"
    write_manifest(path, rows)
    first = path.read_bytes()
    write_manifest(path, repeated)
    assert path.read_bytes() == first
    assert len(path.read_text(encoding="utf-8").splitlines()) == 8


def test_repeated_variants_with_thumbnail_still_give_one_image(tmp_path):
    html = (FIXTURES / "review.html").read_text(encoding="utf-8")
    image = "BAFWUWIQYYrMJxwZFxIuA.jpg"
    url = f"https://irecommend.ru/sites/default/files/imagecache/200i/user-images/530444/{image}"
    marker = '<div class="description hasinlineimage" itemprop="reviewBody">'
    html = html.replace(
        marker,
        marker + '<a data-gallery="gallery_node4726974field_imgf1">'
        f'<img src="{url}"><img src="{url}"></a>',
        1,
    )
    path = tmp_path / "review.html"
    path.write_text(html, encoding="utf-8")
    records = build_manifest([FIXTURES / "product.html"], [path], CATALOG_ROWS)
    assert len(records) == 8
    record = next(row for row in records if row["image_identity"].endswith(image))
    assert len(record["url_variants"]) == 4
    assert record["url_variants"].count(url) == 1
    assert "/copyright1/" in record["preferred_url"]


def test_missing_product_cannot_be_guessed_from_catalog():
    with pytest.raises(ValueError, match="no supplied product"):
        build_manifest(
            [FIXTURES / "product_cru_lermont_merlo.html"],
            [FIXTURES / "review.html"],
            CATALOG_ROWS,
        )


def test_conflicting_snapshots_fail_instead_of_silently_selecting_one(tmp_path):
    copy = tmp_path / "review.html"
    copy.write_bytes((FIXTURES / "review.html").read_bytes() + b"\n")
    with pytest.raises(ValueError, match="Conflicting HTML"):
        build_manifest(
            [FIXTURES / "product.html"],
            [FIXTURES / "review.html", copy],
            CATALOG_ROWS,
        )


def test_cross_review_image_identity_collision_fails(tmp_path):
    html = (FIXTURES / "review.html").read_text(encoding="utf-8")
    other = tmp_path / "other_review.html"
    other.write_text(html.replace("4726974", "9999999"), encoding="utf-8")
    with pytest.raises(ValueError, match="multiple reviews"):
        build_manifest(
            [FIXTURES / "product.html"],
            [FIXTURES / "review.html", other],
            CATALOG_ROWS,
        )


def test_confirmed_export_deduplicates_identical_rows_and_rejects_conflicts(
    auto_matched_rows,
):
    row = {**auto_matched_rows[0], "verification_status": "human_confirmed"}
    assert confirmed_manifest([row, row]) == [row]
    with pytest.raises(ValueError, match="Conflicting manifest"):
        confirmed_manifest([row, {**row, "verification_status": "human_rejected"}])


@pytest.mark.parametrize(
    "field, value",
    [
        ("verification_status", "family_confirmed"),
        ("catalog_item_id", None),
        ("official_slug", ""),
        ("source_review_id", ""),
    ],
)
def test_invalid_confirmation_does_not_export(auto_matched_rows, field, value):
    row = {
        **auto_matched_rows[0],
        "verification_status": "human_confirmed",
        field: value,
    }
    with pytest.raises(ValueError):
        confirmed_manifest([row])


def test_cli_build_and_confirmed(tmp_path, capsys):
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps(CATALOG_ROWS), encoding="utf-8")

    verifications = tmp_path / "review_verifications.jsonl"
    verifications.write_text("", encoding="utf-8")

    quality_overrides = tmp_path / "image_quality_overrides.jsonl"
    quality_overrides.write_text("", encoding="utf-8")

    manifest = tmp_path / "manifest.jsonl"
    confirmed = tmp_path / "confirmed.jsonl"

    assert (
        main(
            [
                "build",
                "--product",
                str(FIXTURES / "product.html"),
                "--review",
                str(FIXTURES / "review.html"),
                "--catalog",
                str(catalog),
                "--verifications",
                str(verifications),
                "--quality-overrides",
                str(quality_overrides),
                "--output",
                str(manifest),
            ]
        )
        == 0
    )
    assert "8 records" in capsys.readouterr().out
    assert (
        main(["confirmed", "--input", str(manifest), "--output", str(confirmed)]) == 0
    )
    assert "0 records" in capsys.readouterr().out
    assert confirmed.read_bytes() == b""
    assert len(manifest.read_text(encoding="utf-8").splitlines()) == 8


def test_cli_does_not_overwrite_reviewed_input(tmp_path):
    source = tmp_path / "reviewed.jsonl"
    source.write_text("", encoding="utf-8")
    with pytest.raises(SystemExit) as error:
        main(["confirmed", "--input", str(source), "--output", str(source)])
    assert error.value.code == 2


def test_current_fixtures_and_manifest_prefer_observed_cdn_urls():
    from urllib.parse import urlsplit

    from app.irecommend import parse_review_page

    for path in FIXTURES.glob("review*.html"):
        html = path.read_text(encoding="utf-8")
        for image in parse_review_page(html).images:
            assert urlsplit(image.preferred_url).hostname == "cdn-irec.r-99.com"
            assert image.preferred_url in image.url_variants
            assert image.preferred_url in html
    rows = build_manifest(
        FIXTURES.glob("product*.html"), FIXTURES.glob("review*.html"), CATALOG_ROWS
    )
    assert len(rows) == 21
    assert all(
        urlsplit(row["preferred_url"]).hostname == "cdn-irec.r-99.com" for row in rows
    )


def test_observed_variant_priority():
    from app.irecommend import image_url_priority

    suffix = "user-images/530444/existing.jpg"
    root = "/sites/default/files/imagecache/"
    ordered = [
        f"https://cdn-irec.r-99.com{root}copyright1/{suffix}",
        f"https://cdn-irec.r-99.com{root}copyright/{suffix}",
        f"https://irecommend.ru{root}copyright1/{suffix}",
        f"https://irecommend.ru{root}copyright/{suffix}",
        f"https://cdn-irec.r-99.com{root}200i/{suffix}",
    ]
    assert sorted(reversed(ordered), key=image_url_priority) == ordered
