from __future__ import annotations

import hashlib
import socket
from copy import deepcopy
from dataclasses import asdict, replace
from pathlib import Path

import pytest

from app.irecommend import parse_product_page, parse_review_page
from app.irecommend_matching import (
    MATCH_THRESHOLD,
    find_irecommend_matches,
    score_irecommend_to_catalog,
)

FIXTURES = Path(__file__).parent / "fixtures" / "irecommend"
# Exact selected fields from the local offline backup:
# backups/lct/vinedetect_wines_autodetect_handoff_20260916_221620.dump
# Read using pg_restore --data-only --table=catalog_items --file=- (no DB).
CATALOG_ROWS = [
    {
        "id": 199,
        "official_slug": "fanagoriya-cru-lermont-merlo-merlo-krasnoe-suhoe-14",
        "title": "Cru Lermont Merlo",
        "category": "Красное",
        "region": "Кубань",
        "grapes": "Мерло",
        "winery": "Фанагория",
    },
    {
        "id": 919,
        "official_slug": "fanagoriya-dekanter-merlo-2018-krasnoe-suhoe-14",
        "title": "Декантер. Мерло 2018",
        "category": "Красное",
        "region": "Кубань",
        "grapes": "Мерло",
        "winery": "Фанагория",
    },
    {
        "id": 469,
        "official_slug": (
            "fanagoriya-primum-alveus-brut-2016-shardone-igristoe-bryut-beloe-12"
        ),
        "title": "Primum Alveus Brut 2016",
        "category": "Белое",
        "region": "Кубань",
        "grapes": "Менье, Пино Нуар, Шардоне",
        "winery": "Фанагория",
    },
    {
        "id": 472,
        "official_slug": (
            "fanagoriya-primum-alveus-extra-brut-2016-shardone-beloe-bryut-12"
        ),
        "title": "Primum Alveus Extra Brut 2016",
        "category": "Белое",
        "region": "Кубань",
        "grapes": "Менье, Пино Нуар, Шардоне",
        "winery": "Фанагория",
    },
]


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    def fail(*args, **kwargs):
        pytest.fail("Offline matching must not open a network connection")

    monkeypatch.setattr(socket, "create_connection", fail)
    monkeypatch.setattr(socket.socket, "connect", fail)
    monkeypatch.setattr(socket.socket, "connect_ex", fail)


@pytest.fixture
def positive():
    return parse_product_page(
        (FIXTURES / "product_cru_lermont_merlo.html").read_text(encoding="utf-8")
    )


@pytest.fixture
def negative():
    return parse_product_page((FIXTURES / "product.html").read_text(encoding="utf-8"))


def test_positive_fixture_is_exact_copy_and_parses(positive):
    assert (
        hashlib.sha256(
            (FIXTURES / "product_cru_lermont_merlo.html").read_bytes()
        ).hexdigest()
        == "efd1bb967f7139d6f55d210e3004187906e38523bb3c38a96e02abbad16b22c3"
    )
    assert positive.product_id == "156562"
    assert positive.title == "Вино Фанагория Мерло CRU LERMONT"
    assert positive.brand == "Fanagoria / Фанагория"
    assert positive.beverage_type == "Вино красное сухое"


def test_cru_lermont_is_confident_top_match(positive):
    result = find_irecommend_matches(positive, CATALOG_ROWS)
    top = result.candidates[0]

    assert result.status == top.status == "matched"
    assert top.catalog_item_id == 199
    assert top.score >= MATCH_THRESHOLD
    assert top.score > max(c.score for c in result.candidates[1:])
    assert all(c.status != "matched" for c in result.candidates[1:])
    assert top.evidence["discriminative_score"] == 1
    assert top.evidence["source_discriminative_tokens"] == ["cru", "lermont"]
    assert top.evidence["missing_discriminative_tokens"] == []
    assert top.evidence["applied_caps"] == []


