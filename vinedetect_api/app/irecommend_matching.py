"""Conservative, deterministic IRecommend matching over in-memory catalog rows."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any, Literal

from app.matching import (
    GENERIC_WINE_TOKENS,
    MANUFACTURER_STOPWORDS,
    extract_years,
    normalize_match_text,
    ratio,
    token_overlap_score,
)

if TYPE_CHECKING:
    from app.irecommend import IRecommendProduct

MatchStatus = Literal["matched", "needs_review", "unmatched"]
MATCH_THRESHOLD = 0.85
REVIEW_THRESHOLD = 0.55
AMBIGUITY_MARGIN = 0.08

_TRANSLITERATION = str.maketrans(
    dict(
        zip(
            "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
            (
                "a",
                "b",
                "v",
                "g",
                "d",
                "e",
                "e",
                "zh",
                "z",
                "i",
                "i",
                "k",
                "l",
                "m",
                "n",
                "o",
                "p",
                "r",
                "s",
                "t",
                "u",
                "f",
                "kh",
                "ts",
                "ch",
                "sh",
                "shch",
                "",
                "y",
                "",
                "e",
                "yu",
                "ya",
            ),
            strict=True,
        )
    )
)
# Explicit linguistic aliases, not catalog/product IDs or series-specific rules.
_ALIASES = {
    "fanagoriya": "fanagoria",
    "merlot": "merlo",
    "chardonnay": "shardone",
    "cabernet": "kaberne",
    "sauvignon": "sovinon",
    "pinot": "pino",
    "noir": "nuar",
    "riesling": "risling",
    "syrah": "sira",
    "shiraz": "shiraz",
    "brut": "bryut",
    "extra": "ekstra",
    "red": "krasnoe",
    "krasnyi": "krasnoe",
    "white": "beloe",
    "belyi": "beloe",
    "rose": "rozovoe",
    "rozovyi": "rozovoe",
    "dry": "suhoe",
    "sukhoe": "suhoe",
    "sukhoi": "suhoe",
    "sparkling": "igristoe",
}
_STYLE_GROUPS = {
    "color": {"krasnoe", "beloe", "rozovoe"},
    "sugar": {"suhoe", "polusukhoe", "polusladkoe", "sladkoe", "bryut"},
    "kind": {"igristoe"},
}


def _tokens(value: str | None) -> set[str]:
    return {
        _ALIASES.get(token, token)
        for token in normalize_match_text(value).translate(_TRANSLITERATION).split()
        if not token.isdigit()
    }


_GENERIC = _tokens(" ".join(GENERIC_WINE_TOKENS | MANUFACTURER_STOPWORDS)) | {
    "wine",
    "winery",
    "red",
    "white",
    "dry",
    "table",
    "stolovoe",
}
_GRAPES = _tokens(
    "Мерло Шардоне Рислинг Совиньон Каберне Фран Саперави Кокур Пино Нуар "
    "Гри Гриджио Мальбек Сира Шираз Мускат Алиготе Ркацители Менье"
)


@dataclass(frozen=True)
class IRecommendCatalogCandidate:
    catalog_item_id: int
    official_slug: str
    score: float
    status: MatchStatus
    evidence: dict[str, Any]


@dataclass(frozen=True)
class IRecommendMatchResult:
    status: MatchStatus
    candidates: list[IRecommendCatalogCandidate]


def _status(score: float) -> MatchStatus:
    if score >= MATCH_THRESHOLD:
        return "matched"
    return "needs_review" if score >= REVIEW_THRESHOLD else "unmatched"


def _style_evidence(source: set[str], catalog: set[str]) -> tuple[float, list[str]]:
    agreements = 0
    conflicts = []
    for dimension, vocabulary in _STYLE_GROUPS.items():
        left, right = source & vocabulary, catalog & vocabulary
        if not left or not right:
            continue
        if left == right:
            agreements += 1
        else:
            conflicts.append(dimension)
    if conflicts:
        return -1.0, conflicts
    return (1.0 if agreements else 0.0), []


def _years(year_candidates: Iterable[str]) -> set[str]:
    if isinstance(year_candidates, str):
        raise ValueError("year_candidates must be an iterable of year strings")
    years = set(year_candidates)
    if any(
        not isinstance(year, str) or not re.fullmatch(r"(19|20)[0-9]{2}", year)
        for year in years
    ):
        raise ValueError("year_candidates must contain four-digit year strings")
    return years


def score_irecommend_to_catalog(
    product: IRecommendProduct | Mapping[str, Any],
    catalog_item: Mapping[str, Any],
    *,
    year_candidates: Iterable[str] = (),
) -> IRecommendCatalogCandidate:
    """Score one pair. A matched pair remains provisional until ranked for ambiguity.

    Pass review.vintage_candidates explicitly; publication dates and review prose
    are never inspected here. Description is intentionally excluded.
    """

    def source(field: str) -> str:
        value = (
            product.get(field)
            if isinstance(product, Mapping)
            else getattr(product, field, None)
        )
        return str(value or "")

    title = source("title")
    official_title = str(catalog_item.get("title") or "")
    official_slug = str(catalog_item["official_slug"])
    source_brand = _tokens(source("brand")) - _GENERIC
    catalog_brand = _tokens(catalog_item.get("winery")) - _GENERIC
    catalog_grapes = _tokens(catalog_item.get("grapes")) - _GENERIC | (
        _tokens(catalog_item.get("grapes")) & _GRAPES
    )
    grape_vocabulary = _GRAPES | catalog_grapes
    source_title = _tokens(title) - source_brand
    catalog_title = _tokens(official_title) - catalog_brand
    catalog_name = (_tokens(official_slug) | catalog_title) - catalog_brand
    source_identity = source_title - _GENERIC - grape_vocabulary
    catalog_identity = catalog_name - _GENERIC - grape_vocabulary
    missing = source_identity - catalog_identity
    conflicting = catalog_identity - source_identity
    identity_score = token_overlap_score(source_identity, catalog_identity)
    title_score = ratio(
        " ".join(sorted(source_title - _GENERIC)),
        " ".join(sorted(catalog_title - _GENERIC)),
    )
    token_score = token_overlap_score(source_title - _GENERIC, catalog_name - _GENERIC)
    winery_score = token_overlap_score(source_brand, catalog_brand)
    winery_conflict = bool(source_brand and catalog_brand and not winery_score)
    source_grapes = _tokens(title) & grape_vocabulary
    grape_score = token_overlap_score(source_grapes, catalog_grapes)
    grape_conflict = bool(source_grapes and catalog_grapes and not grape_score)
    style_score, style_conflicts = _style_evidence(
        _tokens(" ".join((title, source("beverage_type")))),
        _tokens(
            " ".join(
                (official_title, official_slug, str(catalog_item.get("category") or ""))
            )
        ),
    )
    source_years = extract_years(title) | _years(year_candidates)
    catalog_years = extract_years(" ".join((official_title, official_slug)))
    year_score = 0
    if source_years and catalog_years:
        year_score = 1 if source_years & catalog_years else -1

    score = (
        0.55 * identity_score
        + 0.15 * title_score
        + 0.10 * token_score
        + 0.10 * winery_score
        + 0.05 * grape_score
        + 0.05 * max(style_score, 0)
    )
    # A matching year can only support an already exact, non-generic identity.
    year_bonus = 0.03 if year_score == 1 and identity_score == 1 else 0.0
    score += year_bonus
    if year_score == -1:
        score -= 0.12
    if style_conflicts:
        score -= 0.20
    caps = []

    def cap(limit: float, reason: str) -> None:
        nonlocal score
        score = min(score, limit)
        caps.append(reason)

    if not source_identity or not catalog_identity:
        cap(0.49, "missing_discriminative_identity")
    elif missing or conflicting:
        cap(
            0.49 if not source_identity & catalog_identity else 0.79,
            "conflicting_product_identity",
        )
    if winery_conflict:
        cap(0.49, "winery_conflict")
    elif winery_score < 1:
        cap(0.79, "winery_not_confirmed")
    if grape_conflict:
        cap(0.49, "grape_conflict")
    if style_conflicts:
        cap(0.49, "style_conflict")
    if year_score == -1:
        cap(0.79, "year_conflict")

    score = round(max(0.0, min(1.0, score)), 4)
    evidence = {
        "title_score": round(title_score, 4),
        "token_score": round(token_score, 4),
        "winery_score": round(winery_score, 4),
        "discriminative_score": round(identity_score, 4),
        "grape_score": round(grape_score, 4),
        "style_score": style_score,
        "style_conflicts": style_conflicts,
        "year_score": year_score,
        "year_bonus": year_bonus,
        "source_years": sorted(source_years),
        "catalog_years": sorted(catalog_years),
        "source_discriminative_tokens": sorted(source_identity),
        "catalog_discriminative_tokens": sorted(catalog_identity),
        "missing_discriminative_tokens": sorted(missing),
        "conflicting_discriminative_tokens": sorted(conflicting),
        "applied_caps": caps,
        "final_score": score,
    }
    return IRecommendCatalogCandidate(
        catalog_item_id=int(catalog_item["id"]),
        official_slug=official_slug,
        score=score,
        status=_status(score),
        evidence=evidence,
    )


def find_irecommend_matches(
    product: IRecommendProduct | Mapping[str, Any],
    catalog_items: Iterable[Mapping[str, Any]],
    *,
    year_candidates: Iterable[str] = (),
    top_k: int = 5,
) -> IRecommendMatchResult:
    """Rank the complete pool before slicing. Weak candidates remain diagnostic.

    Only an unambiguous top candidate may be matched. Duplicate catalog IDs
    are rejected rather than hiding contradictory rows or inflating ambiguity.
    Thresholds are fixed conservative heuristics, not calibrated probabilities.
    """
    if isinstance(top_k, bool) or not isinstance(top_k, int) or top_k < 0:
        raise ValueError("top_k must be a non-negative integer")
    years = _years(year_candidates)
    if top_k == 0:
        return IRecommendMatchResult("unmatched", [])
    candidates = [
        score_irecommend_to_catalog(product, row, year_candidates=years)
        for row in catalog_items
    ]
    if len({c.catalog_item_id for c in candidates}) != len(candidates):
        raise ValueError("Duplicate catalog_item_id in candidate pool")
    candidates.sort(key=lambda c: (-c.score, c.catalog_item_id))
    if not candidates:
        return IRecommendMatchResult("unmatched", [])
    margin = (
        round(candidates[0].score - candidates[1].score, 4)
        if len(candidates) > 1
        else None
    )
    ambiguous = margin is not None and margin < AMBIGUITY_MARGIN
    ranked = []
    for index, candidate in enumerate(candidates):
        status = candidate.status
        reasons = []
        if status == "matched" and (index > 0 or ambiguous):
            status = "needs_review"
            reasons.append(
                "ambiguous_top_candidates" if ambiguous else "not_top_candidate"
            )
        evidence = {
            **candidate.evidence,
            "score_margin": margin if index == 0 else None,
            "decision_reasons": reasons,
        }
        ranked.append(replace(candidate, status=status, evidence=evidence))
    return IRecommendMatchResult(ranked[0].status, ranked[:top_k])
