"""Phrase-preserving, source-typed OCR features with span-level provenance."""

from collections import Counter, defaultdict
import math
import re
import unicodedata

from ..v8.ocr import CANONICAL, GENERIC, FIELDS, tokens as old_tokens
from ..v5.ocr import translit

ATTRS = ("grape", "color_style", "sweetness", "brut", "vintage")
IDENTITY = ("producer", "product", "other")
# Attribute vocabulary only. No new producer/product aliases.
LEXICAL = {
    "blan": "blanc",
    "nuar": "noir",
    "pino": "pinot",
    "gridzhio": "grigio",
    "gri": "gris",
    "rkaciteli": "rkatsiteli",
}
GENERIC_MORE = GENERIC | {
    "blend",
    "kupazh",
    "sort",
    "sorta",
    "sortov",
    "vinograda",
    "belye",
    "krasnye",
    "white",
    "red",
    "rose",
    "blanc",
    "noir",
    "belyh",
    "krasnyh",
}
GRAPE_PROSE = {
    "blend",
    "kupazh",
    "sort",
    "sorta",
    "sortov",
    "vinograda",
    "smes",
    "drugie",
}
LAT_TO_CYR = str.maketrans("abcehkmoptxy", "авсенкмортху")
CYR_TO_LAT = str.maketrans("авсенкмортху", "abcehkmoptxy")


def word_value(raw):
    word = unicodedata.normalize("NFKC", raw).casefold().replace("ё", "е")
    mixed = bool(re.search("[a-z]", word) and re.search("[а-я]", word))
    if mixed:
        latin = len(re.findall("[a-z]", word))
        cyrillic = len(re.findall("[а-я]", word))
        word = word.translate(LAT_TO_CYR if cyrillic >= latin else CYR_TO_LAT)
    value = translit(word)
    value = CANONICAL.get(value, value)
    return LEXICAL.get(value, value), mixed


def words(text, confidence=1.0, line=None, offset=0):
    out = []
    for match in re.finditer(r"[A-Za-zА-Яа-яЁё0-9]+", text):
        value, mixed = word_value(match.group())
        out.append(
            dict(
                value=value,
                start=offset + match.start(),
                end=offset + match.end(),
                raw=match.group(),
                confidence=float(confidence),
                line=line,
                mixed=mixed,
            )
        )
    return out


def phrase(text):
    return tuple(w["value"] for w in words(text))


# Axis separates color and style, avoiding conflicts such as white vs sparkling.
DEFINITIONS = [
    (
        "sweetness",
        "sweetness",
        "semisweet",
        ("semi-sweet", "semisweet", "полусладкое", "полусладкий"),
    ),
    (
        "sweetness",
        "sweetness",
        "semidry",
        ("semi-dry", "semidry", "полусухое", "полусухой"),
    ),
    ("sweetness", "sweetness", "sweet", ("sweet", "сладкое", "сладкий")),
    ("sweetness", "sweetness", "dry", ("dry", "сухое", "сухой")),
    ("brut", "dosage", "extra_brut", ("extra brut", "экстра брют")),
    ("brut", "dosage", "brut", ("brut", "брют")),
    ("color_style", "style", "blanc_de_noirs", ("blanc de noirs",)),
    ("color_style", "style", "blanc_de_blancs", ("blanc de blancs",)),
    ("color_style", "style", "sparkling", ("sparkling", "игристое", "игристый")),
    ("color_style", "color", "white", ("white", "белое", "белый")),
    ("color_style", "color", "red", ("red", "красное", "красный")),
    ("color_style", "color", "rose", ("rose", "розовое", "розовый")),
    ("color_style", "color", "orange", ("orange", "оранжевое", "оранжевый")),
]


def source_occurrence(field, axis, value, source, text, ws, start, end, typed, rule):
    first, last = ws[start], ws[end - 1]
    return dict(
        field=field,
        axis=axis,
        normalized_value=value,
        catalog_field=source,
        catalog_span=dict(
            start=first["start"],
            end=last["end"],
            text=text[first["start"] : last["end"]],
        ),
        genuinely_typed=typed,
        parser_rule=rule,
    )


