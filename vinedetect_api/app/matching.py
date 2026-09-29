"""Generate external match candidates between catalogs."""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal
from difflib import SequenceMatcher
from typing import Any

ROSKACHESTVO_SOURCE = "roskachestvo"

YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
STYLE_TOKENS = {
    "\u0431\u0435\u043b\u043e\u0435",
    "\u043a\u0440\u0430\u0441\u043d\u043e\u0435",
    "\u0440\u043e\u0437\u043e\u0432\u043e\u0435",
    "\u0441\u0443\u0445\u043e\u0435",
    "\u043f\u043e\u043b\u0443\u0441\u0443\u0445\u043e\u0435",
    "\u043f\u043e\u043b\u0443\u0441\u043b\u0430\u0434\u043a\u043e\u0435",
    "\u0441\u043b\u0430\u0434\u043a\u043e\u0435",
    "\u0431\u0440\u044e\u0442",
    "\u044d\u043a\u0441\u0442\u0440\u0430",
    "\u0438\u0433\u0440\u0438\u0441\u0442\u043e\u0435",
}
GENERIC_WINE_TOKENS = {
    "\u043c\u0435\u0440\u043b\u043e",
    "\u0448\u0430\u0440\u0434\u043e\u043d\u0435",
    "\u0440\u0438\u0441\u043b\u0438\u043d\u0433",
    "\u0441\u043e\u0432\u0438\u043d\u044c\u043e\u043d",
    "\u043a\u0430\u0431\u0435\u0440\u043d\u0435",
    "\u0444\u0440\u0430\u043d",
    "\u0441\u0430\u043f\u0435\u0440\u0430\u0432\u0438",
    "\u043a\u043e\u043a\u0443\u0440",
    "\u043f\u0438\u043d\u043e",
    "\u043d\u0443\u0430\u0440",
    "\u0433\u0440\u0438",
    "\u0433\u0440\u0438\u0434\u0436\u0438\u043e",
    "\u043c\u0430\u043b\u044c\u0431\u0435\u043a",
    "\u0441\u0438\u0440\u0430",
    "\u0448\u0438\u0440\u0430\u0437",
    "\u043c\u0443\u0441\u043a\u0430\u0442",
    "\u0430\u043b\u0438\u0433\u043e\u0442\u0435",
    "\u0440\u043a\u0430\u0446\u0438\u0442\u0435\u043b\u0438",
    *STYLE_TOKENS,
}
MATCH_STOPWORDS = {
    "\u0440\u043e\u0441\u0441\u0438\u0439\u0441\u043a\u043e\u0435",
    "\u0440\u043e\u0441\u0441\u0438\u0439\u0441\u043a\u0438\u0439",
    "\u0440\u043e\u0441\u0441\u0438\u044f",
    "\u0432\u0438\u043d\u043e",
    "\u0432\u0438\u043d\u043d\u044b\u0439",
    "\u0432\u0438\u043d\u043d\u043e\u0433\u0440\u0430\u0434\u043d\u044b\u0439",
    "\u0437\u0433\u0443",
    "\u0437\u043d\u043c\u043f",
    "\u0437\u0433\u043d\u043c\u043f",
    "\u0437\u0430\u0449\u0438\u0449\u0435\u043d\u043d\u043e\u0433\u043e",
    "\u0433\u0435\u043e\u0433\u0440\u0430\u0444\u0438\u0447\u0435\u0441\u043a\u043e\u0433\u043e",
    "\u0443\u043a\u0430\u0437\u0430\u043d\u0438\u044f",
    "\u043d\u0430\u0438\u043c\u0435\u043d\u043e\u0432\u0430\u043d\u0438\u044f",
    "\u043c\u0435\u0441\u0442\u0430",
    "\u043f\u0440\u043e\u0438\u0441\u0445\u043e\u0436\u0434\u0435\u043d\u0438\u044f",
    "\u0430\u043b\u043a\u043e\u0433\u043e\u043b\u044c\u043d\u0430\u044f",
    "\u043f\u0440\u043e\u0434\u0443\u043a\u0446\u0438\u044f",
    "\u043d\u0430\u043f\u0438\u0442\u043e\u043a",
}
MANUFACTURER_STOPWORDS = MATCH_STOPWORDS | {
    "\u0432\u0438\u043d\u043e\u0434\u0435\u043b\u044c\u043d\u044f",
    "\u0437\u0430\u0432\u043e\u0434",
    "\u043e\u043e\u043e",
    "\u0430\u043e",
    "\u043f\u0430\u043e",
    "\u0437\u0430\u043e",
    "\u0438\u043f",
    "\u043a\u0445",
}


