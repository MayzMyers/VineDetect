"""Sequential allowlisted development evaluation, resumable before model startup."""

import argparse
import hashlib
import json
import os
import resource
import subprocess
import time
from pathlib import Path
from .checkpoint import atomic_json, read, save, writer_lock
from .config import Config

ALLOWED = {
    "FIELD51",
    "UNSEEN32",
    "STORE13",
    "FRESH8",
    "IRECOMMEND128",
    "Secondary68",
    "SECONDARY68",
}
EVIDENCE_FILES = (
    "backend.py",
    "config.py",
    "target.py",
    "ocr.py",
    "geometry.py",
    "pool.py",
    "rerank.py",
    "pipeline.py",
    "reference_cache.py",
)


def provenance(repo, row, config, phase):
    here = Path(__file__).parent
    return dict(
        image=row["sha256"],
        config=config.json(),
        phase=phase,
        code={
            n: hashlib.sha256((here / n).read_bytes()).hexdigest()
            for n in EVIDENCE_FILES
        },
        specification=hashlib.sha256(
            (repo / "docs/V8-simple_onepager_v0.2.md").read_bytes()
        ).hexdigest(),
        catalog=hashlib.sha256(
            (repo / ".runtime/v5-rc1/catalog.json").read_bytes()
        ).hexdigest(),
    )


def resources():
    result = dict(max_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    for label, path in (
        ("container_ram_bytes", "/sys/fs/cgroup/memory.current"),
        ("container_peak_bytes", "/sys/fs/cgroup/memory.peak"),
        ("container_limit_bytes", "/sys/fs/cgroup/memory.max"),
    ):
        try:
            result[label] = int(Path(path).read_text())
        except (OSError, ValueError):
            pass
    try:
        result["host_memory_kib"] = {
            line.split(":")[0]: int(line.split()[1])
            for line in Path("/proc/meminfo").read_text().splitlines()
            if line.startswith(("MemTotal:", "MemAvailable:"))
        }
        result["gpu"] = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            text=True,
            timeout=10,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument("--manifest", choices=("scored", "smoke"), default="scored")
    ap.add_argument("--max-new-rows", type=int, default=8)
    ap.add_argument("--phase", choices=("explore", "latency"), default="explore")
    ap.add_argument("--config", type=Path)
    args = ap.parse_args()
    if not 1 <= args.max_new_rows <= 16:
        raise ValueError("Batch bound must be 1..16")
    repo = args.repo
    root = repo / ".generated/v8"
    config = Config(**json.loads(args.config.read_text())) if args.config else Config()
    filename = (
        "image-manifest.json" if args.manifest == "scored" else "smoke-manifest.json"
    )
    manifest = json.loads((repo / ".generated/v7" / filename).read_text())
    if not all(r["dataset"] in ALLOWED for r in manifest):
        raise ValueError("Manifest contains non-consumed dataset")
    if args.phase == "latency":
        # Two systematically spaced photos per dataset; identical selected config.
        manifest = [
            r
            for dataset in sorted({r["dataset"] for r in manifest})
            for rows in [[r for r in manifest if r["dataset"] == dataset]]
            for r in (rows[0], rows[len(rows) // 2])
        ]
    with writer_lock(root):
        runfile = root / "run-state.json"
        try:
            state = json.loads(runfile.read_text())
        except (OSError, ValueError):
            state = dict(worker_starts=0)
        state.update(
            worker_starts=state["worker_starts"] + 1,
            phase=args.phase,
            started=time.time(),
            status="running",
            resources=resources(),
        )
        atomic_json(runfile, state)
        pending = []
        for row in manifest:
            key = hashlib.sha256(row["key"].encode()).hexdigest()
            path = root / args.phase / (key + ".json")
            prov = provenance(repo, row, config, args.phase)
            photo = Path(row["imagePath"])
            if not photo.exists():
                photo = repo / photo.relative_to("/home/mayz/projects/vinedetect_dev")
            if hashlib.sha256(photo.read_bytes()).hexdigest() != row["sha256"]:
                raise ValueError("Input hash mismatch: " + row["key"])
            old = read(path, prov)
            assets = root / "audit" / key
            if old is not None and args.phase == "explore":
                from .audit import valid_assets, repair_assets

                if not valid_assets(assets, old["trace"]):
                    repair_assets(photo.read_bytes(), old["trace"], assets)
                    print(
                        json.dumps(
                            dict(audit_repaired=row["key"], inference_reused=True)
                        ),
                        flush=True,
                    )
            if old is None:
                pending.append((row, key, path, prov))
        if not pending:
            print(
                json.dumps(
                    dict(complete=True, manifest=args.manifest, phase=args.phase)
                ),
                flush=True,
            )
            state["status"] = "complete"
            atomic_json(runfile, state)
            return
        kernel_cache = root / "torch-kernels"
        kernel_cache.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("PYTORCH_KERNEL_CACHE_PATH", str(kernel_cache))
        import cv2
        import torch

        cv2.setNumThreads(2)
        torch.set_num_threads(2)
        from .backend import Backend
        from .pipeline import Pipeline
        from .target import TargetUnavailable

        pipeline = Pipeline(Backend(), config)
        for row, key, path, prov in pending[: args.max_new_rows]:
            photo = Path(row["imagePath"])
            if not photo.exists():
                original = Path("/home/mayz/projects/vinedetect_dev")
                photo = repo / photo.relative_to(original)
            raw = photo.read_bytes()
            if hashlib.sha256(raw).hexdigest() != row["sha256"]:
                raise ValueError("Input hash mismatch: " + row["key"])
            before = resources()
            # Stop before another photo when the host is under sustained pressure.
            if before.get("host_memory_kib", {}).get("MemAvailable", 9999999) < 1200000:
                raise RuntimeError("Host RAM headroom below 1.2 GB")
            if args.phase == "latency":
                pipeline.analyze(raw)  # per-photo warmup, outside measurement
            start = time.perf_counter()
            try:
                trace = pipeline.analyze(
                    raw,
                    root
                    / ("audit" if args.phase == "explore" else "latency-audit")
                    / key,
                    explore=args.phase == "explore",
                )
                status = "ok"
            except TargetUnavailable as exc:
                trace = exc.diagnostics
                status = "target_unavailable"
                # This is an attributed failure, never full-frame fallback.
                atomic_json(root / "audit" / key / "trace.json", trace)
            payload = dict(
                key=row["key"],
                dataset=row["dataset"],
                expected=row.get("expected"),
                status=status,
                trace=trace,
                wall_ms=(time.perf_counter() - start) * 1000,
                resources_before=before,
                resources_after=resources(),
                worker_start=state["worker_starts"],
                runtime=dict(
                    siglip="lossless_http"
                    if os.getenv("V8_SIGLIP_URL")
                    else "direct_gpu",
                    gpu_total_mib=12227,
                    precision_resolution_k_unchanged=True,
                ),
            )
            save(path, payload, prov)
            print(
                json.dumps(
                    dict(
                        key=row["key"],
                        status=status,
                        top1=trace.get("top1"),
                        expected=row.get("expected"),
                        ms=payload["wall_ms"],
                        verified=trace.get("verified_candidates"),
                        resources=payload["resources_after"],
                    )
                ),
                flush=True,
            )
            # Release unused allocator blocks; model weights and exact CPU reference LRU remain.
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        state.update(
            status="batch_complete", finished=time.time(), resources=resources()
        )
        atomic_json(runfile, state)
        print(
            json.dumps(
                dict(
                    remaining=max(0, len(pending) - args.max_new_rows), phase=args.phase
                )
            ),
            flush=True,
        )


if __name__ == "__main__":
    main()
