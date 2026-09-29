"""Direct-vs-saved SigLIP numerical and ranking checks; no completed photo reruns."""
import argparse
import hashlib
import json
import os
from dataclasses import replace
from pathlib import Path

from PIL import Image

from .checkpoint import atomic_json, canonical
from .config import Config
from .pipeline import pixels
from .report import predict, weight_grid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=Path, required=True)
    args = ap.parse_args()
    root = args.repo / ".generated/v8"
    os.environ.pop("V8_SIGLIP_URL", None)
    os.environ.setdefault("PYTORCH_KERNEL_CACHE_PATH", str(root / "torch-kernels"))
    import cv2
    import torch
    cv2.setNumThreads(2)
    torch.set_num_threads(2)
    tf32_before = torch.backends.cuda.matmul.allow_tf32
    from .backend import Backend
    backend = Backend()
    records = sorted((json.loads(p.read_text()) for p in (root / "explore").glob("*.json")),
                     key=lambda r: r["payload"]["key"])
    checks = []
    for record in records:
        payload = record["payload"]
        if payload["status"] != "ok":
            continue
        trace = payload["trace"]
        new_trace = dict(trace, sources=dict(trace["sources"]))
        key = hashlib.sha256(payload["key"].encode()).hexdigest()
        for source, filename, pixel_key in (("siglip", "target.png", "target_pixel_hash"),
                                           ("label_siglip", "label.png", "label_pixel_hash")):
            expected = trace["sources"][source]
            if not expected:
                continue
            with Image.open(root / "audit" / key / filename) as loaded:
                image = loaded.convert("RGB")
            assert pixels(image) == trace[pixel_key]
            actual = backend.siglip(image, 30)
            delta = max(abs(a["score"]-b["score"]) for a,b in zip(actual, expected))
            check = dict(dataset=payload["dataset"], key=payload["key"], source=source,
                         exact_equal=actual == expected, max_score_delta=delta,
                         ids_equal=[x["id"] for x in actual] == [x["id"] for x in expected],
                         numerically_equal=delta <= 1e-6)
            checks.append(check)
            new_trace["sources"][source] = actual
        # Verify global candidate order over the whole grid superset, so any cap/subset
        # inherits that order. This checks fixed, already-declared weights, never selects them.
        stable = True
        for ko, kl in ((0,0),(10,0),(0,15),(10,15)):
            for weights,dw in weight_grid():
                config=Config(ks=30,kd=20,ko=ko,kl=kl,max_pool_size=0,weights=weights,dino_weight=dw)
                before=predict(trace,config);after=predict(new_trace,config)
                if [r["id"] for r in before["ordered"]] != [r["id"] for r in after["ordered"]]:
                    stable=False
                    break
            if not stable:break
        for check in checks:
            if check["key"]==payload["key"]:check["all_predeclared_orders_equal"]=stable
        print(json.dumps(dict(key=payload["key"],rank_stable=stable)),flush=True)
    result = dict(checks=checks, tf32_before=tf32_before,
                  tf32_after=torch.backends.cuda.matmul.allow_tf32,
                  all_exact=all(c["exact_equal"] for c in checks),
                  all_numerically_equal=all(c["numerically_equal"] for c in checks),
                  all_orders_equal=all(c["ids_equal"] and c["all_predeclared_orders_equal"] for c in checks),
                  tolerance=1e-6,model_precision_resolution_k_changed=False,
                  completed_checkpoints_rewritten=False)
    atomic_json(root / "direct-siglip-parity.json", result)
    print(json.dumps({k:v for k,v in result.items() if k!="checks"}),flush=True)
    assert result["all_numerically_equal"] and result["all_orders_equal"]
    assert result["tf32_before"] == result["tf32_after"]


if __name__ == "__main__":
    main()
