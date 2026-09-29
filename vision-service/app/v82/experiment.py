"""Fixed-weight OCR-semantics replay; no image inference or automatic search."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

import numpy as np

from ..v8.checkpoint import atomic_json, digest, read, save, writer_lock
from ..v8.config import Config
from ..v8.rerank import rank
from ..v8.report import SETS, metrics, write_csv
from ..v81.experiment import load
from .parser import Parser


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reduced(ordered):
    return [
        {k: r[k] for k in ("id", "score", "groups", "contributions", "semantic")}
        for r in ordered
    ]


def value_signature(ocr):
    return dict(
        identity=ocr["identity"],
        attribute_agreement=ocr["attribute_agreement"],
        attribute_conflict=ocr["attribute_conflict"],
        available=ocr["available"],
        fields={
            f: {
                k: v[k]
                for k in ("matched", "conflicts", "missing", "match_weight", "absent")
            }
            for f, v in ocr["fields"].items()
        },
    )


def run(repo):
    root = repo / ".generated/v82"
    rows, traces, prepared, baseorders, baseline, groups, catalog, inventory = load(
        repo, root
    )
    print("Original V8 exact replay: 232/232", flush=True)
    for path in [
        repo / "docs/V8_2_EXPERIMENT_PLAN.md",
        repo / ".generated/v81/summary.json",
        repo / ".generated/v81/selected-replay.json",
        repo / ".generated/v81/input-inventory.json",
        repo / "vision-service/app/v81/scorer.py",
        repo / "vision-service/app/v81/experiment.py",
    ]:
        inventory[str(path.relative_to(repo))] = sha(path)
    atomic_json(root / "input-inventory.json", inventory)
    parent = json.loads((repo / ".generated/v81/summary.json").read_text())
    parent_inventory = json.loads(
        (repo / ".generated/v81/input-inventory.json").read_text()
    )
    parent_replay = read(
        repo / ".generated/v81/selected-replay.json",
        dict(
            config=parent["selected_config"],
            anchors=parent["calibration_anchors_all_data"],
            input_inventory=digest(parent_inventory),
        ),
    )
    assert parent_replay is not None
    parent_predictions = {r["key"]: r["top1"] for r in parent_replay}
    config = Config(
        **json.loads((repo / ".generated/v8/selected-config.json").read_text())
    )
    parser = Parser(catalog)
    parser_hash = sha(Path(__file__).parent / "parser.py")
    atomic_json(
        root / "catalog-parser-audit.json",
        dict(
            rejected_grape_entries=parser.rejected_grape_entries,
            typed_attribute_entries={
                f: sum(
                    e["genuinely_typed"]
                    for fields in parser.expected.values()
                    for e in fields[f]
                )
                for f in ("grape", "color_style", "sweetness", "brut", "vintage")
            },
            catalog_fields=sorted(set(k for r in catalog for k in r)),
            idf=parser.idf,
        ),
    )
    predictions = []
    changes = []
    feature_counts = Counter()
    field_counts = Counter()
    provenance_count = 0
    for row, trace, p, oldorder in zip(rows, traces, prepared, baseorders):
        ids = p["ids"]
        original = digest(trace)
        extracted = parser.features(trace["ocr"], ids)
        evidence = {}
        for cid in ids:
            old = trace["evidence"][str(cid)]
            new = extracted[cid]
            feature_counts["candidate_vectors"] += 1
            feature_counts["vectors_with_value_changes"] += value_signature(
                old["ocr"]
            ) != value_signature(new)
            for field in old["ocr"]["fields"]:
                oldf, newf = old["ocr"]["fields"][field], new["fields"][field]
                for item in ("matched", "conflicts", "missing", "match_weight"):
                    field_counts[field + "." + item] += oldf[item] != newf[item]
                field_counts[field + ".matches_before"] += len(oldf["matched"])
                field_counts[field + ".matches_after"] += len(newf["matched"])
                field_counts[field + ".conflicts_before"] += len(oldf["conflicts"])
                field_counts[field + ".conflicts_after"] += len(newf["conflicts"])
                provenance_count += len(newf["provenance"])
            for item in ("identity", "attribute_agreement", "attribute_conflict"):
                feature_counts[item + "_changed"] += old["ocr"][item] != new[item]
            evidence[str(cid)] = dict(old, ocr=new)
            assert evidence[str(cid)]["geometry"] == old["geometry"]
            assert new["available"] == old["ocr"]["available"]
        ordered = rank(
            [dict(id=cid) for cid in ids], evidence, trace["sources"], config
        )
        assert set(r["id"] for r in ordered) == set(ids)
        assert digest(trace) == original, "Frozen evidence modified"
        predicted = ordered[0]["id"]
        predictions.append(dict(top1=predicted, pool_ids=ids))
        key = hashlib.sha256(row["key"].encode()).hexdigest()
        prov = dict(
            parent_trace=original,
            parser=parser_hash,
            config=config.json(),
            input_inventory=digest(inventory),
        )
        save(
            root / "features" / (key + ".json"),
            dict(key=row["key"], candidates=extracted),
            prov,
        )
        oldtop = oldorder[0]["id"]
        replay = dict(
            key=row["key"],
            expected=row["expected"],
            v8=oldtop,
            v81=parent_predictions[row["key"]],
            v7=baseline[row["key"]]["V7-B"],
            top1=predicted,
            pool_ids=ids,
            ordered=reduced(ordered),
            feature_file="features/" + key + ".json",
            raw_inputs_unchanged=True,
        )
        save(root / "replay" / (key + ".json"), replay, prov)
        if oldtop != predicted:
            newlookup = {r["id"]: r for r in ordered}
            oldlookup = {r["id"]: r for r in oldorder}
            focus = {oldtop, predicted, row["expected"]} & set(ids)
            changes.append(
                dict(
                    key=row["key"],
                    expected=row["expected"],
                    v8=oldtop,
                    v82=predicted,
                    v7=baseline[row["key"]]["V7-B"],
                    ocr=trace["ocr"],
                    outcome="fixed"
                    if predicted == row["expected"]
                    else "broken"
                    if oldtop == row["expected"]
                    else "wrong_to_wrong",
                    feature_file=replay["feature_file"],
                    candidates=[
                        dict(
                            id=cid,
                            before=oldlookup[cid],
                            after=reduced([newlookup[cid]])[0],
                            contribution_delta={
                                f: newlookup[cid]["contributions"][f]
                                - oldlookup[cid]["contributions"][f]
                                for f in newlookup[cid]["contributions"]
                            },
                            original_ocr=trace["evidence"][str(cid)]["ocr"],
                            corrected_ocr=extracted[cid],
                        )
                        for cid in sorted(focus)
                    ],
                )
            )

    def evaluate(preds):
        stats = metrics(rows, preds, baseline, groups)
        return dict(
            datasets=stats,
            pooled_exact=sum(m["exact"] for m in stats.values()),
            n=len(rows),
            macro_exact=float(np.mean([m["exact"] / m["n"] for m in stats.values()])),
            fixed_v7=sum(m["fixed_v7"] for m in stats.values()),
            broken_v7=sum(m["broken_v7"] for m in stats.values()),
            sibling=sum(m["sibling"] for m in stats.values()),
            conditional_accuracy=sum(m["conditional_correct"] for m in stats.values())
            / sum(m["gt_in_pool"] for m in stats.values()),
        )

    initial = evaluate(predictions)

    def reference(kind):
        return evaluate(
            [
                dict(
                    top1=(
                        old[0]["id"]
                        if kind == "v8"
                        else parent_predictions[r["key"]]
                        if kind == "v81"
                        else baseline[r["key"]]["V7-B"]
                    ),
                    pool_ids=p["ids"],
                )
                for r, p, old in zip(rows, prepared, baseorders)
            ]
        )

    old = reference("v8")
    v7 = reference("v7")
    v81 = reference("v81")

    def bootstrap(ref):
        rng = np.random.default_rng(8101)
        values = []
        for dataset in SETS:
            ix = [i for i, r in enumerate(rows) if r["dataset"] == dataset]
            delta = np.array(
                [
                    float(predictions[i]["top1"] == rows[i]["expected"])
                    - float(ref[i] == rows[i]["expected"])
                    for i in ix
                ]
            )
            values.append(
                delta[rng.integers(0, len(ix), size=(2000, len(ix)))].mean(axis=1)
            )
        return [float(v) for v in np.quantile(np.mean(values, axis=0), [0.025, 0.975])]

    interval = bootstrap([r[0]["id"] for r in baseorders])
    interval_v81 = bootstrap([parent_predictions[r["key"]] for r in rows])
    gate = dict(
        macro_plus_2pp=initial["macro_exact"] >= old["macro_exact"] + 0.02,
        pooled_plus_3=initial["pooled_exact"] >= old["pooled_exact"] + 3,
        field_floor=initial["datasets"]["FIELD51"]["exact"]
        >= v7["datasets"]["FIELD51"]["exact"] - 3,
        store_floor=initial["datasets"]["STORE13"]["exact"]
        >= v7["datasets"]["STORE13"]["exact"] - 2,
        no_dataset_loss=all(
            initial["datasets"][s]["exact"] >= old["datasets"][s]["exact"] for s in SETS
        ),
        three_datasets_improve=sum(
            initial["datasets"][s]["exact"] > old["datasets"][s]["exact"] for s in SETS
        )
        >= 3,
        sibling=initial["sibling"] <= v7["sibling"],
        bootstrap_positive_lower=interval[0] > 0,
    )
    gate["passed"] = all(gate.values())
    promotion = dict(
        field_floor=gate["field_floor"],
        store_floor=gate["store_floor"],
        nested_macro_improves_over_v8_and_v81=initial["macro_exact"]
        > max(old["macro_exact"], v81["macro_exact"]),
        bootstrap_not_materially_negative=min(interval[0], interval_v81[0]) >= -0.005,
    )
    promotion["passed"] = all(promotion.values())
    save(
        root / "changes.json",
        changes,
        dict(
            parser=parser_hash, input_inventory=digest(inventory), config=config.json()
        ),
    )
    result = dict(
        initial=initial,
        v8=old,
        v81=v81,
        v7=v7,
        config=config.json(),
        nested_lodo=dict(
            macro_exact=initial["macro_exact"],
            datasets=initial["datasets"],
            method="Fixed parser and scorer; no supervised fit/selection. Outer-held-out aggregate equals full replay; weight-grid nested search not run.",
        ),
        bootstrap_macro_delta_vs_v8_95=interval,
        bootstrap_macro_delta_vs_v81_95=interval_v81,
        initial_search_gate=gate,
        promotion_gate=promotion,
        grid_run=False,
        inference_performed=False,
        feature_counts=dict(feature_counts),
        field_counts=dict(field_counts),
        provenance_records=provenance_count,
        changed_top1=len(changes),
        changed_outcomes=dict(Counter(r["outcome"] for r in changes)),
        frozen_inputs_unchanged=all(
            sha(repo / path) == value for path, value in inventory.items()
        ),
        disposition="conditional_grid_required"
        if gate["passed"]
        else "V8-simple development closed; recommend V7-B for separately authorized untouched validation",
    )
    assert result["frozen_inputs_unchanged"]
    atomic_json(root / "summary.json", result)
    write_csv(
        root / "summary.csv",
        [
            dict(variant=name, dataset=s, **m)
            for name, record in (
                ("V8", old),
                ("V8.1", v81),
                ("V8.2-fixed", initial),
                ("V7-B", v7),
            )
            for s, m in record["datasets"].items()
        ],
    )
    write_csv(
        root / "feature-changes.csv",
        [dict(feature=k, count=v) for k, v in field_counts.items()],
    )
    write_csv(
        root / "changed-top1.csv",
        [
            {
                k: r[k]
                for k in (
                    "key",
                    "expected",
                    "v8",
                    "v82",
                    "v7",
                    "outcome",
                    "feature_file",
                )
            }
            for r in changes
        ],
    )
    atomic_json(
        root / "run-state.json",
        dict(
            status="initial_replay_complete",
            search_required=gate["passed"],
            image_inference_allowed=False,
        ),
    )
    print(
        json.dumps(
            dict(
                initial=initial,
                gate=gate,
                promotion=promotion,
                feature_counts=dict(feature_counts),
                changes=len(changes),
            )
        ),
        flush=True,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    args = ap.parse_args()
    with writer_lock(args.repo / ".generated/v82"):
        run(args.repo)


if __name__ == "__main__":
    main()
