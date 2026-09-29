# ruff: noqa: E501
from __future__ import annotations

from decimal import Decimal
from pathlib import Path
from typing import Any

from app.matching import (
    extract_style_tokens,
    extract_years,
    find_roskachestvo_matches,
    is_generic_short_title,
    manufacturer_overlap_score,
    match_roskachestvo_to_wines,
    normalize_match_text,
    score_roskachestvo_to_wine,
)


def test_normalize_match_text_cleans_text() -> None:
    assert normalize_match_text("\u0401\u0436\u0438\u043a\u2014\u041a\u0430\u0431\u0435\u0440\u043d\u0435 \u0424\u0440\u0430\u043d - \u041c\u0435\u0440\u043b\u043e!!!") == (
        "\u0435\u0436\u0438\u043a \u043a\u0430\u0431\u0435\u0440\u043d\u0435 \u0444\u0440\u0430\u043d \u043c\u0435\u0440\u043b\u043e"
    )
    assert normalize_match_text("  LETO   \u041c\u0443\u0441\u043a\u0430\u0442, \u041e\u0440\u0430\u043d\u0436 2024  ") == (
        "leto \u043c\u0443\u0441\u043a\u0430\u0442 \u043e\u0440\u0430\u043d\u0436 2024"
    )
    assert normalize_match_text(None) == ""


def test_extract_years() -> None:
    assert extract_years("\u0412\u0438\u043d\u043e 2024 \u0443\u0440\u043e\u0436\u0430\u0439") == {"2024"}
    assert extract_years("\u0431\u0435\u0437 \u0433\u043e\u0434\u0430") == set()


def test_extract_style_tokens() -> None:
    tokens = extract_style_tokens("\u043a\u0440\u0430\u0441\u043d\u043e\u0435 \u0441\u0443\u0445\u043e\u0435 \u0441\u0442\u043e\u043b\u043e\u0432\u043e\u0435")

    assert "\u043a\u0440\u0430\u0441\u043d\u043e\u0435" in tokens
    assert "\u0441\u0443\u0445\u043e\u0435" in tokens


def test_is_generic_short_title_detects_grape_and_style_titles() -> None:
    assert is_generic_short_title("\u041c\u0435\u0440\u043b\u043e") is True
    assert is_generic_short_title("\u041a\u0430\u0431\u0435\u0440\u043d\u0435 \u0421\u043e\u0432\u0438\u043d\u044c\u043e\u043d") is True
    assert is_generic_short_title("\u0411\u0435\u043b\u044c\u0431\u0435\u043a \u0424\u0438\u043e\u043b\u0435\u043d\u0442 \u041c\u0435\u0440\u043b\u043e") is False


def test_manufacturer_overlap_score_matches_meaningful_token() -> None:
    assert manufacturer_overlap_score(
        "\u0411\u0435\u043b\u044c\u0431\u0435\u043a. \u0424\u0438\u043e\u043b\u0435\u043d\u0442. \u041f\u0442\u0438 \u0412\u0435\u0440\u0434\u043e",
        "\u0412\u0438\u043d\u043e\u0434\u0435\u043b\u044c\u043d\u044f \u0411\u0435\u043b\u044c\u0431\u0435\u043a",
    ) == 1.0


def test_generic_grape_title_is_not_high_confidence_for_long_source() -> None:
    score, method, details = score_roskachestvo_to_wine(
        {
            "rskrf_product_id": "1",
            "name": "\u0411\u0435\u043b\u044c\u0431\u0435\u043a. \u0424\u0438\u043e\u043b\u0435\u043d\u0442. \u041c\u0435\u0440\u043b\u043e. \u0420\u043e\u0441\u0441\u0438\u0439\u0441\u043a\u043e\u0435 \u0432\u0438\u043d\u043e \u0441 \u0417\u0413\u0423 \u00ab\u041a\u0440\u044b\u043c\u00bb, \u043f\u043e\u043b\u0443\u0441\u043b\u0430\u0434\u043a\u043e\u0435 \u043a\u0440\u0430\u0441\u043d\u043e\u0435 2024",
        },
        {
            "id": 1,
            "slug": "merlot",
            "title": "\u041c\u0435\u0440\u043b\u043e",
            "manufacturer_name": "\u0424\u0430\u043d\u0430\u0433\u043e\u0440\u0438\u044f",
            "category_name": "\u041a\u0440\u0430\u0441\u043d\u043e\u0435 \u0441\u0443\u0445\u043e\u0435",
            "region_name": "\u041a\u0443\u0431\u0430\u043d\u044c",
        },
    )

    assert score < Decimal("0.70")
    assert method != "high_confidence_text"
    assert details["is_generic_short_title"] is True
    assert "long_source_short_title" in details["applied_caps"]


