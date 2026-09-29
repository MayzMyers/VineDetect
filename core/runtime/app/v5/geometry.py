"""Ported from frozen simulator c54251c8; thresholds and matching unchanged."""

import cv2
import numpy as np

LOWE = 0.72

RANSAC = 5.0

SIFT = cv2.SIFT_create(nfeatures=3000, contrastThreshold=0.025)

MATCHER = cv2.BFMatcher(cv2.NORM_L2)


def resize_max(image, max_side=1400):
    h, w = image.shape[:2]
    scale = min(1.0, max_side / max(h, w))
    if scale >= 1.0:
        return image
    return cv2.resize(
        image,
        (max(1, round(w * scale)), max(1, round(h * scale))),
        interpolation=cv2.INTER_AREA,
    )


def crop_xywh(image, box, pad_ratio=0.08):
    x, y, w, h = map(float, box)
    ih, iw = image.shape[:2]
    px = w * pad_ratio
    py = h * pad_ratio
    x1 = max(0, int(round(x - px)))
    y1 = max(0, int(round(y - py)))
    x2 = min(iw, int(round(x + w + px)))
    y2 = min(ih, int(round(y + h + py)))
    if x2 <= x1 or y2 <= y1:
        return None
    return image[y1:y2, x1:x2]


def rootsift(desc):
    if desc is None:
        return None
    result = desc.astype(np.float32, copy=True)
    result /= np.sum(np.abs(result), axis=1, keepdims=True) + 1e-07
    return np.sqrt(result)


def descriptors(image):
    image = resize_max(image)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    gray = clahe.apply(gray)
    kp, desc = SIFT.detectAndCompute(gray, None)
    return {
        "shape": image.shape[:2],
        "kp": kp or [],
        "sift": desc,
        "root": rootsift(desc),
    }


def lowe_matches(a, b):
    if a is None or b is None or len(a) < 2 or (len(b) < 2):
        return []
    pairs = MATCHER.knnMatch(a, b, k=2)
    result = []
    for pair in pairs:
        if len(pair) != 2:
            continue
        m, n = pair
        if m.distance < LOWE * n.distance:
            result.append(m)
    return result


def mutual_matches(a, b):
    forward = lowe_matches(a, b)
    reverse = lowe_matches(b, a)
    reverse_map = {m.queryIdx: m.trainIdx for m in reverse}
    return [m for m in forward if reverse_map.get(m.trainIdx) == m.queryIdx]


def grid_coverage(points, shape, grid=4):
    if len(points) == 0:
        return 0.0
    h, w = shape
    cells = set()
    for x, y in points:
        gx = min(grid - 1, max(0, int(x / max(w, 1) * grid)))
        gy = min(grid - 1, max(0, int(y / max(h, 1) * grid)))
        cells.add((gx, gy))
    return len(cells) / (grid * grid)


def hull_coverage(points, shape):
    if len(points) < 3:
        return 0.0
    hull = cv2.convexHull(np.asarray(points, dtype=np.float32))
    area = float(cv2.contourArea(hull))
    h, w = shape
    return area / max(float(h * w), 1.0)


def span_coverage(points, shape):
    if len(points) < 2:
        return 0.0
    pts = np.asarray(points, dtype=np.float32)
    h, w = shape
    sx = (pts[:, 0].max() - pts[:, 0].min()) / max(w, 1)
    sy = (pts[:, 1].max() - pts[:, 1].min()) / max(h, 1)
    return float(sx * sy)


def match_metrics(query, reference, mode):
    matches = mutual_matches(query[mode], reference[mode])
    result = {
        "mutualInliers": 0,
        "mutualRatio": 0.0,
        "queryGrid": 0.0,
        "queryHull": 0.0,
        "querySpan": 0.0,
    }
    if len(matches) < 4:
        return result
    qkp = query["kp"]
    rkp = reference["kp"]
    src = np.float32([qkp[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
    dst = np.float32([rkp[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
    _, mask = cv2.findHomography(src, dst, cv2.RANSAC, RANSAC)
    if mask is None:
        return result
    flags = mask.ravel().astype(bool)
    count = int(flags.sum())
    result["mutualInliers"] = count
    result["mutualRatio"] = count / len(matches)
    if count < 3:
        return result
    points = src[flags].reshape(-1, 2)
    result["queryGrid"] = grid_coverage(points, query["shape"])
    result["queryHull"] = hull_coverage(points, query["shape"])
    result["querySpan"] = span_coverage(points, query["shape"])
    return result


GEOM_METRICS = ["mutualInliers", "mutualRatio", "queryGrid", "queryHull", "querySpan"]


def metric_votes(baseline_metrics, challenger_metrics):
    b = 0
    c = 0
    available = 0
    for metric in GEOM_METRICS:
        bv = baseline_metrics[metric]
        cv = challenger_metrics[metric]
        if bv is None or cv is None or abs(float(bv) - float(cv)) <= 1e-12:
            continue
        available += 1
        if cv > bv:
            c += 1
        else:
            b += 1
    return {"baseline": b, "challenger": c, "available": available}


def pairwise_geometry(q, b, c):
    if q is None or b is None or c is None:
        return {"available": False, "strictVeto": False, "softSupport": False}
    result = {"available": True}
    for mode in ("sift", "root"):
        bm = match_metrics(q, b, mode)
        cm = match_metrics(q, c, mode)
        votes = metric_votes(bm, cm)
        result[mode] = {"baseline": bm, "challenger": cm, "votes": votes}
    sv = result["sift"]["votes"]
    rv = result["root"]["votes"]
    result["strictVeto"] = (
        sv["available"] >= 4
        and rv["available"] >= 4
        and (sv["baseline"] >= 4)
        and (rv["baseline"] >= 4)
    )
    result["softSupport"] = (
        sv["available"] >= 4
        and sv["challenger"] >= 4
        or (rv["available"] >= 4 and rv["challenger"] >= 4)
    )
    return result


def match_features(q_kp, q_desc, r_kp, r_desc):
    result = {
        "query_keypoints": len(q_kp),
        "reference_keypoints": len(r_kp),
        "good_matches": 0,
        "inliers": 0,
        "inlier_ratio": 0.0,
        "score": 0.0,
    }
    if q_desc is None or r_desc is None or len(q_desc) < 2 or (len(r_desc) < 2):
        return result
    pairs = MATCHER.knnMatch(q_desc, r_desc, k=2)
    good = []
    for pair in pairs:
        if len(pair) != 2:
            continue
        m, n = pair
        if m.distance < 0.72 * n.distance:
            good.append(m)
    result["good_matches"] = len(good)
    if len(good) >= 4:
        src = np.float32([q_kp[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
        dst = np.float32([r_kp[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
        _, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
        if mask is not None:
            inliers = int(mask.ravel().sum())
            ratio = inliers / len(good)
            result["inliers"] = inliers
            result["inlier_ratio"] = round(ratio, 4)
    result["score"] = round(
        result["inliers"] + 0.2 * result["good_matches"] + 2.0 * result["inlier_ratio"],
        4,
    )
    return result
