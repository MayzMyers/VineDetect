"""Apply trusted barcode links from external match candidates."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BarcodeMatchApplyStats:
    candidates_seen: int
    barcode_links_saved: int
    dry_run: bool


def apply_barcode_matches_to_db(
    repo,
    source: str = "roskachestvo",
    min_score: float = 0.88,
    min_gap: float = 0.08,
    limit: int | None = None,
    dry_run: bool = False,
) -> BarcodeMatchApplyStats:
    candidates = repo.get_safe_barcode_match_candidates(
        source=source,
        min_score=min_score,
        min_gap=min_gap,
    )
    if limit is not None and limit > 0:
        candidates = candidates[:limit]

    if dry_run:
        return BarcodeMatchApplyStats(
            candidates_seen=len(candidates),
            barcode_links_saved=0,
            dry_run=True,
        )

    barcode_links_saved = 0
    for candidate in candidates:
        repo.upsert_wine_barcode(
            wine_id=candidate["wine_id"],
            barcode=candidate["barcode"],
            source=candidate["source"],
            source_product_id=candidate.get("source_product_id"),
            confidence=candidate["match_score"],
            match_score=candidate["match_score"],
            score_gap=candidate["score_gap"],
            match_method=candidate["match_method"],
            match_details=candidate.get("match_details"),
        )
        barcode_links_saved += 1

    return BarcodeMatchApplyStats(
        candidates_seen=len(candidates),
        barcode_links_saved=barcode_links_saved,
        dry_run=False,
    )