@dataclass(frozen=True)
class WineMatchCandidate:
    wine_id: int
    source: str
    source_product_id: str
    barcode: str | None
    source_name: str
    match_score: Decimal
    match_method: str
    match_details: dict[str, Any]


@dataclass(frozen=True)
class RoskachestvoMatchStats:
    external_products_seen: int
    matches_seen: int
    matches_saved: int


def normalize_match_text(value: str | None) -> str:
    if value is None:
        return ""

    text = value.lower().replace("\u0451", "\u0435")
    text = re.sub(r"[\u2014\u2013-]", " ", text)
    text = "".join(char if char.isalnum() or char.isspace() else " " for char in text)
    return re.sub(r"\s+", " ", text).strip()


def extract_years(value: str | None) -> set[str]:
    return set(YEAR_RE.findall(value or ""))


def tokenize(value: str | None) -> set[str]:
    return {
        token
        for token in normalize_match_text(value).split()
        if len(token) > 1 and token not in MATCH_STOPWORDS
    }


def extract_style_tokens(value: str | None) -> set[str]:
    raw_tokens = {
        token
        for token in normalize_match_text(value).split()
        if len(token) > 1
    }
    return raw_tokens & STYLE_TOKENS


def is_generic_short_title(value: str | None) -> bool:
    tokens = tokenize(value)
    if not tokens:
        return True
    generic_count = len(tokens & GENERIC_WINE_TOKENS)
    if len(tokens) <= 2 and generic_count == len(tokens):
        return True
    return len(tokens) <= 3 and generic_count >= 2


