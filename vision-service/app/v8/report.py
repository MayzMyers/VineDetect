"""Consumed-development selection and complete auditable V8 summaries."""

import argparse
import csv
import hashlib
import itertools
import json
from collections import Counter, defaultdict
from dataclasses import replace
from pathlib import Path
import numpy as np
from .checkpoint import atomic_json, digest, read, save, writer_lock
from .config import Config, SOURCES
from .pool import build_pool
from .rerank import rank
from .evaluate import provenance

SETS = ("FIELD51", "UNSEEN32", "STORE13", "FRESH8", "IRECOMMEND128")
KS = (1, 5, 10, 15, 20, 30)


def percentile(values):
    return dict(
        n=len(values),
        p50=float(np.percentile(values, 50)) if values else None,
        p95=float(np.percentile(values, 95)) if values else None,
        average=float(np.mean(values)) if values else None,
    )


def write_csv(path, rows, fields=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf8") as stream:
        fields = (
            fields or list(dict.fromkeys(k for row in rows for k in row)) or ["key"]
        )
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    k: json.dumps(v, ensure_ascii=False)
                    if isinstance(v, (list, dict, tuple))
                    else v
                    for k, v in row.items()
                }
            )


def macro(by_dataset, field, exclude=None):
    rows = [v for k, v in by_dataset.items() if k != exclude]
    return sum(r[field] / r["n"] for r in rows) / len(rows)


def config_grid(label):
    # A reduced, predeclared recall grid; weights/Top1 are never read here.
    for ks, kd, ko, kl, cap in itertools.product(
        (10, 15, 20, 30),
        (5, 10, 15, 20),
        (0, 3, 5, 10),
        (0, 15) if label else (0,),
        (0, 15, 20, 30, 40),
    ):
        if cap and cap < ks:
            continue
        yield Config(ks=ks, kd=kd, ko=ko, kl=kl, max_pool_size=cap)


def metrics(rows, predictions, baseline, groups):
    stats = {
        s: dict(
            n=0,
            exact=0,
            family=0,
            sibling=0,
            fixed_v5=0,
            broken_v5=0,
            fixed_v7=0,
            broken_v7=0,
            gt_in_pool=0,
            conditional_correct=0,
        )
        for s in SETS
    }
    for row, pred in zip(rows, predictions):
        stat = stats[row["dataset"]]
        gt = row["expected"]
        cid = pred["top1"]
        key = row["key"]
        same = cid == gt or any(cid in g and gt in g for g in groups)
        stat["n"] += 1
        stat["exact"] += int(cid == gt)
        stat["family"] += int(same)
        stat["sibling"] += int(cid != gt and same)
        stat["gt_in_pool"] += int(gt in pred["pool_ids"])
        stat["conditional_correct"] += int(cid == gt and gt in pred["pool_ids"])
        for variant, suffix in (("V5", "v5"), ("V7-B", "v7")):
            old = baseline[key][variant]
            stat["fixed_" + suffix] += int(cid == gt and old != gt)
            stat["broken_" + suffix] += int(cid != gt and old == gt)
    return stats


def baseline_records(repo, rows):
    result = {}
    for row in rows:
        key = hashlib.sha256(row["key"].encode()).hexdigest()
        result[row["key"]] = {}
        for variant in ("V5", "V7-B"):
            data = json.loads(
                (
                    repo / ".generated/v7/images" / (key + "-" + variant + ".json")
                ).read_text()
            )
            if (
                data["key"] != row["key"]
                or data["imageSha256"] != row["sha256"]
                or data["expected"] != row["expected"]
            ):
                raise ValueError("Benchmark reference identity mismatch")
            result[row["key"]][variant] = data["result"]["catalogItemId"]
    return result


def predict(trace, config):
    if "sources" not in trace:
        return dict(top1=None, pool_ids=[], ordered=[], margin=None, nominees=[])
    pool, nominees = build_pool(trace["sources"], config)
    ordered = rank(pool, trace["evidence"], trace["sources"], config)
    return dict(
        top1=ordered[0]["id"] if ordered else None,
        top2=ordered[1]["id"] if len(ordered) > 1 else None,
        pool_ids=[r["id"] for r in pool],
        ordered=ordered,
        nominees=nominees,
        margin=ordered[0]["score"] - ordered[1]["score"] if len(ordered) > 1 else None,
    )


