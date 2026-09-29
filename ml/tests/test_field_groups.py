from __future__ import annotations

import argparse
import hashlib
import json
from copy import deepcopy

import numpy as np
import pytest
from PIL import Image
from test_field import field_case as field_case
from test_retrieval import FakeEncoder

from vinedetect_retrieval.artifacts import digest, write_json
from vinedetect_retrieval.embeddings import embed_manifest
from vinedetect_retrieval.field_cli import add_commands
from vinedetect_retrieval.field_data import build_field_manifest, empty_labels
from vinedetect_retrieval.field_groups import build_source_groups, validate_source_groups
from vinedetect_retrieval.field_retrieval import (
    evaluate_field,
    evaluate_field_vectors,
    retrieve_vectors,
)
from vinedetect_retrieval.field_review import build_review


@pytest.fixture
def grouped_case(request):
    raw, assets, gallery, _ = request.getfixturevalue("field_case")
    Image.new("RGB", (8, 15), (50, 20, 60)).save(raw / "a_thumb.jpg")
    Image.new("RGB", (7, 13), (20, 40, 60)).save(raw / "orphan_thumb.png")
    manifest = build_field_manifest(raw, gallery)
    grouping = build_source_groups(manifest)
    return raw, assets, gallery, manifest, grouping


def test_source_group_pairs_standalone_and_orphan(grouped_case):
    _, _, _, manifest, grouping = grouped_case
    rows = {r["relative_source_path"]: r for r in grouping["rows"]}
    assert grouping["summary"] == {
        "total_files": 4,
        "source_groups": 3,
        "original": 1,
        "thumb": 2,
        "standalone": 1,
        "groups_with_both_original_and_thumb": 1,
        "orphan_thumb_groups": 1,
        "primary_images": 2,
    }
    assert rows["a.jpg"]["source_group_id"] == rows["a_thumb.jpg"]["source_group_id"]
    assert rows["a.jpg"]["variant"] == "original"
    assert rows["a_thumb.jpg"]["variant"] == rows["orphan_thumb.png"]["variant"] == "thumb"
    assert rows["z.JPG"]["variant"] == "standalone"
    assert rows["a.jpg"]["paired_field_image_id"] == rows["a_thumb.jpg"]["field_image_id"]
    assert rows["a_thumb.jpg"]["paired_field_image_id"] == rows["a.jpg"]["field_image_id"]
    assert rows["orphan_thumb.png"]["paired_field_image_id"] is None
    by_path = {r["relative_source_path"]: r for r in manifest["rows"]}
    assert by_path["a.jpg"]["sha256"] != by_path["a_thumb.jpg"]["sha256"]


def test_source_ids_stable_across_order_content_and_unrelated_rows(grouped_case):
    _, _, _, manifest, grouping = grouped_case
    before = deepcopy(manifest)
    assert build_source_groups(manifest) == grouping
    assert manifest == before
    changed = deepcopy(manifest)
    changed["rows"].reverse()
    changed["rows"][0]["sha256"] = "different bytes"
    changed["rows"].append(
        {**changed["rows"][0], "field_image_id": "extra", "relative_source_path": "extra.jpg"}
    )
    changed["row_count"] += 1
    new = {r["field_image_id"]: r for r in build_source_groups(changed)["rows"]}
    assert all(new[r["field_image_id"]] == r for r in grouping["rows"])


def test_filename_policy_terminal_suffix_directory_and_formats(grouped_case):
    _, _, _, manifest, _ = grouped_case
    names = [
        "folder/photo.JPG",
        "folder/photo_THUMB.png",
        "other/photo.jpg",
        "photo_thumb_detail.jpg",
    ]
    manifest = {
        **manifest,
        "rows": [
            {**r, "relative_source_path": name}
            for r, name in zip(manifest["rows"], names, strict=True)
        ],
    }
    grouping = build_source_groups(manifest)
    by_path = {r["relative_source_path"]: r for r in grouping["rows"]}
    assert by_path[names[0]]["source_group_id"] == by_path[names[1]]["source_group_id"]
    assert by_path[names[2]]["variant"] == by_path[names[3]]["variant"] == "standalone"
    assert by_path[names[0]]["source_group_id"] != by_path[names[2]]["source_group_id"]


