from __future__ import annotations

import os
import time
from threading import Lock
from typing import Any

import torch
from PIL import Image, ImageOps
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor


DINO_MODEL_ID = os.getenv(
    "DINO_MODEL",
    "IDEA-Research/grounding-dino-tiny",
)
DINO_MODEL_REVISION = os.getenv(
    "DINO_MODEL_REVISION",
    "a2bb814dd30d776dcf7e30523b00659f4f141c71",
).strip() or None
DINO_PRELOAD = os.getenv("DINO_PRELOAD", "false").strip().lower() in {
    "true",
    "1",
}
DEFAULT_PROMPT = "main wine label"
DEFAULT_THRESHOLD = 0.18
DEFAULT_TEXT_THRESHOLD = 0.15

_runtime: tuple[Any, Any, torch.device] | None = None
_runtime_lock = Lock()


def dino_runtime():
    global _runtime

    if _runtime is not None:
        return _runtime

    with _runtime_lock:
        if _runtime is None:
            processor_kwargs = {}
            model_kwargs = {"use_safetensors": True}

            if DINO_MODEL_REVISION:
                processor_kwargs["revision"] = DINO_MODEL_REVISION
                model_kwargs["revision"] = DINO_MODEL_REVISION

            processor = AutoProcessor.from_pretrained(
                DINO_MODEL_ID,
                **processor_kwargs,
            )

            model = AutoModelForZeroShotObjectDetection.from_pretrained(
                DINO_MODEL_ID,
                **model_kwargs,
            )

            device = torch.device(
                "cuda" if torch.cuda.is_available() else "cpu"
            )

            model.to(device)
            model.eval()

            _runtime = (processor, model, device)

    return _runtime


def dino_loaded() -> bool:
    return _runtime is not None


def clip_box(box, width: int, height: int):
    x0, y0, x1, y1 = [float(v) for v in box]

    x0 = max(0.0, min(float(width - 1), x0))
    y0 = max(0.0, min(float(height - 1), y0))
    x1 = max(x0 + 1.0, min(float(width), x1))
    y1 = max(y0 + 1.0, min(float(height), y1))

    return [x0, y0, x1, y1]


def geometry_features(box, width: int, height: int):
    x0, y0, x1, y1 = box

    w = x1 - x0
    h = y1 - y0

    return {
        "width_ratio": w / width,
        "height_ratio": h / height,
        "area_ratio": (w * h) / (width * height),
        "center_x": ((x0 + x1) / 2) / width,
        "center_y": ((y0 + y1) / 2) / height,
    }


def detection_center_inside(parent: dict, child: dict) -> bool:
    x0, y0, x1, y1 = parent["box_xyxy"]

    cx = child["geometry"]["center_x"]
    cy = child["geometry"]["center_y"]

    width = parent["_image_width"]
    height = parent["_image_height"]

    return (
        x0 / width <= cx <= x1 / width
        and y0 / height <= cy <= y1 / height
    )


def select_candidate(
    detections: list[dict],
) -> tuple[dict | None, str]:
    plausible = []

    for det in detections:
        features = det["geometry"]
        reasons = []

        if not 0.02 <= features["area_ratio"] <= 0.60:
            reasons.append("area")

        if not 0.18 <= features["width_ratio"] <= 1.02:
            reasons.append("width")

        if not 0.07 <= features["height_ratio"] <= 0.65:
            reasons.append("height")

        if not 0.25 <= features["center_y"] <= 0.92:
            reasons.append("vertical-position")

        if not 0.12 <= features["center_x"] <= 0.88:
            reasons.append("horizontal-position")

        det["geometry_reject_reasons"] = reasons

        if not reasons:
            plausible.append(det)

    for det in plausible:
        features = det["geometry"]

        position_prior = max(
            0.0,
            1.0 - abs(features["center_y"] - 0.66) / 0.42,
        )

        area_prior = max(
            0.0,
            1.0 - abs(features["area_ratio"] - 0.18) / 0.30,
        )

        width_prior = max(
            0.0,
            1.0 - abs(features["width_ratio"] - 0.62) / 0.55,
        )

        horizontal_prior = max(
            0.0,
            1.0 - abs(features["center_x"] - 0.50) / 0.40,
        )

        supported = []

        for other in detections:
            if other is det:
                continue

            other_area = other["geometry"]["area_ratio"]

            if other_area < 0.01:
                continue

            if other_area >= features["area_ratio"] * 0.82:
                continue

            if detection_center_inside(det, other):
                supported.append(other)

        support_count = len(supported)
        containment_bonus = min(0.18, support_count * 0.07)

        selection_score = (
            det["model_score"]
            + position_prior * 0.10
            + area_prior * 0.06
            + width_prior * 0.04
            + horizontal_prior * 0.10
            + containment_bonus
        )

        det["support_count"] = support_count
        det["containment_bonus"] = round(containment_bonus, 6)
        det["selection_score"] = round(selection_score, 6)

    if plausible:
        plausible.sort(
            key=lambda item: item["selection_score"],
            reverse=True,
        )
        return plausible[0], "geometry-containment"

    if detections:
        return None, "cv-fallback-needed"

    return None, "no-detection"