@pytest.mark.parametrize("years", [set(), {"2016"}])
def test_f_style_is_unmatched_even_with_matching_year(negative, years):
    assert negative.product_id == "4726923"
    result = find_irecommend_matches(negative, CATALOG_ROWS, year_candidates=years)
    assert result.status == "unmatched"
    assert {c.catalog_item_id for c in result.candidates} == {199, 919, 469, 472}
    assert all(c.status == "unmatched" for c in result.candidates)
    cru = next(c for c in result.candidates if c.catalog_item_id == 199)
    assert cru.evidence["missing_discriminative_tokens"] == ["f", "style"]
    assert cru.evidence["conflicting_discriminative_tokens"] == ["cru", "lermont"]
    assert "conflicting_product_identity" in cru.evidence["applied_caps"]
    assert cru.evidence["winery_score"] == cru.evidence["grape_score"] == 1
    for candidate in result.candidates:
        if candidate.catalog_item_id in {469, 472}:
            assert candidate.evidence["year_score"] == (1 if years else 0)
            assert candidate.evidence["year_bonus"] == 0
            assert "style_conflict" in candidate.evidence["applied_caps"]


def test_review_years_are_explicit_supporting_evidence(negative):
    review = parse_review_page((FIXTURES / "review.html").read_text(encoding="utf-8"))
    assert review.year_candidates == {"2016"}
    result = find_irecommend_matches(
        negative, CATALOG_ROWS, year_candidates=review.year_candidates
    )
    assert result.status == "unmatched"
    assert all(c.evidence["source_years"] == ["2016"] for c in result.candidates)


def test_generic_winery_grape_style_is_insufficient(positive):
    source = replace(positive, title="Вино Фанагория Мерло")
    result = find_irecommend_matches(source, CATALOG_ROWS)

    assert result.status == "unmatched"
    assert all(c.status != "matched" for c in result.candidates)
    cru = next(c for c in result.candidates if c.catalog_item_id == 199)
    assert "missing_discriminative_identity" in cru.evidence["applied_caps"]


def test_latin_grape_brand_and_hyphenated_line_aliases(negative):
    source = replace(negative, title="Wine Fanagoria F–Style Merlot", brand="Fanagoria")
    row = {
        **CATALOG_ROWS[0],
        "title": "F Style Мерло",
        "official_slug": "fanagoriya-f-style-merlo-krasnoe-suhoe",
    }
    candidate = score_irecommend_to_catalog(source, row)
    assert candidate.status == "matched"
    assert candidate.evidence["source_discriminative_tokens"] == ["f", "style"]


@pytest.mark.parametrize(
    "change, cap",
    [
        ({"category": "Белое"}, "style_conflict"),
        ({"winery": "Другая винодельня"}, "winery_conflict"),
        ({"grapes": "Каберне Совиньон"}, "grape_conflict"),
    ],
)
def test_explicit_supporting_conflicts_block_auto_match(positive, change, cap):
    row = {**CATALOG_ROWS[0], **change}
    candidate = score_irecommend_to_catalog(positive, row)
    assert candidate.status == "unmatched"
    assert cap in candidate.evidence["applied_caps"]


def test_year_conflict_blocks_automatic_match(positive):
    row = {**CATALOG_ROWS[0], "title": "Cru Lermont Merlo 2018"}
    candidate = score_irecommend_to_catalog(positive, row, year_candidates={"2016"})
    assert candidate.status == "needs_review"
    assert candidate.evidence["year_score"] == -1
    assert "year_conflict" in candidate.evidence["applied_caps"]


def test_year_can_only_boost_good_identity(positive):
    row = {**CATALOG_ROWS[0], "title": "Cru Lermont Merlo 2016", "category": ""}
    row["official_slug"] = "fanagoriya-cru-lermont-merlo-2016"
    neutral = score_irecommend_to_catalog(positive, row)
    supported = score_irecommend_to_catalog(positive, row, year_candidates={"2016"})
    assert supported.score > neutral.score
    assert supported.evidence["year_bonus"] == 0.03


