from __future__ import annotations

import copy
import hashlib
import json
import struct

import pytest
from PIL import Image

from app.contest_media import (
    inspect_file,
    json_bytes,
    main,
    normalize_filename,
    resolve_catalog,
    scan_media,
)


def make_image(root, name, color="red"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (12, 8), color).save(path, format="PNG")
    return path


def catalog(*photos):
    return {
        "import_run": {"version": "test-v1"},
        "items": [
            {"official_slug": f"wine-{index}", "photo_name": photo}
            for index, photo in enumerate(photos)
        ],
    }


@pytest.mark.parametrize(
    "name",
    [
        "Wine_a49f44e398.PNG",
        "Wine_A49F44E398.png",
    ],
)
def test_terminal_strapi_hash_is_stripped(name):
    assert normalize_filename(name) == ("wine", ".png")


def test_only_terminal_ten_hex_suffix_is_removed():
    assert normalize_filename("Wine_a49f44e398_copy.png")[0] == "winea49f44e398copy"
    assert normalize_filename("Wine_123.png")[0] == "wine123"
    assert normalize_filename("Wine_z49f44e398.png")[0] == "winez49f44e398"


def test_separator_case_unicode_and_observed_transliteration():
    assert normalize_filename("ＣＡＦÉ Wine--Reserve.PNG") == normalize_filename(
        "cafe\u0301_wine reserve.png"
    )
    assert normalize_filename("Агора Мускат Черный.webp") == normalize_filename(
        "Agora_Muskat_Chernyj_b3314704fa.webp"
    )
    assert normalize_filename("Бархат.webp") == normalize_filename(
        "Barhat_cd989f8325.webp"
    )
    assert normalize_filename("Темелион Брют (1).webp") == normalize_filename(
        "Temelion_Bryut_1_a8d14c7360.webp"
    )
    assert normalize_filename("Wine.jpg") != normalize_filename("Wine.png")


def test_exact_match_wins_over_normalized_alternatives(tmp_path):
    make_image(tmp_path, "Wine.png")
    make_image(tmp_path, "wine_a49f44e398.png", "blue")
    report = resolve_catalog(scan_media(tmp_path), catalog("Wine.png"))
    row = report["items"][0]
    assert row["match_class"] == "exact_filename"
    assert row["selected_relative_path"] == "Wine.png"
    assert (row["width"], row["height"]) == (12, 8)
    assert (
        row["sha256"]
        == hashlib.sha256((tmp_path / "Wine.png").read_bytes()).hexdigest()
    )
    assert report["unused_archive_files"] == ["wine_a49f44e398.png"]


def test_normalized_unique_and_timestamp_source_name(tmp_path):
    make_image(tmp_path, "Wine_Reserve_a49f44e398.png")
    make_image(tmp_path, "O4nl0_Y_Wdgyo6_H_Nd_1775200002_52181b7f44.png")
    report = resolve_catalog(
        scan_media(tmp_path),
        catalog("wine-reserve.PNG", "O4nl0YWdgyo6HNd_1775200002.png"),
    )
    assert [row["match_class"] for row in report["items"]] == [
        "normalized_unique",
        "normalized_unique",
    ]
    assert report["summary"]["resolved_normalized_unique"] == 2


def test_shared_reference_keeps_catalog_identity_and_match_basis(tmp_path):
    make_image(tmp_path, "Wine.png")
    report = resolve_catalog(scan_media(tmp_path), catalog("Wine.png", "wine.PNG"))
    assert [row["match_class"] for row in report["items"]] == [
        "shared_reference",
        "shared_reference",
    ]
    assert [row["match_basis"] for row in report["items"]] == [
        "exact_filename",
        "normalized_unique",
    ]
    assert report["summary"]["resolved_exactly"] == 1
    assert report["summary"]["resolved_normalized_unique"] == 1
    assert report["summary"]["selected_physical_assets"] == 1
    assert report["shared_reference_groups"][0]["official_slugs"] == [
        "wine-0",
        "wine-1",
    ]