def test_ambiguous_variant_collision_rejected(grouped_case):
    _, _, _, manifest, _ = grouped_case
    manifest = deepcopy(manifest)
    manifest["rows"].append(
        {**manifest["rows"][0], "field_image_id": "extra", "relative_source_path": "a.png"}
    )
    manifest["row_count"] += 1
    with pytest.raises(ValueError, match="Ambiguous"):
        build_source_groups(manifest)


def test_sidecar_tampering_or_stale_snapshot_rejected(grouped_case):
    _, _, _, manifest, grouping = grouped_case
    for key, value in (
        ("variant", "standalone"),
        ("source_group_id", "wrong"),
        ("paired_field_image_id", None),
    ):
        bad = deepcopy(grouping)
        bad["rows"][0][key] = value
        with pytest.raises(ValueError, match="grouping differs"):
            validate_source_groups(bad, manifest)
    bad = deepcopy(grouping)
    bad["manifest_sha256"] = "stale"
    with pytest.raises(ValueError):
        validate_source_groups(bad, manifest)


def decisions(manifest):
    labels = empty_labels(manifest)
    by_id = {r["field_image_id"]: r for r in labels["rows"]}
    for row in manifest["rows"]:
        target = {"a.jpg": 1, "a_thumb.jpg": 2, "z.JPG": 3}.get(row["relative_source_path"])
        if target:
            by_id[row["field_image_id"]].update(
                status="exact_confirmed", catalog_item_id=target, official_slug=f"wine-{target}"
            )
    return labels


def test_primary_and_explicit_thumb_denominators(grouped_case):
    _, _, gallery, manifest, grouping = grouped_case
    queries, matrix = np.ones((4, 4), dtype=np.float32) / 2, np.ones((12, 4), dtype=np.float32) / 2
    labels = decisions(manifest)
    original = deepcopy(labels)
    primary = evaluate_field_vectors(
        queries, matrix, manifest, gallery, labels, mode="primary_field", grouping=grouping
    )
    robust = evaluate_field_vectors(
        queries,
        matrix,
        manifest,
        gallery,
        labels,
        mode="low_resolution_robustness",
        grouping=grouping,
    )
    assert primary["evaluation_mode"] == "primary_field"
    assert primary["exact_confirmed_count"] == primary["evaluated_source_group_count"] == 2
    assert primary["strict"]["top_1_accuracy"] == 0.5
    assert {r["variant"] for r in primary["results"]} == {"original", "standalone"}
    assert primary["excluded_by_variant_count"] == 2
    assert robust["exact_confirmed_count"] == 1 and robust["eligible_image_count"] == 2
    assert robust["results"][0]["variant"] == "thumb"
    assert robust["strict"]["mean_rank"] == 2
    assert robust["status_counts"]["unreviewed"] == 1
    assert robust["strict"]["top_1_accuracy"] == 0
    assert labels == original
    assert primary == evaluate_field_vectors(queries, matrix, manifest, gallery, labels)
    for label, row in zip(labels["rows"], manifest["rows"], strict=True):
        if row["relative_source_path"].endswith("_thumb.jpg"):
            label.update(status="family_confirmed", catalog_item_id=None, official_slug=None)
    assert (
        evaluate_field_vectors(
            queries, matrix, manifest, gallery, labels, mode="low_resolution_robustness"
        )["strict"]["count"]
        == 0
    )
    with pytest.raises(ValueError, match="Unknown field evaluation mode"):
        evaluate_field_vectors(queries, matrix, manifest, gallery, labels, mode="all")


def test_no_label_propagation_and_not_in_catalog(grouped_case):
    _, _, gallery, manifest, grouping = grouped_case
    labels = empty_labels(manifest)
    by_path = {r["relative_source_path"]: i for i, r in enumerate(manifest["rows"])}
    labels["rows"][by_path["a.jpg"]].update(
        status="exact_confirmed", catalog_item_id=1, official_slug="wine-1"
    )
    labels["rows"][by_path["z.JPG"]]["status"] = "not_in_catalog"
    queries, matrix = np.ones((4, 4), dtype=np.float32) / 2, np.ones((12, 4), dtype=np.float32) / 2
    primary = evaluate_field_vectors(queries, matrix, manifest, gallery, labels, grouping=grouping)
    robustness = evaluate_field_vectors(
        queries,
        matrix,
        manifest,
        gallery,
        labels,
        mode="low_resolution_robustness",
        grouping=grouping,
    )
    assert primary["strict"]["count"] == primary["status_counts"]["not_in_catalog"] == 1
    assert robustness["strict"]["count"] == 0 and robustness["strict"]["top_1_accuracy"] is None
    assert labels["rows"][by_path["a_thumb.jpg"]]["status"] == "unreviewed"


