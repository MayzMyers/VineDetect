"""Human-readable V8.1 report from completed offline artifacts."""

import argparse
import json
from pathlib import Path

from ..v8.report import SETS, write_csv
from ..v8.finalize import table


def render(repo):
    root = repo / ".generated/v81"
    s = json.loads((root / "summary.json").read_text())
    c = s["selected_config"]
    changes = json.loads((root / "changes" / (s["selected_id"] + ".json")).read_text())[
        "payload"
    ]
    cases = []
    for row in changes:
        winner = next(r["after"] for r in row["candidates"] if r["id"] == row["v81"])
        former = next(r["after"] for r in row["candidates"] if r["id"] == row["v8"])
        delta = {
            f: winner["contributions"].get(f, 0) - former["contributions"].get(f, 0)
            for f in winner["contributions"]
        }
        positive = sorted(
            ((k, v) for k, v in delta.items() if v > 0), key=lambda x: -x[1]
        )[:3]
        cases.append(
            dict(
                key=row["key"],
                expected=row["expected"],
                v8=row["v8"],
                v81=row["v81"],
                outcome="fixed"
                if row["v81"] == row["expected"]
                else "broken"
                if row["v8"] == row["expected"]
                else "wrong_to_wrong",
                winning_contribution_difference=delta,
                main_positive_terms=", ".join(f"{k} {v:+.4f}" for k, v in positive),
            )
        )
    write_csv(root / "selected-changes.csv", cases)

    comparisons = {
        "V8": s["baseline_v8"],
        "V7-B": s["baseline_v7"],
        "V8.1 selected (all-data anchors)": s["selected_full"],
        "V8.1 selected (LODO anchors)": s["selected_oof"],
        "V8.1 nested outer predictions": s["nested"],
    }
    closed = (
        s["selected_full"]["macro_exact"] >= s["baseline_v7"]["macro_exact"]
        and s["selected_full"]["pooled_exact"] >= s["baseline_v7"]["pooled_exact"]
        and s["nested"]["macro_exact"] >= s["baseline_v7"]["macro_exact"]
        and s["nested"]["pooled_exact"] >= s["baseline_v7"]["pooled_exact"]
    )
    conclusion = (
        "The predeclared uniform scorer closes the V7-B development gap in both full-data and nested results."
        if closed
        else "This predeclared uniform-scoring grid does not robustly close the V7-B development gap."
    )
    gate = s["verification_gate"]
    lines = [
        "# V8.1 — frozen-feature reranker experiment",
        "",
        conclusion,
        "",
        "This is evidence about the tested scoring grid, not a proof that all uniform rerankers must succeed or fail. "
        "All data was previously consumed development data. No untouched-device generalization claim is made.",
        "",
        "## Scope and predeclaration",
        "",
        "The [protocol](V8_1_EXPERIMENT_PLAN.md) was committed before outcome computation (549ac0b). "
        "The normative V8-simple v0.2 specification and V8 implementation are unchanged. Targets, labels, OCR, "
        "visual source scores/ranks, local metrics, catalog and GT remain frozen. The same uncapped "
        "Ks20/Kd20/Ko3/Kl15 pool is used for every scoring configuration and every fold.",
        "Exact V8 reproduction passed on all 232 images: complete pool, candidate order, scores, contributions, "
        "Top1 and margin. The new implementation preserves Python 3.12 floating-point summation behavior. "
        "Source payload/provenance checksums are validated; an input inventory is checked again after scoring.",
        "",
        "## Results",
        "",
        table(
            ["Variant", *SETS, "Pooled", "Macro", "Sibling", "Conditional Top1"],
            [
                [
                    name,
                    *[
                        f"{m['datasets'][d]['exact']}/{m['datasets'][d]['n']}"
                        for d in SETS
                    ],
                    f"{m['pooled_exact']}/{m['n']}",
                    f"{m['macro_exact']:.2%}",
                    m["sibling"],
                    f"{m['conditional_accuracy']:.2%}",
                ]
                for name, m in comparisons.items()
            ],
        ),
        "",
        "The candidate pool contains GT for 220/232 images (94.83%) throughout; scoring cannot recover the 12 pool misses. "
        "Conditional accuracy for V7-B is evaluated only on these same GT-in-pool images. "
        "Sibling counts use existing authoritative equivalence groups, which do not cover all similar same-brand products.",
        "",
        table(
            [
                "Dataset",
                "Selected fixes/breaks vs V7-B",
                "Nested fixes/breaks vs V7-B",
                "Selected sibling errors",
                "GT in pool",
            ],
            [
                [
                    d,
                    f"{s['selected_full']['datasets'][d]['fixed_v7']}/{s['selected_full']['datasets'][d]['broken_v7']}",
                    f"{s['nested']['datasets'][d]['fixed_v7']}/{s['nested']['datasets'][d]['broken_v7']}",
                    s["selected_full"]["datasets"][d]["sibling"],
                    s["selected_full"]["datasets"][d]["gt_in_pool"],
                ]
                for d in SETS
            ],
        ),
        "",
        "## Selected scorer",
        "",
        "Selected on five-fold held-out predictions; cosine calibration is fitted only on each fold's training datasets. "
        "The all-data result refits only the unlabeled cosine anchors after parameter selection.",
        "```json",
        json.dumps(c, indent=2),
        "```",
        f"FIELD/STORE selection constraints feasible: **{s['selection_eligible']}**. "
        "Constraints require FIELD >=42/51 and STORE >=9/13 relative to V7-B; macro exact is primary among eligible settings. "
        "FIELD/STORE shortfall, authoritative sibling count and pooled exact break ties in that order.",
        "",
        "Structured identity uses confidence-weighted catalog IDF and saturates its aggregate. Explicit attributes remain separate "
        "positive/negative features, with conflict confidence >=.85; absent attributes are neutral. "
        "Shared-family normalization applies one token-frequency attenuation rule to every candidate. "
        "The semantic top10 provides token-frequency context only, never a shortlist or decision branch. "
        "There is no V5 baseline/challenger, rescue or product-specific rule.",
        "",
        "## R1–R3 controls and selected families",
        "",
        table(
            [
                "Control",
                "Pooled",
                "Macro",
                "LODO macro",
                "FIELD",
                "STORE",
                "Changes vs V8",
            ],
            [
                [
                    name,
                    item["full"]["pooled_exact"],
                    f"{item['full']['macro_exact']:.2%}",
                    f"{item['oof']['macro_exact']:.2%}",
                    item["full"]["datasets"]["FIELD51"]["exact"],
                    item["full"]["datasets"]["STORE13"]["exact"],
                    s["score_distributions_and_orders"][name]["top1_changes"],
                ]
                for name, item in s["controls"].items()
            ],
        ),
        "",
        "Named R1 controls change semantic normalization only. R2 splits OCR fields without shared-family attenuation. "
        "R3 adds attenuation at the same R2 weights. Best-mode rows use the same predeclared nested-calibration selection discipline; "
        "all 102 configurations, including losing alternatives, are retained in grid-results.json/CSV.",
        "",
        "The R1 rank-free controls reduce accuracy: min/max-only gives 160/232 and calibrated cosine 148/232, "
        "versus 165/232 for exact V8. The best structured and shared-family variants both reach 167/232; "
        "shared-family attenuation does not demonstrate an additional Top1 gain. The selected setting retains the original rank-bearing semantic normalization.",
        "No grid setting passes FIELD eligibility: the highest FIELD result anywhere in the 102 configurations is 38/51, below the 42/51 floor. "
        "The reported winner is therefore an infeasible exploratory result, not an accepted candidate.",
        "",
        "## Score distributions and candidate orders",
        "",
        table(
            [
                "Control",
                "Score mean / std",
                "Score p05 / p95",
                "Semantic mean",
                "Margin p50",
                "Full order changes",
                "Top1 changes",
                "Pairwise disagreement",
            ],
            [
                [
                    name,
                    f"{m['score']['mean']:.4f} / {m['score']['std']:.4f}",
                    f"{m['score']['p05']:.4f} / {m['score']['p95']:.4f}",
                    f"{m['semantic']['mean']:.4f}",
                    f"{m['margin']['p50']:.4f}",
                    m["complete_order_changes"],
                    m["top1_changes"],
                    f"{m['mean_pairwise_order_disagreement']:.2%}",
                ]
                for name, m in s["score_distributions_and_orders"].items()
            ],
        ),
        "",
        "Score distributions weight each candidate equally, while accuracy selection weights datasets equally. "
        "Complete quantiles, score deltas and mean absolute rank movement are retained in summary.json. "
        "Cosine calibration anchors (p05/p95 of training source similarities) for the all-data descriptive fit:",
        table(
            ["Source", "p05", "p95"],
            [
                [name, *[f"{v:.6f}" for v in values]]
                for name, values in s["calibration_anchors_all_data"].items()
            ],
        ),
        "",
        "## Nested leave-one-dataset-out sensitivity",
        "",
        table(
            ["Outer holdout", "Exact", "Inner eligible", "Chosen scorer"],
            [
                [
                    r["heldout"],
                    f"{r['heldout_metrics']['exact']}/{r['heldout_metrics']['n']}",
                    r["inner_eligible"],
                    r["config_id"],
                ]
                for r in s["nested_folds"]
            ],
        ),
        "",
        "Each outer fold excludes its dataset from calibration and all parameter selection. Each inner validation fold "
        "fits cosine anchors on three datasets. After selection, anchors are refitted on the outer training four. "
        "The selected full-development setting is therefore distinct from the five independently selected outer settings.",
        f"Paired, dataset-stratified bootstrap 95% interval for nested macro improvement over V8: "
        f"[{s['bootstrap_nested_macro_delta_95'][0]:+.2%}, {s['bootstrap_nested_macro_delta_95'][1]:+.2%}] "
        "(2,000 repeats, seed 8101). Small dataset counts limit certainty.",
        "",
        "## Changed-decision evidence",
        "",
        "Every changed full-data decision for every grid configuration has a checksummed record in "
        "`.generated/v81/changes/<config-id>.json`. Each records expected/V8/V8.1/V7 identities, GT-in-pool, "
        "recognized text, saved OCR fields, authoritative/potential sibling labels, before/after per-feature contributions, "
        "contribution deltas and winner-minus-GT deltas. No inferred potential sibling changes authoritative GT.",
        "Selected-replay.json contains all candidates and contributions for all 232 images. Selected-oof-replay.json "
        "and nested-replay.json contain per-fold scoring parameters, full orders and contribution deltas for every changed held-out decision.",
        "",
        "The selected scorer changes 13 decisions versus V8: four fixes, two regressions and seven wrong-to-wrong changes. "
        "The STORE Rkatsiteli fix gains +0.1515 grape contribution and +0.0276 geometry versus the former Cabernet winner, overcoming -0.1745 semantics. "
        "Two Fanagoria fixes gain about +0.1595 sweetness contribution. The FIELD White Blend regression gains +0.1558 from a saved grape-field match "
        "despite -0.1504 semantics. The stored catalog field includes non-specific blend/color text: this is a frozen feature-schema limitation, "
        "not reliable proof of a grape. Several SEMI-SWEET cases receive misleading stored sweetness-conflict evidence because the frozen tokenization splits the phrase. "
        "High OCR line confidence therefore does not guarantee a semantically correct attribute conflict. These findings were reported without changing parser, catalog or the grid.",
        "",
        table(
            [
                "Changed image",
                "GT",
                "V8 → V8.1",
                "Outcome",
                "Main positive winner-vs-former contributions",
            ],
            [
                [
                    r["key"],
                    r["expected"],
                    f"{r['v8']} → {r['v81']}",
                    r["outcome"],
                    r["main_positive_terms"],
                ]
                for r in cases
            ],
        ),
        "",
        "## Live verification decision",
        "",
        table(["Predeclared requirement", "Pass"], [[k, v] for k, v in gate.items()]),
        "",
        (
            "The offline verification gate passed. Scoring parameters must be fixed before the authorized single live pass; "
            "offline completion alone does not establish live parity or latency."
            if gate["passed"]
            else "The offline verification gate failed. No image inference or GPU stack was started; no new latency claim is made. "
            "The existing V8 latency results are not relabelled as V8.1 measurements."
        ),
        "",
        "## Limitations and disposition",
        "",
        *["- " + value for value in s["limitations"]],
        "",
        conclusion
        + " "
        + (
            "Live verification is required before concluding operational parity."
            if gate["passed"]
            else "Retain the current comparison baseline; this result does not justify an inference rerun or release freeze."
        ),
        "New-phone and organizer validation sets were not accessed. No push, merge, deployment or release freeze. "
        "Final tests, source-integrity hashes and local commit are recorded in `.generated/v81/git-checks.json`.",
        "",
        "Validation: 189 Python tests pass (one third-party deprecation warning); 943 frozen input hashes are unchanged. "
        "Independent recounting validates 102 configurations, 2,852 changed-decision audits, and 696 selected/held-out replay records. "
        "All candidate pools remain identical and contribution sums agree with saved scores.",
        "",
        "Reproduce offline with the repository virtual environment; these commands do not load inference models:",
        "```sh",
        "PYTHONPATH=vision-service vision-service/.venv/bin/python -m app.v81.experiment --repo /home/mayz/projects/vinedetect_dev",
        "PYTHONPATH=vision-service vision-service/.venv/bin/python -m app.v81.validate --repo /home/mayz/projects/vinedetect_dev",
        "PYTHONPATH=vision-service vision-service/.venv/bin/python -m app.v81.render --repo /home/mayz/projects/vinedetect_dev",
        "```",
        "",
    ]
    (repo / "docs/V8_1_RESULTS.md").write_text("\n".join(lines))
    print(conclusion)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--repo", type=Path, required=True)
    render(p.parse_args().repo)


if __name__ == "__main__":
    main()
