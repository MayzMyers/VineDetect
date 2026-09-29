"""Predeclared offline experiment. Reads frozen evidence, never runs inference."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

from ..v8.checkpoint import atomic_json, digest, read, save, writer_lock
from ..v8.config import Config
from ..v8.evaluate import provenance, EVIDENCE_FILES
from ..v8.ocr import CatalogText
from ..v8.report import SETS, baseline_records, predict, write_csv
from .scorer import Scoring, grid, fit_anchors, prepare, score, ranking


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def distribution(values):
    x = np.asarray(values, dtype=float)
    return dict(
        n=len(x),
        mean=float(x.mean()),
        std=float(x.std()),
        **{
            k: float(np.quantile(x, q))
            for k, q in (
                ("min", 0),
                ("p05", 0.05),
                ("p25", 0.25),
                ("p50", 0.5),
                ("p75", 0.75),
                ("p95", 0.95),
                ("max", 1),
            )
        },
    )


def load(repo, out):
    root = repo / ".generated/v8"
    manifest = repo / ".generated/v7/image-manifest.json"
    catalog_path = repo / ".runtime/v5-rc1/catalog.json"
    groups_path = repo / ".generated/irecommend531/gt-audit/equivalence_groups.json"
    rows = json.loads(manifest.read_text())
    assert len(rows) == 232 and set(r["dataset"] for r in rows) == set(SETS)
    config = Config(**json.loads((root / "selected-config.json").read_text()))
    assert (config.ks, config.kd, config.ko, config.kl, config.max_pool_size) == (
        20,
        20,
        3,
        15,
        0,
    )
    catalog = json.loads(catalog_path.read_text())["rows"]
    text = CatalogText(catalog)
    groups = [set(r["catalogItemIds"]) for r in json.loads(groups_path.read_text())]
    tracked = [
        manifest,
        catalog_path,
        groups_path,
        root / "selected-config.json",
        repo / "docs/V8-simple_onepager_v0.2.md",
        repo / "docs/V8_1_EXPERIMENT_PLAN.md",
    ]
    tracked += [repo / "vision-service/app/v8" / n for n in EVIDENCE_FILES]
    traces, prepared, baseline_orders = [], [], []
    parity = []
    report_hash = sha(repo / "vision-service/app/v8/report.py")
    for row in rows:
        key = hashlib.sha256(row["key"].encode()).hexdigest()
        path = root / "explore" / (key + ".json")
        record = read(path, provenance(repo, row, Config(), "explore"))
        if record is None or record["status"] != "ok":
            raise ValueError("Invalid source checkpoint: " + row["key"])
        trace = record["trace"]
        pred = predict(trace, config)
        variant = root / "variants" / (key + "-V8-final.json")
        saved = read(
            variant,
            dict(evidence=digest(trace), config=config.json(), report_code=report_hash),
        )
        assert saved is not None, row["key"]
        assert pred["pool_ids"] == saved["pool_ids"]
        assert pred["top1"] == saved["top1"] and pred["margin"] == saved["margin"]
        assert [(r["id"], r["score"], r["contributions"]) for r in pred["ordered"]] == [
            (r["id"], r["score"], r["contributions"]) for r in saved["ordered"]
        ]
        p = prepare(trace, pred["pool_ids"], text.idf)
        control = ranking(p, Scoring(), {})
        assert [(r["id"], r["score"], r["contributions"]) for r in control] == [
            (r["id"], r["score"], r["contributions"]) for r in pred["ordered"]
        ], row["key"]
        traces.append(trace)
        prepared.append(p)
        baseline_orders.append(control)
        parity.append(
            dict(
                key=row["key"],
                pool=len(p["ids"]),
                exact_order_score_contribution_margin=True,
            )
        )
        tracked.extend([path, variant])
        tracked.extend(
            repo / ".generated/v7/images" / (key + "-" + v + ".json")
            for v in ("V5", "V7-B")
        )
    inventory = {str(p.relative_to(repo)): sha(p) for p in tracked}
    atomic_json(out / "input-inventory.json", inventory)
    atomic_json(out / "baseline-parity.json", dict(n=232, all_exact=True, rows=parity))
    return (
        rows,
        traces,
        prepared,
        baseline_orders,
        baseline_records(repo, rows),
        groups,
        catalog,
        inventory,
    )


def run(repo):
    out = repo / ".generated/v81"
    rows, traces, prepared, baseorders, baseline, groups, catalog, inventory = load(
        repo, out
    )
    print(
        "Exact V8 reproduction: 232/232 complete orders, scores, contributions and margins",
        flush=True,
    )
    configs = grid()
    assert len(configs) == 102
    atomic_json(out / "predeclared-grid.json", [c.json() for c in configs])
    gt = np.array([r["expected"] for r in rows])
    v8 = np.array([o[0]["id"] for o in baseorders])
    v7 = np.array([baseline[r["key"]]["V7-B"] for r in rows])
    masks = {s: np.array([r["dataset"] == s for r in rows]) for s in SETS}
    inpool = np.array([g in p["ids"] for g, p in zip(gt, prepared)])

    def metrics(pred, datasets=SETS):
        stats = {}
        for s in datasets:
            ix = np.flatnonzero(masks[s])
            truth, new, old = gt[ix], pred[ix], v7[ix]
            exact = new == truth
            sibling = sum(
                int(cid != g and any(cid in group and g in group for group in groups))
                for cid, g in zip(new, truth)
            )
            stats[s] = dict(
                n=len(ix),
                exact=int(exact.sum()),
                accuracy=float(exact.mean()),
                fixed_v7=int(((new == truth) & (old != truth)).sum()),
                broken_v7=int(((new != truth) & (old == truth)).sum()),
                sibling=sibling,
                gt_in_pool=int(inpool[ix].sum()),
                conditional_accuracy=float(
                    (exact & inpool[ix]).sum() / inpool[ix].sum()
                ),
            )
        return dict(
            datasets=stats,
            pooled_exact=sum(v["exact"] for v in stats.values()),
            n=sum(v["n"] for v in stats.values()),
            macro_exact=float(np.mean([v["accuracy"] for v in stats.values()])),
            sibling=sum(v["sibling"] for v in stats.values()),
            fixed_v7=sum(v["fixed_v7"] for v in stats.values()),
            broken_v7=sum(v["broken_v7"] for v in stats.values()),
            conditional_accuracy=sum(
                v["conditional_accuracy"] * v["gt_in_pool"] for v in stats.values()
            )
            / sum(v["gt_in_pool"] for v in stats.values()),
        )

    v7stats = metrics(v7)
    v8stats = metrics(v8)
    cache = {}
    anchors_cache = {}

    def predictions(training):
        training = tuple(s for s in SETS if s in training)
        if training in cache:
            return cache[training]
        anchors = fit_anchors(
            [t for r, t in zip(rows, traces) if r["dataset"] in training]
        )
        anchors_cache[training] = anchors
        matrix = np.empty((len(configs), len(rows)), dtype=int)
        for k, c in enumerate(configs):
            for i, p in enumerate(prepared):
                values = score(p, c, anchors)
                # IDs were sorted before preparation; argmax resolves ties by ID.
                matrix[k, i] = p["ids"][int(np.argmax(values))]
        cache[training] = matrix
        print("Scored calibration training sets: " + ",".join(training), flush=True)
        return matrix

    def feasible(m, datasets):
        return all(
            m["datasets"][s]["exact"] >= v7stats["datasets"][s]["exact"] - allow
            for s, allow in (("FIELD51", 3), ("STORE13", 2))
            if s in datasets
        )

    def choose(matrix, datasets, indices=None):
        indices = range(len(configs)) if indices is None else indices
        stats = {k: metrics(matrix[k], datasets) for k in indices}
        admitted = [k for k in stats if feasible(stats[k], datasets)]

        def key(k):
            m = stats[k]
            deficit = sum(
                max(0, v7stats["datasets"][s]["exact"] - m["datasets"][s]["exact"])
                for s in ("FIELD51", "STORE13")
                if s in datasets
            )
            return (
                -m["macro_exact"],
                deficit,
                m["sibling"],
                -m["pooled_exact"],
                configs[k].key,
            )

        winner = min(admitted or stats, key=key)
        return winner, bool(admitted), stats

    # Outer five-fold predictions for full-development parameter selection.
    oof = np.zeros((len(configs), len(rows)), dtype=int)
    for held in SETS:
        train = [s for s in SETS if s != held]
        oof[:, masks[held]] = predictions(train)[:, masks[held]]
    chosen, eligible, oofstats = choose(oof, SETS)
    full = predictions(SETS)
    allanchors = anchors_cache[tuple(SETS)]
    nested = np.zeros(len(rows), dtype=int)
    nested_rows = []
    for outer in SETS:
        training = [s for s in SETS if s != outer]
        inner = np.zeros_like(oof)
        for held in training:
            innertrain = [s for s in training if s != held]
            inner[:, masks[held]] = predictions(innertrain)[:, masks[held]]
        k, ok, _ = choose(inner, training)
        nested[masks[outer]] = predictions(training)[k, masks[outer]]
        nested_rows.append(
            dict(
                heldout=outer,
                config=configs[k].json(),
                config_id=configs[k].key,
                inner_eligible=ok,
                heldout_metrics=metrics(nested, [outer])["datasets"][outer],
            )
        )
    fullstats = [metrics(p) for p in full]
    selected = fullstats[chosen]
    nestedstats = metrics(nested)
    rng = np.random.default_rng(8101)
    differences = []
    for s in SETS:
        ix = np.flatnonzero(masks[s])
        delta = (nested[ix] == gt[ix]).astype(float) - (v8[ix] == gt[ix]).astype(float)
        differences.append(
            delta[rng.integers(0, len(ix), size=(2000, len(ix)))].mean(axis=1)
        )
    bootstrap = np.mean(differences, axis=0)
    interval = [float(x) for x in np.quantile(bootstrap, [0.025, 0.975])]
    gate = dict(
        full_macro=selected["macro_exact"] >= v8stats["macro_exact"] + 0.02,
        full_pooled=selected["pooled_exact"] >= v8stats["pooled_exact"] + 3,
        full_field_store=feasible(selected, SETS),
        nested_field_store=feasible(nestedstats, SETS),
        full_siblings=selected["sibling"] <= v7stats["sibling"],
        nested_siblings=nestedstats["sibling"] <= v7stats["sibling"],
        full_no_dataset_loss=all(
            selected["datasets"][s]["exact"] >= v8stats["datasets"][s]["exact"]
            for s in SETS
        ),
        nested_no_dataset_loss=all(
            nestedstats["datasets"][s]["exact"] >= v8stats["datasets"][s]["exact"]
            for s in SETS
        ),
        nested_improves_three=sum(
            nestedstats["datasets"][s]["exact"] > v8stats["datasets"][s]["exact"]
            for s in SETS
        )
        >= 3,
        nested_macro=nestedstats["macro_exact"] >= v8stats["macro_exact"] + 0.01,
        nested_pooled=nestedstats["pooled_exact"] >= v8stats["pooled_exact"] + 2,
        bootstrap_positive_lower=interval[0] > 0,
    )
    gate["passed"] = all(gate.values())
    controls = {
        "V8-exact": Scoring(),
        "R1-minmax-only": Scoring(semantic="minmax"),
        "R1-calibrated-only": Scoring(semantic="calibrated_cosine"),
        "R2-structured": Scoring(ocr="structured", attribute=0.4, conflict=1.0),
        "R3-shared-family": Scoring(ocr="shared_family", attribute=0.4, conflict=1.0),
        "selected": configs[chosen],
    }
    for mode in ("legacy", "structured", "shared_family"):
        ix = [k for k, c in enumerate(configs) if c.ocr == mode]
        k, ok, _ = choose(oof, SETS, ix)
        controls["best-" + mode] = configs[k]
    config_lookup = {c.key: i for i, c in enumerate(configs)}
    result = dict(
        baseline_v8=v8stats,
        baseline_v7=v7stats,
        selected_config=configs[chosen].json(),
        selected_id=configs[chosen].key,
        selection_eligible=eligible,
        selected_full=selected,
        selected_oof=oofstats[chosen],
        nested=nestedstats,
        nested_folds=nested_rows,
        bootstrap_nested_macro_delta_95=interval,
        verification_gate=gate,
        inference_performed=False,
        controls={
            name: dict(
                config=c.json(),
                full=fullstats[config_lookup[c.key]],
                oof=oofstats[config_lookup[c.key]],
            )
            for name, c in controls.items()
        },
        calibration_anchors_all_data=allanchors,
        limitations=[
            "Consumed development data only; no new-device generalization claim.",
            "Authoritative sibling groups are incomplete; potential siblings are separately labelled.",
            "Stored OCR parser omissions and disjoint-conflict semantics remain frozen.",
            "Only source Top30 similarities were retained; missing similarities stay explicitly missing.",
        ],
    )
    gridrows = []
    for k, c in enumerate(configs):
        gridrows.append(
            dict(
                id=c.key,
                config=c.json(),
                full=fullstats[k],
                oof=oofstats[k],
                eligible=feasible(oofstats[k], SETS),
            )
        )
    atomic_json(out / "grid-results.json", gridrows)
    write_csv(
        out / "grid-results.csv",
        [
            dict(
                id=r["id"],
                **r["config"],
                full_macro=r["full"]["macro_exact"],
                full_pooled=r["full"]["pooled_exact"],
                oof_macro=r["oof"]["macro_exact"],
                oof_pooled=r["oof"]["pooled_exact"],
                eligible=r["eligible"],
            )
            for r in gridrows
        ],
    )
    statsrows = []
    for name, item in {
        "V8": v8stats,
        "V7-B": v7stats,
        "V81-selected": selected,
        "V81-nested": nestedstats,
    }.items():
        statsrows.extend(
            dict(variant=name, dataset=s, **m) for s, m in item["datasets"].items()
        )
    write_csv(out / "summary.csv", statsrows)
    catalog_parts = CatalogText(catalog).parts
    slugs = {r["catalog_item_id"]: r["official_slug"] for r in catalog}
    distributions = {}
    changed_counts = {}
    # Every changed decision in every grid candidate has a contribution audit.
    for k, c in enumerate(configs):
        changes = []
        for i in np.flatnonzero(full[k] != v8):
            order = ranking(prepared[i], c, allanchors)
            lookup = {r["id"]: r for r in order}
            before = {r["id"]: r for r in baseorders[i]}
            cid, old, truth = int(full[k, i]), int(v8[i]), int(gt[i])
            shared_prod = (
                catalog_parts[cid]["producer"] & catalog_parts[truth]["producer"]
            )
            shared_product = (
                catalog_parts[cid]["product"] & catalog_parts[truth]["product"]
            )
            selected_candidates = set((cid, old, truth)) & set(lookup)
            changes.append(
                dict(
                    key=rows[i]["key"],
                    expected=truth,
                    v8=old,
                    v81=cid,
                    v7=int(v7[i]),
                    gt_in_pool=bool(inpool[i]),
                    authoritative_sibling=cid != truth
                    and any(cid in g and truth in g for g in groups),
                    potential_sibling=cid != truth
                    and bool(shared_prod and shared_product),
                    ocr_text=traces[i]["ocr"]["text"],
                    candidates=[
                        dict(
                            id=j,
                            slug=slugs[j],
                            before=before[j],
                            after=lookup[j],
                            contribution_delta={
                                f: lookup[j]["contributions"].get(f, 0)
                                - before[j]["contributions"].get(f, 0)
                                for f in set(lookup[j]["contributions"])
                                | set(before[j]["contributions"])
                            },
                            saved_ocr=traces[i]["evidence"][str(j)]["ocr"],
                        )
                        for j in sorted(selected_candidates)
                    ],
                    winner_minus_gt={
                        f: lookup[cid]["contributions"].get(f, 0)
                        - lookup[truth]["contributions"].get(f, 0)
                        for f in lookup[cid]["contributions"]
                    }
                    if truth in lookup
                    else None,
                )
            )
        save(
            out / "changes" / (c.key + ".json"),
            changes,
            dict(
                config=c.json(),
                input_inventory=digest(inventory),
                scorer=sha(Path(__file__).parent / "scorer.py"),
            ),
        )
        changed_counts[c.key] = len(changes)
    for name, c in controls.items():
        scores, semantics, deltas, margins, moves, inversions = [], [], [], [], [], []
        order_changes = 0
        traces_out = []
        for i, p in enumerate(prepared):
            order = ranking(p, c, allanchors)
            before = baseorders[i]
            ids = [r["id"] for r in order]
            oldids = [r["id"] for r in before]
            order_changes += ids != oldids
            oldposition = {cid: j for j, cid in enumerate(oldids)}
            positions = [oldposition[cid] for cid in ids]
            inversions.append(
                sum(
                    positions[a] > positions[b]
                    for a in range(len(ids))
                    for b in range(a + 1, len(ids))
                )
                / max(1, len(ids) * (len(ids) - 1) / 2)
            )
            moves.extend(abs(j - oldposition[cid]) for j, cid in enumerate(ids))
            oldscore = {r["id"]: r["score"] for r in before}
            scores.extend(r["score"] for r in order)
            semantics.extend(r["contributions"]["semantic"] for r in order)
            deltas.extend(r["score"] - oldscore[r["id"]] for r in order)
            margins.append(order[0]["score"] - order[1]["score"])
            if name == "selected":
                traces_out.append(
                    dict(
                        key=rows[i]["key"],
                        expected=int(gt[i]),
                        pool_ids=p["ids"],
                        top1=order[0]["id"],
                        slug=slugs[order[0]["id"]],
                        ordered=order,
                        family_reference_ids=p["family_reference_ids"],
                        family_token_membership=p["family_token_membership"],
                    )
                )
        distributions[name] = dict(
            score=distribution(scores),
            semantic=distribution(semantics),
            score_delta=distribution(deltas),
            margin=distribution(margins),
            complete_order_changes=order_changes,
            top1_changes=changed_counts[c.key],
            mean_absolute_rank_movement=float(np.mean(moves)),
            mean_pairwise_order_disagreement=float(np.mean(inversions)),
        )
        if name == "selected":
            save(
                out / "selected-replay.json",
                traces_out,
                dict(
                    config=c.json(),
                    anchors=allanchors,
                    input_inventory=digest(inventory),
                ),
            )
    fold_by_name = {r["heldout"]: r for r in nested_rows}
    for label in ("selected-oof", "nested"):
        records = []
        for i, row in enumerate(rows):
            training = tuple(s for s in SETS if s != row["dataset"])
            c = (
                configs[chosen]
                if label == "selected-oof"
                else Scoring(**fold_by_name[row["dataset"]]["config"])
            )
            order = ranking(prepared[i], c, anchors_cache[training])
            old = {r["id"]: r for r in baseorders[i]}
            lookup = {r["id"]: r for r in order}
            changed = order[0]["id"] != int(v8[i])
            focus = {int(v8[i]), int(gt[i]), order[0]["id"]} & set(lookup)
            records.append(
                dict(
                    key=row["key"],
                    expected=int(gt[i]),
                    v8=int(v8[i]),
                    top1=order[0]["id"],
                    changed=changed,
                    config=c.json(),
                    calibration_training_datasets=list(training),
                    ordered=order,
                    changed_candidate_contributions=[
                        dict(
                            id=cid,
                            before=old[cid],
                            after=lookup[cid],
                            delta={
                                f: lookup[cid]["contributions"].get(f, 0)
                                - old[cid]["contributions"].get(f, 0)
                                for f in set(lookup[cid]["contributions"])
                                | set(old[cid]["contributions"])
                            },
                        )
                        for cid in sorted(focus)
                    ]
                    if changed
                    else [],
                )
            )
        save(
            out / (label + "-replay.json"),
            records,
            dict(
                input_inventory=digest(inventory),
                scorer=sha(Path(__file__).parent / "scorer.py"),
            ),
        )
    result["score_distributions_and_orders"] = distributions
    result["changed_decisions_by_config"] = changed_counts
    result["inputs_unchanged"] = all(
        sha(repo / path) == value for path, value in inventory.items()
    )
    assert result["inputs_unchanged"]
    atomic_json(out / "summary.json", result)
    atomic_json(
        out / "selected-scoring.json",
        dict(
            config=configs[chosen].json(),
            anchors=allanchors,
            input_inventory_sha256=digest(inventory),
            plan_sha256=sha(repo / "docs/V8_1_EXPERIMENT_PLAN.md"),
            scorer_sha256=sha(Path(__file__).parent / "scorer.py"),
            verification_authorized_by_gate=gate["passed"],
        ),
    )
    print(
        json.dumps(
            dict(
                selected=configs[chosen].json(),
                full=selected,
                nested=nestedstats,
                gate=gate,
            )
        ),
        flush=True,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    args = parser.parse_args()
    with writer_lock(args.repo / ".generated/v81"):
        run(args.repo)


if __name__ == "__main__":
    main()