def test_manufacturer_match_improves_score() -> None:
    score, _method, details = score_roskachestvo_to_wine(
        {
            "rskrf_product_id": "1",
            "name": "\u0412\u0438\u043d\u043e\u0434\u0435\u043b\u044c\u043d\u044f \u0411\u0435\u043b\u044c\u0431\u0435\u043a. \u041f\u0442\u0438 \u0412\u0435\u0440\u0434\u043e. \u0420\u043e\u0441\u0441\u0438\u0439\u0441\u043a\u043e\u0435 \u0432\u0438\u043d\u043e \u0441 \u0417\u0413\u0423 \u00ab\u041a\u0440\u044b\u043c\u00bb, \u0441\u0443\u0445\u043e\u0435 \u043a\u0440\u0430\u0441\u043d\u043e\u0435 2023",
        },
        {
            "id": 2,
            "slug": "belbek-pti-verdo",
            "title": "\u0411\u0435\u043b\u044c\u0431\u0435\u043a \u041f\u0442\u0438 \u0412\u0435\u0440\u0434\u043e",
            "manufacturer_name": "\u0412\u0438\u043d\u043e\u0434\u0435\u043b\u044c\u043d\u044f \u0411\u0435\u043b\u044c\u0431\u0435\u043a",
            "category_name": "\u041a\u0440\u0430\u0441\u043d\u043e\u0435 \u0441\u0443\u0445\u043e\u0435",
            "region_name": "\u041a\u0440\u044b\u043c",
        },
    )

    assert score >= Decimal("0.80")
    assert details["manufacturer_score"] == 1.0


def test_year_mismatch_caps_score() -> None:
    score, _method, details = score_roskachestvo_to_wine(
        {
            "rskrf_product_id": "1",
            "name": "LETO \u041c\u0443\u0441\u043a\u0430\u0442 \u041e\u0440\u0430\u043d\u0436 2024 \u0441\u0443\u0445\u043e\u0435 \u0431\u0435\u043b\u043e\u0435",
        },
        {
            "id": 10,
            "slug": "leto-muskat",
            "title": "LETO \u041c\u0443\u0441\u043a\u0430\u0442 \u041e\u0440\u0430\u043d\u0436 2021 \u0441\u0443\u0445\u043e\u0435 \u0431\u0435\u043b\u043e\u0435",
            "manufacturer_name": "LETO",
            "category_name": "\u0431\u0435\u043b\u043e\u0435 \u0441\u0443\u0445\u043e\u0435",
            "region_name": "\u0420\u043e\u0441\u0441\u0438\u044f",
        },
    )

    assert score <= Decimal("0.69")
    assert details["year_score"] == -0.5
    assert "year_mismatch" in details["applied_caps"]


def test_generic_title_with_same_manufacturer_can_be_medium() -> None:
    score, method, details = score_roskachestvo_to_wine(
        {
            "rskrf_product_id": "1",
            "name": "\u0424\u0430\u043d\u0430\u0433\u043e\u0440\u0438\u044f. \u041c\u0435\u0440\u043b\u043e. \u0420\u043e\u0441\u0441\u0438\u0439\u0441\u043a\u043e\u0435 \u0432\u0438\u043d\u043e \u0441\u0443\u0445\u043e\u0435 \u043a\u0440\u0430\u0441\u043d\u043e\u0435 2023",
        },
        {
            "id": 1,
            "slug": "fanagoria-merlot",
            "title": "\u041c\u0435\u0440\u043b\u043e",
            "manufacturer_name": "\u0424\u0430\u043d\u0430\u0433\u043e\u0440\u0438\u044f",
            "category_name": "\u041a\u0440\u0430\u0441\u043d\u043e\u0435 \u0441\u0443\u0445\u043e\u0435",
            "region_name": "\u041a\u0443\u0431\u0430\u043d\u044c",
        },
    )

    assert Decimal("0.70") <= score < Decimal("0.90")
    assert method in {"low_confidence_text", "medium_confidence_text"}
    assert details["manufacturer_score"] == 1.0


