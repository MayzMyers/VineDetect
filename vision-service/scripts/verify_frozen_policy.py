"""Differential policy verification against an explicitly supplied frozen source.

Only hash-verified pure functions and the decision block execute. The simulator's
imports, dataset discovery, image loading and report-writing code never execute.
"""

import argparse
import ast
import hashlib
import random
import sys
import textwrap
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.v5.decision import decide

EXPECTED_SHA = "c54251c8554672a11396e9b15e5fc097cd72b921995c916d94fe0d5828447329"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("simulator", type=Path)
    args = parser.parse_args()
    raw = args.simulator.read_bytes()
    if hashlib.sha256(raw).hexdigest() != EXPECTED_SHA:
        raise SystemExit("Not the frozen V5-RC1 simulator")
    source = raw.decode()
    names = {
        "cid",
        "ranked_ids",
        "rank_map",
        "top1",
        "semantic_shield",
        "cross_view_candidates",
        "has_hard_veto",
        "cross_view_allow",
        "external_candidate",
    }
    namespace = {}
    functions = [
        n
        for n in ast.parse(source).body
        if isinstance(n, ast.FunctionDef) and n.name in names
    ]
    exec(
        compile(
            ast.Module(body=functions, type_ignores=[]),
            "<frozen-pure-functions>",
            "exec",
        ),
        namespace,
    )
    start = source.index(
        "        shield = semantic_shield(", source.index("ROWS_OUT = []")
    )
    end = source.index("        ROWS_OUT.append(", start)
    block = compile(
        textwrap.dedent(source[start:end]), "<frozen-decision-block>", "exec"
    )
    rng = random.Random(54251)
    for case in range(5000):
        baseline = 1
        v3 = rng.choice([1, 1, 1, 2, 3])
        views = {}
        for view in ("full", "bottle", "label"):
            ids = rng.sample(range(1, 7), rng.randrange(7))
            views[view] = [
                {"catalogItemId": cid, "rank": i + 1} for i, cid in enumerate(ids)
            ]
        evidence = {
            cid: {
                "ocr": {
                    "decision": rng.choice(
                        ["ABSTAIN", "BASELINE_SUPPORT", "CHALLENGER_SUPPORT"]
                    )
                },
                "dinoRank": rng.choice([None, 1, 5, 6, 20]),
                "geometry": {
                    "strictVeto": rng.choice([False, False, True]),
                    "softSupport": rng.choice([False, True]),
                },
            }
            for cid in range(1, 7)
        }
        dino = rng.sample(range(1, 7), rng.randrange(7))
        ocr = rng.sample(range(1, 7), rng.randrange(7))
        namespace.update(
            baseline=baseline,
            old_v3=v3,
            view_row=views,
            set_name="synthetic",
            name=str(case),
            evidence_for=lambda _s, _n, _v, _b, cid: evidence[cid],
            dino_roi_ids=lambda _s, _n: dino,
            ocr_top_ids=lambda _s, _n, limit: ocr[:limit],
        )
        exec(block, namespace)
        actual = decide(baseline, v3, views, lambda cid: evidence[cid], dino, ocr)
        expected = (
            namespace["current"],
            namespace["reason"],
            namespace["proposal"],
            namespace["shield"],
        )
        observed = (
            actual["catalogItemId"],
            actual["reason"],
            actual["proposal"],
            actual["semanticShield"],
        )
        if observed != expected:
            raise AssertionError(
                f"Policy mismatch in case {case}: {observed} != {expected}"
            )
    print(
        "5000/5000 differential decisions match the hash-verified frozen executable policy"
    )


if __name__ == "__main__":
    main()