def test_sha_equivalent_candidates_keep_all_paths(tmp_path):
    make_image(tmp_path, "Wine_a49f44e398.png")
    make_image(tmp_path, "Wine_b49f44e398.png")
    report = resolve_catalog(scan_media(tmp_path), catalog("Wine.png"))
    row = report["items"][0]
    assert row["match_class"] == "sha_equivalent"
    assert row["selected_relative_path"] == "Wine_a49f44e398.png"
    assert row["candidate_paths"] == ["Wine_a49f44e398.png", "Wine_b49f44e398.png"]
    assert row["equivalent_candidate_paths"] == row["candidate_paths"]
    assert report["before_after"]["before"]["ambiguous"] == 1
    assert report["before_after"]["after"]["sha_equivalent"] == 1
    assert len(report["duplicate_physical_files_by_sha256"]) == 1


def test_duplicate_exact_basenames_in_subdirectories_are_ambiguous(tmp_path):
    make_image(tmp_path, "a/Wine.png")
    make_image(tmp_path, "b/Wine.png", "blue")
    report = resolve_catalog(scan_media(tmp_path), catalog("Wine.png"))
    assert report["items"][0]["match_class"] == "ambiguous"
    assert report["items"][0]["candidate_paths"] == ["a/Wine.png", "b/Wine.png"]


def test_missing_non_raster_corrupt_and_extension_mismatch(tmp_path):
    (tmp_path / "Wine.svg").write_text("<svg/>")
    (tmp_path / "Broken.png").write_bytes(b"not an image")
    make_image(tmp_path, "Mislabeled.jpg")
    manifest = scan_media(tmp_path)
    report = resolve_catalog(
        manifest, catalog("absent.png", "Wine.svg", "Broken.png", "Mislabeled.jpg")
    )
    assert [row["match_class"] for row in report["items"]] == [
        "missing",
        "missing",
        "missing",
        "exact_filename",
    ]
    assert report["summary"]["decode_failures"] == 1
    assert report["summary"]["extension_mismatches"] == 1
    assert (
        next(f for f in manifest["files"] if f["filename"] == "Wine.svg")[
            "decode_status"
        ]
        == "non_raster"
    )


def test_duplicate_sha_includes_non_raster_files(tmp_path):
    (tmp_path / "one.txt").write_text("same")
    (tmp_path / "two.txt").write_text("same")
    report = resolve_catalog(scan_media(tmp_path), catalog("none.png"))
    assert report["duplicate_physical_files_by_sha256"] == [
        {
            "sha256": hashlib.sha256(b"same").hexdigest(),
            "relative_paths": ["one.txt", "two.txt"],
        }
    ]


def test_scan_and_resolution_are_deterministic_without_timestamps(tmp_path):
    make_image(tmp_path, "b.png")
    make_image(tmp_path, "a.png")
    first = scan_media(tmp_path)
    (tmp_path / "a.png").touch()
    assert json_bytes(scan_media(tmp_path)) == json_bytes(first)
    source = catalog("a.png", "missing.png", "b.png")
    reversed_manifest = copy.deepcopy(first)
    reversed_manifest["files"].reverse()
    reversed_catalog = copy.deepcopy(source)
    reversed_catalog["items"].reverse()
    assert json_bytes(resolve_catalog(first, source)) == json_bytes(
        resolve_catalog(reversed_manifest, reversed_catalog)
    )


@pytest.mark.parametrize("threshold", [50, 40])
def test_pillow_bomb_warning_and_error_preserve_metadata(
    tmp_path, monkeypatch, threshold
):
    path = make_image(tmp_path, "large.png")
    # 96 pixels: >50 warning, or >2*40 error, without allocating a huge fixture.
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", threshold)
    before = Image.MAX_IMAGE_PIXELS
    entry = inspect_file(path, path.name)
    assert entry["decode_status"] == "oversized"
    assert (entry["width"], entry["height"]) == (12, 8)
    assert entry["sha256"] is not None
    assert entry["decode_error"] == (
        "DecompressionBombWarning" if threshold == 50 else "DecompressionBombError"
    )
    assert Image.MAX_IMAGE_PIXELS == before


def test_metadata_inspection_does_not_decode_pixels(tmp_path, monkeypatch):
    path = make_image(tmp_path, "wine.png")
    from PIL import PngImagePlugin

    def reject_load(*args, **kwargs):
        raise AssertionError("Pixel decoding is forbidden for manifest inspection")

    monkeypatch.setattr(PngImagePlugin.PngImageFile, "load", reject_load)
    assert inspect_file(path, path.name)["decode_status"] == "header_only"


