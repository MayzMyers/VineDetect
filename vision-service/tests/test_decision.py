import hashlib
import itertools
import json
from pathlib import Path

import pytest

from app.v5.decision import cross_view_candidates, decide, frozen_v3, primary_gate
from app.v5.text import normalize, ocr_pairwise

FIXTURES = Path(__file__).parent / "fixtures"
FROZEN = json.loads((FIXTURES / "decision-simulator.json").read_text())["rows"]
VIEWS = json.loads((FIXTURES / "view-ranks.json").read_text())


def ev(ocr="ABSTAIN", dino=None, support=False, veto=False):
    return {
        "ocr": {"decision": ocr},
        "dinoRank": dino,
        "geometry": {"available": True, "strictVeto": veto, "softSupport": support},
    }


def views(full=(1, 2), bottle=(2, 1), label=(2, 1)):
    return {
        name: [{"catalogItemId": cid, "rank": i + 1} for i, cid in enumerate(ids)]
        for name, ids in (("full", full), ("bottle", bottle), ("label", label))
    }


def test_fixture_is_unmodified():
    assert hashlib.sha256(
        (FIXTURES / "decision-simulator.json").read_bytes()
    ).hexdigest() == (
        "110e0b4cd44a19cb193d6246e0075d7e033d931a7de9fc5f4649f93bc39cfa82"
    )


@pytest.mark.parametrize("row", FROZEN, ids=lambda r: r["set"] + "/" + r["filename"])
def test_frozen_snapshot_replay(row):
    """Replay recorded evidence with the original view ranks; no photo inference."""
    evidence = row["evidence"]

    def evidence_for(cid):
        return evidence if cid == row["proposal"] and evidence else ev()

    dino = [row["proposal"]] if evidence and evidence["dinoRank"] == 1 else []
    ocr = [row["proposal"]] if evidence and evidence["ocrTop5"] else []
    result = decide(
        row["baseline"],
        row["v3"],
        VIEWS[row["set"] + "/" + row["filename"]],
        evidence_for,
        dino,
        ocr,
    )
    assert result["catalogItemId"] == row["v5"]
    assert result["reason"] == row["v5Reason"]
    assert result["semanticShield"] == row["semanticShield"]
    assert result["proposal"] == row["proposal"]


def test_semantic_shield_and_no_rescue_after_veto():
    result = decide(
        1, 2, views((1, 2), (1, 2), (1, 2)), lambda _: ev(support=True), [3], [3]
    )
    assert (result["catalogItemId"], result["reason"]) == (1, "SEMANTIC_SHIELD")


@pytest.mark.parametrize(
    "evidence,reason",
    [
        (ev("BASELINE_SUPPORT", 1, True), "OCR_BASELINE_VETO"),
        (ev("CHALLENGER_SUPPORT", 1, True, True), "STRICT_GEOMETRY_VETO"),
    ],
)
def test_existing_switch_defensive_veto(evidence, reason):
    result = decide(1, 2, views(), lambda _: evidence, [3], [3])
    assert (result["catalogItemId"], result["reason"]) == (1, reason)


@pytest.mark.parametrize("ocr,dino,sift", itertools.product((False, True), repeat=3))
def test_two_of_three(ocr, dino, sift):
    evidence = ev("CHALLENGER_SUPPORT" if ocr else "ABSTAIN", 5 if dino else None, sift)
    result = decide(1, 1, views(), lambda _: evidence)
    assert result["catalogItemId"] == (2 if sum((ocr, dino, sift)) >= 2 else 1)


@pytest.mark.parametrize("missing", ["ocr", "dino", "geometry"])
def test_missing_auxiliary_can_only_abstain(missing):
    evidence = ev("CHALLENGER_SUPPORT", 5, True)
    if missing == "ocr":
        evidence["ocr"]["decision"] = "ABSTAIN"
    elif missing == "dino":
        evidence["dinoRank"] = None
    else:
        evidence["geometry"] = {
            "available": False,
            "strictVeto": False,
            "softSupport": False,
        }
    assert decide(1, 1, views(), lambda _: evidence)["catalogItemId"] == 2
    # Missing auxiliary plus only one remaining corroborator must KEEP.
    evidence["geometry"]["softSupport"] = False
    evidence["dinoRank"] = None
    assert decide(1, 1, views(), lambda _: evidence)["catalogItemId"] == 1


