from types import SimpleNamespace

import pytest
from PIL import Image

from app.v5.pipeline import Pipeline
from app.v5.ocr import build_index, extract_ocr, rank_catalog


def service():
    pipeline = Pipeline.__new__(Pipeline)
    pipeline.startup_failures = []
    pipeline.ocr = pipeline.dino = None
    pipeline.catalog = SimpleNamespace(
        by_id={1: {"title": "Cabernet"}, 2: {"title": "Merlot"}},
        identity=lambda cid: {
            "catalogItemId": cid,
            "officialSlug": f"wine-{cid}",
            "title": "Wine",
        },
    )
    pipeline.retrieve = lambda image, limit: {
        "candidates": [
            {"catalogItemId": 1, "rank": 1, "cosineSimilarity": 0.812345},
            {"catalogItemId": 2, "rank": 2, "cosineSimilarity": 0.809123},
        ]
    }
    pipeline.reference = lambda cid: None
    return pipeline


def test_real_cosine_and_margin_survive():
    result = service().recognize(
        Image.new("RGB", (32, 64)), {"targetDetectionMs": 7}, None
    )
    diagnostic = result["diagnostics"]
    assert diagnostic["baselineMargin"] == pytest.approx(0.003222)
    assert diagnostic["views"]["full"][0]["cosineSimilarity"] == 0.812345
    assert result["result"]["officialSlug"] == "wine-1"
    assert diagnostic["timingsMs"]["targetDetection"] == 7
    assert all(value >= 0 for value in diagnostic["timingsMs"].values())


def test_nonexistent_similarity_field_cannot_silently_zero_scores():
    pipeline = service()
    pipeline.retrieve = lambda image, limit: {
        "candidates": [
            {"catalogItemId": 1, "rank": 1, "similarity": 0.8},
            {"catalogItemId": 2, "rank": 2, "similarity": 0.7},
        ]
    }
    with pytest.raises(KeyError, match="cosineSimilarity"):
        pipeline.recognize(Image.new("RGB", (32, 64)), {}, None)


def test_missing_reference_is_abstention_not_zero_baseline_score():
    pipeline = service()
    result = pipeline.recognize(
        Image.new("RGB", (32, 64)),
        {
            "originalLabel": [0, 0, 32, 64],
            "intentLabel": [0, 0, 32, 64],
        },
        None,
    )
    assert result["result"]["catalogItemId"] == 1
    assert result["diagnostics"]["v3Reason"] == "primary"


@pytest.mark.parametrize("name", ["ocr", "dino"])
def test_auxiliary_exception_logs_and_keeps_baseline(name, caplog):
    pipeline = service()

    def failure(_):
        raise RuntimeError("offline")

    setattr(pipeline, name, SimpleNamespace(retrieve=failure))
    result = pipeline.recognize(
        Image.new("RGB", (32, 64)), {"originalLabel": [0, 0, 32, 64]}, None
    )
    assert result["result"]["catalogItemId"] == 1
    assert "evidence unavailable" in caplog.text
    assert ("ocr" if name == "ocr" else "dinoV3") in result["diagnostics"]["failures"]


def test_empty_ocr_does_not_fabricate_catalog_top1():
    index = build_index([{"catalog_item_id": 1, "title": "Cabernet"}])
    assert rank_catalog("", index) == []
    assert extract_ocr(
        [{"rec_texts": ["Merlot", "Cabernet"], "rec_scores": [0.34, 0.35]}]
    )[0] == ["Cabernet"]
