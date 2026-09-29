"""Photographer-intent geometry ported unchanged from field_dino_intent_build.py."""

import math


def clamp01(value):
    return max(0.0, min(1.0, value))


def band_fit(value, minimum, plateau_start, plateau_end, maximum):
    if value <= minimum or value >= maximum:
        return 0.0
    if plateau_start <= value <= plateau_end:
        return 1.0
    if value < plateau_start:
        return (value - minimum) / (plateau_start - minimum)
    return (maximum - value) / (maximum - plateau_end)


def rect_intersection(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x1 = max(ax, bx)
    y1 = max(ay, by)
    x2 = min(ax + aw, bx + bw)
    y2 = min(ay + ah, by + bh)
    return max(0.0, x2 - x1) * max(0.0, y2 - y1)


def rect_coverage(inner, outer):
    area = max(1.0, inner[2] * inner[3])
    return rect_intersection(inner, outer) / area


def rect_iou(a, b):
    intersection = rect_intersection(a, b)
    union = a[2] * a[3] + b[2] * b[3] - intersection
    return intersection / max(1.0, union)


def nms(rows, threshold=0.72):
    kept = []
    for row in sorted(rows, key=lambda x: -x["modelScore"]):
        if any((rect_iou(row["boxXywh"], old["boxXywh"]) >= threshold for old in kept)):
            continue
        kept.append(row)
    return kept


def center_inside(inner, outer):
    ix, iy, iw, ih = inner
    ox, oy, ow, oh = outer
    cx = ix + iw / 2
    cy = iy + ih / 2
    return ox <= cx <= ox + ow and oy <= cy <= oy + oh


def bottle_intent_score(bottle, image_width, image_height):
    x, y, w, h = bottle["boxXywh"]
    cx = (x + w / 2) / image_width
    cy = (y + h / 2) / image_height
    area_ratio = w * h / max(1.0, image_width * image_height)
    centre_distance = math.sqrt(((cx - 0.5) / 0.5) ** 2 + ((cy - 0.52) / 0.52) ** 2)
    centrality = clamp01(1.0 - centre_distance / math.sqrt(2.0))
    prominence = clamp01(math.sqrt(area_ratio))
    aspect = w / max(1.0, h)
    bottle_shape = band_fit(aspect, 0.07, 0.14, 0.72, 1.25)
    score = (
        centrality * 0.45
        + prominence * 0.28
        + bottle["modelScore"] * 0.17
        + bottle_shape * 0.1
    )
    return {
        "score": clamp01(score),
        "centrality": centrality,
        "prominence": prominence,
        "aspect": aspect,
        "areaRatio": area_ratio,
    }


def label_geometry_score(label, bottle_box, largest_label_area):
    lx, ly, lw, lh = label["boxXywh"]
    bx, by, bw, bh = bottle_box
    center_x = lx + lw / 2
    center_y = ly + lh / 2
    normalized_y = (center_y - by) / max(1.0, bh)
    horizontal_centrality = clamp01(
        1.0 - abs(center_x - (bx + bw / 2)) / max(1.0, bw / 2)
    )
    width_ratio = lw / max(1.0, bw)
    height_ratio = lh / max(1.0, bh)
    area = lw * lh
    relative_area = area / max(1.0, largest_label_area)
    aspect_ratio = lw / max(1.0, lh)
    width_fit = band_fit(width_ratio, 0.12, 0.25, 0.92, 1.06)
    front_vertical_fit = band_fit(normalized_y, 0.18, 0.34, 0.88, 0.98)
    aspect_fit = clamp01(1.0 - abs(math.log(max(0.05, aspect_ratio) / 1.15)) / 2.4)
    height_fit = clamp01(1.0 - max(0.0, height_ratio - 0.38) / 0.3)
    containment = rect_coverage(label["boxXywh"], bottle_box)
    geometry = clamp01(
        horizontal_centrality * 0.25
        + width_fit * 0.16
        + front_vertical_fit * 0.17
        + aspect_fit * 0.1
        + height_fit * 0.13
        + math.sqrt(clamp01(relative_area)) * 0.1
        + containment * 0.09
    )
    score = clamp01(geometry * 0.85 + label["modelScore"] * 0.15)
    return {
        "score": score,
        "geometry": geometry,
        "normalizedCenterY": normalized_y,
        "horizontalCentrality": horizontal_centrality,
        "widthRatio": width_ratio,
        "heightRatio": height_ratio,
        "relativeArea": relative_area,
        "aspectRatio": aspect_ratio,
        "containment": containment,
        "frontVerticalFit": front_vertical_fit,
    }


def select_intent(bottles, labels, original_selected, image_width, image_height):
    bottle_rows = []

    for bottle in bottles:
        bmetrics = bottle_intent_score(
            bottle,
            image_width,
            image_height,
        )

        assigned = []

        for label in labels:
            coverage = rect_coverage(
                label["boxXywh"],
                bottle["boxXywh"],
            )

            if coverage < 0.62 and not center_inside(
                label["boxXywh"],
                bottle["boxXywh"],
            ):
                continue

            assigned.append(label)

        largest_area = max(
            [item["boxXywh"][2] * item["boxXywh"][3] for item in assigned] or [1.0]
        )

        label_rows = []

        for label in assigned:
            metrics = label_geometry_score(
                label,
                bottle["boxXywh"],
                largest_area,
            )

            label_rows.append(
                {
                    **label,
                    "intent": metrics,
                }
            )

        label_rows.sort(key=lambda item: -item["intent"]["score"])

        best_label = label_rows[0] if label_rows else None

        joint_score = (
            bmetrics["score"]
            if best_label is None
            else (bmetrics["score"] * 0.62 + best_label["intent"]["score"] * 0.38)
        )

        bottle_rows.append(
            {
                **bottle,
                "intent": bmetrics,
                "jointScore": joint_score,
                "labels": label_rows,
            }
        )

    bottle_rows.sort(key=lambda item: -item["jointScore"])

    primary = bottle_rows[0] if bottle_rows else None

    selected = original_selected

    action = "fallback-original"

    if primary and primary["labels"]:
        primary_box = primary["boxXywh"]

        # Conservative rule:
        # keep the current working selector
        # if it already points to a plausible
        # front label of the intended bottle.
        original_valid = False

        if original_selected:
            coverage = rect_coverage(
                original_selected["boxXywh"],
                primary_box,
            )

            ox, oy, ow, oh = original_selected["boxXywh"]

            bx, by, bw, bh = primary_box

            center_y = oy + oh / 2

            normalized_y = (center_y - by) / max(1.0, bh)

            horizontal_centrality = clamp01(
                1.0
                - abs((ox + ow / 2) - (bx + bw / 2))
                / max(
                    1.0,
                    bw / 2,
                )
            )

            original_valid = (
                coverage >= 0.68
                and 0.20 <= normalized_y <= 0.96
                and horizontal_centrality >= 0.35
            )

        if original_valid:
            selected = original_selected
            action = "keep-original"

        else:
            best = primary["labels"][0]

            selected = {
                "modelScore": best["modelScore"],
                "selectionScore": best["intent"]["score"],
                "boxXywh": best["boxXywh"],
                "geometry": {
                    key: value
                    for key, value in best["intent"].items()
                    if key != "score"
                },
            }

            action = "intent-override"

    else:
        pass

    return {"primaryBottle": primary, "selected": selected, "action": action}