def select_pools(rows, traces):
    unique = {s: [] for s in SOURCES}
    depths = dict(siglip=30, dino=20, ocr=10, label_siglip=15)
    for row, trace in zip(rows, traces):
        lists = {
            s: {r["id"] for r in trace.get("sources", {}).get(s, [])[: depths[s]]}
            for s in SOURCES
        }
        for s in SOURCES:
            if row["expected"] in lists[s] - set().union(
                *(lists[k] for k in SOURCES if k != s)
            ):
                unique[s].append(row["key"])
    records = []
    for config in config_grid(bool(unique["label_siglip"])):
        by = {s: dict(n=0, hits=0, size=0) for s in SETS}
        sizes = []
        for row, trace in zip(rows, traces):
            pool, _ = build_pool(trace.get("sources", {}), config)
            stat = by[row["dataset"]]
            stat["n"] += 1
            stat["hits"] += int(any(r["id"] == row["expected"] for r in pool))
            stat["size"] += len(pool)
            sizes.append(len(pool))
        records.append(
            dict(
                config=config.json(),
                datasets=by,
                macro_recall=macro(by, "hits"),
                hits=sum(v["hits"] for v in by.values()),
                pool_size=percentile(sizes),
            )
        )

    def choose(exclude=None):
        allowed = [
            r
            for r in records
            if not r["config"]["kl"]
            or any(
                not key.startswith((exclude or "!") + "/")
                for key in unique["label_siglip"]
            )
        ]
        # Maximum macro recall, then pooled recall, then minimum verification work.
        return max(
            allowed,
            key=lambda r: (
                macro(r["datasets"], "hits", exclude),
                sum(v["hits"] for k, v in r["datasets"].items() if k != exclude),
                -sum(
                    v["size"] / v["n"] for k, v in r["datasets"].items() if k != exclude
                ),
                -r["config"]["kl"],
                -r["config"]["ks"],
            ),
        )

    selected = choose()
    lodo = {
        s: dict(
            config=choose(s)["config"],
            heldout_recall=choose(s)["datasets"][s]["hits"]
            / choose(s)["datasets"][s]["n"],
        )
        for s in SETS
    }
    return Config(**selected["config"]), records, unique, lodo


def weight_grid():
    for oi, attr, geom, dino in itertools.product(
        (0.0, 0.3, 0.6), (0.0, 0.2), (0.0, 0.3, 0.6), (0.0, 0.25, 0.5)
    ):
        yield (1.0, oi, attr, geom, 0.05), dino


def select_weights(rows, traces, pool_config, baseline, groups):
    candidates = []
    predictions = []
    for weights, dw in weight_grid():
        config = replace(pool_config, weights=weights, dino_weight=dw)
        preds = [predict(trace, config) for trace in traces]
        stats = metrics(rows, preds, baseline, groups)
        candidates.append(
            dict(
                config=config.json(),
                datasets=stats,
                macro_accuracy=macro(stats, "exact"),
                pooled=sum(s["exact"] for s in stats.values()),
                broken=sum(s["broken_v7"] for s in stats.values()),
                siblings=sum(s["sibling"] for s in stats.values()),
            )
        )
        predictions.append([p["top1"] for p in preds])
    # Explicit constraints: <=20% correct V7 rows broken, FIELD/STORE drops <=3/2,
    # and no increase in authoritative same-family wrong predictions.
    basepred = [dict(top1=baseline[r["key"]]["V7-B"], pool_ids=[]) for r in rows]
    basestats = metrics(rows, basepred, baseline, groups)

    def feasible(candidate, exclude=None):
        stats = candidate["datasets"]
        sets = [s for s in SETS if s != exclude]
        return (
            sum(stats[s]["broken_v7"] for s in sets)
            <= 0.20 * sum(stats[s]["n"] for s in sets)
            and all(
                stats[s]["exact"] >= basestats[s]["exact"] - allowance
                for s, allowance in (("FIELD51", 3), ("STORE13", 2))
                if s != exclude
            )
            and sum(stats[s]["sibling"] for s in sets)
            <= sum(basestats[s]["sibling"] for s in sets)
        )

    def choose(exclude=None):
        admissible = [r for r in candidates if feasible(r, exclude)]
        feasible_any = bool(admissible)
        admissible = admissible or candidates
        # Primary macro, pooled secondary; no product-specific exceptions.
        best = max(
            admissible,
            key=lambda r: (
                macro(r["datasets"], "exact", exclude),
                sum(v["exact"] for k, v in r["datasets"].items() if k != exclude),
                -sum(v["broken_v7"] for k, v in r["datasets"].items() if k != exclude),
            ),
        )
        return best, feasible_any

    best, ok = choose()
    lodo = {
        s: dict(
            config=choose(s)[0]["config"],
            constraints_feasible=choose(s)[1],
            heldout_accuracy=choose(s)[0]["datasets"][s]["exact"]
            / choose(s)[0]["datasets"][s]["n"],
        )
        for s in SETS
    }
    return Config(**best["config"]), candidates, lodo, ok


