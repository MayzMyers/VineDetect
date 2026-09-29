"""Validate completed offline artifacts and independently recount predictions."""

import argparse
import hashlib
import json
from pathlib import Path

from ..v8.checkpoint import atomic_json, digest, read
from .scorer import grid


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    repo = ap.parse_args().repo
    root = repo / ".generated/v81"
    inventory = json.loads((root / "input-inventory.json").read_text())
    assert all(sha(repo / path) == value for path, value in inventory.items()), (
        "Frozen input changed"
    )
    summary = json.loads((root / "summary.json").read_text())
    rows = json.loads((repo / ".generated/v7/image-manifest.json").read_text())
    groups = [
        set(r["catalogItemIds"])
        for r in json.loads(
            (
                repo / ".generated/irecommend531/gt-audit/equivalence_groups.json"
            ).read_text()
        )
    ]
    by_key = {r["key"]: r for r in rows}
    baseline = {}
    v7 = {}
    pools = {}
    for row in rows:
        key = hashlib.sha256(row["key"].encode()).hexdigest()
        data = json.loads(
            (repo / ".generated/v8/variants" / (key + "-V8-final.json")).read_text()
        )["payload"]
        baseline[row["key"]] = data["top1"]
        pools[row["key"]] = data["pool_ids"]
        v7[row["key"]] = json.loads(
            (repo / ".generated/v7/images" / (key + "-V7-B.json")).read_text()
        )["result"]["catalogItemId"]

    def recount(predictions, metrics):
        for dataset, m in metrics["datasets"].items():
            subset = [r for r in rows if r["dataset"] == dataset]
            exact = sum(predictions[r["key"]] == r["expected"] for r in subset)
            fixed = sum(
                predictions[r["key"]] == r["expected"] and v7[r["key"]] != r["expected"]
                for r in subset
            )
            broken = sum(
                predictions[r["key"]] != r["expected"] and v7[r["key"]] == r["expected"]
                for r in subset
            )
            siblings = sum(
                predictions[r["key"]] != r["expected"]
                and any(
                    predictions[r["key"]] in g and r["expected"] in g for g in groups
                )
                for r in subset
            )
            conditional = sum(
                predictions[r["key"]] == r["expected"]
                and r["expected"] in pools[r["key"]]
                for r in subset
            )
            denominator = sum(r["expected"] in pools[r["key"]] for r in subset)
            assert (exact, fixed, broken, siblings) == (
                m["exact"],
                m["fixed_v7"],
                m["broken_v7"],
                m["sibling"],
            )
            assert abs(conditional / denominator - m["conditional_accuracy"]) < 1e-12
        assert (
            sum(v["exact"] for v in metrics["datasets"].values())
            == metrics["pooled_exact"]
        )

    scorer_hash = sha(Path(__file__).parent / "scorer.py")
    results = {r["id"]: r for r in json.loads((root / "grid-results.json").read_text())}
    count = 0
    changed_count = 0
    for config in grid():
        records = read(
            root / "changes" / (config.key + ".json"),
            dict(
                config=config.json(),
                input_inventory=digest(inventory),
                scorer=scorer_hash,
            ),
        )
        assert records is not None, config.key
        assert len({r["key"] for r in records}) == len(records)
        predictions = dict(baseline)
        for r in records:
            assert r["v8"] == baseline[r["key"]] and r["v81"] in pools[r["key"]]
            assert r["expected"] == by_key[r["key"]]["expected"]
            predictions[r["key"]] = r["v81"]
            for candidate in r["candidates"]:
                for stage in ("before", "after"):
                    score = candidate[stage]["score"]
                    assert (
                        abs(sum(candidate[stage]["contributions"].values()) - score)
                        < 1e-12
                    )
        recount(predictions, results[config.key]["full"])
        count += 1
        changed_count += len(records)
    replay_count = 0
    for name, expected in (
        ("selected", summary["selected_full"]),
        ("selected-oof", summary["selected_oof"]),
        ("nested", summary["nested"]),
    ):
        path = root / (name + "-replay.json")
        prov = (
            dict(
                config=summary["selected_config"],
                anchors=summary["calibration_anchors_all_data"],
                input_inventory=digest(inventory),
            )
            if name == "selected"
            else dict(input_inventory=digest(inventory), scorer=scorer_hash)
        )
        records = read(path, prov)
        assert records is not None and len(records) == 232
        predictions = {}
        for r in records:
            assert r["top1"] == r["ordered"][0]["id"]
            assert set(x["id"] for x in r["ordered"]) == set(pools[r["key"]])
            assert r["ordered"] == sorted(
                r["ordered"], key=lambda x: (-x["score"], x["id"])
            )
            assert all(
                abs(sum(x["contributions"].values()) - x["score"]) < 1e-12
                for x in r["ordered"]
            )
            if name != "selected":
                assert (
                    by_key[r["key"]]["dataset"]
                    not in r["calibration_training_datasets"]
                )
            predictions[r["key"]] = r["top1"]
        recount(predictions, expected)
        replay_count += len(records)
    recount(baseline, summary["baseline_v8"])
    recount(v7, summary["baseline_v7"])
    assert summary["verification_gate"]["passed"] == all(
        v for k, v in summary["verification_gate"].items() if k != "passed"
    )
    assert not summary["inference_performed"]
    result = dict(
        frozen_input_files=len(inventory),
        frozen_input_hashes_unchanged=True,
        exact_v8_reproduction_images=232,
        grid_configurations=count,
        changed_decision_audits=changed_count,
        replay_records=replay_count,
        metrics_recounted=True,
        pool_membership_unchanged=True,
        contributions_sum_to_scores=True,
        heldout_calibration_exclusion=True,
        inference_performed=False,
    )
    atomic_json(root / "validation.json", result)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