def test_grouped_review_keeps_labels_and_previews(grouped_case, tmp_path):
    raw, assets, gallery, manifest, grouping = grouped_case
    labels = decisions(manifest)
    before = deepcopy(labels)
    vectors = np.ones((12, 4), dtype=np.float32) / 2
    results, _ = retrieve_vectors(vectors[:4], vectors, manifest["rows"], gallery["rows"])
    retrieval = {
        "manifest_sha256": digest(manifest),
        "gallery_sha256": digest(gallery["rows"]),
        "results": results,
    }
    output = tmp_path / "review"
    result = build_review(
        manifest, gallery, retrieval, labels, raw, assets, output, grouping=grouping
    )
    assert result["default_primary_count"] == 2
    page = (output / "index.html").read_bytes()
    data = json.loads(
        page.decode().split('<script id="data" type="application/json">')[1].split("</script>")[0]
    )
    assert data["labels"] == labels == before
    assert len(data["records"]) == 4
    assert all(r["source_group_id"] and r["variant"] for r in data["records"])
    assert b'<option value="primary">Primary only' in page
    assert b"not-in-catalog" in page and b"paired_field_image_id" in page
    previews = {
        p: (p.read_bytes(), p.stat().st_mtime_ns) for p in (output / "assets").rglob("*.jpg")
    }
    build_review(manifest, gallery, retrieval, labels, raw, assets, output, grouping=grouping)
    assert page == (output / "index.html").read_bytes()
    assert all((p.read_bytes(), p.stat().st_mtime_ns) == before for p, before in previews.items())


def test_existing_bundles_and_checkpoints_reused_without_writes(
    grouped_case, tmp_path, monkeypatch
):
    raw, assets, gallery, manifest, grouping = grouped_case
    gallery_dir, query_dir = tmp_path / "gallery", tmp_path / "queries"
    cache = tmp_path / "cache"
    embed_manifest(gallery, FakeEncoder(), assets, gallery_dir, cache, show_progress=False)
    embed_manifest(manifest, FakeEncoder(), raw, query_dir, cache, show_progress=False)
    original = {
        p: (hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns)
        for root in (gallery_dir, query_dir, cache)
        for p in root.rglob("*")
        if p.is_file()
    }

    def forbidden(*args, **kwargs):
        raise AssertionError("Grouping/evaluation must never run inference or rewrite embeddings")

    import psycopg

    import vinedetect_retrieval.embeddings as emb
    import vinedetect_retrieval.encoder as enc

    monkeypatch.setattr(enc, "SiglipEncoder", forbidden)
    monkeypatch.setattr(emb, "embed_manifest", forbidden)
    monkeypatch.setattr(psycopg, "connect", forbidden)
    write_json(tmp_path / "groups.json", grouping)
    for mode in ("primary_field", "low_resolution_robustness"):
        result = evaluate_field(
            gallery_dir,
            query_dir,
            gallery,
            manifest,
            decisions(manifest),
            mode=mode,
            grouping=grouping,
        )
        assert result["evaluation_mode"] == mode
    assert all(
        (hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mtime_ns) == before
        for p, before in original.items()
    )


def test_cli_requires_explicit_mode_and_separate_outputs(tmp_path):
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    add_commands(commands, tmp_path, tmp_path / "baseline")
    with pytest.raises(SystemExit):
        parser.parse_args(["evaluate-field"])
    for mode in ("primary_field", "low_resolution_robustness"):
        args = parser.parse_args(["evaluate-field", "--mode", mode])
        assert args.mode == mode
        assert args.grouping.name == "field-source-groups.json"
    assert parser.parse_args(["field-groups"]).command == "field-groups"
