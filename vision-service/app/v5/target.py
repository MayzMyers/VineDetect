"""Frozen target selection using the shared production Grounding DINO runtime."""

import time
from ..dino import detect_label, detect_objects
from .intent import nms, select_intent


def target(image):
    started = time.perf_counter()
    original = detect_label(
        image, prompt="main wine label", threshold=0.18, text_threshold=0.15
    )
    # The original selector has fallback prompts; multi-ROI always uses main wine label.
    labels = original["primaryDetections"]
    bottles = [
        b
        for b in detect_objects(image, "wine bottle.")
        if b["boxXywh"][3] >= image.height * 0.22
        and b["boxXywh"][2] * b["boxXywh"][3] >= image.width * image.height * 0.025
    ]
    selected = original.get("selected")
    original_roi = (
        {"boxXywh": selected["box_xywh"], "modelScore": selected["model_score"]}
        if selected
        else None
    )
    intent = select_intent(
        nms(bottles), labels, original_roi, image.width, image.height
    )
    bottle = intent["primaryBottle"]
    box = bottle["boxXywh"] if bottle else None
    if box:
        x, y, w, h = box
        x1, y1 = max(0, round(x)), max(0, round(y))
        x2, y2 = min(image.width, round(x + w)), min(image.height, round(y + h))
        box = [x1, y1, x2 - x1, y2 - y1] if x2 > x1 and y2 > y1 else None
    return {
        "width": image.width,
        "height": image.height,
        "bottleBox": box,
        "originalLabel": original_roi["boxXywh"] if original_roi else None,
        "intentLabel": intent["selected"]["boxXywh"] if intent["selected"] else None,
        "allLabels": [item["boxXywh"] for item in labels],
        "targetDetectionMs": (time.perf_counter() - started) * 1000,
    }