def taxonomy(row, trace, pred, groups, manual=None):
    gt = row["expected"]
    ordered = pred["ordered"]
    flags = []
    if trace.get("target", {}).get("manual_audit_required") or row["key"] in (
        manual or {}
    ):
        flags.append("TARGET_SUSPECT")
    if gt not in pred["pool_ids"]:
        flags.append("RETRIEVAL_MISS")
    else:
        flags.append("RERANK_ERROR")
    if pred["margin"] is None or pred["margin"] < 0.03:
        flags.append("LOW_INFORMATION")
    if len(ordered) > 1 and any(
        ordered[0]["id"] in g and ordered[1]["id"] in g for g in groups
    ):
        flags.append("SIBLING_AMBIGUITY")
    if ordered:
        top = ordered[0]
        gtrow = next((r for r in ordered if r["id"] == gt), None)
        if gtrow:
            if (
                top["groups"]["ocr_identity"] - gtrow["groups"]["ocr_identity"] > 0.25
                or gtrow["raw"]["ocr"]["attribute_conflict"] > 0.3
            ):
                flags.append("OCR_CONFLICT")
            if top["groups"]["geometry"] - gtrow["groups"]["geometry"] > 0.25:
                flags.append("GEOMETRY_CONFLICT")
        dino = trace.get("sources", {}).get("dino", [])
        if (
            len(dino) > 1
            and dino[0]["id"] != gt
            and dino[0]["score"] - dino[1]["score"] > 0.03
        ):
            flags.append("DINO_CONFLICT")
    return flags[0], flags[1:]


