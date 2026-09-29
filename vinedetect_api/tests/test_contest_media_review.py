"""Regression coverage for deterministic normalization and human review artifacts."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from PIL import Image

from app import contest_media as media
from app import contest_media_review as review
from tests.test_contest_media import catalog, make_image


def webp(root, name, color="red"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (32, 48), color).save(path, format="WEBP", lossless=True)
    return path


def legacy_report(monkeypatch, manifest, source):
    with monkeypatch.context() as patch:
        patch.setattr(media, "normalization_trace", review.legacy_trace)
        patch.setattr(
            media,
            "candidate_key_traces",
            lambda entry: [
                review.legacy_trace(entry["filename"], strip_strapi_hash=strip)
                for strip in (False, True)
            ],
        )
        return media.resolve_catalog(manifest, source)


@pytest.mark.parametrize("name", ["Бленд №4.webp", "Бленд № 4.webp", "Бленд №４.webp"])
def test_numero_before_number_preserves_numeric_identity(name):
    assert media.normalize_filename(name) == ("blend4", ".webp")
    assert media.normalize_filename(name) != media.normalize_filename("Бленд 5.webp")
    assert media.normalize_filename("Blend No4.webp") == ("blendno4", ".webp")
    assert media.normalize_filename("Blend №A.webp") == ("blendnoa", ".webp")


def test_numero_rule_resolves_complete_name_and_retains_trace(tmp_path):
    webp(tmp_path, "Cellar_Blend_4_suhoe_a49f44e398.webp")
    row = media.resolve_catalog(
        media.scan_media(tmp_path), catalog("Cellar Бленд №4 сухое.webp")
    )["items"][0]
    assert row["match_class"] == "normalized_unique"
    trace = row["normalization_evidence"]["official"]
    assert trace["numero_punctuation"] == "Cellar Бленд 4 сухое.webp"
    assert trace["nfkc"] == trace["numero_punctuation"]


def test_numero_collisions_remain_ambiguous(tmp_path):
    webp(tmp_path, "Blend_4_a49f44e398.webp")
    webp(tmp_path, "Blend_4_b49f44e398.webp", "blue")
    row = media.resolve_catalog(media.scan_media(tmp_path), catalog("Бленд №4.webp"))[
        "items"
    ][0]
    assert row["match_class"] == "ambiguous"


@pytest.mark.parametrize(
    "extension", ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif"]
)
def test_embedded_source_extension_alias(tmp_path, extension):
    webp(tmp_path, f"Original_{extension}_a49f44e398.webp")
    row = media.resolve_catalog(
        media.scan_media(tmp_path), catalog(f"original.{extension}")
    )["items"][0]
    assert row["match_class"] == "normalized_unique"
    assert row["normalization_evidence"]["candidate_keys"][0]["traces"][-1]["rule"] == (
        "strapi_embedded_source_extension"
    )


@pytest.mark.parametrize(
    "name,wrong_format",
    [
        ("Original_png.webp", False),
        ("Original_png_bad.webp", False),
        ("Original_a49f44e398.webp", False),
        ("thumbnail_Original_png_a49f44e398.webp", False),
        ("Original_png_a49f44e398.webp", True),
        ("Original_pdf_a49f44e398.webp", False),
    ],
)
def test_conversion_rule_requires_complete_identity_hash_and_webp(
    tmp_path, name, wrong_format
):
    if wrong_format:
        make_image(tmp_path, name)
    else:
        webp(tmp_path, name)
    row = media.resolve_catalog(media.scan_media(tmp_path), catalog("Original.png"))[
        "items"
    ][0]
    assert row["match_class"] == "missing"


def test_alias_collisions_are_not_selected_by_dimensions(tmp_path):
    webp(tmp_path, "Original_png_a49f44e398.webp")
    webp(tmp_path, "Original_png_b49f44e398.webp", "blue")
    row = media.resolve_catalog(media.scan_media(tmp_path), catalog("Original.png"))[
        "items"
    ][0]
    assert row["match_class"] == "ambiguous"


def test_conversion_alias_keeps_exact_filename_precedence(tmp_path):
    make_image(tmp_path, "Original.png")
    webp(tmp_path, "Original_png_a49f44e398.webp", "blue")
    row = media.resolve_catalog(media.scan_media(tmp_path), catalog("Original.png"))[
        "items"
    ][0]
    assert row["match_class"] == "exact_filename"


def test_vintage_and_opaque_historical_assets_remain_missing(tmp_path):
    webp(tmp_path, "Wine_a49f44e398.webp")
    source = catalog("Wine 2021.webp")
    source["items"][0].update(
        title="Wine",
        winery="Producer",
        linked_wine_id=42,
        linked_wine_slug="old-wine",
        historical_images=[
            {"wine_id": 42, "image_id": 1, "url": "/Wine_a49f44e398.webp"}
        ],
    )
    manifest = media.scan_media(tmp_path)
    result = media.resolve_catalog(manifest, source)
    assert result["items"][0]["match_class"] == "missing"
    investigation = review.build_review(manifest, source, result, result)[
        "remaining_missing"
    ][0]
    assert investigation["linked_wine_slug"] == "old-wine"
    assert investigation["historical_basename_exists_in_archive"] is True
    assert investigation["generic_rule"] is None
    assert investigation["historical_archive_matches"][0]["current_keys"]
    assert investigation["cannot_select_reason"]


def test_review_explains_both_new_rules_and_preserves_six_missing_fields(
    tmp_path, monkeypatch
):
    webp(tmp_path, "Blend_4_a49f44e398.webp")
    webp(tmp_path, "Original_png_a49f44e398.webp")
    source = catalog("Blend №4.webp", "Original.png")
    source["items"][0].update(
        linked_wine_id=42,
        linked_wine_slug="historic",
        historical_images=[
            {"wine_id": 42, "image_id": 1, "url": "/Blend_4_a49f44e398.webp"}
        ],
    )
    manifest = media.scan_media(tmp_path)
    before = legacy_report(monkeypatch, manifest, source)
    after = media.resolve_catalog(manifest, source)
    result = review.build_review(manifest, source, before, after)
    assert result["summary"]["new_generic_rule_resolutions"] == 2
    assert result["summary"]["resolved_before"] == 0
    assert result["summary"]["resolved_after"] == 2
    assert {r["generic_rule"] for r in result["missing_investigations"]} == {
        "numero_sign_before_numeric_identifier",
        "strapi_embedded_source_extension",
    }
    investigation = result["missing_investigations"][0]
    assert investigation["official_legacy_trace"]["normalized_key"] == [
        "blendno4",
        ".webp",
    ]
    assert investigation["official_current_trace"]["normalized_key"] == [
        "blend4",
        ".webp",
    ]
    assert investigation["previous_missing_reason"]
    assert investigation["historical_archive_matches"][0]["legacy_keys"]


def test_review_template_metadata_previews_and_byte_identical_cli_replay(
    tmp_path, monkeypatch
):
    root = tmp_path / "media"
    root.mkdir()
    make_image(root, "Wine_a49f44e398.png")
    make_image(root, "Wine_b49f44e398.png", "blue")
    make_image(root, "unrelated-copy.png")
    source = catalog("Wine.png", "Wine.png", "missing.png")
    for row in source["items"]:
        row.update(title="Вино для обзора", winery="Винодельня")
    manifest = media.scan_media(root)
    baseline = media.resolve_catalog(manifest, source)
    for name, value in (
        ("manifest", manifest),
        ("baseline", baseline),
        ("catalog", source),
    ):
        (tmp_path / f"{name}.json").write_bytes(media.json_bytes(value))
    font = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    if not font.exists():
        pytest.skip("Deterministic preview test requires DejaVu Sans")

    def no_database(*args, **kwargs):
        pytest.fail("Export replay must not connect to PostgreSQL")

    monkeypatch.setattr(review, "read_catalog", no_database)
    argv = [
        "--manifest-json",
        str(tmp_path / "manifest.json"),
        "--baseline-json",
        str(tmp_path / "baseline.json"),
        "--catalog-json",
        str(tmp_path / "catalog.json"),
        "--media-root",
        str(root),
        "--font",
        str(font),
    ]
    original = {p.name: p.read_bytes() for p in root.iterdir()}
    first, second = tmp_path / "first", tmp_path / "second"
    review.main([*argv, "--output-dir", str(first)])
    # Input ordering must not affect any artifact.
    manifest["files"].reverse()
    source["items"].reverse()
    (tmp_path / "manifest.json").write_bytes(media.json_bytes(manifest))
    (tmp_path / "catalog.json").write_bytes(media.json_bytes(source))
    review.main([*argv, "--output-dir", str(second)])
    outputs = {
        p.relative_to(first): p.read_bytes() for p in first.rglob("*") if p.is_file()
    }
    assert outputs == {
        p.relative_to(second): p.read_bytes() for p in second.rglob("*") if p.is_file()
    }
    assert original == {p.name: p.read_bytes() for p in root.iterdir()}
    decisions = json.loads(outputs[Path("review-decisions.json")])
    assert len(decisions) == 2
    assert all(
        r["decision"] is r["selected_relative_path"] is r["note"] is None
        for r in decisions
    )
    result = json.loads(outputs[Path("review-data.json")])
    candidate = result["ambiguous_items"][0]["candidates"][0]
    assert candidate["duplicate_sha_paths"] == ["unrelated-copy.png"]
    assert candidate["width"] == 12 and candidate["height"] == 8
    assert candidate["preview_status"] == "rendered"
    assert result["duplicate_photo_name_groups"][0]["status"] == "ambiguous"
    assert (
        result["remaining_missing"][0]["historical_basename_exists_in_archive"] is False
    )
    markdown = outputs[Path("review.md")].decode()
    assert "Вино для обзора" in markdown and candidate["sha256"] in markdown
    assert "previews/001-01.png" in markdown
    with Image.open(first / "previews/001-01.png") as sheet:
        assert sheet.width == 1200
    with pytest.raises(SystemExit):
        review.main([*argv, "--output-dir", str(root / "review")])
    with pytest.raises(SystemExit):
        review.main([*argv, "--output-dir", str(first)])


@pytest.mark.parametrize(
    "update,status",
    [
        ({"width": 100_000, "height": 100_000}, "pixel_limit"),
        ({"decode_status": "oversized"}, "unsafe_decode_status"),
        ({"sha256": "0" * 64}, "source_sha_mismatch"),
        ({"relative_path": "../escape.png"}, "unsafe_relative_path"),
    ],
)
def test_preview_bounds_and_snapshot_integrity(tmp_path, update, status):
    make_image(tmp_path, "test.png")
    candidate = media.scan_media(tmp_path)["files"][0] | update
    pixels, actual_status = review.preview_image(tmp_path, candidate)
    assert pixels is None
    assert actual_status == status


def test_review_rejects_mismatched_baseline(tmp_path):
    make_image(tmp_path, "test.png")
    manifest = media.scan_media(tmp_path)
    source = catalog("test.png")
    after = media.resolve_catalog(manifest, source)
    before = copy.deepcopy(after)
    before["items"][0]["official_slug"] = "wrong"
    with pytest.raises(ValueError, match="identities differ"):
        review.build_review(manifest, source, before, after)