def select_compact_wordmark_candidate(detections: list[dict]):
    """
    Select a compact lower wordmark/name block.

    This is intentionally narrower than the main label selector.
    It is used only after the regular label prompts failed.
    """
    plausible = []

    for det in detections:
        features = det["geometry"]

        if det["model_score"] < 0.20:
            continue

        if not 0.012 <= features["area_ratio"] <= 0.08:
            continue

        if not 0.30 <= features["width_ratio"] <= 0.80:
            continue

        if not 0.02 <= features["height_ratio"] <= 0.12:
            continue

        if not 0.72 <= features["center_y"] <= 0.97:
            continue

        if not 0.15 <= features["center_x"] <= 0.85:
            continue

        # Keep the score semantics simple for this highly constrained
        # fallback: Grounding DINO confidence determines the winner.
        det["support_count"] = 0
        det["containment_bonus"] = 0.0
        det["selection_score"] = round(
            det["model_score"],
            6,
        )

        plausible.append(det)

    if not plausible:
        return None

    plausible.sort(
        key=lambda item: item["model_score"],
        reverse=True,
    )

    return plausible[0]

def _post_process(
    processor,
    outputs,
    *,
    threshold: float,
    text_threshold: float,
    width: int,
    height: int,
):
    # Transformers versions differ in the Grounding DINO keyword name.
    try:
        return processor.post_process_grounded_object_detection(
            outputs,
            threshold=threshold,
            text_threshold=text_threshold,
            target_sizes=[(height, width)],
        )[0]
    except TypeError:
        return processor.post_process_grounded_object_detection(
            outputs,
            box_threshold=threshold,
            text_threshold=text_threshold,
            target_sizes=[(height, width)],
        )[0]



