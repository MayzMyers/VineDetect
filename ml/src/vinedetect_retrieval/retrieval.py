"""Exact cosine ranking and explicitly separated sanity metrics."""

from __future__ import annotations

import time
from collections import Counter
from pathlib import Path

import numpy as np

from .artifacts import digest, write_json
from .embeddings import latencies, load_bundle

WARNING = "proxy_same_source is a sanity benchmark only, not expected contest or shelf/field-photo accuracy."


def rank_scores(scores, catalog_ids):
    scores = np.asarray(scores)
    if scores.ndim != 1 or len(scores) != len(catalog_ids) or not np.isfinite(scores).all():
        raise ValueError("Ranking requires a finite score per target")
    return np.lexsort((np.asarray(catalog_ids, dtype=np.int64), -scores))


def metrics(ranks):
    return {
        "count": len(ranks),
        **{
            f"top_{k}_accuracy": float(np.mean(np.asarray(ranks) <= k)) if ranks else None
            for k in (1, 3, 5, 10)
        },
        "mrr": float(np.mean(1 / np.asarray(ranks))) if ranks else None,
        "mean_rank": float(np.mean(ranks)) if ranks else None,
    }


def evaluate_vectors(queries, gallery, query_rows, gallery_rows):
    if queries.shape[1] != gallery.shape[1]:
        raise ValueError("Query/gallery dimensions differ")
    ids = [r["catalog_item_id"] for r in gallery_rows]
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate gallery catalog identity")
    positions = {key: i for i, key in enumerate(ids)}
    sha_counts = Counter(r["sha256"] for r in gallery_rows)
    strict, equivalent, unambiguous, results, retrieval_times = [], [], [], [], []
    for vector, query in zip(queries, query_rows, strict=True):
        expected = query["catalog_item_id"]
        if expected not in positions:
            raise ValueError(f"Expected target {expected} is missing from gallery")
        start = time.perf_counter()
        scores = vector[None] @ gallery.T
        ordering = rank_scores(scores[0], ids)
        retrieval_times.append(time.perf_counter() - start)
        position = positions[expected]
        expected_sha = gallery_rows[position]["sha256"]
        strict_rank = int(np.flatnonzero(ordering == position)[0]) + 1
        equivalent_rank = next(
            i + 1 for i, j in enumerate(ordering) if gallery_rows[j]["sha256"] == expected_sha
        )
        strict.append(strict_rank)
        equivalent.append(equivalent_rank)
        if sha_counts[expected_sha] == 1:
            unambiguous.append(strict_rank)
        results.append(
            {
                "query_row_id": query["row_id"],
                "expected_catalog_item_id": expected,
                "expected_official_slug": query["official_slug"],
                "strict_rank": strict_rank,
                "diagnostic_visual_equivalence_rank": equivalent_rank,
                "identical_reference_group_size": sha_counts[expected_sha],
                "top_10": [
                    {
                        "catalog_item_id": ids[j],
                        "official_slug": gallery_rows[j]["official_slug"],
                        "cosine_similarity": float(scores[0, j]),
                    }
                    for j in ordering[:10]
                ],
            }
        )
    return {
        "strict": metrics(strict),
        "strict_excluding_multi_identity_identical_reference": metrics(unambiguous),
        "diagnostic_visual_equivalence": metrics(equivalent),
        "results": results,
        "retrieval_latency": {
            **latencies(retrieval_times),
            "gallery_size": len(gallery),
            "includes_stable_ranking": True,
        },
    }


def self_sanity(matrix, rows, ambiguity):
    groups = [set(g["catalog_item_ids"]) for g in ambiguity["duplicate_sha256_groups"]]
    ids = [r["catalog_item_id"] for r in rows]
    explained, failures = [], []
    # Evaluate strict ranking without privileging the query's own row.
    for index, vector in enumerate(matrix):
        scores = (vector[None] @ matrix.T)[0]
        ordering = rank_scores(scores, ids)
        own = float(scores[index])
        ahead = [j for j in ordering if j != index and scores[j] >= own - 1e-6]
        unexplained = [
            ids[j]
            for j in ahead
            if rows[j]["sha256"] != rows[index]["sha256"]
            or abs(float(scores[j]) - own) > 1e-6
            or not any({ids[index], ids[j]} <= group for group in groups)
        ]
        if unexplained:
            failures.append({"catalog_item_id": ids[index], "unexplained_competitors": unexplained})
        elif ahead:
            explained.append(
                {"catalog_item_id": ids[index], "identical_sha_ties": [ids[j] for j in ahead]}
            )
    return {
        "passed": not failures,
        "unexplained_failures": failures,
        "explained_identical_image_ties": explained,
        "note": "Pipeline sanity only. Ranking uses exact scores then catalog ID; 1e-6 is used only to audit numerical ties, never to alter ranks.",
    }


def evaluate_bundles(
    gallery_dir: Path, query_dir: Path, ambiguity, output: Path, *, self_check=False
):
    gallery, gallery_rows, gm = load_bundle(gallery_dir)
    queries, query_rows, qm = load_bundle(query_dir)
    if gm["dataset_type"] != "official_gallery":
        raise ValueError("Gallery must contain official reference embeddings")
    if gm["config_sha256"] != qm["config_sha256"]:
        raise ValueError("Query/gallery encoder configuration differs")
    if (
        gm["source_gallery_sha256"] != ambiguity["gallery_sha256"]
        or qm["source_gallery_sha256"] != gm["source_gallery_sha256"]
    ):
        raise ValueError("Gallery, proxy, or ambiguity manifest snapshot differs")
    if not self_check and qm["dataset_type"] != "proxy_same_source":
        raise ValueError("Historical evaluation requires proxy_same_source queries")
    result = evaluate_vectors(queries, gallery, query_rows, gallery_rows)
    result.update(
        schema_version="siglip-evaluation/1",
        dataset_type="gallery_self_sanity" if self_check else "proxy_same_source",
        warning="Pipeline sanity check, not an accuracy benchmark." if self_check else WARNING,
        sample_only=gm["sample_only"] or qm["sample_only"],
        gallery_count=len(gallery),
        query_count=len(queries),
        gallery_bundle_sha256=digest(gm),
        query_bundle_sha256=digest(qm),
    )
    if self_check:
        if not np.array_equal(queries, gallery) or query_rows != gallery_rows:
            raise ValueError("Self sanity requires the same ordered gallery matrix")
        result["self_retrieval_sanity"] = self_sanity(gallery, gallery_rows, ambiguity)
    write_json(output, result)
    return result


def timing_2103(matrix, repeats=100):
    # Timing only; explicitly synthetic until the full gallery is embedded.
    gallery = np.tile(matrix, (int(np.ceil(2103 / len(matrix))), 1))[:2103].copy()
    vector = matrix[0:1]
    ids = np.arange(2103)
    samples = []
    for _ in range(5):
        rank_scores((vector @ gallery.T)[0], ids)
    for _ in range(repeats):
        start = time.perf_counter()
        rank_scores((vector @ gallery.T)[0], ids)
        samples.append(time.perf_counter() - start)
    return {
        "dataset_type": "synthetic_2103_way_timing_only",
        "warning": "Repeated smoke vectors; measures matrix/ranking cost, never retrieval accuracy.",
        "gallery_size": 2103,
        "dimension": matrix.shape[1],
        "latency": latencies(samples),
    }
