#!/usr/bin/env python3
"""One sequential, resource-bounded pipeline. Resume by validated image records."""

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

IMAGE = "sha256:222c7906258dc4f034f2b90db3c647713a9f1a0e4f2df569f8f40d302bb7bca5"


def command(repo, manifest, phase, selected=False):
    args = [
        "docker",
        "run",
        "--rm",
        "--user",
        f"{os.getuid()}:{os.getgid()}",
        "--name",
        "vinedetect-v8-eval",
        "--gpus",
        "all",
        "--memory",
        "6g",
        "--memory-swap",
        "6g",
        "--cpus",
        "4",
        "--volumes-from",
        "vinedetect-vision-service-1:ro",
        "-v",
        f"{repo}:/workspace",
        "-w",
        "/workspace/vision-service",
    ]
    env = dict(
        PYTHONPATH="/workspace/vision-service",
        PYTHONDONTWRITEBYTECODE="1",
        HF_HOME="/models/huggingface",
        HF_HUB_OFFLINE="1",
        TRANSFORMERS_OFFLINE="1",
        PADDLE_PDX_CACHE_HOME="/models/paddlex",
        RETRIEVAL_GALLERY_ROOT="/gallery",
        V5_ASSET_ROOT="/data/assets",
        V5_DINOV3_MODEL_DIR="/models/dinov3",
        V8_REFERENCE_CACHE="/workspace/.generated/v8/reference-cache",
        OMP_NUM_THREADS="2",
        MKL_NUM_THREADS="2",
    )
    for k, v in env.items():
        args.extend(["-e", k + "=" + v])
    args.extend(
        [
            IMAGE,
            "python",
            "-u",
            "-m",
            "app.v8.evaluate",
            "--repo",
            "/workspace",
            "--manifest",
            manifest,
            "--phase",
            phase,
            "--max-new-rows",
            "8",
        ]
    )
    if selected:
        args.extend(["--config", "/workspace/.generated/v8/selected-config.json"])
    return args


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    ap.add_argument(
        "--through", choices=("scored", "smoke", "report", "latency"), default="latency"
    )
    args = ap.parse_args()
    repo = args.repo.resolve()
    root = repo / ".generated/v8"
    root.mkdir(parents=True, exist_ok=True)
    # No inference workers or preparation processes are spawned concurrently.
    for manifest, phase in (
        ("scored", "explore"),
        ("smoke", "explore"),
        ("scored", "latency"),
    ):
        if manifest == "smoke":
            env = dict(
                os.environ,
                PYTHONPATH=str(repo / "vision-service"),
                PYTHONDONTWRITEBYTECODE="1",
            )
            subprocess.run(
                [
                    str(repo / "vision-service/.venv/bin/python"),
                    "-m",
                    "app.v8.report",
                    "--repo",
                    str(repo),
                ],
                check=True,
                env=env,
            )
            if args.through == "report":
                break
        for batch in range(100):
            log = root / f"{manifest}-{phase}-{int(time.time())}-{batch:03d}.log"
            with log.open("w") as stream:
                process = subprocess.Popen(
                    command(repo, manifest, phase, phase == "latency"),
                    stdout=stream,
                    stderr=subprocess.STDOUT,
                )
                while process.poll() is None:
                    # Lightweight log; no second model/preparation/latency job.
                    observation = dict(
                        time=time.time(), manifest=manifest, phase=phase, batch=batch
                    )
                    for name, cmd in (
                        (
                            "gpu",
                            [
                                "nvidia-smi",
                                "--query-gpu=memory.used,memory.total,utilization.gpu",
                                "--format=csv,noheader,nounits",
                            ],
                        ),
                        (
                            "worker",
                            [
                                "docker",
                                "stats",
                                "--no-stream",
                                "--format",
                                "{{.MemUsage}}",
                                "vinedetect-v8-eval",
                            ],
                        ),
                        (
                            "resident_restart",
                            [
                                "docker",
                                "inspect",
                                "vinedetect-vision-service-1",
                                "--format",
                                "{{.RestartCount}} {{.State.StartedAt}}",
                            ],
                        ),
                    ):
                        try:
                            observation[name] = subprocess.check_output(
                                cmd, text=True, timeout=10
                            ).strip()
                        except (OSError, subprocess.SubprocessError):
                            observation[name] = "unavailable"
                    with (root / "resources.jsonl").open("a") as out:
                        out.write(json.dumps(observation) + "\n")
                        out.flush()
                        os.fsync(out.fileno())
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        pass
            print(log.name, process.returncode, flush=True)
            if process.returncode:
                print(log.read_text()[-6000:], flush=True)
                raise SystemExit(process.returncode)
            lines = [
                line for line in log.read_text().splitlines() if line.startswith("{")
            ]
            if lines:
                print(lines[-1], flush=True)
                status = json.loads(lines[-1])
                if status.get("complete") or status.get("remaining") == 0:
                    break
        else:
            raise RuntimeError("Batch limit exceeded")
        if args.through == "scored" and manifest == "scored":
            break
        if args.through == "smoke" and manifest == "smoke":
            break
    if args.through == "latency":
        env = dict(
            os.environ,
            PYTHONPATH=str(repo / "vision-service"),
            PYTHONDONTWRITEBYTECODE="1",
        )
        subprocess.run(
            [
                str(repo / "vision-service/.venv/bin/python"),
                "-m",
                "app.v8.finalize",
                "--repo",
                str(repo),
            ],
            check=True,
            env=env,
        )


if __name__ == "__main__":
    main()
