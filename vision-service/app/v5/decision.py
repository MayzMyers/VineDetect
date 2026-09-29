"""Frozen V3 gates and V5-RC1 decisions. No model or I/O dependencies."""

import math


def rank_map(views, view):
    return {int(c["catalogItemId"]): int(c["rank"]) for c in views.get(view, [])}


def top1(views, view):
    rows = views.get(view, [])
    return int(rows[0]["catalogItemId"]) if rows else None


def semantic_shield(views, baseline):
    return all(top1(views, view) == baseline for view in ("full", "bottle", "label"))


def cross_view_candidates(views, baseline):
    full, bottle, label = (rank_map(views, v) for v in ("full", "bottle", "label"))
    candidates = set()
    l1, b1 = top1(views, "label"), top1(views, "bottle")
    if (
        l1 is not None
        and l1 != baseline
        and bottle.get(l1, 999) <= 3
        and full.get(l1, 999) <= 20
    ):
        candidates.add(l1)
    if (
        b1 is not None
        and b1 != baseline
        and label.get(b1, 999) <= 3
        and full.get(b1, 999) <= 20
    ):
        candidates.add(b1)
    return sorted(candidates)


def has_hard_veto(evidence):
    return evidence["ocr"]["decision"] == "BASELINE_SUPPORT" or evidence[
        "geometry"
    ].get("strictVeto", False)


def cross_view_allow(evidence):
    return (
        not has_hard_veto(evidence)
        and sum(
            (
                evidence["ocr"]["decision"] == "CHALLENGER_SUPPORT",
                evidence["dinoRank"] is not None and evidence["dinoRank"] <= 5,
                bool(evidence["geometry"].get("softSupport", False)),
            )
        )
        >= 2
    )


def decide(baseline, v3, views, evidence_for, dino_ids=(), ocr_ids=()):
    """evidence_for is request-local and abstains for unavailable signals."""
    current, reason, proposal, evidence = v3, "KEEP_V3", None, None
    shield = semantic_shield(views, baseline)
    if v3 != baseline:
        proposal = v3
        evidence = evidence_for(v3)
        if shield:
            current, reason = baseline, "SEMANTIC_SHIELD"
        elif evidence["ocr"]["decision"] == "BASELINE_SUPPORT":
            current, reason = baseline, "OCR_BASELINE_VETO"
        elif evidence["geometry"].get("strictVeto", False):
            current, reason = baseline, "STRICT_GEOMETRY_VETO"
        # A reverted V3 switch MUST NOT enter either rescue path.
    else:
        accepted = []
        for challenger in cross_view_candidates(views, baseline):
            ev = evidence_for(challenger)
            if cross_view_allow(ev):
                accepted.append((challenger, ev))
        if len(accepted) == 1:
            proposal, evidence = accepted[0]
            current, reason = proposal, "CROSS_VIEW_V5"
        if current == baseline and dino_ids:
            challenger = dino_ids[0]
            if challenger != baseline and challenger in ocr_ids[:5]:
                ev = evidence_for(challenger)
                if not has_hard_veto(ev) and ev["geometry"].get("softSupport", False):
                    proposal, evidence = challenger, ev
                    current, reason = challenger, "EXTERNAL_V5"
    return dict(
        catalogItemId=current,
        reason=reason,
        proposal=proposal,
        evidence=evidence,
        semanticShield=shield,
    )


def ratio(a, b):
    return a / b if b > 0 else math.inf if a > 0 else 1.0


def primary_gate(baseline, margin, candidates):
    candidates = sorted(
        candidates, key=lambda c: (-c["score"], c["siglip_rank"], c["catalog_item_id"])
    )
    if not candidates:
        return baseline
    winner = candidates[0]
    baseline_score = next(
        (c["score"] for c in candidates if c["catalog_item_id"] == baseline), 0.0
    )
    second = candidates[1]["score"] if len(candidates) > 1 else 0.0
    wb, ws = ratio(winner["score"], baseline_score), ratio(winner["score"], second)
    rank, cid = winner["siglip_rank"], winner["catalog_item_id"]
    strong = cid != baseline and rank <= 2 and (wb >= 5 or (wb >= 2 and ws >= 2))
    ambiguous = (
        cid != baseline and margin <= 0.01 and rank <= 3 and wb >= 1.10 and ws >= 1.12
    )
    return cid if strong or ambiguous else baseline


def frozen_v3(
    baseline, margin, siglip_ids, primary, multi, intent, far, union, ocr_ids, dino_ids
):
    """Primary/multi/intent use original Top10; far uses raw Top20; union is separate."""
    current, reason = primary_gate(baseline, margin, primary), "primary"
    mf, inf = (
        primary_gate(baseline, margin, multi),
        primary_gate(baseline, margin, intent),
    )
    if current == baseline and mf != baseline and inf != baseline and mf == inf:
        current, reason = mf, "no-ref-consensus"
    if current == baseline and far:
        winner = far[0]
        second = far[1]["score"] if len(far) > 1 else 0.0
        bs = next((c["score"] for c in far if c["catalog_item_id"] == baseline), 0.0)
        if (
            winner["catalog_item_id"] != baseline
            and 4 <= winner["siglip_rank"] <= 20
            and winner["inliers"] >= 10
            and winner["inlier_ratio"] >= 0.50
            and ratio(winner["score"], second) >= 2
            and bs == 0
        ):
            current, reason = winner["catalog_item_id"], "far-rank"
    if current == baseline and ocr_ids:
        cid = ocr_ids[0]
        candidate = next((c for c in union if c["catalog_item_id"] == cid), None)
        if (
            candidate
            and margin <= 0.01
            and cid != baseline
            and cid not in siglip_ids[:20]
            and cid in dino_ids[:20]
            and candidate["inliers"] >= 8
            and candidate["inlier_ratio"] >= 0.35
        ):
            current, reason = cid, "external-support"
    return current, reason
