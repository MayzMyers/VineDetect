from types import SimpleNamespace
from app.v8.config import Config
from app.v8.pool import build_pool
from app.v8.target import select_bottle, select_label
from app.v8.ocr import CatalogText
from app.v8.checkpoint import save, read
from app.v8.rerank import rank


def test_target_selection_cannot_see_labels():
    detections = [
        dict(boxXywh=[200, 50, 100, 500], modelScore=0.7),
        dict(boxXywh=[0, 0, 50, 400], modelScore=0.9),
    ]
    result = select_bottle(detections, 500, 600)
    assert result["selected_box"] == [200, 50, 100, 500]
    assert set(result["selected"]["components"]) == {
        "centrality",
        "prominence",
        "visibility",
        "shape",
        "confidence",
    }


def test_label_clipped_to_target_and_abstains_when_weak():
    cfg = Config()
    result = select_label(
        [dict(boxXywh=[-10, 80, 130, 120], modelScore=0.9)], 100, 300, cfg
    )
    assert result["selected_box"] == [0, 80, 100, 120]
    assert result["trusted"]
    assert not select_label([], 100, 300, cfg)["trusted"]


def test_pool_dedup_cap_and_no_top1_privilege():
    sources = dict(
        siglip=[dict(id=2, rank=1, score=0.8), dict(id=1, rank=2, score=0.7)],
        dino=[dict(id=1, rank=1, score=0.9)],
    )
    chosen, all_rows = build_pool(sources, Config(max_pool_size=1))
    assert chosen[0]["id"] == 1
    assert len(all_rows) == 2 and len(chosen[0]["sources"]) == 2


def test_checkpoint_corruption_and_provenance(tmp_path):
    path = tmp_path / "row.json"
    save(path, {"ok": 1}, {"version": 1})
    assert read(path, {"version": 1}) == {"ok": 1}
    assert read(path, {"version": 2}) is None
    path.write_text(path.read_text().replace('"ok": 1', '"ok": 2'))
    assert read(path, {"version": 1}) is None
    path.write_text("")
    assert read(path, {"version": 1}) is None


def test_ocr_generic_no_injection_and_conflict_not_missing():
    rows = [
        dict(
            catalog_item_id=1, title="Fanagoria Riesling white dry", winery="Fanagoria"
        ),
        dict(catalog_item_id=2, title="Other Merlot red semisweet", winery="Other"),
    ]
    text = CatalogText(rows, minimum=0.1)
    features, ranking = text.features("wine")
    assert not ranking
    features, ranking = text.features("Фанагория Рислинг белое сухое")
    assert ranking[0]["id"] == 1
    assert features[2]["fields"]["sweetness"]["conflicts"] == ["dry"]
    features, _ = text.features("")
    assert not features[2]["fields"]["sweetness"]["conflicts"]


def test_uniform_score_permutation_missing_and_geometry_can_win():
    cfg = Config(weights=(1, 0, 0, 2, 0))
    sources = dict(
        siglip=[dict(id=1, rank=1, score=0.9), dict(id=2, rank=2, score=0.8)],
        dino=[],
        ocr=[],
        label_siglip=[],
    )
    pool, _ = build_pool(sources, cfg)
    o = dict(identity=0, attribute_agreement=0, attribute_conflict=0, available=False)
    metrics = dict(inliers=30, ratio=1, grid=1, hull=0.25, span=0.5)
    evidence = {
        1: dict(ocr=o, geometry=dict(available=False)),
        2: dict(ocr=o, geometry=dict(available=True, sift=metrics, root=metrics)),
    }
    result = rank(pool, evidence, sources, cfg)
    assert result[0]["id"] == 2
    assert result == rank(list(reversed(pool)), evidence, sources, cfg)
    assert result[0]["semantic"]["dino"]["score"] is None