def ratio(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    return SequenceMatcher(None, left, right).ratio()


def token_overlap_score(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def manufacturer_overlap_score(
    source_name: str,
    manufacturer_name: str | None,
) -> float:
    manufacturer_tokens = _manufacturer_tokens(manufacturer_name)
    if not manufacturer_tokens:
        return 0.0

    source_tokens = tokenize(source_name)
    if manufacturer_tokens & source_tokens:
        return 1.0
    return token_overlap_score(source_tokens, manufacturer_tokens)


def score_roskachestvo_to_wine(
    rskrf_product: dict[str, Any],
    wine: dict[str, Any],
) -> tuple[Decimal, str, dict[str, Any]]:
    source_name = _string_or_empty(rskrf_product.get("name"))
    wine_title = _string_or_empty(wine.get("title"))
    manufacturer_name = _string_or_empty(wine.get("manufacturer_name"))
    wine_doc = " ".join(
        _string_or_empty(wine.get(key))
        for key in ("title", "manufacturer_name", "category_name", "region_name")
    )

    source_name_norm = rskrf_product.get("_match_name_norm") or normalize_match_text(
        source_name
    )
    wine_title_norm = wine.get("_match_title_norm") or normalize_match_text(wine_title)
    wine_doc_norm = wine.get("_match_doc_norm") or normalize_match_text(wine_doc)

    source_tokens = rskrf_product.get("_match_tokens") or tokenize(source_name_norm)
    wine_doc_tokens = wine.get("_match_doc_tokens") or tokenize(wine_doc_norm)
    wine_title_tokens = wine.get("_match_title_tokens") or tokenize(wine_title_norm)

    title_ratio = ratio(source_name_norm, wine_title_norm)
    doc_ratio = ratio(source_name_norm, wine_doc_norm)
    token_score = token_overlap_score(source_tokens, wine_doc_tokens)
    substring_score = _substring_score(source_name_norm, wine_title_norm)
    manufacturer_score = manufacturer_overlap_score(source_name, manufacturer_name)

    source_years = rskrf_product.get("_match_years") or extract_years(source_name)
    wine_years = wine.get("_match_years") or extract_years(wine_doc)
    year_score = _evidence_score(source_years, wine_years)
    year_mismatch = bool(source_years and wine_years and not source_years & wine_years)

    source_style_tokens = (
        rskrf_product.get("_match_style_tokens") or extract_style_tokens(source_name)
    )
    wine_style_tokens = wine.get("_match_style_tokens") or extract_style_tokens(
        wine_doc
    )
    style_score = _evidence_score(source_style_tokens, wine_style_tokens)
    style_mismatch = bool(
        source_style_tokens
        and wine_style_tokens
        and not source_style_tokens & wine_style_tokens
    )

    score = (
        title_ratio * 0.25
        + doc_ratio * 0.15
        + token_score * 0.22
        + substring_score * 0.12
        + manufacturer_score * 0.28
        + max(year_score, 0.0) * 0.05
        + max(style_score, 0.0) * 0.10
    )
    if year_score < 0:
        score -= 0.08
    if style_score < 0:
        score -= 0.06

    generic_short_title = is_generic_short_title(wine_title)
    applied_caps: list[str] = []
    source_token_count = len(source_tokens)
    title_token_count = len(wine_title_tokens)

    if year_mismatch:
        score = _apply_cap(score, 0.69, "year_mismatch", applied_caps)
    if style_mismatch:
        score = _apply_cap(score, 0.74, "style_mismatch", applied_caps)
    if generic_short_title and manufacturer_score < 0.5:
        score = _apply_cap(
            score,
            0.69,
            "generic_short_title_without_manufacturer",
            applied_caps,
        )
    if (
        generic_short_title
        and manufacturer_score < 0.5
        and year_score <= 0
        and style_score <= 0
    ):
        score = _apply_cap(
            score,
            0.62,
            "generic_short_title_without_evidence",
            applied_caps,
        )
    if source_token_count >= 6 and title_token_count <= 2 and manufacturer_score < 0.5:
        score = _apply_cap(score, 0.69, "long_source_short_title", applied_caps)
    if (
        generic_short_title
        and manufacturer_score >= 0.5
        and year_score <= 0
        and style_score <= 0
    ):
        score = _apply_cap(
            score,
            0.82,
            "generic_short_title_manufacturer_only",
            applied_caps,
        )

    score = max(0.0, min(1.0, score))
    match_score = Decimal(str(round(score, 4)))
    details = {
        "title_ratio": round(title_ratio, 4),
        "doc_ratio": round(doc_ratio, 4),
        "token_score": round(token_score, 4),
        "substring_score": round(substring_score, 4),
        "manufacturer_score": round(manufacturer_score, 4),
        "year_score": year_score,
        "style_score": style_score,
        "source_years": sorted(source_years),
        "wine_years": sorted(wine_years),
        "source_style_tokens": sorted(source_style_tokens),
        "wine_style_tokens": sorted(wine_style_tokens),
        "is_generic_short_title": generic_short_title,
        "applied_caps": applied_caps,
        "final_score": float(match_score),
    }
    return match_score, _match_method(score), details


def find_roskachestvo_matches(
    rskrf_product: dict[str, Any],
    wines: list[dict[str, Any]],
    top_k: int = 5,
    min_score: float = 0.55,
) -> list[WineMatchCandidate]:
    if top_k <= 0:
        return []

    candidates: list[WineMatchCandidate] = []
    for wine in _prefilter_wines(rskrf_product, wines, top_k=top_k):
        match_score, match_method, match_details = score_roskachestvo_to_wine(
            rskrf_product,
            wine,
        )
        if float(match_score) < min_score:
            continue

        candidates.append(
            WineMatchCandidate(
                wine_id=int(wine["id"]),
                source=ROSKACHESTVO_SOURCE,
                source_product_id=str(rskrf_product["rskrf_product_id"]),
                barcode=_optional_string(rskrf_product.get("barcode")),
                source_name=source_name_from_product(rskrf_product),
                match_score=match_score,
                match_method=match_method,
                match_details=match_details,
            )
        )

    candidates.sort(key=lambda candidate: (-candidate.match_score, candidate.wine_id))
    return candidates[:top_k]


def match_roskachestvo_to_wines(
    repo,
    top_k: int = 5,
    min_score: float = 0.55,
    limit: int | None = None,
    reset: bool = False,
) -> RoskachestvoMatchStats:
    if reset:
        repo.clear_external_matches(source=ROSKACHESTVO_SOURCE)

    wines = [
        _prepare_wine_for_matching(wine)
        for wine in repo.get_wines_for_external_matching()
    ]
    products = [
        _prepare_product_for_matching(product)
        for product in repo.get_roskachestvo_products_for_matching(limit=limit)
    ]

    matches_seen = 0
    matches_saved = 0
    for product in products:
        candidates = find_roskachestvo_matches(
            product,
            wines,
            top_k=top_k,
            min_score=min_score,
        )
        matches_seen += len(candidates)
        for candidate in candidates:
            repo.upsert_external_match(
                wine_id=candidate.wine_id,
                source=candidate.source,
                source_product_id=candidate.source_product_id,
                barcode=candidate.barcode,
                source_name=candidate.source_name,
                match_score=candidate.match_score,
                match_method=candidate.match_method,
                match_details=candidate.match_details,
            )
            matches_saved += 1

    return RoskachestvoMatchStats(
        external_products_seen=len(products),
        matches_seen=matches_seen,
        matches_saved=matches_saved,
    )


def source_name_from_product(product: dict[str, Any]) -> str:
    return _string_or_empty(product.get("name"))


def _match_method(score: float) -> str:
    if score >= 0.90:
        return "high_confidence_text"
    if score >= 0.78:
        return "medium_confidence_text"
    if score >= 0.65:
        return "low_confidence_text"
    return "weak_text"


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _prepare_product_for_matching(product: dict[str, Any]) -> dict[str, Any]:
    prepared = dict(product)
    name = _string_or_empty(prepared.get("name"))
    name_norm = normalize_match_text(name)
    prepared["_match_name_norm"] = name_norm
    prepared["_match_tokens"] = tokenize(name_norm)
    prepared["_match_signal_tokens"] = _signal_tokens(prepared["_match_tokens"])
    prepared["_match_years"] = extract_years(name)
    prepared["_match_style_tokens"] = extract_style_tokens(name)
    return prepared


def _prepare_wine_for_matching(wine: dict[str, Any]) -> dict[str, Any]:
    prepared = dict(wine)
    title = _string_or_empty(prepared.get("title"))
    doc = " ".join(
        _string_or_empty(prepared.get(key))
        for key in ("title", "manufacturer_name", "category_name", "region_name")
    )
    title_norm = normalize_match_text(title)
    doc_norm = normalize_match_text(doc)
    prepared["_match_title_norm"] = title_norm
    prepared["_match_doc_norm"] = doc_norm
    prepared["_match_title_tokens"] = tokenize(title_norm)
    prepared["_match_doc_tokens"] = tokenize(doc_norm)
    prepared["_match_signal_tokens"] = _signal_tokens(prepared["_match_doc_tokens"])
    prepared["_match_years"] = extract_years(doc)
    prepared["_match_style_tokens"] = extract_style_tokens(doc)
    return prepared


def _string_or_empty(value: Any) -> str:
    if value is None:
        return ""
    return str(value)


def _signal_tokens(tokens: set[str]) -> set[str]:
    return tokens - STYLE_TOKENS - MATCH_STOPWORDS


def _manufacturer_tokens(value: str | None) -> set[str]:
    return tokenize(value) - MANUFACTURER_STOPWORDS - STYLE_TOKENS


def _evidence_score(left: set[str], right: set[str]) -> float:
    if left and right:
        return 1.0 if left & right else -0.5
    return 0.0


def _apply_cap(
    score: float,
    cap: float,
    reason: str,
    applied_caps: list[str],
) -> float:
    applied_caps.append(reason)
    return min(score, cap)


def _prefilter_wines(
    rskrf_product: dict[str, Any],
    wines: list[dict[str, Any]],
    top_k: int,
) -> list[dict[str, Any]]:
    source_name_norm = rskrf_product.get("_match_name_norm") or normalize_match_text(
        _string_or_empty(rskrf_product.get("name"))
    )
    source_signal_tokens = rskrf_product.get("_match_signal_tokens") or _signal_tokens(
        tokenize(source_name_norm)
    )
    scored_wines: list[tuple[float, int, dict[str, Any]]] = []
    for wine in wines:
        wine_title_norm = wine.get("_match_title_norm") or normalize_match_text(
            _string_or_empty(wine.get("title"))
        )
        wine_signal_tokens = wine.get("_match_signal_tokens") or _signal_tokens(
            wine.get("_match_doc_tokens") or tokenize(wine_title_norm)
        )
        cheap_score = token_overlap_score(source_signal_tokens, wine_signal_tokens)
        cheap_score += _substring_score(source_name_norm, wine_title_norm) * 0.5
        if cheap_score <= 0:
            continue
        scored_wines.append((cheap_score, int(wine["id"]), wine))

    if not scored_wines:
        return wines

    scored_wines.sort(key=lambda item: (-item[0], item[1]))
    limit = max(top_k * 40, 180)
    return [wine for _score, _wine_id, wine in scored_wines[:limit]]


def _substring_score(source_name_norm: str, wine_title_norm: str) -> float:
    if not source_name_norm or not wine_title_norm:
        return 0.0
    if source_name_norm == wine_title_norm:
        return 1.0
    if source_name_norm in wine_title_norm or wine_title_norm in source_name_norm:
        return 0.75 if is_generic_short_title(wine_title_norm) else 0.85
    return 0.0