def detect_label(
    image: Image.Image,
    *,
    prompt: str = DEFAULT_PROMPT,
    threshold: float = DEFAULT_THRESHOLD,
    text_threshold: float = DEFAULT_TEXT_THRESHOLD,
):
    image = ImageOps.exif_transpose(image).convert("RGB")

    processor, model, device = dino_runtime()

    def run_prompt(current_prompt: str):
        inputs = processor(
            images=image,
            text=[[current_prompt]],
            return_tensors="pt",
        ).to(device)

        if device.type == "cuda":
            torch.cuda.synchronize()

        started = time.perf_counter()

        with torch.inference_mode():
            outputs = model(**inputs)

        if device.type == "cuda":
            torch.cuda.synchronize()

        inference_ms = (
            time.perf_counter() - started
        ) * 1000

        result = _post_process(
            processor,
            outputs,
            threshold=threshold,
            text_threshold=text_threshold,
            width=image.width,
            height=image.height,
        )

        boxes = result["boxes"].detach().cpu()
        scores = result["scores"].detach().cpu()

        detections = []
        raw_detections = []

        for box, score in zip(boxes, scores):
            x1, y1, x2, y2 = [float(v) for v in box.tolist()]
            raw_detections.append({"modelScore": float(score), "boxXywh": [x1, y1, max(0., x2-x1), max(0., y2-y1)]})
            clipped = clip_box(
                box.tolist(),
                image.width,
                image.height,
            )

            features = geometry_features(
                clipped,
                image.width,
                image.height,
            )

            detections.append(
                {
                    "_image_width": image.width,
                    "_image_height": image.height,
                    "model_score": round(
                        float(score),
                        6,
                    ),
                    "box_xyxy": [
                        round(value, 2)
                        for value in clipped
                    ],
                    "box_xywh": [
                        round(clipped[0], 2),
                        round(clipped[1], 2),
                        round(
                            clipped[2] - clipped[0],
                            2,
                        ),
                        round(
                            clipped[3] - clipped[1],
                            2,
                        ),
                    ],
                    "geometry": {
                        key: round(value, 6)
                        for key, value
                        in features.items()
                    },
                }
            )

        detections.sort(
            key=lambda item: item["model_score"],
            reverse=True,
        )

        selected, selection_method = (
            select_candidate(detections)
        )

        return {
            "rawDetections": sorted(raw_detections, key=lambda item: -item["modelScore"]),
            "prompt": current_prompt,
            "detections": detections,
            "selected": selected,
            "selectionMethod": selection_method,
            "inferenceMs": inference_ms,
        }

    attempted_prompts = []
    total_inference_ms = 0.0
    any_detections = False

    def record(stage):
        nonlocal total_inference_ms
        nonlocal any_detections

        attempted_prompts.append(
            stage["prompt"]
        )

        total_inference_ms += (
            stage["inferenceMs"]
        )

        if stage["detections"]:
            any_detections = True

        return stage

    def response(
        stage,
        selected,
        selection_method,
    ):
        return {
            "model": DINO_MODEL_ID,
            "revision": DINO_MODEL_REVISION,
            "device": str(device),
            "prompt": stage["prompt"],
            "threshold": threshold,
            "textThreshold": text_threshold,
            "width": image.width,
            "height": image.height,
            "inferenceMs": round(
                total_inference_ms,
                3,
            ),
            "selectionMethod": selection_method,
            "selected": selected,
            "detections": stage["detections"],
            "attemptedPrompts": attempted_prompts,
            "primaryDetections": primary["rawDetections"],
        }

    # --------------------------------------------------------
    # Stage 1: regular main-label prompt + selector v3.
    # This remains the normal path for the validated 94/100.
    # --------------------------------------------------------

    primary = record(
        run_prompt(prompt)
    )

    if primary["selected"] is not None:
        return response(
            primary,
            primary["selected"],
            "geometry-containment",
        )

    # --------------------------------------------------------
    # Stage 2: broad white-label fallback.
    # It recovers cases such as catalog item 15.
    # --------------------------------------------------------

    white_prompt = "main white wine label"

    if white_prompt != prompt:
        white_stage = record(
            run_prompt(white_prompt)
        )

        if white_stage["selected"] is not None:
            return response(
                white_stage,
                white_stage["selected"],
                "white-label-fallback",
            )

    # --------------------------------------------------------
    # Stage 3: compact name/variety wordmark.
    # It targets labels such as ARGONNE where the useful SKU
    # evidence is a short block near the bottom of the bottle.
    # --------------------------------------------------------

    wordmark_prompt = "wine name text"

    wordmark_stage = record(
        run_prompt(wordmark_prompt)
    )

    compact = (
        select_compact_wordmark_candidate(
            wordmark_stage["detections"]
        )
    )

    if compact is not None:
        return response(
            wordmark_stage,
            compact,
            "compact-wordmark-fallback",
        )

    # --------------------------------------------------------
    # Last resort remains the existing classic CV pipeline.
    # --------------------------------------------------------

    return response(
        wordmark_stage,
        None,
        (
            "cv-fallback-needed"
            if any_detections
            else "no-detection"
        ),
    )



def detect_objects(image: Image.Image, prompt: str) -> list[dict]:
    """Raw detections for frozen V3 multi-ROI and photographer intent."""
    processor, model, device = dino_runtime()
    inputs = processor(images=image, text=prompt, return_tensors="pt").to(device)
    with torch.inference_mode():
        outputs = model(**inputs)
    result = _post_process(
        processor, outputs, threshold=0.18, text_threshold=0.15,
        width=image.width, height=image.height,
    )
    rows = []
    for box, score in zip(result["boxes"].detach().cpu(), result["scores"].detach().cpu()):
        x1, y1, x2, y2 = [float(v) for v in box.tolist()]
        rows.append({"modelScore": float(score), "boxXywh": [x1, y1, max(0., x2-x1), max(0., y2-y1)]})
    return sorted(rows, key=lambda item: -item["modelScore"])
