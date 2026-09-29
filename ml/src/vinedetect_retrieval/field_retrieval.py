"""Exact frozen-gallery retrieval, human-only field evaluation and proxy diagnostics."""

from __future__ import annotations

import time
from collections import Counter

import numpy as np

from .artifacts import digest
from .embeddings import embedding_rows, load_bundle
from .field_data import STATUSES, validate_labels
from .field_groups import grouping_for, mode_includes
from .retrieval import WARNING, metrics, rank_scores

DIAGNOSTIC = "Confidence/margin is diagnostic only and does not measure correctness."


def validate_field_encoder(metadata, args):
    config = metadata["config"]
    if (
        metadata["dataset_type"] != "official_gallery"
        or metadata["row_count"] != 2103
        or metadata["sample_only"]
    ):
        raise ValueError("Field embedding requires the complete existing 2103-row gallery")
    required = {
        "device": "cpu",
        "dtype": "float32",
        "max_num_patches": 256,
        "model_id": "google/siglip2-so400m-patch16-naflex",
        "revision": config["resolved_revision"],
        "batch_size": config["batch_size"],
        "threads": config["torch_threads"],
    }
    for name, value in required.items():
        if getattr(args, name) != value:
            raise ValueError(f"Field encoder requires --{name.replace('_', '-')} {value}")
    if (
        config["device"] != "cpu"
        or config["dtype"] != "float32"
        or config["max_num_patches"] != 256
        or metadata["dimension"] != 1152
    ):
        raise ValueError(
            "Gallery is not the frozen CPU float32 256-patch 1152-dimensional baseline"
        )


def load_field_pair(gallery_dir, query_dir, gallery_manifest, field_manifest):
    gallery, grows, gm = load_bundle(gallery_dir)
    queries, qrows, qm = load_bundle(query_dir)
    if (
        gm["dataset_type"] != "official_gallery"
        or qm["dataset_type"] != "field_real_world"
        or gm["sample_only"]
        or qm["sample_only"]
    ):
        raise ValueError("Expected complete official gallery and field_real_world bundles")
    if (
        gm["config_sha256"] != qm["config_sha256"]
        or digest(gm["config"]) != gm["config_sha256"]
        or digest(qm["config"]) != qm["config_sha256"]
    ):
        raise ValueError("Field/gallery configuration differs")
    if (
        gm["manifest_sha256"] != digest(gallery_manifest)
        or qm["manifest_sha256"] != digest(field_manifest)
        or gm["source_gallery_sha256"] != qm["source_gallery_sha256"]
        or qm["source_gallery_sha256"] != digest(gallery_manifest["rows"])
    ):
        raise ValueError("Field/gallery snapshot differs")
    for rows, manifest in ((grows, gallery_manifest), (qrows, field_manifest)):
        if rows != [{"index": i, **r} for i, r in enumerate(embedding_rows(manifest))]:
            raise ValueError("Bundle mapping differs from manifest")
    return gallery, queries, gm, qm


def candidate(row, score, rank):
    return {
        "rank": rank,
        "catalog_item_id": row["catalog_item_id"],
        "official_slug": row["official_slug"],
        "title": row.get("title"),
        "winery": row.get("winery"),
        "manufacturer": row.get("historical_manufacturer"),
        "reference_path": row["reference_path"],
        "reference_sha256": row["reference_sha256"],
        "cosine_similarity": float(score),
    }


def retrieve_vectors(queries, gallery, fields, targets):
    if len(fields) != len(queries) or len(targets) != len(gallery) or len(targets) < 10:
        raise ValueError("Retrieval requires matching row mappings and at least ten targets")
    ids = [r["catalog_item_id"] for r in targets]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate gallery identity")
    start = time.perf_counter()
    scores = queries @ gallery.T
    results = []
    for query, values in zip(fields, scores, strict=True):
        ordering = rank_scores(values, ids)
        top = [candidate(targets[j], values[j], rank) for rank, j in enumerate(ordering[:10], 1)]
        results.append(
            {
                "field_image_id": query["field_image_id"],
                "filename": query["original_filename"],
                "relative_source_path": query["relative_source_path"],
                "top_1_score": top[0]["cosine_similarity"],
                "top_2_score": top[1]["cosine_similarity"],
                "margin": top[0]["cosine_similarity"] - top[1]["cosine_similarity"],
                "top_5_spread": top[0]["cosine_similarity"] - top[4]["cosine_similarity"],
                "top_10": top,
            }
        )
    elapsed = time.perf_counter() - start
    return results, {
        "query_count": len(queries),
        "gallery_count": len(gallery),
        "total_seconds": elapsed,
        "amortized_seconds_per_query": elapsed / len(queries),
        "includes": "exact float32 query matrix @ gallery.T and stable ranking with catalog ID tie-break",
    }


