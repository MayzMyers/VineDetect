from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.irecommend import extract_vintage_candidates, parse_review_page
from app.irecommend_manifest import (
    build_manifest,
    confirmed_manifest,
    main,
    read_manifest,
)
from tests.test_irecommend_matching import CATALOG_ROWS

FIXTURES = Path(__file__).parent / "fixtures" / "irecommend"
VERIFICATIONS = [
    {
        "source_review_id": review_id,
        "catalog_item_id": 199,
        "verification_status": "human_confirmed",
    }
    for review_id in ("4532995", "9140838")
]
EXPECTED_IMAGES = {
    "4532995": {
        "user-images/530444/f2gvnbHgtOlb1XDL77hDcQ.jpg",
        "user-images/530444/EBwBCzvfyNiD9JRn5aaqPA.jpg",
        "user-images/530444/K1hOGgdDCTgbPECgDqSdpg.jpg",
        "user-images/530444/GirwFl8YpPiezF7vhE20Qg.jpg",
    },
    "9140838": {
        "user-images/2415173/7LUSChswC99wjHO7gSmCuQ.jpg",
        "user-images/2415173/PoiY8y33DuF6yjjpqA0Hg.jpg",
        "user-images/2415173/pmTNrqWaorc76y8Tf0CWA.jpg",
        "user-images/2415173/xTe2uW84C0SiuXbe54g.jpg",
        "user-images/2415173/xCB7acLVdLtnZdV9Aboc8Q.jpg",
        "user-images/2415173/UzgmBsEfznKTNc5ifRlQ.jpg",
        "user-images/2415173/hSI1jjbzQLAxCi9bPb7JIQ.jpg",
        "user-images/2415173/9FTiEBofiwMTE2ifpXfA.jpg",
        "user-images/2415173/BDFG3p6kuwObt2dUFvgbg.jpg",
    },
}


@pytest.mark.parametrize("review_id", ["4532995", "9140838"])
def test_cru_real_review_body_images_and_years(review_id):
    html = (FIXTURES / f"review_cru_lermont_merlo_{review_id}.html").read_text(
        encoding="utf-8"
    )
    review = parse_review_page(html)
    assert review.review_id == review_id
    assert review.product_id == "156562"
    assert review.product_title == "Вино Фанагория Мерло CRU LERMONT"
    assert {image.image_key for image in review.images} == EXPECTED_IMAGES[review_id]
    assert len(review.images) == len(EXPECTED_IMAGES[review_id])
    assert review.full_text
    if review_id == "4532995":
        assert review.title.startswith("Пятьдесят оттенков Лермонтова!")
        assert review.author == "Бутафория"
        assert str(review.publication_date) == "2018-02-20"
        assert review.year_candidates == {"1959", "2016"}
        assert review.vintage_candidates == set()
    else:
        assert (
            review.title
            == "Отличное вино под стейк и блюд из мяса. Желательно декантировать"
        )
        assert review.author == "Роман Ч"
        assert str(review.publication_date) == "2023-04-30"
        assert review.year_candidates == {"2019", "2022"}
        assert review.vintage_candidates == {"2019"}
    for image in review.images:
        assert "/200i/" not in image.preferred_url
        assert image.preferred_url in html
    # An image tagged with the correct gallery but OUTSIDE reviewBody is excluded.
    noise = (
        f'<a data-gallery="gallery_node{review_id}field_imgf1">'
        '<img src="https://irecommend.ru/sites/default/files/imagecache/copyright1/'
        'user-images/999999/outside.jpg"></a><p>урожай 2099</p>'
    )
    marker = re.search(r'<div[^>]*itemprop="reviewBody"[^>]*>', html)
    assert marker
    polluted = html[: marker.start()] + noise + html[marker.start() :]
    assert parse_review_page(polluted) == review
    # Remove/change recommendations without changing the main body result.
    suffix = html.index(f"<!-- /#node-myreview-{review_id} -->")
    assert parse_review_page(html[:suffix] + "</body></html>") == review


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Вино урожая 2019 года.", {"2019"}),
        ("урожай 2019", {"2019"}),
        ("ВИНТАЖ: 2019", {"2019"}),
        ("vintage 2019", {"2019"}),
        ("Дата публикации 2023, дата розлива 22.06.2022", set()),
        ("Медаль конкурса 2016, основано в 1959", set()),
        ("конкурс Vintage 2016", set()),
        ("Дата розлива: vintage 2022", set()),
        ("Вино урожая 2019 года. Дата розлива 22.06.2022.", {"2019"}),
        ("Куплено в 2022, урожай 2019, медаль 2016", {"2019"}),
        ("vintage 2019.06.22", set()),
    ],
)
def test_precise_vintage_context(text, expected):
    assert extract_vintage_candidates(text) == expected