def test_oversized_jpeg_header_fallback(tmp_path, monkeypatch):
    path = tmp_path / "large.jpg"
    Image.new("RGB", (12, 8)).save(path)
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 40)
    entry = inspect_file(path, path.name)
    assert entry["decode_status"] == "oversized"
    assert (entry["format"], entry["width"], entry["height"]) == ("JPEG", 12, 8)


def test_oversized_png_header_without_large_allocation(tmp_path):
    path = make_image(tmp_path, "large.png")
    data = bytearray(path.read_bytes())
    data[16:24] = struct.pack(">II", 27797, 8556)
    import zlib

    data[29:33] = struct.pack(">I", zlib.crc32(data[12:29]))
    path.write_bytes(data)
    entry = inspect_file(path, path.name)
    assert entry["decode_status"] == "oversized"
    assert (entry["width"], entry["height"]) == (27797, 8556)


def test_symlinks_are_recorded_without_following(tmp_path):
    root = tmp_path / "media"
    root.mkdir()
    target = make_image(tmp_path, "outside.png")
    try:
        (root / "linked.png").symlink_to(target)
    except OSError:
        pytest.skip("Symlink creation not supported")
    entry = scan_media(root)["files"][0]
    assert entry["decode_status"] == "skipped_non_regular"
    assert entry["sha256"] is None


def test_cli_export_and_cached_replay(tmp_path, monkeypatch, capsys):
    root = tmp_path / "media"
    root.mkdir()
    make_image(root, "Wine.png")
    source = tmp_path / "input.json"
    source.write_bytes(json_bytes(catalog("Wine.png")))
    output = tmp_path / "report"
    monkeypatch.delenv("DATABASE_URL", raising=False)
    main(
        [
            "--media-root",
            str(root),
            "--catalog-json",
            str(source),
            "--output-dir",
            str(output),
        ]
    )
    assert json.loads(capsys.readouterr().out)["resolved_exactly"] == 1
    second = tmp_path / "replay"
    main(
        [
            "--manifest-json",
            str(output / "media-manifest.json"),
            "--catalog-json",
            str(output / "catalog-items.json"),
            "--output-dir",
            str(second),
        ]
    )
    for filename in (
        "media-manifest.json",
        "media-resolution.json",
        "catalog-items.json",
    ):
        assert (output / filename).read_bytes() == (second / filename).read_bytes()
    with pytest.raises(SystemExit):
        main(
            [
                "--media-root",
                str(root),
                "--catalog-json",
                str(source),
                "--output-dir",
                str(root / "report"),
            ]
        )
    assert not (root / "report").exists()


def test_compressed_size_limit_does_not_open_image(tmp_path, monkeypatch):
    from app import contest_media

    path = make_image(tmp_path, "wine.png")
    monkeypatch.setattr(contest_media, "MAX_INSPECTION_BYTES", 1)

    def reject_open(*args, **kwargs):
        raise AssertionError("Oversized compressed files must not reach Pillow")

    monkeypatch.setattr(Image, "open", reject_open)
    entry = inspect_file(path, path.name)
    assert entry["decode_status"] == "inspection_limit"
    assert (entry["width"], entry["height"]) == (12, 8)


def test_cli_sorts_exports_and_hashes_exact_export_bytes(tmp_path, capsys):
    root = tmp_path / "media"
    root.mkdir()
    make_image(root, "wine.png")
    source = catalog("wine.png", "missing.png")
    source["items"].reverse()
    input_path = tmp_path / "input.json"
    input_path.write_bytes(json_bytes(source))
    output = tmp_path / "report"
    main(
        [
            "--media-root",
            str(root),
            "--catalog-json",
            str(input_path),
            "--output-dir",
            str(output),
        ]
    )
    capsys.readouterr()
    report = json.loads((output / "media-resolution.json").read_bytes())
    for field, filename in (
        ("catalog_sha256", "catalog-items.json"),
        ("manifest_sha256", "media-manifest.json"),
    ):
        assert (
            report[field]
            == hashlib.sha256((output / filename).read_bytes()).hexdigest()
        )
