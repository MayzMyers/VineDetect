"""Uniform scoring only. No images, GT, baseline decisions or model loaders."""

from collections import Counter
from dataclasses import asdict, dataclass
from itertools import product

import numpy as np

from ..v8.ocr import GENERIC, tokens
from ..v8.geometry import normalized

SOURCES = ("siglip", "dino", "label_siglip")
ATTRIBUTES = ("grape", "color_style", "sweetness", "brut", "vintage")
IDENTITY = ("producer", "product", "other")
MIX = np.array([1.0, 0.5, 0.15])


@dataclass(frozen=True)
class Scoring:
    semantic: str = "legacy"
    ocr: str = "legacy"
    identity: float = 0.6
    attribute: float = 0.0
    conflict: float = 0.0
    geometry: float = 0.6

    def json(self):
        return asdict(self)

    @property
    def key(self):
        return f"{self.semantic}__{self.ocr}__i{self.identity:g}_a{self.attribute:g}_c{self.conflict:g}_g{self.geometry:g}"


def grid():
    out = [
        Scoring(semantic=s, geometry=g)
        for s, g in product(("legacy", "minmax", "calibrated_cosine"), (0.3, 0.6))
    ]
    out += [
        Scoring(s, o, i, a, c, g)
        for s, o, i, a, c, g in product(
            ("legacy", "minmax", "calibrated_cosine"),
            ("structured", "shared_family"),
            (0.3, 0.6),
            (0.4, 0.8),
            (0.0, 1.0),
            (0.3, 0.6),
        )
    ]
    return sorted(out, key=lambda c: c.key)


def fit_anchors(traces):
    """Catalog-independent, label-free quantiles with equal image/source weight."""
    result = {}
    for source in SOURCES:
        values, weights = [], []
        for trace in traces:
            scores = [r["score"] for r in trace["sources"].get(source, [])]
            values.extend(scores)
            weights.extend([1 / len(scores)] * len(scores))
        if not values:
            result[source] = [0.0, 1.0]
            continue
        order = np.argsort(values, kind="stable")
        x = np.asarray(values)[order]
        w = np.asarray(weights)[order]
        cumulative = np.cumsum(w) / np.sum(w)
        result[source] = [float(np.interp(q, cumulative, x)) for q in (0.05, 0.95)]
    return result


def prepare(trace, ids, idf):
    """Derive normalization features only from persisted candidate/text evidence."""
    ids = sorted(ids)
    raw = [trace["evidence"][str(cid)] for cid in ids]
    source_values = np.zeros((len(ids), 3))
    present = np.zeros((len(ids), 3), dtype=bool)
    minmax = np.zeros((len(ids), 3))
    legacy = np.zeros((len(ids), 3))
    for j, source in enumerate(SOURCES):
        rows = trace["sources"].get(source, [])
        lookup = {r["id"]: r for r in rows}
        lo = min((r["score"] for r in rows), default=0.0)
        hi = max((r["score"] for r in rows), default=0.0)
        for i, cid in enumerate(ids):
            if cid in lookup:
                row = lookup[cid]
                present[i, j] = True
                source_values[i, j] = row["score"]
                minmax[i, j] = (row["score"] - lo) / (hi - lo) if hi > lo else 1.0
                legacy[i, j] = 0.75 * minmax[i, j] + 0.25 / row["rank"]
    sem = (legacy[:, 0] + 0.5 * legacy[:, 1] + 0.15 * legacy[:, 2]) / 1.65
    top = sorted(range(len(ids)), key=lambda i: (-sem[i], ids[i]))[:10]
    membership = Counter()
    for i in top:
        fields = raw[i]["ocr"]["fields"]
        membership.update(
            set().union(
                *(
                    set(fields[f]["matched"]) | set(fields[f]["missing"])
                    for f in IDENTITY
                )
            )
        )
    confidence = {}
    ocr = trace["ocr"]
    for line, value in zip(ocr.get("texts", []), ocr.get("confidences", [])):
        for token in tokens(line):
            confidence[token] = max(
                confidence.get(token, 0.0), float(np.clip(value, 0.0, 1.0))
            )
    structured = np.zeros((len(ids), 6))
    shared = np.zeros((len(ids), 6))
    attributes = np.zeros((len(ids), 10))
    for i, evidence in enumerate(raw):
        fields = evidence["ocr"]["fields"]
        for j, field in enumerate(IDENTITY):
            for token in fields[field]["matched"]:
                if token in GENERIC:
                    continue
                value = idf.get(token, 0.0) * confidence.get(token, 0.0)
                family = field == "producer" or membership[token] >= 2
                col = j * 2 + (0 if family else 1)
                structured[i, col] += value
                shared[i, col] += value / np.sqrt(max(1, membership[token]))
        for matrix in (structured, shared):
            total = float(matrix[i].sum())
            matrix[i] /= max(2.0, total)
        for j, field in enumerate(ATTRIBUTES):
            matched = [
                confidence.get(t, 0.0)
                for t in fields[field]["matched"]
                if t not in GENERIC
            ]
            conflicts = [
                confidence.get(t, 0.0)
                for t in fields[field]["conflicts"]
                if t not in GENERIC
            ]
            attributes[i, 2 * j] = float(np.mean(matched)) if matched else 0.0
            maximum = max(conflicts, default=0.0)
            attributes[i, 2 * j + 1] = maximum if maximum >= 0.85 else 0.0
    return dict(
        ids=ids,
        source_values=source_values,
        present=present,
        minmax=minmax,
        legacy=legacy,
        structured=structured,
        shared_family=shared,
        attributes=attributes,
        identity=np.array([r["ocr"]["identity"] for r in raw]),
        geometry=np.array([normalized(r["geometry"]) for r in raw]),
        quality=np.array(
            [
                (
                    int(r["ocr"]["available"])
                    + int(r["geometry"].get("available", False))
                )
                / 2
                for r in raw
            ]
        ),
        family_reference_ids=[ids[i] for i in top],
        family_token_membership=dict(membership),
    )


