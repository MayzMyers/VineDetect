"""Independent frozen-input, provenance, contribution and outcome audit."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

from ..v8.checkpoint import atomic_json, digest, read
from ..v8.config import Config
from ..v8.evaluate import provenance


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def score_fingerprint(value):
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    repo = ap.parse_args().repo
    root = repo / ".generated/v82"
    inventory = json.loads((root / "input-inventory.json").read_text())
    assert all(sha(repo / path) == value for path, value in inventory.items())
    summary = json.loads((root / "summary.json").read_text())
    rows = json.loads((repo / ".generated/v7/image-manifest.json").read_text())
    catalog = {
        r["catalog_item_id"]: r
        for r in json.loads((repo / ".runtime/v5-rc1/catalog.json").read_text())["rows"]
    }
    config = Config(**summary["config"])
    assert config.weights == [1.0, 0.6, 0.0, 0.6, 0.05]
    parser_hash = sha(Path(__file__).parent / "parser.py")
    counts = Counter()
    metrics = {}
    scored = {}
    snapshot = json.loads(
        (root / "score-before-provenance-completion.json").read_text()
    )
    for row in rows:
        key = hashlib.sha256(row["key"].encode()).hexdigest()
        parent = read(
            repo / ".generated/v8/explore" / (key + ".json"),
            provenance(repo, row, Config(), "explore"),
        )
        assert parent is not None
        trace = parent["trace"]
        prov = dict(
            parent_trace=digest(trace),
            parser=parser_hash,
            config=config.json(),
            input_inventory=digest(inventory),
        )
        features = read(root / "features" / (key + ".json"), prov)
        replay = read(root / "replay" / (key + ".json"), prov)
        assert features is not None and replay is not None
        assert score_fingerprint(replay["ordered"]) == snapshot[key + ".json"]
        old = json.loads(
            (repo / ".generated/v8/variants" / (key + "-V8-final.json")).read_text()
        )["payload"]
        old_by_id = {r["id"]: r for r in old["ordered"]}
        assert (
            set(replay["pool_ids"])
            == set(old["pool_ids"])
            == {int(cid) for cid in features["candidates"]}
        )
        assert replay["top1"] == replay["ordered"][0]["id"]
        assert replay["ordered"] == sorted(
            replay["ordered"], key=lambda r: (-r["score"], r["id"])
        )
        for candidate in replay["ordered"]:
            for group in ("semantic", "geometry", "quality"):
                assert (
                    candidate["contributions"][group]
                    == old_by_id[candidate["id"]]["contributions"][group]
                )
            assert candidate["contributions"]["ocr_attributes"] == 0
            assert (
                abs(sum(candidate["contributions"].values()) - candidate["score"])
                < 1e-12
            )
        raw = " ".join(trace["ocr"]["texts"])
        for cid, feature in features["candidates"].items():
            counts["candidate_vectors"] += 1
            for field, data in feature["fields"].items():
                assert data["provenance"], "Missing neutral-field lineage"
                for p in data["provenance"]:
                    counts["provenance_records"] += 1
                    observed = p["ocr"]
                    if observed:
                        span = observed["ocr_span"]
                        assert raw[span["start"] : span["end"]] == span["text"]
                        confidence = min(
                            trace["ocr"]["confidences"][i] for i in span["lines"]
                        )
                        assert confidence == p["confidence"] == observed["confidence"]
                        assert observed["parser_rule"]
                    elif p["status"] in ("missing_neutral", "absent_neutral"):
                        assert p["confidence"] is None
                    catalogs = (
                        p["catalog"]
                        if isinstance(p["catalog"], list)
                        else [p["catalog"]]
                        if p["catalog"]
                        else []
                    )
                    for source in catalogs:
                        original = str(
                            catalog[int(cid)].get(source["catalog_field"], "") or ""
                        )
                        span = source["catalog_span"]
                        assert original[span["start"] : span["end"]] == span["text"]
                    if p["status"] == "conflict":
                        assert observed and observed["confidence"] >= 0.85 and catalogs
                        assert all(
                            e["genuinely_typed"]
                            and e["catalog_field"]
                            not in ("title", "official_slug", "description", "color")
                            for e in catalogs
                        )
                        counts["typed_conflicts"] += 1
        stat = metrics.setdefault(row["dataset"], Counter())
        correct = replay["top1"] == row["expected"]
        stat["n"] += 1
        stat["exact"] += correct
        stat["fixed_v7"] += correct and replay["v7"] != row["expected"]
        stat["broken_v7"] += not correct and replay["v7"] == row["expected"]
        stat["gt_in_pool"] += row["expected"] in replay["pool_ids"]
        scored[row["key"]] = replay
        counts["replay_records"] += 1
    for dataset, stat in metrics.items():
        for field, value in stat.items():
            assert summary["initial"]["datasets"][dataset][field] == value
    assert counts["candidate_vectors"] == summary["feature_counts"]["candidate_vectors"]
    assert counts["provenance_records"] == summary["provenance_records"]
    assert (
        sum(m["exact"] for m in metrics.values()) == summary["initial"]["pooled_exact"]
    )
    assert (
        abs(
            sum(m["exact"] / m["n"] for m in metrics.values()) / 5
            - summary["initial"]["macro_exact"]
        )
        < 1e-12
    )
    changes = read(
        root / "changes.json",
        dict(
            parser=parser_hash, input_inventory=digest(inventory), config=config.json()
        ),
    )
    assert changes is not None
    changed = {k for k, r in scored.items() if r["top1"] != r["v8"]}
    assert {r["key"] for r in changes} == changed
    for r in changes:
        for candidate in r["candidates"]:
            for field, value in candidate["contribution_delta"].items():
                assert (
                    value
                    == candidate["after"]["contributions"][field]
                    - candidate["before"]["contributions"][field]
                )
    result = dict(
        frozen_input_files=len(inventory),
        frozen_inputs_unchanged=True,
        **dict(counts),
        unchanged_scores_after_provenance_completion=True,
        weights_and_non_ocr_contributions_unchanged=True,
        pool_membership_unchanged=True,
        ocr_and_catalog_spans_verified=True,
        conflict_typing_and_confidence_verified=True,
        changed_top1_audits=len(changes),
        metrics_independently_recounted=True,
    )
    atomic_json(root / "validation.json", result)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