def distribution(values):
    return {
        "count": len(values),
        "min": float(np.min(values)),
        "p05": float(np.quantile(values, 0.05)),
        "p25": float(np.quantile(values, 0.25)),
        "median": float(np.median(values)),
        "p75": float(np.quantile(values, 0.75)),
        "p95": float(np.quantile(values, 0.95)),
        "max": float(np.max(values)),
        "mean": float(np.mean(values)),
    }


def retrieve_field(gallery_dir, query_dir, gallery_manifest, field_manifest):
    gallery, queries, gm, qm = load_field_pair(
        gallery_dir, query_dir, gallery_manifest, field_manifest
    )
    results, timing = retrieve_vectors(
        queries, gallery, field_manifest["rows"], gallery_manifest["rows"]
    )
    report = {
        "schema_version": "siglip-field-retrieval/1",
        "dataset_type": "field_real_world",
        "warning": DIAGNOSTIC,
        "manifest_sha256": digest(field_manifest),
        "gallery_sha256": digest(gallery_manifest["rows"]),
        "gallery_bundle_sha256": digest(gm),
        "query_bundle_sha256": digest(qm),
        "query_count": len(results),
        "gallery_count": len(gallery),
        "top_5_spread_definition": "Top1 cosine score minus Top5 cosine score",
        "results": results,
    }
    ordered = sorted(results, key=lambda r: (r["margin"], r["field_image_id"]))

    def examples(rows):
        return [
            {k: r[k] for k in ("field_image_id", "filename", "margin", "top_1_score")} for r in rows
        ]

    summary = {
        "schema_version": "siglip-field-summary/1",
        "dataset_type": "field_real_world",
        "warning": DIAGNOSTIC,
        "query_count": len(results),
        "top_1_score": distribution([r["top_1_score"] for r in results]),
        "margin": distribution([r["margin"] for r in results]),
        "lowest_margin_examples": examples(ordered[:10]),
        "highest_margin_examples": examples(list(reversed(ordered[-10:]))),
        "duplicate_sha_group_count": len(field_manifest["duplicate_sha256_groups"]),
        "duplicate_extra_image_count": sum(
            len(g["field_image_ids"]) - 1 for g in field_manifest["duplicate_sha256_groups"]
        ),
        "decode_failures": field_manifest["decode_failures"],
        "retrieval_latency": timing,
    }
    return report, summary