def test_no_decision_modules_in_v8():
    import ast
    from pathlib import Path

    for p in (Path(__file__).parents[1] / "app/v8").glob("*.py"):
        tree = ast.parse(p.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                assert not any(
                    s in (node.module or "").split(".")
                    for s in ("v6", "v7", "decision")
                )


def test_reference_cache_preserves_descriptors_and_geometry(tmp_path):
    import numpy as np
    from app.v8.geometry import descriptors, compare
    from app.v8.reference_cache import save, load

    rng = np.random.default_rng(17)
    image = rng.integers(0, 255, size=(160, 140, 3), dtype=np.uint8)
    original = descriptors(image)
    path = tmp_path / "features.npz"
    save(path, original)
    cached = load(path)
    assert np.array_equal(original["sift"], cached["sift"])
    assert np.array_equal(original["root"], cached["root"])
    assert [k.pt for k in original["kp"]] == [k.pt for k in cached["kp"]]
    for mode in ("sift", "root"):
        a = compare(original, original, mode)
        b = compare(original, cached, mode)
        for k in a:
            if not k.endswith("_ms"):
                assert a[k] == b[k]
    path.write_bytes(b"broken")
    assert load(path) is None


def test_checkpoint_roundtrip_config_tuples(tmp_path):
    path = tmp_path / "config.json"
    provenance = {"config": Config().json()}
    save(path, {"done": True}, provenance)
    assert read(path, provenance) == {"done": True}


def test_debug_does_not_change_inference(tmp_path):
    import io
    import numpy as np
    from PIL import Image
    from app.v8.pipeline import Pipeline

    class Fake:
        catalog = SimpleNamespace(
            rows=[
                dict(catalog_item_id=1, title="Alpha", official_slug="alpha"),
                dict(catalog_item_id=2, title="Beta", official_slug="beta"),
            ],
            by_id={1: {"official_slug": "alpha"}, 2: {"official_slug": "beta"}},
        )

        def detect(self, image, prompt):
            return (
                [dict(boxXywh=[20, 5, 60, 180], modelScore=0.9)]
                if prompt == "wine bottle."
                else []
            )

        def siglip(self, image, depth):
            return [dict(id=1, score=0.9, rank=1), dict(id=2, score=0.7, rank=2)]

    buffer = io.BytesIO()
    Image.fromarray(np.zeros((200, 100, 3), dtype=np.uint8)).save(buffer, format="PNG")
    pipeline = Pipeline(Fake(), Config(kd=0, ko=0, geometry_enabled=False))
    a = pipeline.analyze(buffer.getvalue())
    b = pipeline.analyze(buffer.getvalue(), tmp_path / "debug")
    assert a["ordered"] == b["ordered"]
    assert pipeline.recognize(buffer.getvalue()) == {"slug": "alpha"}
    assert len(list((tmp_path / "debug").glob("*.png"))) == 2


def test_checkpoint_integer_candidate_keys_roundtrip(tmp_path):
    path = tmp_path / "candidates.json"
    save(
        path,
        {"trace": {"evidence": {2: {"score": 0.4}, 10: {"score": 0.7}}}},
        {"config": Config().json()},
    )
    assert (
        read(path, {"config": Config().json()})["trace"]["evidence"]["10"]["score"]
        == 0.7
    )
    path.write_text(path.read_text().replace('"score": 0.7', '"score": 0.8'))
    assert read(path, {"config": Config().json()}) is None


def test_old_checkpoint_key_types_require_original_checksum(tmp_path):
    import hashlib, json

    payload = {"trace": {"evidence": {2: {"score": 0.4}, 10: {"score": 0.7}}}}
    checksum = hashlib.sha256(
        json.dumps(
            payload,
            sort_keys=True,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    path = tmp_path / "old.json"
    path.write_text(
        json.dumps(
            dict(
                schema="v8-checkpoint/1",
                provenance={},
                payload=payload,
                sha256=checksum,
            )
        )
    )
    assert read(path, {})["trace"]["evidence"]["2"]["score"] == 0.4
    assert json.loads(path.read_text())["schema"] == "v8-checkpoint/2"


def test_pool_selection_never_reads_reranker_evidence():
    from app.v8.report import select_pools, SETS

    rows = [dict(key=s + "/image", dataset=s, expected=2) for s in SETS]
    sources = dict(
        siglip=[dict(id=1, rank=1, score=0.9), dict(id=2, rank=2, score=0.8)],
        dino=[dict(id=2, rank=1, score=0.9)],
        ocr=[],
        label_siglip=[],
    )

    class Forbidden(dict):
        def __getitem__(self, key):
            raise AssertionError("Pool selection read decision evidence")

    traces = [dict(sources=sources, evidence=Forbidden()) for _ in rows]
    config, grid, unique, lodo = select_pools(rows, traces)
    assert config.kd > 0
    assert all(r["hits"] == len(rows) for r in grid)
    assert all(r["heldout_recall"] == 1 for r in lodo.values())


def test_no_target_never_runs_retrieval():
    import io
    from PIL import Image
    from app.v8.pipeline import Pipeline
    from app.v8.target import TargetUnavailable

    class Fake:
        catalog = SimpleNamespace(
            rows=[dict(catalog_item_id=1, title="Alpha", official_slug="alpha")]
        )

        def detect(self, image, prompt):
            return []

        def siglip(self, *args):
            raise AssertionError("Full-frame retrieval after no target")

    buffer = io.BytesIO()
    Image.new("RGB", (40, 80)).save(buffer, format="PNG")
    try:
        Pipeline(Fake()).analyze(buffer.getvalue())
    except TargetUnavailable as exc:
        assert exc.diagnostics["target"]["selected"] is None
    else:
        raise AssertionError("Missing target did not fail")


def test_checkpoint_lock_excludes_another_writer(tmp_path):
    from app.v8.checkpoint import writer_lock

    with writer_lock(tmp_path):
        try:
            with writer_lock(tmp_path):
                raise AssertionError("Concurrent writer accepted")
        except BlockingIOError:
            pass


def test_audit_repair_requires_identical_pixels_without_models(tmp_path):
    import io
    import hashlib
    from PIL import Image
    from app.v8.backend import jpeg95
    from app.v8.pipeline import pixels
    from app.v8.audit import valid_assets, repair_assets

    image = Image.new("RGB", (40, 80), (120, 90, 40))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    raw = buffer.getvalue()
    bottle = jpeg95(image)
    trace = dict(
        input_sha256=hashlib.sha256(raw).hexdigest(),
        canonical_pixel_hash=pixels(image),
        target_pixel_hash=pixels(bottle),
        label_pixel_hash=pixels(bottle),
        sources={},
        target=dict(selected_box=[0, 0, 40, 80], candidates=[dict(box=[0, 0, 40, 80])]),
        label=dict(selected_box=[0, 0, 40, 80], trusted=False, proposals=[]),
    )
    repair_assets(raw, trace, tmp_path)
    assert valid_assets(tmp_path, trace)
    (tmp_path / "label.png").write_bytes(b"corrupt")
    assert not valid_assets(tmp_path, trace)
    repair_assets(raw, trace, tmp_path)
    assert valid_assets(tmp_path, trace)
    try:
        repair_assets(b"wrong", trace, tmp_path)
    except ValueError:
        pass
    else:
        raise AssertionError("Mismatched input accepted")


def test_evaluation_http_contract_and_target_failure_sidecar(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from app.v8 import service
    from app.v8.target import TargetUnavailable

    class Fake:
        backend = SimpleNamespace(
            catalog=SimpleNamespace(by_id={1: {"official_slug": "official"}})
        )
        fail = False

        def analyze(self, raw, debug_dir):
            if self.fail:
                raise TargetUnavailable(
                    {"trace_id": "failure", "target": {"selected": None}}
                )
            return {
                "slug": "official",
                "trace_id": "ok",
                "sources": {"siglip": [{"id": 1, "rank": 1, "score": 0.8}]},
                "ordered": [{"id": 1, "score": 0.8}],
                "nominations": [{"id": 1}],
            }

    fake = Fake()
    monkeypatch.setattr(service, "pipeline", fake)
    monkeypatch.setenv("V8_DEBUG_DIR", str(tmp_path))
    client = TestClient(service.app)
    response = client.post("/v8/evaluate", json={"imageBase64": "YWJj"})
    assert response.status_code == 200
    assert response.json() == {"slug": "official"}
    fake.fail = True
    assert client.post("/v8/evaluate", json={"imageBase64": "YWJj"}).status_code == 422
    import json

    records = [json.loads(p.read_text()) for p in tmp_path.glob("*/trace.json")]
    assert any(r["trace_id"] == "failure" for r in records)


def test_report_end_to_end_on_synthetic_complete_sets(tmp_path):
    import hashlib, json
    from app.v8.checkpoint import atomic_json, save
    from app.v8.evaluate import provenance
    from app.v8.report import run, SETS

    root = tmp_path / ".generated/v8"
    rows = []
    for dataset in SETS:
        rows.append(
            dict(
                key=dataset + "/synthetic",
                dataset=dataset,
                expected=1,
                sha256="synthetic",
            )
        )
    atomic_json(tmp_path / ".generated/v7/image-manifest.json", rows)
    atomic_json(
        tmp_path / ".runtime/v5-rc1/catalog.json",
        {
            "rows": [
                dict(catalog_item_id=1, title="Alpha", official_slug="alpha"),
                dict(catalog_item_id=2, title="Beta", official_slug="beta"),
            ]
        },
    )
    atomic_json(
        tmp_path / ".generated/irecommend531/gt-audit/equivalence_groups.json", []
    )
    spec = tmp_path / "docs/V8-simple_onepager_v0.2.md"
    spec.parent.mkdir(parents=True)
    spec.write_text("Synthetic fixture only")
    ocr = dict(identity=0, attribute_agreement=0, attribute_conflict=0, available=False)
    for row in rows:
        key = hashlib.sha256(row["key"].encode()).hexdigest()
        trace = dict(
            sources=dict(
                siglip=[dict(id=1, rank=1, score=0.9), dict(id=2, rank=2, score=0.7)],
                dino=[dict(id=1, rank=1, score=0.9)],
                ocr=[],
                label_siglip=[],
            ),
            evidence={
                1: dict(ocr=ocr, geometry=dict(available=False)),
                2: dict(ocr=ocr, geometry=dict(available=False)),
            },
            target=dict(manual_audit_required=False),
            label=dict(trusted=False),
            timings_ms={"total_inference": 1},
            failures=[],
        )
        payload = dict(
            key=row["key"],
            dataset=row["dataset"],
            expected=1,
            trace=trace,
            resources_after=dict(max_rss_kib=1, container_ram_bytes=1, gpu="1, 12227"),
            worker_start=1,
        )
        save(
            root / "explore" / (key + ".json"),
            payload,
            provenance(tmp_path, row, Config(), "explore"),
        )
        for variant in ("V5", "V7-B"):
            atomic_json(
                tmp_path / ".generated/v7/images" / (key + "-" + variant + ".json"),
                dict(
                    key=row["key"],
                    imageSha256=row["sha256"],
                    expected=1,
                    result={"catalogItemId": 1},
                ),
            )
    run(SimpleNamespace(repo=tmp_path))
    summary = json.loads((root / "summary.json").read_text())
    assert summary["metrics"]["V8-final"]["pooled_exact"] == 5
    assert summary["selection_constraints_feasible"]
    assert len(summary["nested_lodo"]) == 5
    assert (root / "errors.csv").read_text().startswith("key,dataset,expected")
    assert (root / "candidate_recall.csv").is_file()
    completed = {p: p.stat().st_mtime_ns for p in (root / "variants").glob("*.json")}
    run(SimpleNamespace(repo=tmp_path))
    assert completed == {p: p.stat().st_mtime_ns for p in completed}