def contributions(prepared, config, anchors):
    if config.semantic == "calibrated_cosine":
        semantic = np.zeros_like(prepared["source_values"])
        for j, source in enumerate(SOURCES):
            lo, hi = anchors[source]
            semantic[:, j] = np.where(
                prepared["present"][:, j],
                np.clip(
                    (prepared["source_values"][:, j] - lo) / max(hi - lo, 1e-12),
                    0.0,
                    1.0,
                ),
                0.0,
            )
    else:
        semantic = prepared[config.semantic]
    group = (semantic[:, 0] + 0.5 * semantic[:, 1] + 0.15 * semantic[:, 2]) / 1.65
    result = dict(semantic=group)
    if config.ocr == "legacy":
        result["ocr_identity"] = prepared["identity"] * config.identity
        result["ocr_attributes"] = np.zeros(len(group))
    else:
        matrix = prepared[config.ocr]
        for j, field in enumerate(IDENTITY):
            for k, kind in enumerate(("family", "sku")):
                result[field + "_" + kind + "_match"] = (
                    matrix[:, 2 * j + k] * config.identity
                )
        for j, field in enumerate(ATTRIBUTES):
            result[field + "_match"] = (
                prepared["attributes"][:, 2 * j] * config.attribute / 5
            )
            result[field + "_conflict"] = (
                -prepared["attributes"][:, 2 * j + 1]
                * config.attribute
                * config.conflict
                / 5
            )
    result["geometry"] = prepared["geometry"] * config.geometry
    result["quality"] = prepared["quality"] * 0.05
    components = semantic * MIX / 1.65
    return result, components


def score(prepared, config, anchors):
    fields, _ = contributions(prepared, config, anchors)
    # Python 3.12 sum uses improved floating-point summation; preserve V8 exactly.
    return np.array(
        [sum(float(value) for value in values) for values in zip(*fields.values())]
    )


def ranking(prepared, config, anchors):
    fields, components = contributions(prepared, config, anchors)
    scores = score(prepared, config, anchors)
    order = sorted(range(len(scores)), key=lambda i: (-scores[i], prepared["ids"][i]))
    return [
        dict(
            id=prepared["ids"][i],
            score=float(scores[i]),
            contributions={k: float(v[i]) for k, v in fields.items()},
            semantic_components={
                s: float(components[i, j]) for j, s in enumerate(SOURCES)
            },
        )
        for i in order
    ]
