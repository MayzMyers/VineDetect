"""Frozen OCR candidate retrieval; title veto lives in text.py."""

import re
import unicodedata
from statistics import mean
from difflib import SequenceMatcher

RU_TO_LAT = {
    "а": "a",
    "б": "b",
    "в": "v",
    "г": "g",
    "д": "d",
    "е": "e",
    "ё": "e",
    "ж": "zh",
    "з": "z",
    "и": "i",
    "й": "i",
    "к": "k",
    "л": "l",
    "м": "m",
    "н": "n",
    "о": "o",
    "п": "p",
    "р": "r",
    "с": "s",
    "т": "t",
    "у": "u",
    "ф": "f",
    "х": "h",
    "ц": "ts",
    "ч": "ch",
    "ш": "sh",
    "щ": "sch",
    "ъ": "",
    "ы": "y",
    "ь": "",
    "э": "e",
    "ю": "yu",
    "я": "ya",
}


def normalize(text):
    text = unicodedata.normalize("NFKC", str(text or "")).casefold()
    text = text.replace("ё", "е")
    text = re.sub("[^0-9a-zа-я]+", " ", text)
    return " ".join(text.split())


def translit(text):
    return "".join((RU_TO_LAT.get(ch, ch) for ch in normalize(text)))


def tokens(text):
    values = set()
    for variant in (normalize(text), translit(text)):
        for token in re.findall("[0-9a-zа-я]+", variant):
            if len(token) >= 3 or re.fullmatch("\\d{4}", token):
                values.add(token)
    return sorted(values)


def aliases(row):
    values = []
    for key in (
        "title",
        "winery",
        "manufacturer",
        "producer",
        "official_slug",
        "officialSlug",
    ):
        value = row.get(key)
        if value:
            values.append(str(value))
    return list(dict.fromkeys(values))


def extract_ocr(results):
    texts = []
    scores = []
    for result in results:
        payload = None
        if hasattr(result, "json"):
            payload = result.json
            if callable(payload):
                payload = payload()
        if payload is None:
            payload = result
        if not isinstance(payload, dict):
            continue
        res = payload.get("res") or payload
        rec_texts = res.get("rec_texts") or []
        rec_scores = res.get("rec_scores") or []
        for index, text in enumerate(rec_texts):
            score = float(rec_scores[index]) if index < len(rec_scores) else 1.0
            if score < 0.35:
                continue
            cleaned = normalize(text)
            if not cleaned:
                continue
            texts.append(str(text))
            scores.append(score)
    return (texts, scores)


def text_candidate_score(ocr_text, item):
    ocr_tokens = tokens(ocr_text)
    candidate_tokens = item["tokens"]
    if not ocr_tokens or not candidate_tokens:
        return (0, 0, 0, 0.0, 0.0)
    matches = []
    exact = 0
    strong = 0
    for candidate_token in candidate_tokens:
        best = 0.0
        for ocr_token in ocr_tokens:
            similarity = SequenceMatcher(None, candidate_token, ocr_token).ratio()
            if similarity > best:
                best = similarity
        matches.append(best)
        if best >= 0.999:
            exact += 1
        if best >= 0.82:
            strong += 1
    matches.sort(reverse=True)
    top3 = mean(matches[:3]) if matches else 0.0
    ocr_years = {
        token for token in ocr_tokens if re.fullmatch("(?:19|20)\\d{2}", token)
    }
    year_match = int(bool(item["years"] & ocr_years))
    joined_ocr = translit(ocr_text)
    char_similarity = 0.0
    for alias in item["aliases"]:
        char_similarity = max(
            char_similarity, SequenceMatcher(None, translit(alias), joined_ocr).ratio()
        )
    return (strong, exact, year_match, top3, char_similarity)


def build_index(catalog):
    index = []
    for row in catalog:
        item_aliases = aliases(row)
        token_set = set()
        for alias in item_aliases:
            token_set.update(tokens(alias))
        index.append(
            {
                "catalog_item_id": int(row["catalog_item_id"]),
                "aliases": item_aliases,
                "tokens": sorted(token_set),
                "years": {t for t in token_set if re.fullmatch(r"(?:19|20)\d{2}", t)},
            }
        )
    return index


def rank_catalog(text, index):
    # No detected text is absence of evidence, not a catalog-order Top1.
    if not tokens(text):
        return []
    ranked = sorted(
        index, key=lambda item: text_candidate_score(text, item), reverse=True
    )
    return [item["catalog_item_id"] for item in ranked[:20]]
