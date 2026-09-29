"""Production V3 + V5 orchestration; shared models, request-local evidence."""

import io
import logging
import os
import time
from functools import lru_cache
from threading import Lock

import cv2
import numpy as np
from PIL import Image

from .catalog import Catalog
from .decision import decide, frozen_v3, rank_map
from .geometry import crop_xywh, descriptors, match_features, pairwise_geometry
from .models import DinoRetrieval, OcrRetrieval
from .text import ocr_pairwise

logger = logging.getLogger(__name__)
# Serialize the shared OpenCV/Paddle runtimes, including their RNG state.
inference_lock = Lock()
_runtime = None
_startup_lock = Lock()


def crop(image, box, pad=0.08):
    if box is None:
        return None
    x, y, w, h = box
    bounds = (
        max(0, round(x - w * pad)),
        max(0, round(y - h * pad)),
        min(image.width, round(x + w + w * pad)),
        min(image.height, round(y + h + h * pad)),
    )
    return (
        image.crop(bounds) if bounds[2] > bounds[0] and bounds[3] > bounds[1] else None
    )


def bottle_image(image, box):
    result = crop(image, box, pad=0)
    if result is None:
        return None
    # Validated target crops were JPEG quality=95 before CV/semantic inference.
    # Preserve that encoding in memory rather than introducing temporary files.
    buffer = io.BytesIO()
    result.save(buffer, format="JPEG", quality=95)
    buffer.seek(0)
    return Image.open(buffer).convert("RGB")


