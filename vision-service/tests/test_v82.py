"""Exact frozen failure fixtures plus global phrase/typing invariants."""

import json
from pathlib import Path
import pytest

from app.v82.parser import Parser

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures/v82_parser_regressions.json").read_text()
)


def ocr(text, confidence=0.99):
    return dict(text=text, texts=[text], confidences=[confidence])


@pytest.fixture
def parser():
    return Parser(FIXTURE["catalog"])


def test_exact_semi_sweet_never_becomes_sweet(parser):
    feature = parser.features(FIXTURE["semi_sweet"]["ocr"], [1907])[1907]
    f = feature["fields"]["sweetness"]
    assert f["matched"] == ["semisweet"] and f["conflicts"] == []
    span = next(p["ocr"] for p in f["provenance"] if p["status"] == "match")
    assert span["ocr_span"]["text"] == "SEMI-SWEET"
    assert span["confidence"] == 0.9945945739746094


def test_exact_white_blend_does_not_match_white_grape_fragment(parser):
    features = parser.features(FIXTURE["white_blend"]["ocr"], [625, 626])
    for cid in (625, 626):
        assert features[cid]["fields"]["grape"]["matched"] == []
        assert features[cid]["fields"]["grape"]["conflicts"] == []
    assert {e["normalized_value"] for e in parser.expected[626]["grape"]} == {
        "muskat white"
    }


def test_exact_store_rkatsiteli_typed_match(parser):
    f = parser.features(FIXTURE["rkatsiteli"]["ocr"], [1635])[1635]["fields"]["grape"]
    assert f["matched"] == ["rkatsiteli"] and f["conflicts"] == []
    p = next(p for p in f["provenance"] if p["status"] == "match")
    assert p["ocr"]["ocr_span"]["text"] == "РКАЦИТЕЛИ"
    assert p["catalog"]["catalog_field"] == "grapes" and p["catalog"]["genuinely_typed"]
    assert p["confidence"] == 0.9471758604049683


def test_fanagoria_brut_semisweet_title_is_positive_but_not_typed_conflict(parser):
    features = parser.features(ocr("FANAGORIA SEMI-SWEET"), [1908, 1909])
    assert features[1909]["fields"]["sweetness"]["matched"] == ["semisweet"]
    assert features[1908]["fields"]["sweetness"]["matched"] == []
    assert features[1908]["fields"]["brut"]["conflicts"] == []
    assert features[1909]["fields"]["sweetness"]["conflicts"] == []
    assert not any(e["genuinely_typed"] for e in parser.expected[1908]["brut"])


def test_exact_incomplete_low_confidence_mixed_riesling_stays_unknown(parser):
    features = parser.features(FIXTURE["mixed_riesling"]["ocr"], [1611, 1808])
    for cid in (1611, 1808):
        assert features[cid]["fields"]["grape"]["matched"] == []
        assert features[cid]["fields"]["grape"]["conflicts"] == []


def test_global_exact_homoglyph_repair_and_typed_conflict(parser):
    features = parser.features(ocr("PИCЛИHГ"), [1611, 1808])
    assert features[1611]["fields"]["grape"]["matched"] == ["riesling"]
    assert features[1808]["fields"]["grape"]["conflicts"] == ["riesling"]
    features = parser.features(ocr("SАUVIGNОN BLАNC"), [1611, 1808])
    assert features[1808]["fields"]["grape"]["matched"] == ["sauvignon blanc"]
    assert features[1611]["fields"]["grape"]["conflicts"] == ["sauvignon blanc"]


@pytest.mark.parametrize(
    "text,field,value",
    [
        ("SEMI-DRY", "sweetness", "semidry"),
        ("EXTRA BRUT", "brut", "extra_brut"),
        ("BLANC DE NOIRS", "color_style", "blanc_de_noirs"),
        ("BLANC DE BLANCS", "color_style", "blanc_de_blancs"),
    ],
)
def test_longest_attribute_phrase_prevents_component_leakage(
    parser, text, field, value
):
    _, _, observed = parser.query(ocr(text))
    assert [h["normalized_value"] for h in observed[field]] == [value]
    if "BLANC DE" in text:
        assert not observed.get("grape")


def test_multiline_phrase_confidence_and_span(parser):
    query = dict(text="EXTRA BRUT", texts=["EXTRA", "BRUT"], confidences=[0.91, 0.88])
    _, _, observed = parser.query(query)
    hit = observed["brut"][0]
    assert hit["normalized_value"] == "extra_brut"
    assert hit["confidence"] == 0.88 and hit["ocr_span"]["lines"] == [0, 1]


def test_typed_conflict_confidence_and_missing_neutral():
    row = dict(
        catalog_item_id=1,
        title="Example wine",
        grapes="Шардоне",
        category="Белое",
        sweetness="semi-dry",
        brut="brut",
    )
    parser = Parser([row])
    for text, conf in [("", 0.99), ("unrelated label", 0.99), ("semi-sweet", 0.70)]:
        assert (
            parser.features(ocr(text, conf), [1])[1]["fields"]["sweetness"]["conflicts"]
            == []
        )
    f = parser.features(ocr("semi-sweet extra brut"), [1])[1]["fields"]
    assert f["sweetness"]["conflicts"] == ["semisweet"]
    assert f["brut"]["conflicts"] == ["extra_brut"]


def test_grape_generic_descriptions_and_title_not_typed():
    parser = Parser(
        [
            dict(
                catalog_item_id=1,
                title="Chardonnay White Blend",
                grapes="Белые сорта винограда",
                category="Белое",
            )
        ]
    )
    f = parser.features(ocr("WHITE BLEND"), [1])[1]["fields"]["grape"]
    assert f["matched"] == [] and f["conflicts"] == []
    assert parser.expected[1]["grape"] == []


def test_catalog_product_phrase_and_provenance(parser):
    f = parser.features(ocr("GRAND JETE BLANC DE BLANCS"), [263])[263]["fields"]
    assert f["product"]["matched"] == ["grand jete"]
    assert f["color_style"]["matched"] == ["blanc_de_blancs"]
    for field in f.values():
        assert field["provenance"]
        for p in field["provenance"]:
            assert {
                "status",
                "ocr",
                "catalog",
                "normalized_value",
                "confidence",
            } <= p.keys()
            if p["ocr"]:
                assert {
                    "ocr_span",
                    "parser_rule",
                    "confidence",
                    "raw_line_confidences",
                } <= p["ocr"].keys()


def test_partial_multiword_grape_does_not_create_conflict():
    parser = Parser(
        [
            dict(catalog_item_id=1, title="A", grapes="Каберне Совиньон"),
            dict(catalog_item_id=2, title="B", grapes="Совиньон"),
        ]
    )
    features = parser.features(ocr("SAUVIGNON"), [1, 2])
    assert features[1]["fields"]["grape"]["conflicts"] == []
    assert features[2]["fields"]["grape"]["matched"] == ["sauvignon"]
