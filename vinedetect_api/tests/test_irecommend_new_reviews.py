from __future__ import annotations

import re
from pathlib import Path

from app.irecommend import (
    extract_vintage_candidates,
    parse_product_page,
    parse_review_page,
)
from app.irecommend_matching import find_irecommend_matches

FIXTURES = Path(__file__).parent / "fixtures" / "irecommend" / "new_reviews"
REVIEWS = {
    "review_cru_lermont_saperavi_8912162.html": (
        "8912162",
        "4745085",
        8,
        {"2020"},
        202,
    ),
    "review_cru_lermont_saperavi_4745086.html": (
        "4745086",
        "4745085",
        14,
        set(),
        202,
    ),
    "review_cru_lermont_pinot_noir_10021562.html": (
        "10021562",
        "463459",
        10,
        {"2022"},
        201,
    ),
    "review_cru_lermont_cabernet_sauvignon_10584749.html": (
        "10584749",
        "9297089",
        12,
        {"2021"},
        197,
    ),
    "review_cru_lermont_cabernet_sauvignon_9297105.html": (
        "9297105",
        "9297089",
        3,
        set(),
        197,
    ),
}
PRODUCTS = {
    "4745085": "product_cru_lermont_saperavi.html",
    "463459": "product_cru_lermont_pinot_noir.html",
    "9297089": "product_cru_lermont_cabernet_sauvignon.html",
}
CATALOG = [
    {
        "id": 197,
        "official_slug": (
            "fanagoriya-cru-lermont-cabernet-sauvignon-kaberne-sovinon-krasnoe-suhoe-13"
        ),
        "title": "Cru Lermont Cabernet Sauvignon",
        "winery": "Фанагория",
        "category": "Красное",
        "grapes": "Каберне Совиньон",
    },
    {
        "id": 201,
        "official_slug": (
            "fanagoriya-cru-lermont-pinot-noir-pino-nuar-krasnoe-suhoe-13"
        ),
        "title": "Cru Lermont Pinot Noir",
        "winery": "Фанагория",
        "category": "Красное",
        "grapes": "Пино Нуар",
    },
    {
        "id": 202,
        "official_slug": ("fanagoriya-cru-lermont-saperavi-saperavi-krasnoe-suhoe-135"),
        "title": "Cru Lermont Saperavi",
        "winery": "Фанагория",
        "category": "Красное",
        "grapes": "Саперави",
    },
]


def test_five_new_reviews_have_47_images_and_exact_skus():
    products = {
        product_id: parse_product_page((FIXTURES / name).read_text(encoding="utf-8"))
        for product_id, name in PRODUCTS.items()
    }
    identities = set()
    for name, (review_id, product_id, count, vintages, catalog_id) in REVIEWS.items():
        review = parse_review_page((FIXTURES / name).read_text(encoding="utf-8"))
        assert (review.review_id, review.product_id) == (review_id, product_id)
        assert len(review.images) == count
        assert review.vintage_candidates == vintages
        identities.update(image.image_key for image in review.images)
        result = find_irecommend_matches(
            products[product_id], CATALOG, year_candidates=review.vintage_candidates
        )
        assert result.status == "matched"
        assert result.candidates[0].catalog_item_id == catalog_id
        assert result.candidates[0].score == 1
        assert result.candidates[0].evidence["discriminative_score"] == 1
        assert result.candidates[0].evidence["grape_score"] == 1
    assert len(identities) == 47


def test_pinot_gallery_is_scoped_to_current_review():
    path = FIXTURES / "review_cru_lermont_pinot_noir_10021562.html"
    html = path.read_text(encoding="utf-8")
    review = parse_review_page(html)
    identities = {image.image_key for image in review.images}
    assert "user-images/2415173/aKw2CMxVPyQszVudRQQ.jpg" in identities
    assert "user-images/2415173/ZFw7tEiyKwsPdoiwXxrfCA.jpg" in identities
    fieldset = re.search(r'<fieldset[^>]*class="[^"]*group-images[^"]*"[^>]*>', html)
    assert fieldset
    noise = (
        '<a data-gallery="gallery_node999field_imgf1">'
        '<img src="https://irecommend.ru/sites/default/files/imagecache/copyright1/'
        'user-images/999999/foreign.jpg"></a>'
    )
    polluted = html[: fieldset.end()] + noise + html[fieldset.end() :]
    polluted = polluted.replace("</body>", "<p>Комментарий: год урожая 2099</p></body>")
    assert parse_review_page(polluted) == review


def test_vintage_context_forms():
    assert extract_vintage_candidates("урожая 2022 года") == {"2022"}
    assert extract_vintage_candidates("вино урожая 2020 года") == {"2020"}
    assert extract_vintage_candidates("год урожая 2021-ый") == {"2021"}
