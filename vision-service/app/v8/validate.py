"""Read-only checkpoint inventory for recovery; does not load inference models."""

import argparse
import hashlib
import json
from collections import Counter
from dataclasses import replace
from pathlib import Path

from .audit import valid_assets
from .checkpoint import atomic_json, digest, read
from .config import Config
from .evaluate import provenance


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--partial", action="store_true")
    args = ap.parse_args()
    repo = args.repo
    root = repo / ".generated/v8"
    result = {}
    failures = False
    validated_scored = []
    for name, filename in (
        ("scored", "image-manifest.json"),
        ("smoke", "smoke-manifest.json"),
    ):
        manifest = json.loads((repo / ".generated/v7" / filename).read_text())
        counts = Counter()
        datasets = Counter()
        invalid = []
        for row in manifest:
            key = hashlib.sha256(row["key"].encode()).hexdigest()
            path = root / "explore" / (key + ".json")
            if not path.exists():
                counts["missing"] += 1
                continue
            data = read(path, provenance(repo, row, Config(), "explore"))
            if data is None:
                counts["corrupt_or_stale"] += 1
                invalid.append(row["key"])
                continue
            photo = Path(row["imagePath"])
            if not photo.exists():
                photo = repo / photo.relative_to("/home/mayz/projects/vinedetect_dev")
            if hashlib.sha256(photo.read_bytes()).hexdigest() != row["sha256"]:
                counts["input_hash_mismatch"] += 1
                invalid.append(row["key"])
                continue
            if not valid_assets(root / "audit" / key, data["trace"]):
                counts["invalid_audit_assets"] += 1
                invalid.append(row["key"])
                continue
            counts["valid"] += 1
            if name == "scored":
                validated_scored.append((row, key, data["trace"]))
            datasets[row["dataset"]] += 1
        result[name] = dict(
            total=len(manifest),
            counts=dict(counts),
            by_dataset=dict(datasets),
            invalid=invalid,
        )
        failures |= bool(invalid) or (
            not args.partial and counts["valid"] != len(manifest)
        )
    selected_path = root / "selected-config.json"
    if selected_path.exists():
        selected = Config(**json.loads(selected_path.read_text()))
        variants = {
            "V8-S0": replace(selected, kd=0, ko=0, kl=0, geometry_enabled=False),
            "V8-S1": replace(selected, ko=0, kl=0, geometry_enabled=False),
            "V8-S2": replace(selected, kl=0, geometry_enabled=False),
            "V8-S3": replace(selected, kl=0),
            "V8-final": selected,
            "V8-no-cap": replace(selected, max_pool_size=0),
        }
        summary = json.loads((root / "summary.json").read_text())
        if "V8-S4" in summary["metrics"]:
            variants["V8-S4"] = replace(selected, kl=15)
        report_hash = hashlib.sha256(
            (Path(__file__).parent / "report.py").read_bytes()
        ).hexdigest()
        counts = Counter()
        invalid = []
        for row, key, trace in validated_scored:
            for variant, config in variants.items():
                path = root / "variants" / (key + "-" + variant + ".json")
                prov = dict(
                    evidence=digest(trace),
                    config=config.json(),
                    report_code=report_hash,
                )
                if read(path, prov) is None:
                    counts["corrupt_stale_or_missing"] += 1
                    invalid.append(row["key"] + ":" + variant)
                else:
                    counts["valid"] += 1
        result["variants"] = dict(counts=dict(counts), invalid=invalid)
        failures |= bool(invalid)
        manifest = json.loads((repo / ".generated/v7/image-manifest.json").read_text())
        rows = [
            row
            for dataset in sorted({r["dataset"] for r in manifest})
            for group in [[r for r in manifest if r["dataset"] == dataset]]
            for row in (group[0], group[len(group) // 2])
        ]
        counts = Counter()
        invalid = []
        for row in rows:
            key = hashlib.sha256(row["key"].encode()).hexdigest()
            data = read(
                root / "latency" / (key + ".json"),
                provenance(repo, row, selected, "latency"),
            )
            if data is None:
                counts["corrupt_stale_or_missing"] += 1
                if not args.partial:
                    invalid.append(row["key"])
            elif not valid_assets(root / "latency-audit" / key, data["trace"]):
                counts["invalid_audit_assets"] += 1
                invalid.append(row["key"])
            else:
                counts["valid"] += 1
        result["latency"] = dict(total=len(rows), counts=dict(counts), invalid=invalid)
        failures |= bool(invalid)
    atomic_json(root / "checkpoint-validation.json", result)
    print(json.dumps(result, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