def run(args):
    repo = args.repo
    root = repo / ".generated/v8"
    rows = json.loads((repo / ".generated/v7/image-manifest.json").read_text())
    traces = []
    payloads = []
    for row in rows:
        key = hashlib.sha256(row["key"].encode()).hexdigest()
        value = read(
            root / "explore" / (key + ".json"),
            provenance(repo, row, Config(), "explore"),
        )
        if value is None:
            raise RuntimeError("Missing/corrupt/stale evidence: " + row["key"])
        payloads.append(value)
        traces.append(value["trace"])
    baseline = baseline_records(repo, rows)
    groups = [
        set(x["catalogItemIds"])
        for x in json.loads(
            (
                repo / ".generated/irecommend531/gt-audit/equivalence_groups.json"
            ).read_text()
        )
    ]
    pool, pool_grid, unique, pool_lodo = select_pools(rows, traces)
    atomic_json(root / "pool-sensitivity.json", pool_grid)
    selected, weights, weight_lodo, constraints = select_weights(
        rows, traces, pool, baseline, groups
    )
    atomic_json(root / "weight-sensitivity.json", weights)
    atomic_json(root / "selected-config.json", selected.json())
    # Nested LODO: both pool and weights are chosen without the excluded dataset.
    nested = {}
    for excluded in SETS:
        fold_pool = Config(**pool_lodo[excluded]["config"])
        _, _, fold_weights, _ = select_weights(
            rows, traces, fold_pool, baseline, groups
        )
        fold = Config(**fold_weights[excluded]["config"])
        preds = [predict(t, fold) for t in traces]
        fold_stats = metrics(rows, preds, baseline, groups)
        nested[excluded] = dict(
            config=fold.json(),
            heldout_accuracy=fold_stats[excluded]["exact"] / fold_stats[excluded]["n"],
            constraints_feasible=fold_weights[excluded]["constraints_feasible"],
        )
    variants = {
        "V8-S0": replace(selected, kd=0, ko=0, kl=0, geometry_enabled=False),
        "V8-S1": replace(selected, ko=0, kl=0, geometry_enabled=False),
        "V8-S2": replace(selected, kl=0, geometry_enabled=False),
        "V8-S3": replace(selected, kl=0),
        "V8-final": selected,
        "V8-no-cap": replace(selected, max_pool_size=0),
    }
    if unique["label_siglip"]:
        variants["V8-S4"] = replace(selected, kl=15)
    catalog = {
        r["catalog_item_id"]: r
        for r in json.loads((repo / ".runtime/v5-rc1/catalog.json").read_text())["rows"]
    }
    all_metrics = {}
    csvrows = []
    errors = []
    final_preds = None
    for name, config in variants.items():
        preds = [predict(t, config) for t in traces]
        if name == "V8-final":
            final_preds = preds
        stats = metrics(rows, preds, baseline, groups)
        all_metrics[name] = dict(
            datasets=stats,
            macro_accuracy=macro(stats, "exact"),
            pooled_exact=sum(s["exact"] for s in stats.values()),
            n=len(rows),
            pool_size=percentile([len(p["pool_ids"]) for p in preds]),
        )
        for dataset, stat in stats.items():
            csvrows.append(
                dict(
                    variant=name,
                    dataset=dataset,
                    **stat,
                    accuracy=stat["exact"] / stat["n"],
                )
            )
        for row, trace, pred in zip(rows, traces, preds):
            key = hashlib.sha256(row["key"].encode()).hexdigest()
            for nomination in pred["nominees"]:
                nomination["slug"] = catalog[nomination["id"]]["official_slug"]
            for candidate in pred["ordered"]:
                candidate["slug"] = catalog[candidate["id"]]["official_slug"]
            gt_ranks = {
                source: next(
                    (
                        r["rank"]
                        for r in trace.get("sources", {}).get(source, [])
                        if r["id"] == row["expected"]
                    ),
                    None,
                )
                for source in SOURCES
            }
            source_limits = dict(
                zip(SOURCES, (config.ks, config.kd, config.ko, config.kl))
            )
            for candidate in pred["ordered"]:
                for source, feature in candidate["semantic"].items():
                    feature["outside_source_k"] = (
                        feature["rank"] is None
                        or feature["rank"] > source_limits[source]
                    )
            payload = dict(
                key=row["key"],
                variant=name,
                config=config.json(),
                **pred,
                gt_ranks=gt_ranks,
                gt_in_pool=row["expected"] in pred["pool_ids"],
                gt_first_source=next(
                    (
                        s
                        for s in SOURCES
                        if gt_ranks[s] is not None and gt_ranks[s] <= source_limits[s]
                    ),
                    None,
                ),
            )
            variant_path = root / "variants" / (key + "-" + name + ".json")
            variant_provenance = dict(
                evidence=digest(trace),
                config=config.json(),
                report_code=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            )
            if read(variant_path, variant_provenance) is None:
                save(variant_path, payload, variant_provenance)
    for name in ("V5", "V7-B"):
        preds = [dict(top1=baseline[r["key"]][name], pool_ids=[]) for r in rows]
        stats = metrics(rows, preds, baseline, groups)
        all_metrics[name] = dict(
            datasets=stats,
            macro_accuracy=macro(stats, "exact"),
            pooled_exact=sum(s["exact"] for s in stats.values()),
            n=len(rows),
        )
        for dataset, stat in stats.items():
            csvrows.append(
                dict(
                    variant=name,
                    dataset=dataset,
                    **stat,
                    accuracy=stat["exact"] / stat["n"],
                )
            )
    recalls = []
    for dataset in (*SETS, "ALL"):
        subset = [
            (r, t)
            for r, t in zip(rows, traces)
            if dataset == "ALL" or r["dataset"] == dataset
        ]
        for source in (*SOURCES, "union"):
            for k in KS:
                hits = 0
                for row, trace in subset:
                    sources = trace.get("sources", {})
                    if source == "union":
                        cfg = replace(selected, max_pool_size=0)
                        nominees, _ = build_pool(sources, cfg)
                        ids = {x["id"] for x in nominees[:k]}
                    else:
                        ids = {x["id"] for x in sources.get(source, [])[:k]}
                    hits += int(row["expected"] in ids)
                recalls.append(
                    dict(
                        dataset=dataset,
                        source=source,
                        k=k,
                        hits=hits,
                        n=len(subset),
                        recall=hits / len(subset),
                    )
                )
    manual_path = root / "manual-target-audit.json"
    manual = json.loads(manual_path.read_text()) if manual_path.exists() else {}
    for row, trace, pred in zip(rows, traces, final_preds):
        if pred["top1"] != row["expected"]:
            primary, flags = taxonomy(row, trace, pred, groups, manual)
            errors.append(
                dict(
                    key=row["key"],
                    dataset=row["dataset"],
                    expected=row["expected"],
                    prediction=pred["top1"],
                    primary=primary,
                    flags=flags,
                    gt_in_pool=row["expected"] in pred["pool_ids"],
                    margin=pred["margin"],
                    v5=baseline[row["key"]]["V5"],
                    v7=baseline[row["key"]]["V7-B"],
                    audit="audit/"
                    + hashlib.sha256(row["key"].encode()).hexdigest()
                    + "/target-overlay.jpg",
                )
            )
    timed = defaultdict(list)
    for trace in traces:
        for k, v in trace.get("timings_ms", {}).items():
            timed[k].append(v)
    resources = [r["resources_after"] for r in payloads]
    target_audit = dict(
        total=len(rows),
        no_target=sum("sources" not in t for t in traces),
        suspicious=sum(
            bool(t.get("target", {}).get("manual_audit_required")) for t in traces
        ),
        label_fallback=sum(
            not t.get("label", {}).get("trusted", False) for t in traces
        ),
        modality_failures=[
            dict(key=r["key"], failures=t.get("failures"))
            for r, t in zip(rows, traces)
            if t.get("failures")
        ],
    )
    target_audit["manual_review"] = manual
    summary = dict(
        architecture="V8-simple v0.2",
        specification="docs/V8-simple_onepager_v0.2.md",
        base="45992e9051e28aac7334530a354532d85bad12c9",
        metrics=all_metrics,
        selected=selected.json(),
        selection_constraints_feasible=constraints,
        pool_lodo=pool_lodo,
        weights_lodo=weight_lodo,
        nested_lodo=nested,
        unique_recall_contribution=unique,
        target_audit=target_audit,
        error_classes=dict(Counter(r["primary"] for r in errors)),
        error_flags=dict(Counter(f for r in errors for f in r["flags"])),
        exploration_latency_ms={k: percentile(v) for k, v in timed.items()},
        resources=dict(
            max_rss_kib=max(r["max_rss_kib"] for r in resources),
            max_container_ram_bytes=max(
                r.get("container_ram_bytes", 0) for r in resources
            ),
            gpu_snapshots=sorted({r.get("gpu", "") for r in resources}),
            worker_starts=max(p["worker_start"] for p in payloads),
        ),
        limitations=[
            "Consumed development data; no untouched validation was accessed.",
            "V5 and V7-B comparison uses the audited fresh runs from the immediately preceding experiment.",
            "Sibling metric uses authoritative equivalence groups only; absent groups are not inferred from titles.",
            "Exploration verifies a grid superset and is not deployment latency.",
            "No-target requests fail explicitly (422); successful responses contain exactly one official slug.",
            "Automatic target suspicion requires manual image audit, not a claim of wrong-target selection.",
        ],
    )
    atomic_json(root / "summary.json", summary)
    write_csv(root / "summary.csv", csvrows)
    write_csv(
        root / "errors.csv",
        errors,
        fields=[
            "key",
            "dataset",
            "expected",
            "prediction",
            "primary",
            "flags",
            "gt_in_pool",
            "margin",
            "v5",
            "v7",
            "audit",
        ],
    )
    write_csv(root / "candidate_recall.csv", recalls)
    write_csv(
        root / "pool-sensitivity.csv",
        [
            dict(
                **r["config"],
                macro_recall=r["macro_recall"],
                hits=r["hits"],
                average_size=r["pool_size"]["average"],
                p95_size=r["pool_size"]["p95"],
            )
            for r in pool_grid
        ],
    )
    atomic_json(root / "target-audit.json", target_audit)
    print(
        json.dumps(
            dict(
                selected=selected.json(),
                metrics={k: v["pooled_exact"] for k, v in all_metrics.items()},
                constraints_feasible=constraints,
            )
        ),
        flush=True,
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    args = ap.parse_args()
    with writer_lock(args.repo / ".generated/v8"):
        run(args)


if __name__ == "__main__":
    main()
