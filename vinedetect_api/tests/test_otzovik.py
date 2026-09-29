from __future__ import annotations

import socket
from datetime import datetime
from pathlib import Path

import pytest

from app.otzovik import (
    build_manifest_rows,
    build_manual_save_queue,
    confirmed_manifest,
    parse_product_page,
    parse_review_page,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SAMPLES = REPOSITORY_ROOT / "data/otzovik/samples"
CATALOG = REPOSITORY_ROOT / "data/irecommend/catalog_items.json"
VERIFICATIONS = REPOSITORY_ROOT / "data/otzovik/review_verifications.jsonl"


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    def fail(*args, **kwargs):
        pytest.fail("Offline parsing must not open a network connection")

    monkeypatch.setattr(socket, "create_connection", fail)
    monkeypatch.setattr(socket.socket, "connect", fail)
    monkeypatch.setattr(socket.socket, "connect_ex", fail)


def test_minimal_product_page_parses_only_review_list_thumbnails():
    html = """
    <html><head>
      <link rel="canonical" href="/reviews/sample_product/">
    </head><body>
      <h1 class="product-name"><span itemprop="name">Sample wine</span></h1>
      <a class="postreview" data-pid="2034224"></a>
      <div class="reviews-counter"><span class="votes">24 отзыва</span></div>
      <img src="./hero_files/hero.jpeg">
      <div class="review-list-2">
        <div class="item" itemprop="review">
          <a class="review-title" href="/review_11.html">First review</a>
          <time itemprop="datePublished" datetime="2024-01-02"></time>
          <a class="review-thumbs">
            <img src="./product_files/11_1_t.jpeg" width="120" height="90">
            <img src="./product_files/11_2_t.jpeg">
          </a>
        </div>
        <div class="item" itemprop="review">
          <a class="review-title" href="/review_12.html">Second review</a>
          <meta itemprop="datePublished" content="03.02.2024">
        </div>
      </div>
      <div class="recommendations">
        <a class="review-title" href="/review_99.html">Wrong review</a>
      </div>
    </body></html>
    """

    product = parse_product_page(html)

    assert product.product_name == "Sample wine"
    assert product.product_url == "https://otzovik.com/reviews/sample_product/"
    assert product.product_id == "2034224"
    assert product.reviews_count == 24
    assert [review.review_id for review in product.reviews] == ["11", "12"]
    assert [review.photo_count_observed for review in product.reviews] == [2, 0]
    assert product.reviews[0].published_at == datetime(2024, 1, 2)
    assert product.reviews[0].thumbnails[0].remote_url is None
    assert (
        product.reviews[0].thumbnails[0].local_asset_path
        == "product_files/11_1_t.jpeg"
    )


def test_review_page_uses_only_current_body_full_size_images():
    html = """
    <html><head>
      <link rel="canonical" href="https://otzovik.com/review_13121047.html">
    </head><body>
      <div class="brand">TETE</div>
      <h1 class="product-name">
        <a href="/reviews/sample_product/">
          <span itemprop="name">Sample wine</span>
        </a>
      </h1>
      <img class="bigimg" src="https://cdn.example/hero.jpeg">
      <div class="review-contents" itemprop="review"
           data-rid="13121047" data-pid="2034224">
        <span class="summary" itemprop="name">Useful review</span>
        <meta itemprop="datePublished" content="2023-08-17">
        <div class="review-body description" itemprop="description">
          <p>Body <b>text</b>.</p>
          <img class="bigimg" src="./review_files/2034224_1.jpeg"
               width="600" height="800">
          <img class="smallimg" src="./review_files/ignore.jpeg">
          <img class="bigimg" src="https://cdn.example/2034224_2.jpeg"
               width="1200" height="900">
          <div class="comments">
            Comment text.
            <img class="bigimg" src="./review_files/comment.jpeg">
          </div>
          <aside>
            Advertisement.
            <img class="bigimg" src="./review_files/advertisement.jpeg">
          </aside>
        </div>
      </div>
    </body></html>
    """

    review = parse_review_page(html)

    assert review.review_id == "13121047"
    assert review.review_url == "https://otzovik.com/review_13121047.html"
    assert review.product_id == "2034224"
    assert review.product_url == "https://otzovik.com/reviews/sample_product/"
    assert review.product_name == "Sample wine"
    assert review.brand == "TETE"
    assert review.review_title == "Useful review"
    assert review.review_text == "Body text."
    assert review.published_at == datetime(2023, 8, 17)
    assert [image.filename for image in review.images] == [
        "2034224_1.jpeg",
        "2034224_2.jpeg",
    ]
    assert review.images[0].remote_url is None
    assert review.images[0].local_asset_path == "review_files/2034224_1.jpeg"
    assert review.images[0].width == 600
    assert review.images[0].height == 800
    assert review.images[1].remote_url == "https://cdn.example/2034224_2.jpeg"
    assert review.images[1].local_asset_path is None


def _require_saved_samples() -> None:
    if not (SAMPLES / "product_tete_de_cheval_sweet.html").is_file():
        pytest.skip("Saved Otzovik regression HTML is not present")


def test_saved_product_page_regression():
    _require_saved_samples()
    product = parse_product_page(
        (SAMPLES / "product_tete_de_cheval_sweet.html").read_text(
            encoding="utf-8-sig"
        )
    )

    assert product.product_name == (
        "Игристое вино сладкое белое TETE de CHEVAL sweet"
    )
    assert product.product_id == "2034224"
    assert product.reviews_count == 24
    assert len(product.reviews) == 24
    photo_counts = {
        review.review_id: review.photo_count_observed for review in product.reviews
    }
    assert photo_counts["14167925"] == 6
    assert photo_counts["13121047"] == 6
    assert photo_counts["16871457"] == 6
    assert photo_counts["12886435"] == 3


def test_saved_review_pages_have_fourteen_unique_full_size_images():
    _require_saved_samples()
    expected = {
        "review_tete_de_cheval_sweet_13121047.html": 6,
        "review_shato_taman_saperavi_9293623.html": 4,
        "review_novyi_svet_pinot_noir_10691512.html": 4,
        "review_novyi_svet_pinot_noir_1470346.html": 0,
        "review_novyi_svet_pinot_noir_2367484.html": 0,
    }
    identities = []
    for filename, count in expected.items():
        review = parse_review_page(
            (SAMPLES / filename).read_text(encoding="utf-8-sig")
        )
        assert len(review.images) == count
        identities.extend(image.image_identity for image in review.images)

    assert len(identities) == 14
    assert len(set(identities)) == 14


def test_saved_manifest_contains_only_human_confirmed_images():
    _require_saved_samples()
    if not CATALOG.is_file() or not VERIFICATIONS.is_file():
        pytest.skip("Saved catalog or human verifications are not present")
    rows = build_manifest_rows(
        sorted(SAMPLES.glob("review*.html")),
        CATALOG,
        VERIFICATIONS,
    )

    assert len(rows) == 14
    assert len(confirmed_manifest(rows)) == 14
    assert {row["verification_status"] for row in rows} == {"human_confirmed"}
    assert all("quality_status" not in row for row in rows)
    assert all(
        row["local_asset_path"].startswith("data/otzovik/samples/")
        for row in rows
    )


def test_manual_queue_uses_positive_photo_counts_and_excludes_saved_reviews():
    _require_saved_samples()
    queue = build_manual_save_queue(REPOSITORY_ROOT)
    saved = {"13121047", "9293623", "10691512", "1470346", "2367484"}

    assert queue
    assert all(row["known_photo_count"] > 0 for row in queue)
    assert all(row["already_saved"] is False for row in queue)
    assert saved.isdisjoint(row["review_id"] for row in queue)
    assert {row["catalog_item_id"] for row in queue} == {574, 1911, 2044}
    assert {
        row["source"] for row in queue
    } == {"irecommend", "otzovik"}
