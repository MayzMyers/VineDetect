"""Training-only relationship masks, positive filtering and hard-negative mining.

Inference/evaluation never imports this policy. Groups define pairwise exclusions,
not identity merges, transitive equivalence or automatic cross-identity positives.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from itertools import combinations
from pathlib import Path

import numpy as np

from .artifacts import digest, read_json, write_json
from .embeddings import load_bundle, validate_vectors
from .retrieval import rank_scores

DEFAULT_POLICY = Path(__file__).with_name("training_relationships.json")
NEGATIVE_TYPES = {
    "visual_equivalent_or_vintage",
    "same_product_alias_or_version",
    "same_product_packaging_variant",
}
DIAGNOSTIC_TYPE = "non_discriminative_reference_group"


def load_policy(path=DEFAULT_POLICY):
    return read_json(path)


class TrainingPolicy:
    def __init__(self, gallery, policy=None, *, expected_count=2103):
        policy = load_policy() if policy is None else policy
        rows = gallery["rows"]
        if (
            gallery.get("dataset_type") != "official_gallery"
            or gallery["row_count"] != len(rows)
            or len(rows) != expected_count
            or len({r["official_slug"] for r in rows}) != len(rows)
        ):
            raise ValueError("Training requires the complete unique official gallery")
        self.rows = {r["catalog_item_id"]: dict(r) for r in rows}
        if len(self.rows) != len(rows) or any(type(k) is not int or k <= 0 for k in self.rows):
            raise ValueError("Duplicate or invalid catalog identities")
        if policy.get("schema_version") != "contest-training-relationships/1" or policy.get(
            "contest_version"
        ) != gallery.get("contest_version"):
            raise ValueError("Training policy version differs from gallery")
        self.ids = sorted(self.rows)
        self.negative_reasons = defaultdict(set)
        self.hard_reasons = defaultdict(set)
        buckets = defaultdict(list)
        for key in self.ids:
            sha = self.rows[key]["reference_sha256"]
            if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
                raise ValueError("Invalid current reference SHA-256")
            buckets[sha].append(key)
        self.sha_groups = [
            {"sha256": sha, "catalog_item_ids": ids}
            for sha, ids in sorted(buckets.items())
            if len(ids) > 1
        ]
        for group in self.sha_groups:
            self._exclude(group["catalog_item_ids"], "identical_reference_sha256", hard_only=False)
        groups = []
        for group in policy["relationships"]:
            kind, ids = group["type"], sorted(group["catalog_item_ids"])
            if (
                kind not in NEGATIVE_TYPES | {DIAGNOSTIC_TYPE}
                or len(ids) < 2
                or len(set(ids)) != len(ids)
                or not set(ids) <= self.rows.keys()
                or group.get("provenance") != "human_reviewed_dq2"
            ):
                raise ValueError("Invalid reviewed training relationship")
            normalized = {**group, "catalog_item_ids": ids}
            if normalized in groups:
                raise ValueError("Duplicate reviewed relationship")
            groups.append(normalized)
            self._exclude(ids, kind, hard_only=kind == DIAGNOSTIC_TYPE)
        self.groups = sorted(groups, key=lambda g: (g["type"], g["catalog_item_ids"]))
        self.historical_exclusions = set()
        for entry in policy["historical_image_exclusions"]:
            key = (entry["catalog_item_id"], entry["historical_image_id"])
            if (
                key[0] not in self.rows
                or type(key[1]) is not int
                or key[1] <= 0
                or key in self.historical_exclusions
                or entry.get("reason") != "mismatch"
                or entry.get("provenance") != "human_reviewed_dq2"
            ):
                raise ValueError("Invalid reviewed historical exclusion")
            self.historical_exclusions.add(key)
        self.gallery_sha256 = digest(sorted(rows, key=lambda r: r["catalog_item_id"]))
        self.policy_sha256 = digest(policy)

    def _exclude(self, ids, reason, *, hard_only):
        for pair in combinations(ids, 2):
            self.hard_reasons[pair].add(reason)
            if not hard_only:
                self.negative_reasons[pair].add(reason)

    def can_be_negative(self, anchor, candidate, *, hard=False):
        if anchor not in self.rows or candidate not in self.rows:
            raise ValueError("Unknown training catalog identity")
        pair = tuple(sorted((anchor, candidate)))
        return anchor != candidate and pair not in (
            self.hard_reasons if hard else self.negative_reasons
        )

    def negative_candidates(self, anchor, candidates=None, *, hard=False):
        candidates = self.ids if candidates is None else candidates
        return [key for key in candidates if self.can_be_negative(anchor, key, hard=hard)]

    def sample_negatives(self, anchor, count, *, seed, hard=False):
        if type(count) is not int or count < 0:
            raise ValueError("Negative sample count must be nonnegative")
        candidates = self.negative_candidates(anchor, hard=hard)
        if count > len(candidates):
            raise ValueError("Not enough eligible negatives; never backfill forbidden pairs")
        return np.random.default_rng(seed).choice(candidates, count, replace=False).tolist()

    def historical_positive_exclusion(self, row):
        key = row["catalog_item_id"]
        if key not in self.rows:
            raise ValueError("Unknown historical target")
        # Explicit row review markers have precedence over any eligibility flags.
        if (
            (key, row["historical_image_id"]) in self.historical_exclusions
            or row.get("historical_image_mismatch") is True
            or row.get("historical_image_status") == "mismatch"
            or row.get("review_status") == "mismatch"
        ):
            return "explicit_historical_image_mismatch"
        target = self.rows[key]
        if target["link_method"] != "exact_slug":
            return "not_exact_slug"
        if row["historical_wine_id"] != target["wine_id"]:
            return "historical_wine_identity_mismatch"
        if row.get("official_reference_sha256") != target["reference_sha256"]:
            raise ValueError("Historical proxy targets a stale gallery reference")
        return None

    def report(self):
        def pairs(reasons):
            return [
                {"catalog_item_ids": list(pair), "reasons": sorted(values)}
                for pair, values in sorted(reasons.items())
            ]

        return {
            "schema_version": "contest-training-policy-report/1",
            "policy_sha256": self.policy_sha256,
            "gallery_sha256": self.gallery_sha256,
            "identical_sha_group_count": len(self.sha_groups),
            "identical_sha_groups": self.sha_groups,
            "identical_sha_affected_catalog_ids": sorted(
                {key for g in self.sha_groups for key in g["catalog_item_ids"]}
            ),
            "curated_relationship_group_count": len(self.groups),
            "curated_relationship_groups": self.groups,
            "diagnostic_groups": [g for g in self.groups if g["type"] == DIAGNOSTIC_TYPE],
            "forbidden_negative_pair_count": len(self.negative_reasons),
            "forbidden_hard_negative_pair_count": len(self.hard_reasons),
            "forbidden_negative_pairs": pairs(self.negative_reasons),
            "forbidden_hard_negative_pairs": pairs(self.hard_reasons),
            "affected_catalog_ids": sorted({key for pair in self.hard_reasons for key in pair}),
            "pair_count_semantics": "Unique unordered distinct-ID pairs; excludes self-pairs. No transitive closure.",
            "inference_identity_count": len(self.ids),
            "inference_catalog_ids": self.ids,
            "inference_official_slugs": [self.rows[key]["official_slug"] for key in self.ids],
            "inference_identities_preserved": True,
            "automatic_cross_identity_visual_positives": False,
        }


def build_training_dataset(gallery, proxy, policy=None, *, expected_count=2103):
    rules = TrainingPolicy(gallery, policy, expected_count=expected_count)
    if (
        proxy["dataset_type"] != "proxy_same_source"
        or proxy["row_count"] != len(proxy["rows"])
        or proxy["gallery_sha256"] != digest(gallery["rows"])
    ):
        raise ValueError("Proxy/gallery snapshot differs")
    positives, excluded, seen = [], [], set()
    for row in sorted(
        proxy["rows"], key=lambda r: (r["catalog_item_id"], r["historical_image_id"])
    ):
        identity = (row["catalog_item_id"], row["historical_image_id"])
        if identity in seen:
            raise ValueError("Duplicate historical training assignment")
        seen.add(identity)
        reason = rules.historical_positive_exclusion(row)
        if reason:
            excluded.append({**row, "training_exclusion_reason": reason})
        else:
            positives.append(dict(row))
    return {
        "schema_version": "contest-training-dataset/1",
        "policy": rules.report(),
        "official_reference_rows": [rules.rows[key] for key in rules.ids],
        "official_positive_policy": "Each reference/augmentation targets its own official identity only.",
        "historical_positive_rows": positives,
        "excluded_historical_positive_rows": excluded,
        "historical_positive_count": len(positives),
        "excluded_historical_positive_count": len(excluded),
    }


def mine_hard_negatives(
    matrix, embedding_rows, gallery, policy=None, *, top_k=10, expected_count=2103
):
    rules = TrainingPolicy(gallery, policy, expected_count=expected_count)
    if type(top_k) is not int or top_k <= 0:
        raise ValueError("top_k must be positive")
    validate_vectors(matrix, len(rules.ids), matrix.shape[1])
    if [r["catalog_item_id"] for r in embedding_rows] != rules.ids:
        raise ValueError("Embedding identity order differs from current gallery")
    for row in embedding_rows:
        current = rules.rows[row["catalog_item_id"]]
        if (
            row["sha256"] != current["reference_sha256"]
            or row["official_slug"] != current["official_slug"]
        ):
            raise ValueError("Embedding references differ from current gallery")
    result = []
    similarities = matrix @ matrix.T
    for index, anchor in enumerate(rules.ids):
        scores = similarities[index]
        ranking = rank_scores(scores, rules.ids)
        eligible = [
            int(j) for j in ranking if rules.can_be_negative(anchor, rules.ids[j], hard=True)
        ]
        selected = eligible[:top_k]
        result.append(
            {
                "catalog_item_id": anchor,
                "official_slug": rules.rows[anchor]["official_slug"],
                "hard_negatives": [
                    {
                        "catalog_item_id": rules.ids[j],
                        "official_slug": embedding_rows[j]["official_slug"],
                        "cosine_similarity": float(scores[j]),
                    }
                    for j in selected
                ],
            }
        )
    return {
        "schema_version": "contest-hard-negatives/1",
        "gallery_sha256": rules.gallery_sha256,
        "policy_sha256": rules.policy_sha256,
        "top_k": top_k,
        "row_count": len(result),
        "rows": result,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gallery-manifest", type=Path, required=True)
    parser.add_argument("--proxy-manifest", type=Path, required=True)
    parser.add_argument("--policy", type=Path, default=DEFAULT_POLICY)
    parser.add_argument("--gallery-bundle", type=Path)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.output.exists():
        parser.error("Use a new output directory; existing artifacts are immutable")
    gallery, proxy, policy = (
        read_json(args.gallery_manifest),
        read_json(args.proxy_manifest),
        load_policy(args.policy),
    )
    dataset = build_training_dataset(gallery, proxy, policy)
    hard = None
    if args.gallery_bundle:
        matrix, rows, metadata = load_bundle(args.gallery_bundle)
        if metadata["dataset_type"] != "official_gallery":
            raise ValueError("Hard-negative mining needs official gallery embeddings")
        hard = mine_hard_negatives(matrix, rows, gallery, policy, top_k=args.top_k)
    write_json(args.output / "training-dataset.json", dataset)
    write_json(args.output / "training-policy-report.json", dataset["policy"])
    if hard is not None:
        write_json(args.output / "hard-negatives.json", hard)
    print(
        json.dumps(
            {
                key: value
                for key, value in dataset["policy"].items()
                if key.endswith("_count") or key == "inference_identities_preserved"
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