def test_cross_view_requires_original_full_top20():
    assert cross_view_candidates(views((1, 3), (2, 1), (2, 1)), 1) == []
    assert cross_view_candidates(views((1, 2), (1, 3, 4, 2), (2, 1)), 1) == []
    assert cross_view_candidates(views((1, 2), (1, 3, 2), (2, 1)), 1) == [2]


def test_two_accepted_candidates_abstain():
    assert (
        decide(
            1,
            1,
            views((1, 2, 3), (2, 3), (3, 2)),
            lambda _: ev("CHALLENGER_SUPPORT", 1),
        )["catalogItemId"]
        == 1
    )


@pytest.mark.parametrize("veto", [False, True])
def test_external_rescue(veto):
    result = decide(
        1,
        1,
        views((1,), (1,), (1,)),
        lambda _: ev(support=True, veto=veto),
        [3],
        [4, 3],
    )
    assert result["catalogItemId"] == (1 if veto else 3)


def test_external_requires_all_signals():
    for dino, ocr, evidence in [
        ([3], [], ev(support=True)),
        ([], [3], ev(support=True)),
        ([3], [3], ev()),
    ]:
        assert (
            decide(1, 1, views(), lambda _: evidence, dino, ocr)["catalogItemId"] == 1
        )


def test_default_keep():
    assert decide(1, 1, views(), lambda _: ev())["reason"] == "KEEP_V3"


def test_ocr_exact_title_and_year_semantics():
    assert normalize("ЁЛКА ＡＢＣ") == "елка abc"
    assert (
        ocr_pairwise("Cabernet 2021", "Cabernet 2020", "Merlot 2021")["decision"]
        == "BASELINE_SUPPORT"
    )
    assert ocr_pairwise("2021", "Wine 2020", "Wine 2021")["decision"] == "ABSTAIN"
    assert (
        ocr_pairwise("merlot", "Cabernet", "Merlot")["decision"] == "CHALLENGER_SUPPORT"
    )
    assert (
        ocr_pairwise("cabernet merlot", "Cabernet", "Merlot")["decision"] == "ABSTAIN"
    )
    assert (
        ocr_pairwise("krasnostop", "Красностоп", "Merlot")["decision"]
        == "BASELINE_SUPPORT"
    )
    assert ocr_pairwise("cabernett", "Cabernet", "Merlot")["decision"] == "ABSTAIN"


def candidate(cid, rank, score, inliers=10, ratio=0.5):
    return dict(
        catalog_item_id=cid,
        siglip_rank=rank,
        score=score,
        inliers=inliers,
        inlier_ratio=ratio,
    )


def test_primary_gates_and_boundaries():
    assert primary_gate(1, 0.1, [candidate(2, 2, 5), candidate(1, 1, 1)]) == 2
    assert primary_gate(1, 0.1, [candidate(2, 3, 5), candidate(1, 1, 1)]) == 1
    assert primary_gate(1, 0.01, [candidate(2, 3, 1.12), candidate(1, 1, 1)]) == 2
    assert primary_gate(1, 0.010001, [candidate(2, 3, 1.12), candidate(1, 1, 1)]) == 1


def v3(**kw):
    args = dict(
        baseline=1,
        margin=0.01,
        siglip_ids=list(range(1, 21)),
        primary=[],
        multi=[],
        intent=[],
        far=[],
        union=[],
        ocr_ids=[],
        dino_ids=[],
    )
    args.update(kw)
    return frozen_v3(**args)


def test_no_ref_consensus():
    switch = [candidate(2, 2, 10), candidate(1, 1, 1)]
    assert v3(multi=switch, intent=switch) == (2, "no-ref-consensus")
    assert v3(multi=switch)[0] == 1


def test_far_rank_exact_baseline_zero():
    far = [candidate(4, 4, 10), candidate(1, 1, 0)]
    assert v3(far=far) == (4, "far-rank")
    far[1]["score"] = 0.00001
    assert v3(far=far)[0] == 1


def test_v3_external_union_not_far():
    union = [candidate(25, 999, 8, 8, 0.35)]
    assert v3(union=union, ocr_ids=[25], dino_ids=[25]) == (25, "external-support")
    assert v3(far=union, ocr_ids=[25], dino_ids=[25])[0] == 1
    assert v3(union=union, ocr_ids=[25], dino_ids=[25], siglip_ids=[1, 25])[0] == 1
