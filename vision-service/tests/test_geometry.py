import cv2
import numpy as np
from app.v5 import geometry as g


def test_strict_veto_needs_both_modes(monkeypatch):
    baseline, challenger = object(), object()
    high = {m: 2.0 for m in g.GEOM_METRICS}
    low = {m: 1.0 for m in g.GEOM_METRICS}
    monkeypatch.setattr(
        g, "match_metrics", lambda q, r, mode: high if r is baseline else low
    )
    result = g.pairwise_geometry(object(), baseline, challenger)
    assert result["strictVeto"] and not result["softSupport"]
    monkeypatch.setattr(
        g,
        "match_metrics",
        lambda q, r, mode: high if (r is baseline) == (mode == "sift") else low,
    )
    result = g.pairwise_geometry(object(), baseline, challenger)
    assert not result["strictVeto"] and result["softSupport"]


def test_missing_geometry_does_not_create_veto():
    assert g.pairwise_geometry(None, object(), object()) == {
        "available": False,
        "strictVeto": False,
        "softSupport": False,
    }


def test_mutual_matching_requires_reciprocal_indices(monkeypatch):
    a, b = object(), object()
    forward = [cv2.DMatch(0, 1, 0, 0.1), cv2.DMatch(1, 0, 0, 0.2)]
    reverse = [cv2.DMatch(1, 0, 0, 0.1)]
    monkeypatch.setattr(g, "lowe_matches", lambda x, y: forward if x is a else reverse)
    assert [(m.queryIdx, m.trainIdx) for m in g.mutual_matches(a, b)] == [(0, 1)]


def test_rootsift_and_spatial_metrics():
    result = g.rootsift(np.array([[1.0, 3.0]], dtype=np.float32))
    assert np.allclose(result, [[0.5, np.sqrt(0.75)]])
    points = np.array([[0, 0], [99, 0], [99, 99], [0, 99]], dtype=np.float32)
    assert g.grid_coverage(points, (100, 100)) == 0.25
    assert np.isclose(g.hull_coverage(points, (100, 100)), 0.9801)
    assert np.isclose(g.span_coverage(points, (100, 100)), 0.9801)


def test_real_sift_and_rootsift_identity():
    rng = np.random.default_rng(7)
    image = rng.integers(0, 256, (256, 256, 3), dtype=np.uint8)
    q = g.descriptors(image)
    for mode in ("sift", "root"):
        metrics = g.match_metrics(q, q, mode)
        assert metrics["mutualInliers"] > 20
        assert metrics["mutualRatio"] == 1
    assert not g.pairwise_geometry(q, q, q)["strictVeto"]
