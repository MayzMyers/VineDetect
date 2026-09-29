"""Render final fixed-weight experiment and V8-simple closure report."""

import argparse
import json
from pathlib import Path

from ..v8.finalize import table
from ..v8.report import SETS


def render(repo):
    root = repo / ".generated/v82"
    s = json.loads((root / "summary.json").read_text())
    validation = json.loads((root / "validation.json").read_text())
    audit = json.loads((root / "catalog-parser-audit.json").read_text())
    changes = json.loads((root / "changes.json").read_text())["payload"]
    catalog = {
        r["catalog_item_id"]: r
        for r in json.loads((repo / ".runtime/v5-rc1/catalog.json").read_text())["rows"]
    }
    assert not s["initial_search_gate"]["passed"], (
        "Conditional grid must be completed before closure"
    )
    assert not s["promotion_gate"]["passed"]
    compare = {
        "V8": s["v8"],
        "V8.1 best development": s["v81"],
        "V8.2 fixed weights": s["initial"],
        "V7-B": s["v7"],
    }
    case_rows = []
    for r in changes:
        truth = next((c for c in r["candidates"] if c["id"] == r["expected"]), None)
        case_rows.append(
            [
                r["key"],
                catalog[r["expected"]]["title"],
                catalog[r["v8"]]["title"] + " → " + catalog[r["v82"]]["title"],
                r["outcome"],
                f"{truth['contribution_delta']['ocr_identity']:+.4f}"
                if truth
                else "GT outside pool",
            ]
        )
    lines = [
        "# V8.2 final feature-semantics experiment",
        "",
        "**V8-simple development is closed after this experiment. Recommend V7-B for separately authorized untouched validation.**",
        "The feature cleanup did not approach V7-B robustly. The fixed-weight replay scored 162/232 with 63.38% equal-dataset macro, "
        "versus V8 165/232 (66.17%), V8.1 167/232 (67.63%), and V7-B 169/232 (71.45%). "
        "The search and promotion gates failed; the V8.1 weight grid was not run. No image inference or untouched validation was performed.",
        "",
        "## Scope and protocol",
        "",
        "The [predeclared protocol](V8_2_EXPERIMENT_PLAN.md) was committed as ef1a39d before outcomes. "
        "Parser code and the initial exact regression fixtures were checkpointed as 0ad01ee before replay. "
        "The [normative architecture](V8-simple_onepager_v0.2.md), V8/V8.1 scorers and V8.1 search protocol are unchanged.",
        "Only derived OCR/catalog features changed. Target and label selection, raw OCR lines/confidences, catalog/GT, "
        "SigLIP/DINO similarities/ranks and SIFT/RootSIFT metrics remain frozen. Every image retains its original "
        "uncapped Ks20/Kd20/Ko3/Kl15 candidate IDs. Original V8 scores, complete orders, contributions and margins first reproduced exactly on all 232 images.",
        "Weights remain [1, 0.6, 0, 0.6, 0.05], with DINO .5 and label .15. In particular, the OCR attribute weight remains zero. "
        "No scorer normalization, candidate privileges, product-specific alias, rescue rule or decision branch was added.",
        "",
        "## Parser corrections and provenance",
        "",
        "Ordered spans are retained before longest-phrase matching. SEMI-SWEET/SEMI-DRY, EXTRA BRUT, BLANC DE NOIRS and BLANC DE BLANCS "
        "remain complete attributes. Catalog-derived multi-word grape/product/range phrases are matched as phrases. "
        "Mixed-script visual homoglyph repair is global and requires an exact lexical result; no fuzzy spelling completion is used.",
        "Grapes come only from the typed grapes field. Genuine multi-word varieties such as Мускат Белый remain intact, "
        "so WHITE BLEND cannot match the white fragment as a grape. Generic grape/blend/description entries are rejected. "
        "Color uses category rather than prose color descriptions; color and style are separate conflict axes.",
        "An explicit catalog title phrase can support a positive attribute match, but remains untyped and cannot authorize a conflict. "
        "Negative evidence requires confidence >=.85 and a genuinely typed catalog value on the same attribute axis. "
        "Missing values, ambiguous categorical observations and partial/parent grape evidence remain neutral.",
        f"Typed catalog entries: {json.dumps(audit['typed_attribute_entries'])}. "
        "There are no dedicated sweetness, brut or vintage values in this snapshot. Their title-derived positive evidence is retained, "
        "but their conflict features therefore abstain. Typed source absence is not repaired by treating slug/title prose as a typed field.",
        "Every structured field has provenance, including wholly absent neutral fields: OCR span and line indices, raw/extracted confidence, "
        "parser rule, catalog source/span, normalized value and typing status. A metadata-only completion added explicit absent-field records; "
        "all 232 complete score/order fingerprints remained identical.",
        "",
        "## Required regression fixtures",
        "",
        table(
            ["Fixture", "Verified behavior"],
            [
                [
                    "Exact saved SEMI-SWEET",
                    "One semisweet value; no sweet fragment or false sweetness conflict; confidence 0.9945946.",
                ],
                [
                    "FIELD White Blend, catalog 625/626",
                    "Neither candidate gets a grape match from WHITE BLEND; Мускат Белый stays one typed phrase.",
                ],
                [
                    "STORE Rkatsiteli, catalog 1635",
                    "РКАЦИТЕЛИ matches the typed grapes field at saved confidence 0.9471759.",
                ],
                [
                    "Fanagoria brut/semisweet siblings",
                    "Positive semisweet match goes to the semisweet title; title-only sibling attributes do not invent typed conflicts.",
                ],
                [
                    "Actual mixed-script Riesling/Sauvignon case",
                    "Incomplete PNCЛИH at confidence 0.4317066 stays unknown for both grapes.",
                ],
                [
                    "Exact mixed homoglyph attributes",
                    "Unambiguous PИCЛИHГ and SАUVIGNОN BLАNC normalize globally to the correct typed phrases.",
                ],
                [
                    "Other global phrase/neutrality cases",
                    "Semi-dry, extra brut, both blanc-de styles, multi-line confidence, product phrases, missing values and parent-grape neutrality.",
                ],
            ],
        ),
        "",
        "## Accuracy and regressions",
        "",
        table(
            ["Variant", *SETS, "Pooled", "Macro", "Sibling", "Top1 given GT in pool"],
            [
                [
                    name,
                    *[
                        f"{m['datasets'][d]['exact']}/{m['datasets'][d]['n']}"
                        for d in SETS
                    ],
                    f"{m['pooled_exact']}/232",
                    f"{m['macro_exact']:.2%}",
                    m["sibling"],
                    f"{m['conditional_accuracy']:.2%}",
                ]
                for name, m in compare.items()
            ],
        ),
        "",
        "GT remains in the pool for 220/232 images (94.83%). Authoritative sibling counts use the inherited equivalence groups, "
        "which are not a complete taxonomy of all same-brand wines.",
        table(
            ["Dataset", "Exact", "Fixed/broken vs V7-B", "GT in pool"],
            [
                [
                    d,
                    f"{m['exact']}/{m['n']}",
                    f"{m['fixed_v7']}/{m['broken_v7']}",
                    f"{m['gt_in_pool']}/{m['n']}",
                ]
                for d, m in s["initial"]["datasets"].items()
            ],
        ),
        f"Total fixes/breaks versus V7-B: {s['initial']['fixed_v7']}/{s['initial']['broken_v7']}.",
        "",
        "## LODO and bootstrap interpretation",
        "",
        f"Fixed-parser/fixed-scorer held-out aggregate macro: **{s['nested_lodo']['macro_exact']:.2%}**. "
        "There is no supervised fitting, image-derived calibration or hyperparameter selection in this stage, so scoring each held-out dataset "
        "produces exactly the same predictions as the full fixed replay. A newly tuned nested-LODO weight-search result does not exist: "
        "the prerequisite gate failed and the grid was skipped.",
        f"Paired stratified bootstrap 95% macro-delta interval versus V8: "
        f"[{s['bootstrap_macro_delta_vs_v8_95'][0] * 100:+.2f}, {s['bootstrap_macro_delta_vs_v8_95'][1] * 100:+.2f}] percentage points; "
        f"versus V8.1 best: [{s['bootstrap_macro_delta_vs_v81_95'][0] * 100:+.2f}, "
        f"{s['bootstrap_macro_delta_vs_v81_95'][1] * 100:+.2f}] points. Seed8101, 2,000 repeats, equal dataset weights.",
        "",
        "## Changed feature counts",
        "",
        table(
            ["Measure", "Count"],
            list(s["feature_counts"].items())
            + [["provenance_records", s["provenance_records"]]],
        ),
        "",
        table(
            [
                "Field",
                "Candidate fields with changed matches",
                "Changed conflicts",
                "Match entries before → after",
                "Conflict entries before → after",
            ],
            [
                [
                    f,
                    s["field_counts"][f + ".matched"],
                    s["field_counts"][f + ".conflicts"],
                    f"{s['field_counts'][f + '.matches_before']} → {s['field_counts'][f + '.matches_after']}",
                    f"{s['field_counts'][f + '.conflicts_before']} → {s['field_counts'][f + '.conflicts_after']}",
                ]
                for f in (
                    "producer",
                    "product",
                    "grape",
                    "color_style",
                    "sweetness",
                    "brut",
                    "vintage",
                    "other",
                )
            ],
        ),
        "Counts are candidate/field-level, not image counts. Atomic tokens and complete phrases are different units, "
        "so before/after entry totals alone are not a measure of extraction quality. Changed missing inventories and catalog IDF weights "
        "are included in feature-changes.csv. All 9,647 candidate feature vectors are retained under .generated/v82/features/.",
        "",
        "## Every changed Top1",
        "",
        table(
            [
                "Image",
                "GT",
                "V8 → V8.2",
                "Outcome",
                "GT OCR-identity contribution delta",
            ],
            case_rows,
        ),
        "There are three regressions, one wrong-to-wrong change and no fixes versus V8. "
        "All four changes come solely from OCR identity contributions; semantic, geometry, quality and zero-weight attribute contributions "
        "are bit-identical to the original scorer. Whole-phrase identity extraction loses partial/noisy identity matches in the STORE and UNSEEN cases. "
        "The low-confidence incomplete Riesling text is correctly left unknown, but that does not recover the SKU.",
        "The intended attribute corrections are verified by fixtures and feature provenance, but cannot directly change a zero-weight attribute group. "
        "Consequently this result does not prove that corrected attributes would be useless under other weights. The requested conditional protocol "
        "does not permit that search after a failed fixed-weight gate, and no post-hoc rescue was attempted.",
        "Complete before/after candidate scores, each group contribution/delta, original/corrected OCR fields and provenance for every changed decision "
        "are in .generated/v82/changes.json. All-image score orders are in replay/. The compact index is changed-top1.csv.",
        "",
        "## Gates and final disposition",
        "",
        table(
            ["Initial search requirement", "Pass"],
            list(s["initial_search_gate"].items()),
        ),
        "",
        table(["Promotion requirement", "Pass"], list(s["promotion_gate"].items())),
        "The declared FIELD floor is 42/51 (V7-B minus 3), STORE floor 9/13 (V7-B minus 2), "
        "macro must exceed both V8 and the best V8.1 development macro, and the bootstrap lower bound must be no worse than -0.5 percentage points. "
        "These conditions fail.",
        "**Stop V8-simple development here. Recommend V7-B for the next, separately authorized untouched-validation stage.** "
        "No untouched set has been opened or evaluated. This conclusion concerns the completed V8/V8.1/V8.2 experiments, "
        "not a mathematical impossibility claim about all uniform rerankers.",
        "",
        "## Checks and reproduction",
        "",
        f"204 Python tests pass (one existing third-party deprecation warning). Independent validation checks "
        f"{validation['frozen_input_files']} frozen input hashes, {validation['replay_records']} replay checkpoints, "
        f"{validation['candidate_vectors']} candidate vectors, {validation['provenance_records']} provenance records and all four changed decisions. "
        "OCR/catalog span provenance and every typed conflict threshold are verified. V8/V8.1, production routes and the normative document remain unchanged.",
        "```sh",
        "PYTHONPATH=vision-service vision-service/.venv/bin/python -m app.v82.validate --repo /home/mayz/projects/vinedetect_dev",
        "PYTHONPATH=vision-service vision-service/.venv/bin/python -m app.v82.render --repo /home/mayz/projects/vinedetect_dev",
        "```",
        "The completed experiment is checkpointed; no additional inference or search is pending. Final branch/commit and checks are in "
        ".generated/v82/git-checks.json. No push, merge, deployment or release freeze.",
        "",
    ]
    (repo / "docs/V8_2_RESULTS.md").write_text("\n".join(lines))
    print(
        "V8-simple development closed; V7-B recommended for separately authorized untouched validation."
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    render(ap.parse_args().repo)


if __name__ == "__main__":
    main()