def test_style_mismatch_caps_score() -> None:
    score, _method, details = score_roskachestvo_to_wine(
        {
            "rskrf_product_id": "1",
            "name": "\u0412\u0438\u043d\u043e \u043a\u0440\u0430\u0441\u043d\u043e\u0435 \u0441\u0443\u0445\u043e\u0435",
        },
        {
            "id": 10,
            "slug": "white",
            "title": "\u0412\u0438\u043d\u043e \u0431\u0435\u043b\u043e\u0435 \u0441\u043b\u0430\u0434\u043a\u043e\u0435",
            "manufacturer_name": "",
            "category_name": "\u0431\u0435\u043b\u043e\u0435 \u0441\u043b\u0430\u0434\u043a\u043e\u0435",
            "region_name": "\u0420\u043e\u0441\u0441\u0438\u044f",
        },
    )

    assert score <= Decimal("0.74")
    assert details["style_score"] == -0.5


def test_find_roskachestvo_matches_ranks_branded_title_above_generic() -> None:
    product = {
        "rskrf_product_id": "1",
        "name": "\u0411\u0435\u043b\u044c\u0431\u0435\u043a. \u0424\u0438\u043e\u043b\u0435\u043d\u0442. \u041c\u0435\u0440\u043b\u043e. \u0420\u043e\u0441\u0441\u0438\u0439\u0441\u043a\u043e\u0435 \u0432\u0438\u043d\u043e \u0441 \u0417\u0413\u0423 \u00ab\u041a\u0440\u044b\u043c\u00bb, \u043f\u043e\u043b\u0443\u0441\u043b\u0430\u0434\u043a\u043e\u0435 \u043a\u0440\u0430\u0441\u043d\u043e\u0435 2024",
        "barcode": "111",
    }
    wines = [
        {
            "id": 1,
            "slug": "fanagoria-merlot",
            "title": "\u041c\u0435\u0440\u043b\u043e",
            "manufacturer_name": "\u0424\u0430\u043d\u0430\u0433\u043e\u0440\u0438\u044f",
            "category_name": "\u043a\u0440\u0430\u0441\u043d\u043e\u0435 \u0441\u0443\u0445\u043e\u0435",
            "region_name": "\u041a\u0443\u0431\u0430\u043d\u044c",
        },
        {
            "id": 2,
            "slug": "belbek-fiolent-merlot",
            "title": "\u0411\u0435\u043b\u044c\u0431\u0435\u043a \u0424\u0438\u043e\u043b\u0435\u043d\u0442 \u041c\u0435\u0440\u043b\u043e",
            "manufacturer_name": "\u0412\u0438\u043d\u043e\u0434\u0435\u043b\u044c\u043d\u044f \u0411\u0435\u043b\u044c\u0431\u0435\u043a",
            "category_name": "\u043a\u0440\u0430\u0441\u043d\u043e\u0435 \u043f\u043e\u043b\u0443\u0441\u043b\u0430\u0434\u043a\u043e\u0435",
            "region_name": "\u041a\u0440\u044b\u043c",
        },
        {
            "id": 3,
            "slug": "cabernet",
            "title": "\u041a\u0430\u0431\u0435\u0440\u043d\u0435 \u0421\u043e\u0432\u0438\u043d\u044c\u043e\u043d",
            "manufacturer_name": "\u041a\u0443\u0431\u0430\u043d\u044c-\u0412\u0438\u043d\u043e",
            "category_name": "\u043a\u0440\u0430\u0441\u043d\u043e\u0435 \u0441\u0443\u0445\u043e\u0435",
            "region_name": "\u041a\u0443\u0431\u0430\u043d\u044c",
        },
    ]

    matches = find_roskachestvo_matches(product, wines, top_k=3, min_score=0.1)

    assert matches[0].wine_id == 2
    assert matches[0].match_score > matches[1].match_score


