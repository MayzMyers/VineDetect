from __future__ import annotations

from decimal import Decimal
from typing import Any

from app.barcodes import apply_barcode_matches_to_db


class FakeRepo:
    def __init__(self, candidates: list[dict[str, Any]]) -> None:
        self.candidates = candidates
        self.saved: list[dict[str, Any]] = []
        self.last_params: dict[str, Any] | None = None

    def get_safe_barcode_match_candidates(
        self,
        source: str = "roskachestvo",
        min_score: float = 0.88,
        min_gap: float = 0.08,
    ) -> list[dict[str, Any]]:
        self.last_params = {
            "source": source,
            "min_score": min_score,
            "min_gap": min_gap,
        }
        return self.candidates

    def upsert_wine_barcode(
        self,
        wine_id,
        barcode,
        source,
        source_product_id,
        confidence,
        match_score,
        score_gap,
        match_method,
        match_details,
        is_primary=False,
    ):
        self.saved.append(
            {
                "wine_id": wine_id,
                "barcode": barcode,
                "source": source,
                "source_product_id": source_product_id,
                "confidence": confidence,
                "match_score": match_score,
                "score_gap": score_gap,
                "match_method": match_method,
                "match_details": match_details,
                "is_primary": is_primary,
            }
        )
        return len(self.saved)


def _candidate(
    wine_id: int = 1,
    barcode: str = "4600000000001",
    source_product_id: str = "p1",
) -> dict[str, Any]:
    return {
        "wine_id": wine_id,
        "barcode": barcode,
        "source": "roskachestvo",
        "source_product_id": source_product_id,
        "match_score": Decimal("0.91"),
        "score_gap": Decimal("0.12"),
        "match_method": "high_confidence_text",
        "match_details": {"final_score": 0.91},
    }


def test_apply_barcode_matches_dry_run_does_not_write() -> None:
    repo = FakeRepo([_candidate(), _candidate(wine_id=2, barcode="4600000000002")])

    stats = apply_barcode_matches_to_db(repo, dry_run=True)

    assert stats.candidates_seen == 2
    assert stats.barcode_links_saved == 0
    assert stats.dry_run is True
    assert repo.saved == []


def test_apply_barcode_matches_saves_all_candidates() -> None:
    repo = FakeRepo([_candidate(), _candidate(wine_id=2, barcode="4600000000002")])

    stats = apply_barcode_matches_to_db(repo)

    assert stats.candidates_seen == 2
    assert stats.barcode_links_saved == 2
    assert repo.saved[0]["wine_id"] == 1
    assert repo.saved[0]["barcode"] == "4600000000001"
    assert repo.saved[0]["source"] == "roskachestvo"
    assert repo.saved[0]["confidence"] == repo.saved[0]["match_score"]
    assert repo.saved[0]["is_primary"] is False


def test_apply_barcode_matches_limit_restricts_application() -> None:
    repo = FakeRepo(
        [
            _candidate(wine_id=1, barcode="1"),
            _candidate(wine_id=2, barcode="2"),
            _candidate(wine_id=3, barcode="3"),
        ]
    )

    stats = apply_barcode_matches_to_db(repo, limit=2)

    assert stats.candidates_seen == 2
    assert stats.barcode_links_saved == 2
    assert len(repo.saved) == 2


def test_apply_barcode_matches_handles_empty_candidates() -> None:
    repo = FakeRepo([])

    stats = apply_barcode_matches_to_db(repo)

    assert stats.candidates_seen == 0
    assert stats.barcode_links_saved == 0
    assert repo.saved == []


def test_apply_barcode_matches_passes_selection_params_to_repo() -> None:
    repo = FakeRepo([])

    apply_barcode_matches_to_db(
        repo,
        source="other",
        min_score=0.95,
        min_gap=0.2,
    )

    assert repo.last_params == {
        "source": "other",
        "min_score": 0.95,
        "min_gap": 0.2,
    }
