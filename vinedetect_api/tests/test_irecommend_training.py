from __future__ import annotations

import json
import shutil
from copy import deepcopy

import pytest

from app.irecommend_manifest import (
    build_manifest,
    confirmed_manifest,
    main,
    read_manifest,
    training_manifest,
    write_manifest,
)
from tests.test_irecommend_confirmed import FIXTURES, VERIFICATIONS
from tests.test_irecommend_matching import CATALOG_ROWS

QUALITY_FIXTURE = FIXTURES / "image_quality_overrides.jsonl"


def build_with_quality(overrides=()):
    return build_manifest(
        FIXTURES.glob("product*.html"),
        FIXTURES.glob("review*.html"),
        CATALOG_ROWS,
        review_verifications=VERIFICATIONS,
        image_quality_overrides=overrides,
    )


def test_six_training_records_and_seven_drops_preserve_provenance():
    overrides = read_manifest(QUALITY_FIXTURE)
    rows = build_with_quality(overrides)
    before = deepcopy(rows)
    confirmed = confirmed_manifest(rows)
    training = training_manifest(rows)
    assert len(rows) == 21
    assert len(confirmed) == 13
    assert len(training) == 6
    assert {row["image_identity"] for row in training} == {
        row["image_identity"]
        for row in overrides
        if row["quality_status"] in {"keep", "keep_hard"}
    }
    dropped = [row for row in confirmed if row["quality_status"] == "drop"]
    assert len(dropped) == 7
    assert not training_manifest(dropped)
    for row in confirmed:
        decision = next(
            item
            for item in overrides
            if item["image_identity"] == row["image_identity"]
        )
        assert row["provenance"]["image_quality_override"] == decision
        assert len(row["provenance"]["image_quality_override_sha256"]) == 64
        assert row["provenance"]["review_html"]["sha256"]
        assert row["match_evidence"]
    assert rows == before


def test_missing_or_unknown_quality_never_enters_training():
    rows = build_with_quality()
    assert len(confirmed_manifest(rows)) == 13
    assert all(row["quality_status"] == "unknown" for row in rows)
    assert training_manifest(rows) == []
    row = confirmed_manifest(rows)[0]
    for status in ("unknown", None, "unrecognized_future_status"):
        assert training_manifest([{**row, "quality_status": status}]) == []
    row.pop("quality_status")
    assert training_manifest([row]) == []


@pytest.mark.parametrize(
    "change",
    [
        {"verification_status": "auto"},
        {"verification_status": "human_rejected"},
        {"match_status": "unmatched"},
        {"match_status": "needs_review"},
    ],
)
def test_quality_keep_does_not_replace_exact_human_confirmation(change):
    row = training_manifest(build_with_quality(read_manifest(QUALITY_FIXTURE)))[0]
    assert training_manifest([{**row, **change}]) == []


def test_build_discovers_quality_file_and_repeats_all_exports(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    root = tmp_path / "data" / "irecommend"
    samples = root / "samples"
    samples.mkdir(parents=True)
    for path in FIXTURES.glob("*.html"):
        shutil.copyfile(path, samples / path.name)
    (root / "catalog_items.json").write_text(json.dumps(CATALOG_ROWS), encoding="utf-8")
    write_manifest(root / "review_verifications.jsonl", VERIFICATIONS)
    shutil.copyfile(QUALITY_FIXTURE, root / "image_quality_overrides.jsonl")
    dropped_file = root / "images" / "retained_drop.jpg"
    dropped_file.parent.mkdir()
    dropped_file.write_bytes(b"existing downloaded image must remain untouched")
    assert main(["build"]) == 0
    paths = [
        root / name
        for name in (
            "manifest.jsonl",
            "manifest.confirmed.jsonl",
            "manifest.training.jsonl",
        )
    ]
    first = [path.read_bytes() for path in paths]
    assert [len(read_manifest(path)) for path in paths] == [21, 13, 6]
    # Input ordering also must not influence deterministic output.
    write_manifest(
        root / "image_quality_overrides.jsonl", reversed(read_manifest(QUALITY_FIXTURE))
    )
    assert main(["build"]) == 0
    assert [path.read_bytes() for path in paths] == first
    assert (
        dropped_file.read_bytes() == b"existing downloaded image must remain untouched"
    )


def test_conflicting_quality_decisions_fail_instead_of_selecting_one():
    row = read_manifest(QUALITY_FIXTURE)[0]
    with pytest.raises(ValueError, match="Conflicting quality"):
        build_with_quality([row, {**row, "quality_status": "drop"}])