def test_real_confirmed_manifest_keeps_raw_years_out_of_match_evidence():
    rows = build_manifest(
        FIXTURES.glob("product*.html"),
        FIXTURES.glob("review*.html"),
        CATALOG_ROWS,
        review_verifications=VERIFICATIONS,
    )
    assert len(rows) == 21
    confirmed = confirmed_manifest(rows)
    assert len(confirmed) == 13
    assert {row["image_identity"] for row in confirmed} == set.union(
        *EXPECTED_IMAGES.values()
    )
    for row in confirmed:
        assert row["source_product_id"] == "156562"
        assert row["catalog_item_id"] == 199
        assert row["match_status"] == "matched"
        assert row["verification_status"] == "human_confirmed"
        assert row["provenance"]["review_verification"]["catalog_item_id"] == 199
        assert len(row["provenance"]["review_verification_sha256"]) == 64
        # Score/evidence remain the original deterministic matcher decision.
        assert row["match_evidence"]["status"] == "matched"
        assert (
            row["match_evidence"]["candidates"][0]["evidence"]["source_years"]
            == row["vintage_candidates"]
        )
    f_style = [row for row in rows if row["source_product_id"] == "4726923"]
    assert len(f_style) == 8
    assert all(
        row["match_status"] == "unmatched" and row["verification_status"] == "auto"
        for row in f_style
    )
    assert not confirmed_manifest(f_style)
    auto = build_manifest(
        FIXTURES.glob("product*.html"), FIXTURES.glob("review*.html"), CATALOG_ROWS
    )
    assert confirmed_manifest(auto) == []


def test_autodiscovery_builds_both_files_deterministically(tmp_path):
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps(CATALOG_ROWS), encoding="utf-8")
    verifications = tmp_path / "review_verifications.jsonl"
    verifications.write_text(
        "\n".join(json.dumps(row) for row in VERIFICATIONS), encoding="utf-8"
    )
    output = tmp_path / "manifest.jsonl"
    confirmed = tmp_path / "manifest.confirmed.jsonl"
    args = [
        "build",
        "--samples-dir",
        str(FIXTURES),
        "--catalog",
        str(catalog),
        "--verifications",
        str(verifications),
        "--output",
        str(output),
    ]
    assert main(args) == 0
    first = output.read_bytes(), confirmed.read_bytes()
    assert len(read_manifest(output)) == 21
    assert len(read_manifest(confirmed)) == 13
    assert main(args) == 0
    assert (output.read_bytes(), confirmed.read_bytes()) == first


@pytest.mark.parametrize(
    "change",
    [
        {"catalog_item_id": 999999},
        {"verification_status": "family_confirmed"},
        {"catalog_item_id": True},
        {"catalog_item_id": 919},
    ],
)
def test_invalid_or_mismatched_review_confirmation_fails(change):
    with pytest.raises(ValueError):
        build_manifest(
            FIXTURES.glob("product*.html"),
            FIXTURES.glob("review*.html"),
            CATALOG_ROWS,
            review_verifications=[{**VERIFICATIONS[0], **change}],
        )


def test_rejected_review_is_not_exported():
    rows = build_manifest(
        FIXTURES.glob("product*.html"),
        FIXTURES.glob("review*.html"),
        CATALOG_ROWS,
        review_verifications=[
            {**VERIFICATIONS[0], "verification_status": "human_rejected"},
            VERIFICATIONS[1],
        ],
    )
    assert len(confirmed_manifest(rows)) == 9
