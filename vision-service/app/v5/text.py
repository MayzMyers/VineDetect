"""Ported from frozen simulator c54251c8; thresholds and matching unchanged."""

import re
import unicodedata

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


def text_tokens(text):
    values = set()
    for variant in (normalize(text), translit(text)):
        for token in re.findall("[0-9a-zа-я]+", variant):
            if len(token) >= 3 or re.fullmatch("\\d{4}", token):
                values.add(token)
    return values


def is_year(token):
    return bool(re.fullmatch("(?:19|20)\\d{2}", token))


def ocr_pairwise(text, baseline_title, challenger_title):
    text = str(text or "")
    ocr_tokens = text_tokens(text)
    if not ocr_tokens:
        return {
            "decision": "ABSTAIN",
            "text": text,
            "baselineExact": [],
            "challengerExact": [],
        }
    b = text_tokens(baseline_title)
    c = text_tokens(challenger_title)
    b_unique = b - c
    c_unique = c - b
    b_exact = sorted(b_unique & ocr_tokens)
    c_exact = sorted(c_unique & ocr_tokens)
    b_non_year = [value for value in b_exact if not is_year(value)]
    c_non_year = [value for value in c_exact if not is_year(value)]
    if b_non_year and (not c_non_year):
        decision = "BASELINE_SUPPORT"
    elif c_non_year and (not b_non_year):
        decision = "CHALLENGER_SUPPORT"
    else:
        decision = "ABSTAIN"
    return {
        "decision": decision,
        "text": text,
        "baselineExact": b_exact,
        "challengerExact": c_exact,
        "baselineNonYear": b_non_year,
        "challengerNonYear": c_non_year,
    }