def test_match_roskachestvo_to_wines_uses_repo_reset_and_limit() -> None:
    class FakeRepo:
        def __init__(
            self,
            wines: list[dict[str, Any]],
            products: list[dict[str, Any]],
        ) -> None:
            self.wines = wines
            self.products = products
            self.saved: list[tuple[Any, ...]] = []
            self.cleared_sources: list[str] = []
            self.product_limits: list[int | None] = []

        def clear_external_matches(self, source: str) -> None:
            self.cleared_sources.append(source)

        def get_wines_for_external_matching(self) -> list[dict[str, Any]]:
            return self.wines

        def get_roskachestvo_products_for_matching(
            self,
            limit: int | None = None,
        ) -> list[dict[str, Any]]:
            self.product_limits.append(limit)
            if limit is not None and limit > 0:
                return self.products[:limit]
            return self.products

        def upsert_external_match(
            self,
            wine_id,
            source,
            source_product_id,
            barcode,
            source_name,
            match_score,
            match_method,
            match_details,
        ):
            self.saved.append(
                (
                    wine_id,
                    source,
                    source_product_id,
                    barcode,
                    source_name,
                    match_score,
                    match_method,
                    match_details,
                )
            )
            return len(self.saved)

    repo = FakeRepo(
        wines=[
            {
                "id": 1,
                "slug": "leto",
                "title": "LETO \u041c\u0443\u0441\u043a\u0430\u0442 \u041e\u0440\u0430\u043d\u0436 2024 \u0441\u0443\u0445\u043e\u0435 \u0431\u0435\u043b\u043e\u0435",
                "manufacturer_name": "LETO",
                "category_name": "\u0431\u0435\u043b\u043e\u0435 \u0441\u0443\u0445\u043e\u0435",
                "region_name": "\u0420\u043e\u0441\u0441\u0438\u044f",
            }
        ],
        products=[
            {
                "rskrf_product_id": "1",
                "name": "LETO \u041c\u0443\u0441\u043a\u0430\u0442 \u041e\u0440\u0430\u043d\u0436 2024 \u0441\u0443\u0445\u043e\u0435 \u0431\u0435\u043b\u043e\u0435",
                "barcode": "111",
                "rating": Decimal("4.2"),
                "raw_json": {"source": "detail"},
            },
            {
                "rskrf_product_id": "2",
                "name": "\u041a\u0430\u0431\u0435\u0440\u043d\u0435 \u0421\u043e\u0432\u0438\u043d\u044c\u043e\u043d \u043a\u0440\u0430\u0441\u043d\u043e\u0435 \u0441\u0443\u0445\u043e\u0435",
                "barcode": "222",
                "rating": Decimal("3.9"),
                "raw_json": {"source": "list"},
            },
        ],
    )

    stats = match_roskachestvo_to_wines(
        repo,
        top_k=5,
        min_score=0.55,
        limit=1,
        reset=True,
    )

    assert repo.cleared_sources == ["roskachestvo"]
    assert repo.product_limits == [1]
    assert stats.external_products_seen == 1
    assert stats.matches_saved > 0
    assert repo.saved[0][1] == "roskachestvo"
    assert repo.saved[0][2] == "1"
    assert repo.saved[0][3] == "111"
    assert repo.saved[0][4] == (
        "LETO \u041c\u0443\u0441\u043a\u0430\u0442 \u041e\u0440\u0430\u043d\u0436 2024 "
        "\u0441\u0443\u0445\u043e\u0435 \u0431\u0435\u043b\u043e\u0435"
    )


def test_matching_module_uses_roskachestvo_products_source() -> None:
    source = Path("vinedetect_api/app/matching.py").read_text()
    legacy_method = "get_roskachestvo_" + "wines_for_matching"

    assert "get_roskachestvo_products_for_matching" in source
    assert legacy_method not in source
