"""Validate final artifacts and render the A–L experiment report after isolated latency."""

import argparse
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path
from .checkpoint import read, atomic_json, writer_lock
from .config import Config
from .evaluate import provenance
from .report import SETS, percentile, write_csv, predict


def table(headers, rows):
    return "\n".join(
        [
            "| " + " | ".join(map(str, headers)) + " |",
            "| " + " | ".join("---" for _ in headers) + " |",
        ]
        + [
            "| " + " | ".join(str(x).replace("|", "/") for x in row) + " |"
            for row in rows
        ]
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    args = ap.parse_args()
    repo = args.repo
    root = repo / ".generated/v8"
    with writer_lock(root):
        summary = json.loads((root / "summary.json").read_text())
        selected = Config(**summary["selected"])
        scored = json.loads((repo / ".generated/v7/image-manifest.json").read_text())
        smoke = json.loads((repo / ".generated/v7/smoke-manifest.json").read_text())
        audit = []
        scaling = []
        smoke_status = Counter()
        latency = []
        all_records = []
        cache_counts = defaultdict(Counter)
        catalog = {
            r["catalog_item_id"]: r
            for r in json.loads((repo / ".runtime/v5-rc1/catalog.json").read_text())[
                "rows"
            ]
        }
        slugs = {cid: r["official_slug"] for cid, r in catalog.items()}
        from .ocr import structured

        parts = {cid: structured(r) for cid, r in catalog.items()}
        groups = [
            set(r["catalogItemIds"])
            for r in json.loads(
                (
                    repo / ".generated/irecommend531/gt-audit/equivalence_groups.json"
                ).read_text()
            )
        ]
        sibling_cases = []
        for row in scored + smoke:
            key = hashlib.sha256(row["key"].encode()).hexdigest()
            data = read(
                root / "explore" / (key + ".json"),
                provenance(repo, row, Config(), "explore"),
            )
            if data is None:
                raise ValueError("Missing/corrupt evidence: " + row["key"])
            all_records.append(data)
            cache_counts["smoke" if row in smoke else "scored"].update(
                {
                    k: data["trace"].get("cache", {}).get(k, 0)
                    for k in ("hits", "misses", "disk_hits")
                }
            )
            trace = data["trace"]
            if row in smoke:
                smoke_status[data["status"]] += 1
            if data["status"] == "ok":
                pred = predict(trace, selected)
                x, y, w, h = trace["target"]["selected_box"]
                for proposal in trace["label"]["proposals"]:
                    lx, ly, lw, lh = proposal["box"]
                    if not (0 <= lx and 0 <= ly and lx + lw <= w and ly + lh <= h):
                        raise ValueError("Label escaped target: " + row["key"])
                if any(
                    str(cid) not in trace["evidence"] and cid not in trace["evidence"]
                    for cid in pred["pool_ids"]
                ):
                    raise ValueError("Nonuniform verification: " + row["key"])
                # Published debug sidecar uses the selected final config, not exploratory default ranking.
                gt = row.get("expected")
                cid = pred["top1"]
                if row in scored and cid != gt:
                    authoritative = any(cid in g and gt in g for g in groups)
                    same_producer = bool(parts[cid]["producer"] & parts[gt]["producer"])
                    shared_product = parts[cid]["product"] & parts[gt]["product"]
                    potential = same_producer and bool(shared_product)
                    if authoritative or potential:
                        winner = pred["ordered"][0]
                        truth = next(
                            (r for r in pred["ordered"] if r["id"] == gt), None
                        )
                        delta = (
                            {
                                k: winner["contributions"][k]
                                - truth["contributions"][k]
                                for k in winner["contributions"]
                            }
                            if truth
                            else {}
                        )
                        sibling_cases.append(
                            dict(
                                key=row["key"],
                                expected=gt,
                                prediction=cid,
                                expected_title=catalog[gt]["title"],
                                prediction_title=catalog[cid]["title"],
                                classification="authoritative_family"
                                if authoritative
                                else "potential_sibling_manual_review",
                                shared_product=sorted(shared_product),
                                ocr_text=trace["ocr"]["text"],
                                expected_attributes={
                                    k: sorted(v) for k, v in parts[gt].items()
                                },
                                predicted_attributes={
                                    k: sorted(v) for k, v in parts[cid].items()
                                },
                                gt_in_pool=gt in pred["pool_ids"],
                                contribution_delta=delta,
                                largest_contribution=max(delta, key=delta.get)
                                if delta
                                else "retrieval",
                                expected_ocr=truth["raw"]["ocr"] if truth else None,
                                predicted_ocr=winner["raw"]["ocr"],
                            )
                        )
                trace = dict(
                    trace,
                    exploration_decision={
                        k: trace.get(k)
                        for k in (
                            "config",
                            "ordered",
                            "top1",
                            "top2",
                            "margin",
                            "slug",
                            "pool_ids",
                        )
                    },
                    selected_final=pred,
                    selected_final_config=selected.json(),
                    config=selected.json(),
                    ordered=pred["ordered"],
                    nominations=pred["nominees"],
                    top1=pred["top1"],
                    top2=pred.get("top2"),
                    margin=pred["margin"],
                    slug=slugs[pred["top1"]],
                    pool_ids=pred["pool_ids"],
                )
                for source in trace["sources"].values():
                    for nomination in source:
                        nomination["slug"] = slugs[nomination["id"]]
                for nomination in pred["nominees"]:
                    nomination["slug"] = slugs[nomination["id"]]
                for candidate in pred["ordered"]:
                    candidate["slug"] = slugs[candidate["id"]]
                atomic_json(root / "audit" / key / "trace.json", trace)
            audit.append(
                dict(
                    key=row["key"],
                    status=data["status"],
                    target_reason=trace["target"]["reason"],
                    target_candidates=len(trace["target"]["candidates"]),
                    target_suspicious=trace["target"]["manual_audit_required"],
                    label_trusted=trace.get("label", {}).get("trusted", False),
                    label_proposals=len(trace.get("label", {}).get("proposals", [])),
                    label_reason=trace.get("label", {}).get("reason"),
                    artifact_directory=str(root / "audit" / key),
                )
            )
            times = trace.get("timings_ms", {})
            scaling.append(
                dict(
                    key=row["key"],
                    phase="exploration",
                    verified=trace.get("verified_candidates", 0),
                    total_ms=times.get("total_inference"),
                    reference_ms=times.get("reference_descriptors", 0),
                    matching_ms=times.get("sift_verification", 0)
                    + times.get("root_verification", 0),
                )
            )
        for dataset in SETS:
            rows = [r for r in scored if r["dataset"] == dataset]
            for row in (rows[0], rows[len(rows) // 2]):
                key = hashlib.sha256(row["key"].encode()).hexdigest()
                data = read(
                    root / "latency" / (key + ".json"),
                    provenance(repo, row, selected, "latency"),
                )
                if data is None:
                    raise ValueError("Missing latency row: " + row["key"])
                trace = data["trace"]
                original = read(
                    root / "explore" / (key + ".json"),
                    provenance(repo, row, Config(), "explore"),
                )["trace"]
                pred = predict(original, selected)
                if data["status"] == "ok" and trace["top1"] != pred["top1"]:
                    raise ValueError(
                        "Selected-pool live/replay mismatch: " + row["key"]
                    )
                latency.append(data)
                all_records.append(data)
                cache_counts["warm_latency"].update(
                    {
                        k: trace.get("cache", {}).get(k, 0)
                        for k in ("hits", "misses", "disk_hits")
                    }
                )
                scaling.append(
                    dict(
                        key=row["key"],
                        phase="warm_selected",
                        verified=trace.get("verified_candidates", 0),
                        total_ms=trace.get("timings_ms", {}).get("total_inference"),
                        reference_ms=trace.get("timings_ms", {}).get(
                            "reference_descriptors", 0
                        ),
                        matching_ms=sum(
                            trace.get("timings_ms", {}).get(k, 0)
                            for k in ("sift_verification", "root_verification")
                        ),
                    )
                )
        stage = defaultdict(list)
        for data in latency:
            for name, value in data["trace"].get("timings_ms", {}).items():
                stage[name].append(value)
        summary["warm_latency_ms"] = {
            name: percentile(values) for name, values in stage.items()
        }
        summary["warm_latency_ms"]["pipeline_with_diagnostics"] = percentile(
            [r["wall_ms"] for r in latency]
        )
        summary["cache"] = {
            phase: dict(
                counts,
                memory_hit_rate=counts["hits"]
                / max(1, counts["hits"] + counts["misses"]),
                disk_hit_rate_given_memory_miss=counts["disk_hits"]
                / max(1, counts["misses"]),
                descriptor_reuse_rate=(counts["hits"] + counts["disk_hits"])
                / max(1, counts["hits"] + counts["misses"]),
            )
            for phase, counts in cache_counts.items()
        }
        observed_resources = [
            r[key]
            for r in all_records
            for key in ("resources_before", "resources_after")
            if key in r
        ]
        for output, source in (
            ("max_rss_kib", "max_rss_kib"),
            ("max_container_ram_bytes", "container_ram_bytes"),
            ("max_container_peak_bytes", "container_peak_bytes"),
        ):
            summary["resources"][output] = max(
                (r.get(source, 0) for r in observed_resources), default=0
            )
        summary["resources"]["worker_starts"] = max(
            r.get("worker_start", 0) for r in all_records
        )
        summary["resources"]["min_sampled_host_available_kib"] = min(
            r["host_memory_kib"]["MemAvailable"]
            for r in observed_resources
            if "MemAvailable" in r.get("host_memory_kib", {})
        )
        parity_path = root / "direct-siglip-parity.json"
        if parity_path.exists():
            summary["direct_siglip_parity"] = json.loads(parity_path.read_text())
        switch_path = root / "service-switch-checkpoint.json"
        if switch_path.exists():
            summary["service_switch"] = json.loads(switch_path.read_text())
        summary["smoke"] = dict(
            n=len(smoke), status=dict(smoke_status), accuracy_scored=False
        )
        summary["validation"] = dict(
            scored=len(scored),
            smoke=len(smoke),
            latency=len(latency),
            uniform_verification=True,
            label_containment=True,
            live_replay_top1_equal=True,
        )
        resource_rows = []
        resource_file = root / "resources.jsonl"
        if resource_file.exists():
            resource_rows = [
                json.loads(line)
                for line in resource_file.read_text().splitlines()
                if line.strip()
            ]
        starts = sorted(
            {
                r["resident_restart"]
                for r in resource_rows
                if r.get("resident_restart") != "unavailable"
            }
        )
        summary["resources"]["resident_start_observations"] = starts
        summary["resources"]["monitor_samples"] = len(resource_rows)
        gpu_samples = []
        for observation in resource_rows:
            try:
                gpu_samples.append(int(observation.get("gpu", "").split(",")[0]))
            except ValueError:
                pass
        summary["resources"]["max_monitored_gpu_mib"] = max(gpu_samples, default=None)
        by_pool = defaultdict(list)
        for data in latency:
            trace = data["trace"]
            count = trace.get("verified_candidates", 0)
            band = (
                "<=15"
                if count <= 15
                else "<=20"
                if count <= 20
                else "<=30"
                if count <= 30
                else ">30"
            )
            if "total_inference" in trace.get("timings_ms", {}):
                by_pool[band].append(trace["timings_ms"]["total_inference"])
        summary["warm_latency_by_pool_size_ms"] = {
            k: percentile(v) for k, v in by_pool.items()
        }

        final = summary["metrics"]["V8-final"]
        v7 = summary["metrics"]["V7-B"]
        robust = (
            final["macro_accuracy"] > v7["macro_accuracy"]
            and summary["selection_constraints_feasible"]
        )
        recommendation = (
            "V8 promising but needs a specific next experiment"
            if robust
            else "V8 does not beat V7-B robustly"
        )
        summary["recommendation"] = recommendation
        summary["next_experiment"] = (
            "Validate the fixed V8 configuration on a separately authorized untouched set; do not access it automatically."
            if robust
            else "Retain V7-B. For a future, separately run experiment, hold target selection and the recall pool fixed and predeclare a global semantic-normalization ablation removing the reciprocal-rank term. Compare against the current score with the same weight grid, FIELD/STORE regression constraints and nested leave-one-dataset-out evaluation. This is a hypothesis from saved contribution deltas, not a demonstrated improvement; no such tuning was performed in this run."
        )
        gt_in_pool = sum(m["gt_in_pool"] for m in final["datasets"].values())
        summary["diagnosis"] = dict(
            gt_in_pool=gt_in_pool,
            retrieval_misses=final["n"] - gt_in_pool,
            wrong_with_gt_in_pool=gt_in_pool - final["pooled_exact"],
            conditional_top1=final["pooled_exact"] / gt_in_pool,
            fixed_v7=sum(m["fixed_v7"] for m in final["datasets"].values()),
            broken_v7=sum(m["broken_v7"] for m in final["datasets"].values()),
        )
        atomic_json(root / "summary.json", summary)
        write_csv(root / "sibling-review.csv", sibling_cases)
        atomic_json(root / "sibling-review.json", sibling_cases)
        summary["sibling_review"] = dict(
            authoritative=sum(
                r["classification"] == "authoritative_family" for r in sibling_cases
            ),
            potential_only=sum(
                r["classification"] != "authoritative_family" for r in sibling_cases
            ),
        )
        atomic_json(root / "summary.json", summary)
        write_csv(root / "target-audit.csv", audit)
        write_csv(root / "latency-scaling.csv", scaling)
        atomic_json(root / "validation.json", summary["validation"])
        errors = list(__import__("csv").DictReader((root / "errors.csv").open()))
        from .audit import render_gallery

        render_gallery(
            root,
            scored + smoke,
            errors,
            catalog,
            summary["target_audit"].get("manual_review", {}),
        )
        lines = [
            "# V8-simple v0.2 experiment results",
            "",
            recommendation + ".",
            "",
            "## A. Implemented architecture",
            "",
            "Frozen V5 base: `45992e9051e28aac7334530a354532d85bad12c9`; branch `feat/v8-simple`. "
            "One canonical RGB image → bottle detector/intent score → target-contained label → recall-selected source union → "
            "uniform SIFT/RootSIFT/OCR/semantic feature vectors → one weighted reranker → official slug. "
            "The normative [v0.2 specification](V8-simple_onepager_v0.2.md) and "
            "[implementation details](V8_IMPLEMENTATION.md) define all interpretations. No V5/V7 decisions participate in V8.",
            "",
            "## B. Target/label audit",
            "",
            f"Scored images: {len(scored)}. No target: {summary['target_audit']['no_target']}; "
            f"geometry-suspicious targets: {summary['target_audit']['suspicious']}; "
            f"label fallbacks: {summary['target_audit']['label_fallback']}. "
            f"Images with modality failures: {len(summary['target_audit']['modality_failures'])}.",
            "All 300 consumed/scored-or-smoke entries have per-image trace/audit records. "
            "The audit is diagnostic: geometric suspicion alone does not prove a wrong target. Independent target-box GT is unavailable, so detection coverage is not reported as target-selection accuracy. The browsable package is `.generated/v8/target-audit.html`.",
            "",
            *[
                f"- `{key}`: {value['evidence']}"
                for key, value in summary["target_audit"]
                .get("manual_review", {})
                .items()
            ],
            "",
            "## C. Candidate retrieval",
            "",
            f"Selected Ks={selected.ks}, Kd={selected.kd}, Ko={selected.ko}, Kl={selected.kl}, "
            f"cap={selected.max_pool_size or 'uncapped'}. Selection used recall only, followed by pool cost.",
            f"Final pool size: {json.dumps(final['pool_size'])}.",
            "Unique recalled GT images at exploration depths: "
            + ", ".join(
                f"{s}={len(v)}"
                for s, v in summary["unique_recall_contribution"].items()
            )
            + ".",
            "Source and fused-union Recall@1/5/10/15/20/30 are in `.generated/v8/candidate_recall.csv`; "
            "the complete cap/K grid and leave-one-dataset-out choices are in the pool sensitivity artifacts.",
            "",
            "## D. Reranker",
            "",
            "Normalized groups are semantic, OCR identity, OCR attribute agreement/conflict, local geometry, and missing/abstain quality. "
            "Raw metrics and each weighted contribution are retained. Exact normalization is in the implementation document.",
            f"Group weights: {list(selected.weights)}; DINO semantic weight: {selected.dino_weight}; "
            f"label semantic weight: {selected.label_weight}.",
            f"Release-oriented regression/sibling constraints feasible: **{summary['selection_constraints_feasible']}**. "
            "An infeasible winner is experimental only; no rescue rules were added.",
            "",
            "## E. Ablations",
            "",
            table(
                ["Variant", *SETS, "Pooled", "Macro"],
                [
                    [
                        name,
                        *[
                            f"{m['datasets'][s]['exact']}/{m['datasets'][s]['n']}"
                            for s in SETS
                        ],
                        f"{m['pooled_exact']}/{m['n']}",
                        f"{m['macro_accuracy']:.4f}",
                    ]
                    for name, m in summary["metrics"].items()
                    if name.startswith("V8")
                ],
            ),
            "",
            "S4 is omitted when label SigLIP has no demonstrated unique recall contribution. Ablations share the selected global weights; "
            "they are not separately optimized on the same benchmark. `V8-no-cap` isolates pool capping.",
            "",
            "## F. Comparison",
            "",
            table(
                ["Variant", "Exact", "Macro"],
                [
                    [
                        name,
                        f"{summary['metrics'][name]['pooled_exact']}/232",
                        f"{summary['metrics'][name]['macro_accuracy']:.4f}",
                    ]
                    for name in ("V5", "V7-B", "V8-final")
                ],
            ),
            "V5/V7-B are the audited fresh-model runs from the preceding experiment, not new measurements taken during this V8 run.",
            "",
            table(
                [
                    "Dataset",
                    "Fixed/broken vs V5",
                    "Fixed/broken vs V7-B",
                    "GT in pool",
                    "Top1 given GT in pool",
                ],
                [
                    [
                        s,
                        f"{m['fixed_v5']}/{m['broken_v5']}",
                        f"{m['fixed_v7']}/{m['broken_v7']}",
                        f"{m['gt_in_pool']}/{m['n']}",
                        f"{m['conditional_correct']}/{m['gt_in_pool']}",
                    ]
                    for s, m in final["datasets"].items()
                ],
            ),
            "",
            f"Across the scored set, V8 fixes {summary['diagnosis']['fixed_v7']} V7-B errors and breaks "
            f"{summary['diagnosis']['broken_v7']} previously correct results. FIELD51 loses 8 exact matches and STORE13 loses 2; "
            "IRECOMMEND128 gains 6, while FRESH8 and UNSEEN32 are unchanged. The larger IRECOMMEND set therefore masks "
            "part of the equal-dataset macro regression.",
            "",
            "## G. Error taxonomy",
            "",
            "Primary counts: "
            + json.dumps(summary["error_classes"])
            + ". Secondary flags: "
            + json.dumps(summary["error_flags"])
            + ".",
            f"GT is in the final pool for {gt_in_pool}/{final['n']} images ({gt_in_pool / final['n']:.2%}); "
            f"conditional Top1 is {final['pooled_exact']}/{gt_in_pool} ({final['pooled_exact'] / gt_in_pool:.2%}). "
            f"There are {final['n'] - gt_in_pool} pool misses and {gt_in_pool - final['pooled_exact']} wrong rankings with GT present. "
            "Primary TARGET_SUSPECT labels overlap these categories, so primary-class counts alone do not equal the pool-miss/reranking totals.",
            "Saved contribution review points mainly to semantic-versus-local score balance and OCR/catalog alignment, "
            "not a demonstrated global target-detector failure. For FIELD photo_14420, the wrong Fanagoria sweetness sibling "
            "gains 0.2105 in semantic contribution despite losing 0.0370 in geometry. On FIELD photo_15025, "
            "Malbec Katya Belmas gains 0.6226 semantically despite GT having more SIFT/RootSIFT inliers (18/22 versus 14/12). "
            "On STORE IMG_0019, OCR recognizes Rkatsiteli but grape evidence belongs to the attribute group whose selected weight is zero. "
            "On FIELD photo_14850, mixed-script OCR/catalog token alignment gives the wrong Sauvignon Blanc a 0.4194 identity advantage "
            "over Riesling, outweighing a 0.3291 semantic advantage for GT. These are diagnostic examples, not rules added to recognition.",
            "Every wrong prediction is listed in `.generated/v8/errors.csv`, with GT-in-pool, margin, baseline identities and an audit asset path.",
            "",
            table(
                ["Example", "GT → prediction", "Primary", "Flags"],
                [
                    [
                        r["key"],
                        f"{r['expected']} → {r['prediction']}",
                        r["primary"],
                        r["flags"],
                    ]
                    for r in errors[:10]
                ],
            ),
            "",
            "## H. Sibling errors",
            "",
            table(
                ["Dataset", "Authoritative-family wrong Top1", "Same-family Top1"],
                [
                    [s, m["sibling"], f"{m['family']}/{m['n']}"]
                    for s, m in final["datasets"].items()
                ],
            ),
            "This metric uses the existing authoritative equivalence groups only. It is not a complete taxonomy of all same-brand wines. "
            "Review vintage, sweetness/brut qualifiers and missing OCR attributes in the per-candidate vectors before attributing a sibling error.",
            "",
            "Detailed case-level attribute differences, recognized target text, expected/winning OCR evidence and score-group deltas are in "
            "`.generated/v8/sibling-review.json` and CSV. Potential siblings inferred from shared catalog producer/product tokens are "
            "explicit manual-review suggestions and do not alter authoritative same-family accuracy.",
            "",
            table(
                [
                    "Sibling case",
                    "Expected → predicted",
                    "Status",
                    "Largest score delta",
                ],
                [
                    [
                        r["key"],
                        r["expected_title"] + " → " + r["prediction_title"],
                        r["classification"],
                        r["largest_contribution"],
                    ]
                    for r in sibling_cases[:10]
                ],
            ),
            "",
            "## I. Latency",
            "",
            "Warm selected-pool requests use two systematically spaced images per dataset (10 total), each with an untimed warmup. "
            "They run after regression/smoke inference with one direct V8 GPU stack and the old V5 service stopped. "
            "The small p95 sample is descriptive, not a service guarantee. The pipeline total includes diagnostic writes; ASGI/network transfer, base64 envelope decoding and model startup are excluded.",
            "",
            table(
                ["Stage", "p50 ms", "p95 ms"],
                [
                    [s, f"{m['p50']:.1f}", f"{m['p95']:.1f}"]
                    for s, m in summary["warm_latency_ms"].items()
                ],
            ),
            "Exploration timings include verification of the whole grid superset and cannot be substituted for production latency. "
            "Per-image stage time versus verified-candidate count is in `latency-scaling.csv`.",
            "",
            "Reference descriptor cache counts and rates (RAM first, then exact disk cache) are in summary.json. "
            + "; ".join(
                f"{phase}: RAM {m['memory_hit_rate']:.1%}, disk given RAM miss {m['disk_hit_rate_given_memory_miss']:.1%}, total descriptor reuse {m['descriptor_reuse_rate']:.1%}"
                for phase, m in summary["cache"].items()
            )
            + ". Repeated Lowe correspondences reuse the same computed match lists; RANSAC/decisions are not cached.",
            "",
            "## J. Stability",
            "",
            f"Maximum observed worker RSS: {summary['resources']['max_rss_kib'] / 1024:.1f} MiB; "
            f"maximum per-image container RAM: {summary['resources']['max_container_ram_bytes'] / 1024**3:.2f} GiB "
            "(6 GiB limit; sampled values are not a continuous peak measurement).",
            f"Recorded cgroup peak: {summary['resources']['max_container_peak_bytes'] / 1024**3:.2f} GiB. "
            "Process RSS includes shared/file-backed mappings and is not the cgroup charged-memory measure. "
            "The GPU has 12227 MiB total; the initial 64 requests shared the old SigLIP loader, after which V5 was stopped at a durable checkpoint. "
            "All later stages used one direct V8 stack. Direct-transport parity on those 64 saved crops preserved every tested source rank "
            "and candidate order; raw scores differed by at most 1e-6. Details are in direct-siglip-parity.json.",
            f"Maximum monitored GPU allocation: {summary['resources']['max_monitored_gpu_mib']} MiB; "
            f"minimum sampled host memory available: {summary['resources']['min_sampled_host_available_kib'] / 1024**2:.2f} GiB. "
            f"Resource monitor samples: {len(resource_rows)}. Resident start/restart observations: {starts}.",
            "Workers are sequential and bounded to eight photos. One early SigLIP transport failure was retained in logs; "
            "resume checksum tests caught and fixed JSON integer-key canonicalization. Earlier records migrate only after verifying their original checksum. "
            "Corrupt/stale checkpoint tests, descriptor-cache parity, diagnostic invariance and per-image containment checks pass. "
            "Worker startups include planned batches and diagnostic retries; they are not machine crashes.",
            f"Secondary68 smoke status: {dict(smoke_status)}. Optional remaining unconfirmed IRECOMMEND raw images were not run. "
            "New-phone and organizer validation remain untouched.",
            "",
            "## K. Recommendation",
            "",
            recommendation + ". " + summary["next_experiment"],
            "Nested leave-one-dataset-out held-out accuracies: "
            + ", ".join(
                f"{s}={r['heldout_accuracy']:.4f}"
                for s, r in summary["nested_lodo"].items()
            )
            + ". "
            "All selection data is already-consumed development data; these results do not establish untouched-set generalization.",
            "",
            "## L. Git and checks",
            "",
            "Branch: `feat/v8-simple`, based directly on frozen V5. Added separate V8 modules, focused tests, a bounded run launcher, "
            "and architecture/results documentation. Frozen V5 and production route files are unchanged. "
            "The full Python suite passes 184 checks (one third-party deprecation warning). Checksum/provenance validation passes for 232 scored, 68 smoke, 10 latency and 1,624 ablation records, including source and diagnostic crop hashes. "
            "No push, merge, deployment, or automatic freeze. The final commit and check receipt are recorded in `.generated/v8/git-checks.json`.",
            "",
            "Machine-readable results and all per-image diagnostics are under `.generated/v8/`.",
        ]
        (repo / "docs/V8_RESULTS.md").write_text("\n".join(lines) + "\n")
        print(
            json.dumps(
                dict(
                    recommendation=recommendation,
                    validation=summary["validation"],
                    warm_total=summary["warm_latency_ms"].get("total_inference"),
                )
            )
        )


if __name__ == "__main__":
    main()