class Pipeline:
    def __init__(self):
        from ..dino import dino_runtime
        from ..retrieval import GALLERY_ROOT, retrieval_runtime, retrieve_top_k

        started = time.perf_counter()
        self.catalog = Catalog(GALLERY_ROOT, os.getenv("V5_ASSET_ROOT", "/data/assets"))
        retrieval_runtime()
        self.retrieve = retrieve_top_k
        self.ocr = self.dino = None
        self.startup_failures = []
        self.target_available = False
        for name, factory in (
            ("targetDetection", dino_runtime),
            ("ocr", lambda: OcrRetrieval(self.catalog)),
            ("dino", lambda: DinoRetrieval(self.catalog)),
        ):
            try:
                model = factory()
                if name == "targetDetection":
                    self.target_available = True
                else:
                    setattr(self, name, model)
            except Exception:
                logger.exception("V5 startup auxiliary unavailable: %s", name)
                self.startup_failures.append(name)
        self.cold_startup_ms = (time.perf_counter() - started) * 1000

    @lru_cache(maxsize=None)
    def reference(self, cid):
        try:
            path = self.catalog.reference_path(cid)
            image = cv2.imread(str(path), cv2.IMREAD_COLOR)
            if image is None:
                raise RuntimeError("Cannot decode official reference")
            return descriptors(image)
        except Exception:
            logger.exception("V5 reference unavailable: catalogItemId=%s", cid)
            return None

    def recognize(self, image, target, label_roi):
        started = time.perf_counter()
        timings = {
            name: 0.0
            for name in (
                "fullSiglip",
                "bottleSiglip",
                "labelSiglip",
                "ocr",
                "dinoV3",
                "localMatching",
                "decision",
            )
        }
        timings["targetDetection"] = target.get("targetDetectionMs", 0.0)
        failures = list(self.startup_failures)

        def timed(name, action, fallback=None, required=False):
            t = time.perf_counter()
            try:
                return action()
            except Exception:
                logger.exception("V5 evidence unavailable: %s", name)
                failures.append(name)
                if required:
                    raise
                return fallback
            finally:
                timings[name] += (time.perf_counter() - t) * 1000

        views = {
            "full": timed(
                "fullSiglip",
                lambda: self.retrieve(image, limit=20)["candidates"],
                required=True,
            )
        }
        full = views["full"]
        if len(full) < 2:
            raise RuntimeError("V5 requires at least two full-image candidates")
        baseline = int(full[0]["catalogItemId"])
        # Contract is cosineSimilarity. Never default a missing score to zero.
        margin = float(full[0]["cosineSimilarity"]) - float(full[1]["cosineSimilarity"])
        if not np.isfinite(margin):
            raise RuntimeError("Invalid SigLIP margin")
        bottle = bottle_image(image, target.get("bottleBox"))
        label = None
        if bottle is not None and label_roi is not None:
            x, y, w, h = label_roi
            label = crop(
                bottle,
                [
                    x * bottle.width,
                    y * bottle.height,
                    w * bottle.width,
                    h * bottle.height,
                ],
            )
        for name, view_image in (("bottle", bottle), ("label", label)):
            views[name] = (
                timed(
                    name + "Siglip",
                    lambda: self.retrieve(view_image, limit=20)["candidates"],
                    [],
                )
                if view_image is not None
                else []
            )

        # Frozen auxiliaries and local geometry use ORIGINAL selected DINO ROI.
        selected = crop(image, target.get("originalLabel"))
        ocr_text, ocr_ids = ("", [])
        dino_ids = []
        if selected is not None:
            if self.ocr is not None:
                ocr_text, ocr_ids = timed(
                    "ocr", lambda: self.ocr.retrieve(selected), ("", [])
                )
            if self.dino is not None:
                dino_ids = timed("dinoV3", lambda: self.dino.retrieve(selected), [])

        bgr = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
        query_cache = {}

        def query(box):
            if box is None:
                return None
            key = tuple(box)
            if key not in query_cache:
                region = crop_xywh(bgr, box)
                query_cache[key] = descriptors(region) if region is not None else None
            return query_cache[key]

        def score_candidates(ids, boxes):
            queries = [query(box) for box in boxes if box is not None]
            queries = [q for q in queries if q is not None]
            if not queries:
                return []
            scored = []
            ranks = rank_map(views, "full")
            for cid in ids:
                ref = self.reference(cid)
                if ref is None:
                    # A missing baseline descriptor must not become baselineSiftScore=0.
                    return []
                best = max(
                    (
                        match_features(q["kp"], q["sift"], ref["kp"], ref["sift"])
                        for q in queries
                    ),
                    key=lambda m: (
                        m["score"],
                        m["inliers"],
                        m["good_matches"],
                        m["inlier_ratio"],
                    ),
                )
                scored.append(
                    dict(best, catalog_item_id=cid, siglip_rank=ranks.get(cid, 999))
                )
            return sorted(
                scored,
                key=lambda c: (
                    -c["score"],
                    -c["inliers"],
                    -c["good_matches"],
                    c["siglip_rank"],
                ),
            )

        def local():
            ids = [int(c["catalogItemId"]) for c in full]
            original = target.get("originalLabel")
            far = score_candidates(ids, [original])
            # Reuse the original pair metrics, preserving the primary gate's own sorting.
            primary = [c for c in far if c["siglip_rank"] <= 10]
            all_labels = target.get("allLabels") or ([original] if original else [])
            multi = score_candidates(ids[:10], all_labels)
            intent = score_candidates(ids[:10], [target.get("intentLabel")])
            union_ids = list(dict.fromkeys(ids + ocr_ids[:5] + dino_ids[:5]))
            union = score_candidates(union_ids, [original])
            return frozen_v3(
                baseline,
                margin,
                ids,
                primary,
                multi,
                intent,
                far,
                union,
                ocr_ids,
                dino_ids,
            )

        v3, v3_reason = timed(
            "localMatching", local, (baseline, "auxiliary-unavailable")
        )
        evidence_cache = {}

        def evidence_for(challenger):
            if challenger not in evidence_cache:
                geometry = timed(
                    "localMatching",
                    lambda: pairwise_geometry(
                        query(target.get("originalLabel")),
                        self.reference(baseline),
                        self.reference(challenger),
                    ),
                    {"available": False, "strictVeto": False, "softSupport": False},
                )
                evidence_cache[challenger] = {
                    "viewRanks": {
                        v: rank_map(views, v).get(challenger)
                        for v in ("full", "bottle", "label")
                    },
                    "ocr": ocr_pairwise(
                        ocr_text,
                        self.catalog.by_id[baseline]["title"],
                        self.catalog.by_id[challenger]["title"],
                    ),
                    "geometry": geometry,
                    "dinoRank": dino_ids.index(challenger) + 1
                    if challenger in dino_ids
                    else None,
                    "ocrTop5": challenger in ocr_ids[:5],
                }
            return evidence_cache[challenger]

        t = time.perf_counter()
        local_before = timings["localMatching"]
        decision = decide(baseline, v3, views, evidence_for, dino_ids, ocr_ids)
        timings["decision"] = max(
            0.0,
            (time.perf_counter() - t) * 1000
            - (timings["localMatching"] - local_before),
        )
        timings["total"] = (time.perf_counter() - started) * 1000 + timings[
            "targetDetection"
        ]
        result = {
            "architecture": "V5-RC1",
            "result": self.catalog.identity(decision["catalogItemId"]),
            "diagnostics": {
                "baseline": baseline,
                "baselineMargin": margin,
                "views": views,
                "v3": v3,
                "v3Reason": v3_reason,
                "decision": decision,
                "timingsMs": timings,
                "failures": failures,
            },
        }
        logger.info(
            "V5 recognition catalogItemId=%s reason=%s timingsMs=%s failures=%s",
            decision["catalogItemId"],
            decision["reason"],
            timings,
            failures,
        )
        return result


def preload():
    global _runtime
    with _startup_lock:
        if _runtime is None:
            _runtime = Pipeline()
    return _runtime


def runtime():
    if _runtime is None:
        raise RuntimeError("V5 runtime was not preloaded")
    return _runtime


def readiness():
    """Inspect preloaded state without loading models or changing evidence fallbacks."""
    from ..dino import dino_loaded
    from ..retrieval import retrieval_loaded
    from .catalog import DINO_ID, DINO_REVISION

    service = _runtime
    dino = service.dino if service is not None else None
    components = {
        "groundingDinoLoaded": bool(service and service.target_available and dino_loaded()),
        "siglipRetrievalLoaded": retrieval_loaded(),
        "dinov3Loaded": dino is not None,
        "ocrLoaded": bool(service and service.ocr is not None),
        "galleryLoaded": bool(service and service.catalog.dino_gallery is not None),
    }
    return {
        "architecture": "V5-RC1",
        "v5Ready": all(components.values()),
        **components,
        "unavailableV5Components": [name for name, loaded in components.items() if not loaded],
        "dinov3Model": DINO_ID,
        "dinov3Revision": DINO_REVISION,
        "dinov3SnapshotPath": str(dino.snapshot_path) if dino else None,
        "dinov3Device": dino.device if dino else None,
    }
