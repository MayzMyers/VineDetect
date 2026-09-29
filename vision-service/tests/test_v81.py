"""Scoring invariants for the predeclared, offline-only V8.1 experiment."""

from copy import deepcopy
import numpy as np

from app.v8.config import Config
from app.v8.ocr import FIELDS
from app.v8.rerank import rank
from app.v81.scorer import Scoring, grid, prepare, ranking, fit_anchors


def fixture():
    fields = {
        k: dict(matched=[], missing=[], conflicts=[], match_weight=0.0, absent=True)
        for k in FIELDS
    }
    trace = dict(
        ocr=dict(
            text="BRAND CHARDONNAY",
            texts=["BRAND", "CHARDONNAY"],
            confidences=[0.99, 0.95],
        ),
        sources={
            s: [dict(id=1, rank=1, score=0.8), dict(id=2, rank=2, score=0.7)]
            for s in ("siglip", "dino", "label_siglip")
        },
        evidence={},
    )
    for cid in (1, 2):
        f = deepcopy(fields)
        f["producer"].update(matched=["brand"], absent=False, match_weight=0.5)
        trace["evidence"][str(cid)] = dict(
            ocr=dict(
                fields=f,
                identity=0.25,
                attribute_agreement=0.0,
                attribute_conflict=0.0,
                available=True,
            ),
            geometry=dict(available=False),
        )
    return trace


def test_legacy_exact_and_uniform_permutation():
    trace = fixture()
    config = Config(
        ks=20,
        kd=20,
        ko=3,
        kl=15,
        max_pool_size=0,
        weights=(1.0, 0.6, 0.0, 0.6, 0.05),
        dino_weight=0.5,
    )
    old = rank([dict(id=1), dict(id=2)], trace["evidence"], trace["sources"], config)
    expected = [(r["id"], r["score"], r["contributions"]) for r in old]
    for ids in ([1, 2], [2, 1]):
        new = ranking(prepare(trace, ids, dict(brand=0.5)), Scoring(), {})
        assert [(r["id"], r["score"], r["contributions"]) for r in new] == expected


def test_rank_free_ignores_rank_with_equal_cosines():
    trace = fixture()
    for rows in trace["sources"].values():
        rows[1]["score"] = rows[0]["score"]
    p = prepare(trace, [1, 2], dict(brand=0.5))
    legacy = ranking(p, Scoring(), {})
    rankfree = ranking(p, Scoring(semantic="minmax"), {})
    assert legacy[0]["score"] > legacy[1]["score"]
    assert rankfree[0]["score"] == rankfree[1]["score"]


def test_missing_is_not_conflict_and_explicit_conflict_needs_confidence():
    trace = fixture()
    trace["evidence"]["2"]["ocr"]["fields"]["grape"].update(
        conflicts=["chardonnay"], missing=["riesling"]
    )
    c = Scoring(ocr="structured", attribute=0.4, conflict=1.0)
    rows = {r["id"]: r for r in ranking(prepare(trace, [1, 2], dict(brand=0.5)), c, {})}
    assert rows[1]["contributions"]["grape_conflict"] == 0
    assert rows[2]["contributions"]["grape_conflict"] < 0
    trace["ocr"]["confidences"][1] = 0.6
    rows = {r["id"]: r for r in ranking(prepare(trace, [1, 2], dict(brand=0.5)), c, {})}
    assert rows[2]["contributions"]["grape_conflict"] == 0


def test_family_attenuation_is_uniform_and_generic_is_zero():
    trace = fixture()
    for evidence in trace["evidence"].values():
        evidence["ocr"]["fields"]["producer"]["matched"].append("wine")
    trace["ocr"]["texts"].append("WINE")
    trace["ocr"]["confidences"].append(1.0)
    p = prepare(trace, [1, 2], dict(brand=0.5, wine=1.0))
    a = ranking(p, Scoring(ocr="structured", attribute=0.4, conflict=1.0), {})
    b = ranking(p, Scoring(ocr="shared_family", attribute=0.4, conflict=1.0), {})
    for first, second in zip(a, b):
        assert first["contributions"]["producer_family_match"] == 0.5 * 0.99 / 2 * 0.6
        assert np.isclose(
            second["contributions"]["producer_family_match"],
            first["contributions"]["producer_family_match"] / np.sqrt(2),
        )
    assert a[0]["id"] == b[0]["id"]


def test_calibration_only_uses_supplied_training_records_and_grid_is_fixed():
    train = fixture()
    held = deepcopy(train)
    held["sources"]["siglip"][0]["score"] = 100.0
    anchors = fit_anchors([train])
    assert anchors["siglip"][1] <= 0.8
    assert fit_anchors([train, held])["siglip"][1] > 0.8
    assert len(grid()) == 102
    assert len({c.key for c in grid()}) == 102