def evaluate_field_vectors(
    queries, gallery, manifest, gallery_manifest, labels, *, mode="primary_field", grouping=None
):
    validate_labels(labels, manifest, gallery_manifest)
    grouping = grouping_for(manifest, grouping)
    group_rows = {r["field_image_id"]: r for r in grouping["rows"]}
    included_ids = {
        r["field_image_id"] for r in grouping["rows"] if mode_includes(r["variant"], mode)
    }
    eligible_groups = [group_rows[key]["source_group_id"] for key in included_ids]
    if len(eligible_groups) != len(set(eligible_groups)):
        raise ValueError("A benchmark may include at most one variant per source group")
    targets = gallery_manifest["rows"]
    ids = [r["catalog_item_id"] for r in targets]
    positions = {key: i for i, key in enumerate(ids)}
    sha_counts = Counter(r["reference_sha256"] for r in targets)
    decisions = {r["field_image_id"]: r for r in labels["rows"]}
    strict, equivalent, unambiguous, results, failures = [], [], [], [], []
    # Same full matrix operation as candidate retrieval, even when labels are sparse.
    scores = queries @ gallery.T
    for field, values in zip(manifest["rows"], scores, strict=True):
        label = decisions[field["field_image_id"]]
        if field["field_image_id"] not in included_ids or label["status"] != "exact_confirmed":
            continue
        expected = positions[label["catalog_item_id"]]
        ordering = rank_scores(values, ids)
        rank = int(np.flatnonzero(ordering == expected)[0]) + 1
        sha = targets[expected]["reference_sha256"]
        visual_rank = next(
            i + 1 for i, j in enumerate(ordering) if targets[j]["reference_sha256"] == sha
        )
        strict.append(rank)
        equivalent.append(visual_rank)
        if sha_counts[sha] == 1:
            unambiguous.append(rank)
        top = [candidate(targets[j], values[j], i) for i, j in enumerate(ordering[:10], 1)]
        row = {
            "field_image_id": field["field_image_id"],
            "field_image_path": field["relative_source_path"],
            "source_group_id": group_rows[field["field_image_id"]]["source_group_id"],
            "variant": group_rows[field["field_image_id"]]["variant"],
            "expected_catalog_item_id": label["catalog_item_id"],
            "expected_official_slug": label["official_slug"],
            "expected_reference_path": targets[expected]["reference_path"],
            "expected_rank": rank,
            "expected_score": float(values[expected]),
            "predicted_top_1": top[0],
            "predicted_top_1_score": top[0]["cosine_similarity"],
            "margin": top[0]["cosine_similarity"] - top[1]["cosine_similarity"],
            "top_10": top,
            "identical_reference_group_size": sha_counts[sha],
            "diagnostic_visual_equivalence_rank": visual_rank,
            "reviewer_note": label["note"],
            "reviewer_tags": label["tags"],
        }
        results.append(row)
        if rank != 1:
            failures.append(row)
    counts = Counter(r["status"] for r in labels["rows"] if r["field_image_id"] in included_ids)
    all_counts = Counter(r["status"] for r in labels["rows"])
    return {
        "schema_version": "siglip-field-evaluation/2",
        "evaluation_mode": mode,
        "grouping_sha256": digest(grouping),
        "grouping_summary": grouping["summary"],
        "eligible_image_count": len(included_ids),
        "eligible_source_group_count": len(eligible_groups),
        "evaluated_source_group_count": len(strict),
        "excluded_by_variant_count": len(labels["rows"]) - len(included_ids),
        "excluded_by_status_count": len(included_ids) - len(strict),
        "all_status_counts": {s: all_counts[s] for s in STATUSES},
        "dataset_type": "field_real_world",
        "warning": "Only explicitly human exact_confirmed labels within evaluation_mode enter accuracy; original/standalone and thumb denominators are separate. Labels never propagate between variants. Identical-SHA equivalence is diagnostic, not strict identity accuracy.",
        "exact_confirmed_count": len(strict),
        "excluded_from_exact_count": len(labels["rows"]) - len(strict),
        "status_counts": {s: counts[s] for s in STATUSES},
        "strict": metrics(strict),
        "strict_excluding_multi_identity_identical_reference": metrics(unambiguous),
        "diagnostic_visual_equivalence": metrics(equivalent),
        "results": results,
        "failures": failures,
        "manifest_sha256": digest(manifest),
        "gallery_sha256": digest(targets),
        "labels_sha256": digest(labels),
    }


def evaluate_field(
    gallery_dir,
    query_dir,
    gallery_manifest,
    manifest,
    labels,
    *,
    mode="primary_field",
    grouping=None,
):
    gallery, queries, gm, qm = load_field_pair(gallery_dir, query_dir, gallery_manifest, manifest)
    result = evaluate_field_vectors(
        queries, gallery, manifest, gallery_manifest, labels, mode=mode, grouping=grouping
    )
    result.update(gallery_bundle_sha256=digest(gm), query_bundle_sha256=digest(qm))
    return result


def proxy_errors(evaluation, gallery, ambiguity):
    if evaluation["dataset_type"] != "proxy_same_source" or ambiguity["gallery_sha256"] != digest(
        gallery["rows"]
    ):
        raise ValueError("Proxy/ambiguity dataset differs")
    targets = {r["catalog_item_id"]: r for r in gallery["rows"]}
    failures = []
    for row in evaluation["results"]:
        if row["strict_rank"] == 1:
            continue
        expected = targets[row["expected_catalog_item_id"]]
        predicted = targets[row["top_10"][0]["catalog_item_id"]]
        same = expected["reference_sha256"] == predicted["reference_sha256"]
        failures.append(
            {
                **row,
                "classification": "identical-reference ambiguity"
                if same
                else "non-ambiguity failure",
                "expected_reference_path": expected["reference_path"],
                "predicted_reference_path": predicted["reference_path"],
                "expected_reference_sha256": expected["reference_sha256"],
                "predicted_reference_sha256": predicted["reference_sha256"],
            }
        )
    counts = Counter(r["classification"] for r in failures)
    return {
        "schema_version": "siglip-proxy-errors/1",
        "dataset_type": "proxy_same_source",
        "warning": WARNING,
        "classification_rule": "Identical-reference ambiguity requires predicted Top1 and expected target to share exactly the same reference SHA; group membership alone is insufficient.",
        "source_evaluation_sha256": digest(evaluation),
        "failure_count": len(failures),
        "classification_counts": {
            k: counts[k] for k in ("identical-reference ambiguity", "non-ambiguity failure")
        },
        "failures": failures,
    }