def test_description_and_publication_year_never_supply_identity_or_years(negative):
    source = {**asdict(negative), "publication_date": "2016-01-01"}
    row = {
        **CATALOG_ROWS[0],
        "description": "F-Style Merlo Фанагория 2016 " * 100,
    }
    candidate = score_irecommend_to_catalog(source, row)
    baseline = score_irecommend_to_catalog(negative, CATALOG_ROWS[0])
    assert candidate == baseline
    assert candidate.evidence["source_years"] == []
    assert candidate.evidence["catalog_years"] == []


@pytest.mark.parametrize("top_k", [1, 2, 10])
def test_ambiguity_checked_before_top_k(positive, top_k):
    rows = [CATALOG_ROWS[0], {**CATALOG_ROWS[0], "id": 200}]
    result = find_irecommend_matches(positive, rows, top_k=top_k)

    assert result.status == "needs_review"
    assert len(result.candidates) == min(top_k, 2)
    assert all(c.status == "needs_review" for c in result.candidates)
    assert result.candidates[0].catalog_item_id == 199
    assert result.candidates[0].evidence["score_margin"] == 0
    assert (
        "ambiguous_top_candidates" in result.candidates[0].evidence["decision_reasons"]
    )


def test_close_nonidentical_candidates_are_ambiguous(positive):
    second = {
        **CATALOG_ROWS[0],
        "id": 200,
        "category": "",
        "official_slug": "fanagoriya-cru-lermont-merlo",
    }
    result = find_irecommend_matches(positive, [CATALOG_ROWS[0], second], top_k=1)
    assert result.status == "needs_review"
    assert result.candidates[0].evidence["score_margin"] == 0.05


def test_empty_catalog_and_zero_top_k(positive):
    assert find_irecommend_matches(positive, []).status == "unmatched"
    result = find_irecommend_matches(positive, CATALOG_ROWS, top_k=0)
    assert result.status == "unmatched"
    assert result.candidates == []


@pytest.mark.parametrize("top_k", [-1, 1.5, True])
def test_invalid_top_k_is_rejected(positive, top_k):
    with pytest.raises(ValueError, match="top_k"):
        find_irecommend_matches(positive, CATALOG_ROWS, top_k=top_k)


def test_duplicate_ids_rejected(positive):
    with pytest.raises(ValueError, match="Duplicate"):
        find_irecommend_matches(positive, [CATALOG_ROWS[0], CATALOG_ROWS[0]])


@pytest.mark.parametrize("years", ["2016", {"16"}, {2016}])
def test_invalid_year_candidates_rejected(positive, years):
    with pytest.raises(ValueError, match="year_candidates"):
        find_irecommend_matches(positive, CATALOG_ROWS, year_candidates=years)


def test_repeatable_order_and_no_input_mutation(negative):
    product = asdict(negative)
    rows = deepcopy(CATALOG_ROWS)
    before = deepcopy((product, rows))
    first = find_irecommend_matches(product, rows, year_candidates=iter(["2016"]))
    second = find_irecommend_matches(product, reversed(rows), year_candidates={"2016"})
    assert first == second
    assert (product, rows) == before
    assert all(c.evidence["final_score"] == c.score for c in first.candidates)
    assert all(0 <= c.score <= 1 for c in first.candidates)


def test_partial_line_identity_requires_review(positive):
    row = {**CATALOG_ROWS[0], "title": "Cru Lermont Reserve Merlo"}
    candidate = score_irecommend_to_catalog(positive, row)
    assert candidate.status != "matched"
    assert candidate.evidence["conflicting_discriminative_tokens"] == ["reserve"]
    assert "conflicting_product_identity" in candidate.evidence["applied_caps"]


def test_missing_winery_does_not_allow_auto_match(positive):
    source = replace(positive, brand=None, title="Cru Lermont Merlo")
    candidate = score_irecommend_to_catalog(source, CATALOG_ROWS[0])
    assert candidate.status == "needs_review"
    assert "winery_not_confirmed" in candidate.evidence["applied_caps"]


def test_explicit_sugar_conflict_blocks_match(positive):
    source = replace(positive, beverage_type="Вино красное полусладкое")
    candidate = score_irecommend_to_catalog(source, CATALOG_ROWS[0])
    assert candidate.status == "unmatched"
    assert candidate.evidence["style_conflicts"] == ["sugar"]
