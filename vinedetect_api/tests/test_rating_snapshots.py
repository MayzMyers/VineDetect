from __future__ import annotations

from decimal import Decimal
from typing import Any

from app.rating_snapshots import (
    PUBLIC_RATING_SOURCE,
    RATING_SOURCE,
    extract_rating_snapshots,
    extract_rating_snapshots_to_db,
    parse_rating_value,
)


def test_parse_rating_value_accepts_numbers_and_numeric_strings() -> None:
    assert parse_rating_value(5) == Decimal("5")
    assert parse_rating_value(4.2) == Decimal("4.2")
    assert parse_rating_value("4.5") == Decimal("4.5")


def test_parse_rating_value_rejects_empty_invalid_and_non_scalars() -> None:
    assert parse_rating_value(None) is None
    assert parse_rating_value("") is None
    assert parse_rating_value("   ") is None
    assert parse_rating_value({"rating": 5}) is None
    assert parse_rating_value([5]) is None
    assert parse_rating_value(True) is None
    assert parse_rating_value(False) is None
    assert parse_rating_value("not-a-number") is None


def test_extract_rating_snapshots_reads_public_rating() -> None:
    snapshots = extract_rating_snapshots(
        {"id": 1, "raw_detail_json": {"publicRating": 5}}
    )

    assert len(snapshots) == 1
    assert snapshots[0].wine_id == 1
    assert snapshots[0].source == PUBLIC_RATING_SOURCE
    assert snapshots[0].rating_value == Decimal("5")
    assert snapshots[0].rating_raw == 5


def test_extract_rating_snapshots_reads_rating() -> None:
    snapshots = extract_rating_snapshots({"id": 2, "raw_detail_json": {"rating": 4.2}})

    assert len(snapshots) == 1
    assert snapshots[0].wine_id == 2
    assert snapshots[0].source == RATING_SOURCE
    assert snapshots[0].rating_value == Decimal("4.2")
    assert snapshots[0].rating_raw == 4.2


def test_extract_rating_snapshots_reads_both_sources() -> None:
    snapshots = extract_rating_snapshots(
        {"id": 3, "raw_detail_json": {"publicRating": "5", "rating": "4.5"}}
    )

    assert [snapshot.source for snapshot in snapshots] == [
        PUBLIC_RATING_SOURCE,
        RATING_SOURCE,
    ]
    assert [snapshot.rating_value for snapshot in snapshots] == [
        Decimal("5"),
        Decimal("4.5"),
    ]


def test_extract_rating_snapshots_returns_empty_for_missing_payload_or_id() -> None:
    assert extract_rating_snapshots({"id": 1, "raw_detail_json": None}) == []
    assert extract_rating_snapshots({"id": 1, "raw_detail_json": "bad"}) == []
    assert extract_rating_snapshots({"raw_detail_json": {"rating": 5}}) == []
    assert (
        extract_rating_snapshots({"id": None, "raw_detail_json": {"rating": 5}})
        == []
    )


def test_extract_rating_snapshots_skips_invalid_values() -> None:
    snapshots = extract_rating_snapshots(
        {
            "id": 4,
            "raw_detail_json": {
                "publicRating": "not-a-number",
                "rating": True,
            },
        }
    )

    assert snapshots == []


def test_extract_rating_snapshots_to_db_uses_repo() -> None:
    class FakeRepo:
        def __init__(self, wines: list[dict[str, Any]]) -> None:
            self.wines = wines
            self.saved: list[tuple[Any, ...]] = []

        def get_wines_for_rating_snapshot_extraction(self) -> list[dict[str, Any]]:
            return self.wines

        def upsert_wine_rating_snapshot(
            self,
            wine_id: int,
            source: str,
            rating_value: Decimal,
            rating_raw: Any,
            votes_count: int | None = None,
            reviews_count: int | None = None,
        ) -> int:
            self.saved.append(
                (wine_id, source, rating_value, rating_raw, votes_count, reviews_count)
            )
            return len(self.saved)

    repo = FakeRepo(
        [
            {"id": 1, "raw_detail_json": {"publicRating": 5, "rating": 4.2}},
            {"id": 2, "raw_detail_json": {"rating": "4.5"}},
            {"id": 3, "raw_detail_json": {"rating": None}},
        ]
    )

    stats = extract_rating_snapshots_to_db(repo)

    assert stats.wines_seen == 3
    assert stats.snapshots_seen == 3
    assert stats.snapshots_saved == 3
    assert [item[1] for item in repo.saved] == [
        PUBLIC_RATING_SOURCE,
        RATING_SOURCE,
        RATING_SOURCE,
    ]
