import sys
from types import SimpleNamespace

import pytest

from app.v5 import pipeline


@pytest.mark.parametrize("missing", [None, "grounding", "siglip", "dinov3", "ocr", "gallery", "runtime"])
def test_readiness_requires_every_v5_component(monkeypatch, missing):
    monkeypatch.setitem(sys.modules, "app.dino", SimpleNamespace(
        dino_loaded=lambda: missing != "grounding"))
    monkeypatch.setitem(sys.modules, "app.retrieval", SimpleNamespace(
        retrieval_loaded=lambda: missing != "siglip"))
    monkeypatch.setattr(pipeline, "_runtime", None if missing == "runtime" else SimpleNamespace(
        target_available=True,
        dino=None if missing == "dinov3" else SimpleNamespace(snapshot_path="/models/dinov3", device="cuda"),
        ocr=None if missing == "ocr" else object(),
        catalog=SimpleNamespace(dino_gallery=None if missing == "gallery" else object()),
    ))
    state = pipeline.readiness()
    assert state["v5Ready"] is (missing is None)
    assert bool(state["unavailableV5Components"]) is (missing is not None)
    assert state["architecture"] == "V5-RC1"