def recognize(ws, lexicon):
    """Longest non-overlapping phrase first, including multi-line phrases."""
    hits = []
    i = 0
    while i < len(ws):
        matches = []
        for key, definitions in lexicon.get(ws[i]["value"], []):
            if tuple(w["value"] for w in ws[i : i + len(key)]) == key:
                matches.append((len(key), key, definitions))
        if matches:
            length, key, definitions = max(matches, key=lambda x: (x[0], x[1]))
            for field, axis, value, rule in definitions:
                hits.append(
                    dict(
                        field=field,
                        axis=axis,
                        normalized_value=value,
                        begin=i,
                        finish=i + length,
                        parser_rule=rule,
                    )
                )
            i += length
        else:
            if re.fullmatch(r"(19|20)\d{2}", ws[i]["value"]):
                hits.append(
                    dict(
                        field="vintage",
                        axis="vintage",
                        normalized_value=ws[i]["value"],
                        begin=i,
                        finish=i + 1,
                        parser_rule="four_digit_vintage",
                    )
                )
            i += 1
    return hits


class Parser:
    def __init__(self, rows):
        self.rows = {r["catalog_item_id"]: r for r in rows}
        rules = defaultdict(list)
        for field, axis, value, aliases in DEFINITIONS:
            for alias in aliases:
                item = (field, axis, value, "attribute_phrase")
                if item not in rules[phrase(alias)]:
                    rules[phrase(alias)].append(item)
        self.grape_entries = {}
        self.rejected_grape_entries = []
        for cid, row in self.rows.items():
            entries = []
            text = row.get("grapes", "") or ""
            # List separators only: a multi-word variety is never tokenized into grapes.
            for match in re.finditer(r"[^,;/+]+", text):
                raw = match.group()
                ws = words(raw)
                clean = [w for w in ws if not w["value"].isdigit()]
                values = [w["value"] for w in clean]
                valid = (
                    bool(values)
                    and len(values) <= 4
                    and not set(values) & GRAPE_PROSE
                    and not set(values) <= GENERIC_MORE
                )
                if not valid:
                    self.rejected_grape_entries.append(
                        dict(id=cid, source="grapes", text=raw)
                    )
                    continue
                key = tuple(values)
                value = " ".join(values)
                rules[key].append(("grape", "grape", value, "typed_grape_phrase"))
                entries.append(
                    dict(
                        field="grape",
                        axis="grape",
                        normalized_value=value,
                        catalog_field="grapes",
                        catalog_span=dict(
                            start=match.start(), end=match.end(), text=raw
                        ),
                        genuinely_typed=True,
                        parser_rule="typed_grape_phrase",
                    )
                )
            self.grape_entries[cid] = entries
        self.lexicon = defaultdict(list)
        for key, values in rules.items():
            if key:
                self.lexicon[key[0]].append((key, sorted(set(values))))
        self.expected = {cid: self.catalog(row) for cid, row in self.rows.items()}
        df = Counter(
            value
            for fields in self.expected.values()
            for value in {
                e["normalized_value"] for entries in fields.values() for e in entries
            }
        )
        self.idf = {
            value: math.log((len(rows) + 1) / (count + 1)) / math.log(len(rows) + 1)
            for value, count in df.items()
        }

    def catalog(self, row):
        result = {f: [] for f in FIELDS}
        result["grape"] = self.grape_entries[row["catalog_item_id"]]
        producer_words = set()
        for field in ("winery", "manufacturer", "producer"):
            text = row.get(field, "") or ""
            ws = words(text)
            useful = [w for w in ws if w["value"] not in GENERIC_MORE]
            producer_words.update(w["value"] for w in useful)
            if useful:
                result["producer"].append(
                    dict(
                        field="producer",
                        axis="identity",
                        normalized_value=" ".join(w["value"] for w in useful),
                        catalog_field=field,
                        catalog_span=dict(start=0, end=len(text), text=text),
                        genuinely_typed=True,
                        parser_rule="catalog_producer_phrase",
                    )
                )
        dedicated = {
            "category": ("color_style", "color"),
            "sweetness": ("sweetness", "sweetness"),
            "brut": ("brut", "dosage"),
            "style": ("color_style", "style"),
            "vintage": ("vintage", "vintage"),
        }
        for source, (allowed, axis) in dedicated.items():
            text = str(row.get(source, "") or "")
            ws = words(text)
            for h in recognize(ws, self.lexicon):
                if h["field"] == allowed and h["axis"] == axis:
                    result[allowed].append(
                        source_occurrence(
                            allowed,
                            axis,
                            h["normalized_value"],
                            source,
                            text,
                            ws,
                            h["begin"],
                            h["finish"],
                            True,
                            "typed_catalog_attribute_phrase",
                        )
                    )
        for source, outfield in (("title", "product"), ("official_slug", "other")):
            text = row.get(source, "") or ""
            ws = words(text)
            hits = recognize(ws, self.lexicon)
            excluded = {i for h in hits for i in range(h["begin"], h["finish"])}
            # Titles can supply explicit positive attributes, never typed conflicts.
            if source == "title":
                for h in hits:
                    if h["field"] != "grape":
                        result[h["field"]].append(
                            source_occurrence(
                                h["field"],
                                h["axis"],
                                h["normalized_value"],
                                source,
                                text,
                                ws,
                                h["begin"],
                                h["finish"],
                                False,
                                "untyped_title_attribute_phrase",
                            )
                        )
            chunks = []
            current = []
            for i, w in enumerate(ws):
                if (
                    i in excluded
                    or w["value"] in producer_words | GENERIC_MORE
                    or w["value"].isdigit()
                ):
                    if current:
                        chunks.append(current)
                        current = []
                else:
                    current.append(i)
            if current:
                chunks.append(current)
            for chunk in chunks:
                first, last = chunk[0], chunk[-1]
                value = " ".join(ws[i]["value"] for i in chunk)
                if len(value) < 3:
                    continue
                result[outfield].append(
                    source_occurrence(
                        outfield,
                        "identity",
                        value,
                        source,
                        text,
                        ws,
                        first,
                        last + 1,
                        False,
                        "catalog_" + outfield + "_phrase",
                    )
                )
        return result

    def query(self, ocr):
        text = " ".join(ocr.get("texts", []))
        ws = []
        offset = 0
        for line, (part, confidence) in enumerate(
            zip(ocr.get("texts", []), ocr.get("confidences", []))
        ):
            ws.extend(words(part, confidence, line, offset))
            offset += len(part) + 1
        features = defaultdict(list)
        for h in recognize(ws, self.lexicon):
            features[h["field"]].append(
                self.observation(
                    text,
                    ws,
                    h["begin"],
                    h["finish"],
                    h["normalized_value"],
                    h["axis"],
                    h["parser_rule"],
                )
            )
        return text, ws, features

    @staticmethod
    def observation(text, ws, start, end, value, axis, rule):
        span = ws[start:end]
        return dict(
            normalized_value=value,
            axis=axis,
            ocr_span=dict(
                start=span[0]["start"],
                end=span[-1]["end"],
                text=text[span[0]["start"] : span[-1]["end"]],
                lines=sorted({w["line"] for w in span}),
            ),
            parser_rule=rule
            + (":mixed_script_homoglyph" if any(w["mixed"] for w in span) else ""),
            confidence=min(w["confidence"] for w in span),
            raw_line_confidences=sorted({w["confidence"] for w in span}),
        )

    @staticmethod
    def compatible(observed, expected):
        if observed == expected:
            return True
        # A parent variety is not evidence of a different grape.
        a, b = observed.split(), expected.split()
        return any(a == b[i : i + len(a)] for i in range(len(b) - len(a) + 1)) or any(
            b == a[i : i + len(b)] for i in range(len(a) - len(b) + 1)
        )

    def features(self, ocr, ids):
        text, ws, observed = self.query(ocr)
        query_values = [w["value"] for w in ws]
        out = {}
        for cid in ids:
            fields = {}
            for field in FIELDS:
                expected = self.expected[cid][field]
                observations = list(observed.get(field, [])) if field in ATTRS else []
                if field in IDENTITY:
                    for e in expected:
                        key = tuple(e["normalized_value"].split())
                        for i in range(len(ws) - len(key) + 1):
                            if tuple(query_values[i : i + len(key)]) == key:
                                observations.append(
                                    self.observation(
                                        text,
                                        ws,
                                        i,
                                        i + len(key),
                                        e["normalized_value"],
                                        "identity",
                                        "catalog_" + field + "_phrase",
                                    )
                                )
                matched = set()
                conflicts = set()
                provenance = []
                confidence = {}
                for e in expected:
                    exact = [
                        o
                        for o in observations
                        if o["normalized_value"] == e["normalized_value"]
                    ]
                    if exact:
                        matched.add(e["normalized_value"])
                        for o in exact:
                            confidence[e["normalized_value"]] = max(
                                confidence.get(e["normalized_value"], 0.0),
                                o["confidence"],
                            )
                            provenance.append(
                                dict(
                                    status="match",
                                    ocr=o,
                                    catalog=e,
                                    normalized_value=e["normalized_value"],
                                    confidence=o["confidence"],
                                )
                            )
                    else:
                        provenance.append(
                            dict(
                                status="missing_neutral",
                                ocr=None,
                                catalog=e,
                                normalized_value=e["normalized_value"],
                                confidence=None,
                            )
                        )
                for o in observations:
                    same_axis = [
                        e
                        for e in expected
                        if e["genuinely_typed"] and e["axis"] == o["axis"]
                    ]
                    compatible = any(
                        self.compatible(o["normalized_value"], e["normalized_value"])
                        if field == "grape"
                        else o["normalized_value"] == e["normalized_value"]
                        for e in same_axis
                    )
                    # Conflicting OCR extractions on the same categorical axis abstain.
                    ambiguous = (
                        field != "grape"
                        and len(
                            {
                                v["normalized_value"]
                                for v in observations
                                if v["axis"] == o["axis"]
                            }
                        )
                        > 1
                    )
                    if (
                        field in ATTRS
                        and same_axis
                        and o["confidence"] >= 0.85
                        and not compatible
                        and not ambiguous
                    ):
                        conflicts.add(o["normalized_value"])
                        confidence[o["normalized_value"]] = max(
                            confidence.get(o["normalized_value"], 0.0), o["confidence"]
                        )
                        provenance.append(
                            dict(
                                status="conflict",
                                ocr=o,
                                catalog=same_axis,
                                normalized_value=o["normalized_value"],
                                confidence=o["confidence"],
                            )
                        )
                    elif not any(
                        o["normalized_value"] == e["normalized_value"] for e in expected
                    ):
                        provenance.append(
                            dict(
                                status="observed_neutral",
                                ocr=o,
                                catalog=same_axis or None,
                                normalized_value=o["normalized_value"],
                                confidence=o["confidence"],
                            )
                        )
                if not provenance:
                    provenance.append(
                        dict(
                            status="absent_neutral",
                            ocr=None,
                            catalog=None,
                            normalized_value=None,
                            confidence=None,
                            parser_rule="no_expected_or_observed_value",
                            catalog_sources_considered=(
                                ["grapes"]
                                if field == "grape"
                                else ["winery", "manufacturer", "producer"]
                                if field == "producer"
                                else ["title"]
                                if field == "product"
                                else ["official_slug"]
                                if field == "other"
                                else ["category", "style", "title"]
                                if field == "color_style"
                                else [field, "title"]
                            ),
                        )
                    )
                expected_values = {e["normalized_value"] for e in expected}
                fields[field] = dict(
                    matched=sorted(matched),
                    conflicts=sorted(conflicts),
                    missing=sorted(expected_values - matched),
                    absent=not bool(matched or conflicts),
                    match_weight=sum(self.idf.get(v, 0.0) for v in matched),
                    confidence=confidence,
                    provenance=provenance,
                )
            identity = set().union(*(set(fields[f]["matched"]) for f in IDENTITY))
            out[cid] = dict(
                fields=fields,
                identity=min(1.0, sum(self.idf.get(v, 0.0) for v in identity) / 2),
                attribute_agreement=sum(bool(fields[f]["matched"]) for f in ATTRS) / 5,
                attribute_conflict=sum(bool(fields[f]["conflicts"]) for f in ATTRS) / 5,
                discriminative=sorted(
                    v for v in identity if self.idf.get(v, 0.0) >= 0.45
                ),
                available=bool(old_tokens(ocr.get("text", ""))),
            )
        return out
