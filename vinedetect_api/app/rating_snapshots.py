"""Extract dynamic wine rating snapshots from raw detail payloads."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

PUBLIC_RATING_SOURCE = "svoe_vino_public_rating"
RATING_SOURCE = "svoe_vino_rating"


@dataclass(frozen=True)
class WineRatingSnapshot:
    wine_id: int
    source: str
    rating_value: Decimal
    rating_raw: Any
    votes_count: int | None = None
    reviews_count: int | None = None


@dataclass(frozen=True)
class RatingSnapshotExtractStats:
    wines_seen: int
    snapshots_seen: int
    snapshots_saved: int


def parse_rating_value(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, str) and not value.strip():
        return None
    if isinstance(value, dict | list):
        return None

    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not parsed.is_finite():
        return None
    return parsed


def extract_rating_snapshots(wine_row: dict[str, Any]) -> list[WineRatingSnapshot]:
    wine_id = wine_row.get("id")
    if not isinstance(wine_id, int):
        return []

    raw_detail_json = wine_row.get("raw_detail_json")
    if not isinstance(raw_detail_json, dict):
        return []

    snapshots: list[WineRatingSnapshot] = []
    _append_snapshot(
        snapshots,
        wine_id=wine_id,
        source=PUBLIC_RATING_SOURCE,
        rating_raw=raw_detail_json.get("publicRating"),
    )
    _append_snapshot(
        snapshots,
        wine_id=wine_id,
        source=RATING_SOURCE,
        rating_raw=raw_detail_json.get("rating"),
    )
    return snapshots


def extract_rating_snapshots_to_db(repo: Any) -> RatingSnapshotExtractStats:
    wines = repo.get_wines_for_rating_snapshot_extraction()
    snapshots_seen = 0
    snapshots_saved = 0

    for wine in wines:
        snapshots = extract_rating_snapshots(wine)
        snapshots_seen += len(snapshots)
        for snapshot in snapshots:
            repo.upsert_wine_rating_snapshot(
                wine_id=snapshot.wine_id,
                source=snapshot.source,
                rating_value=snapshot.rating_value,
                rating_raw=snapshot.rating_raw,
                votes_count=snapshot.votes_count,
                reviews_count=snapshot.reviews_count,
            )
            snapshots_saved += 1

    return RatingSnapshotExtractStats(
        wines_seen=len(wines),
        snapshots_seen=snapshots_seen,
        snapshots_saved=snapshots_saved,
    )


def _append_snapshot(
    snapshots: list[WineRatingSnapshot],
    wine_id: int,
    source: str,
    rating_raw: Any,
) -> None:
    rating_value = parse_rating_value(rating_raw)
    if rating_value is None:
        return
    snapshots.append(
        WineRatingSnapshot(
            wine_id=wine_id,
            source=source,
            rating_value=rating_value,
            rating_raw=rating_raw,
        )
    )
