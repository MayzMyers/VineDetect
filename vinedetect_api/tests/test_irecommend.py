from __future__ import annotations

import re
import socket
from datetime import date
from pathlib import Path

import pytest

from app.irecommend import parse_product_page, parse_review_page

FIXTURE = Path(__file__).parent / "fixtures" / "irecommend" / "product.html"
CDN = "https://cdn-irec.r-99.com/sites/default/files/imagecache/200i/user-images/"
FIRST_URL = (
    "https://irecommend.ru/content/"
    "govoryat-esli-khudeesh-no-pri-etom-khochetsya-vypit-spirtnogo-"
    "nuzhno-otdat-predpochtenie-suk"
)
SECOND_URL = (
    "https://irecommend.ru/content/"
    "eto-vino-trebuet-zhirnogo-myasa-i-tekh-kto-otsenit-sukhoe-presukhoe"
)


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    def fail(*args, **kwargs):
        pytest.fail("Offline parsing must not open a network connection")

    monkeypatch.setattr(socket, "create_connection", fail)
    monkeypatch.setattr(socket.socket, "connect", fail)
    monkeypatch.setattr(socket.socket, "connect_ex", fail)


@pytest.fixture
def product_html():
    return FIXTURE.read_text(encoding="utf-8")


def test_product_metadata(product_html):
    product = parse_product_page(product_html)

    assert product.product_id == "4726923"
    assert product.canonical_url == (
        "https://irecommend.ru/content/vino-fanagoriya-f-style-merlo"
    )
    assert product.title == "Вино Фанагория F-Style Мерло"
    assert product.brand == "Fanagoria / Фанагория"
    assert product.beverage_type == "Вино красное сухое"
    assert product.product_image_url == (
        "https://irecommend.ru/sites/default/files/product-images/"
        "530444/InxsynWKTtRHfdvoHeu5g.png"
    )


def test_main_reviews_and_exact_preview_urls(product_html):
    product = parse_product_page(product_html)

    assert len(product.reviews) == 2
    first, second = product.reviews
    assert [r.review_id for r in product.reviews] == ["4726974", "5024725"]
    assert all(r.product_id == product.product_id for r in product.reviews)
    assert first.review_url == FIRST_URL
    assert first.title == (
        "Говорят, если худеешь, но при этом хочется выпить спиртного, то нужно "
        "отдать предпочтение сухому вину. Кажется, я нашла то самое вино - сухое "
        'и в тоже время "легкое"'
    )
    assert first.author == "Бутафория"
    assert first.publication_date == date(2018, 5, 5)
    assert first.photos_count == 8
    assert first.preview_image_urls == [
        CDN + "530444/BAFWUWIQYYrMJxwZFxIuA.jpg",
        CDN + "530444/r76hXLhRoYO2ZmwOQGGoWQ.jpg",
        CDN + "530444/wVBptK42TeZ4JkTLgbBQ.jpg",
    ]
    assert second.review_url == SECOND_URL
    assert second.title == (
        "Это вино требует жирного мяса и тех, кто оценит сухое-пресухое!"
    )
    assert second.author == "La_Bohème"
    assert second.publication_date == date(2018, 9, 22)
    assert second.photos_count == 16
    assert second.preview_image_urls == [
        CDN + "280391/jPbUrun9LPnA9nlSPJlWiQ.jpeg",
        CDN + "280391/lHzP3zyVsd4Jlsf2yP6T1w.jpeg",
        CDN + "280391/qeuU6GaNSUh8XsAxctzp2Q.jpeg",
    ]


def test_recommendations_excluded_even_with_same_product_id(product_html):
    assert "Смотрите также" in product_html
    assert 'data-nid="9140838"' in product_html
    # Give recommendations both the main teaser class and the current product ID.
    # They still must not enter the result from outside the main review list.
    html = product_html.replace('data-product-id="156562"', 'data-product-id="4726923"')
    html = html.replace(
        'class="smTeaser plate teaser-item',
        'class="smTeaser plate reviews-list-item teaser-item',
    )

    assert [r.review_id for r in parse_product_page(html).reviews] == [
        "4726974",
        "5024725",
    ]


@pytest.mark.parametrize(
    ("old", "new", "error"),
    [
        ('data-product-id="4726923"', 'data-product-id="999"', "belongs to product"),
        ('data-product-id="4726923"', "", "review_product_id"),
        ('data-product-id="4726923"', 'data-product-id="bad"', "review_product_id"),
        ('data-nid="4726974"', 'data-nid=""', "review_id"),
        ('data-photos-count="8"', 'data-photos-count="-1"', "photos_count"),
        ('data-photos-count="8"', "", "photos_count"),
        ("05.05.2018", "31.02.2018", "day is out of range"),
        ('rel="canonical"', 'rel="alternate"', "canonical_url"),
        ('id="product-4726923"', 'id="product-bad"', "product_id"),
        ('id="product-ttl-4726923"', 'id="product-ttl-999"', "title"),
        ("view-referenced-nodes", "unrelated-view", "view-referenced-nodes"),
    ],
)
def test_invalid_required_data_is_rejected(product_html, old, new, error):
    assert old in product_html
    html = product_html.replace(old, new, 1)

    with pytest.raises(ValueError, match=error):
        parse_product_page(html)


def test_only_local_preview_sources_are_ignored(product_html):
    html = re.sub(r' data-original="[^"]*"', "", product_html)

    product = parse_product_page(html)

    assert [r.preview_image_urls for r in product.reviews] == [[], []]
    assert [r.photos_count for r in product.reviews] == [8, 16]


def test_remote_src_fallback_and_relative_links(product_html):
    html = product_html.replace("https://irecommend.ru/content/", "/content/")
    html = html.replace("https://cdn-irec.r-99.com/", "//cdn-irec.r-99.com/")
    # Simulate an unsaved image whose only remote URL is src.
    html = re.sub(r' src="[^"]*"', "", html)
    html = html.replace("data-original=", "src=")

    product = parse_product_page(html)

    assert product.reviews[0].review_url == FIRST_URL
    assert product.reviews[0].preview_image_urls[0] == (
        CDN + "530444/BAFWUWIQYYrMJxwZFxIuA.jpg"
    )
    assert all(len(r.preview_image_urls) == 3 for r in product.reviews)


def test_text_entities_and_nested_markup(product_html):
    html = product_html.replace(
        ">Бутафория</a>", ">  Бутафория &amp; <b>друг</b>  </a>"
    )
    html = html.replace('время "легкое"</div>', "время &quot;легкое&quot;</div>")

    product = parse_product_page(html)

    assert product.reviews[0].author == "Бутафория & друг"
    assert product.reviews[0].title.endswith('время "легкое"')


def test_optional_product_metadata_can_be_absent(product_html):
    html = product_html.replace('itemprop="brand"', 'itemprop="missing"')
    html = html.replace("vid-38", "missing-type")
    html = html.replace('itemprop="contentUrl"', 'itemprop="missing"')

    product = parse_product_page(html)

    assert product.brand is None
    assert product.beverage_type is None
    assert product.product_image_url is None
    assert len(product.reviews) == 2


def test_empty_main_list_does_not_fall_back_to_recommendations(product_html):
    html, count = re.subn(
        r'<ul class="list-comments">.*?</ul>',
        '<ul class="list-comments"></ul>',
        product_html,
        count=1,
        flags=re.DOTALL,
    )
    assert count == 1

    assert parse_product_page(html).reviews == []


def test_missing_product_is_rejected():
    with pytest.raises(ValueError, match="site-product-header-content-wrapper"):
        parse_product_page("<html><body>Unavailable</body></html>")


REVIEW_FIXTURE = FIXTURE.with_name("review.html")
REVIEW_BODY_START = '<div class="description hasinlineimage" itemprop="reviewBody">'
REVIEW_BODY_AFTER = '        <div class="hasinlineimage">'
REVIEW_END = "<!-- /#node-myreview-4726974 -->"
REVIEW_FILENAMES = {
    "BAFWUWIQYYrMJxwZFxIuA.jpg",
    "MuaBXLVnfQ0wHa2gxR2Qrg.jpg",
    "T6voyHFMCJnBEyu4ylr95A.jpg",
    "Y8o9J7inOcHyS9DH9QHQ.jpg",
    "havdtfLpsxOdDOsTbq2GA.jpg",
    "qV76OO3HgDm3DlZgZbKo0g.jpg",
    "r76hXLhRoYO2ZmwOQGGoWQ.jpg",
    "wVBptK42TeZ4JkTLgbBQ.jpg",
}


@pytest.fixture
def review_html():
    return REVIEW_FIXTURE.read_text(encoding="utf-8")


def replace_review_body(html, body):
    before, rest = html.split(REVIEW_BODY_START, 1)
    _, after = rest.split(REVIEW_BODY_AFTER, 1)
    return before + REVIEW_BODY_START + body + "</div>\n" + REVIEW_BODY_AFTER + after


def test_review_metadata(review_html):
    review = parse_review_page(review_html)

    assert review.review_id == "4726974"
    assert review.product_id == "4726923"
    assert review.canonical_url == FIRST_URL
    assert review.product_title == "Вино Фанагория F-Style Мерло"
    assert review.title == (
        "Говорят, если худеешь, но при этом хочется выпить спиртного, то нужно "
        "отдать предпочтение сухому вину. Кажется, я нашла то самое вино - сухое "
        'и в тоже время "легкое"'
    )
    assert review.author == "Бутафория"
    assert review.publication_date == date(2018, 5, 5)


def test_review_full_text_and_year_candidates(review_html):
    review = parse_review_page(review_html)

    assert review.full_text
    assert review.full_text.startswith("Я честно худела не пила цельных два месяца,")
    assert review.full_text.endswith(
        "Вино красное сухое Фанагория Каберне Цимлянский черный"
    )
    assert "F-style Merlot 2016." in review.full_text
    assert "Сорта: мерло Объем 750 мл Алкоголь 13%" in review.full_text
    assert review.full_text.count("Я честно худела") == 1
    assert "<" not in review.full_text
    assert review.full_text == " ".join(review.full_text.split())
    assert "Показать цитату" not in review.full_text
    assert "Смотрите также" not in review.full_text
    assert "Опубликовано" not in review.full_text
    assert review.year_candidates == {"2016"}
    assert str(review.publication_date.year) not in review.year_candidates


def test_review_text_comes_only_from_body_and_keeps_inline_punctuation(review_html):
    html = replace_review_body(
        review_html,
        "<p>Только <b>этот</b>&nbsp;текст.</p><p>Год 2011.</p>"
        "<p>Слова<br>после<br/>переноса.</p>"
        "<script>noise 2091</script><style>noise 2092</style>"
        "<noscript>Повтор текста 2093</noscript>"
        '<div class="quote-container-button-wrapper">Показать цитату 2094</div>',
    )
    # These are still inside reviewBlock, but outside reviewBody.
    html = html.replace(
        '<div class="extraInfo"></div>', '<div class="extraInfo">Сосед 2095</div>'
    )
    review = parse_review_page(html)

    assert review.full_text == "Только этот текст. Год 2011. Слова после переноса."
    assert review.year_candidates == {"2011"}
    assert review.images == []


@pytest.mark.parametrize("location", ["product_title", "review_title", "body"])
def test_year_candidates_include_only_allowed_text_sources(review_html, location):
    html = replace_review_body(review_html, "<p>Без указания года.</p>")
    if location == "product_title":
        html = html.replace(
            'itemprop="name">Вино Фанагория F-Style Мерло</span>',
            'itemprop="name">Вино Фанагория F-Style Мерло 2009</span>',
            1,
        )
    elif location == "review_title":
        html = html.replace(
            'itemprop="url">Говорят,', 'itemprop="url">2009 Говорят,', 1
        )
    else:
        html = replace_review_body(html, "<p>2009 год</p>")

    assert parse_review_page(html).year_candidates == {"2009"}


def test_publication_date_is_not_a_year_candidate(review_html):
    html = replace_review_body(review_html, "<p>Без указания года.</p>")
    html = html.replace("2018-05-05T22:13:18+02:00", "2025-06-07T22:13:18+02:00")
    review = parse_review_page(html)

    assert review.publication_date == date(2025, 6, 7)
    assert review.year_candidates == set()


def test_eight_unique_review_images_and_observed_variants(review_html):
    review = parse_review_page(review_html)

    assert len(review.images) == 8
    assert {image.filename for image in review.images} == REVIEW_FILENAMES
    assert len({image.image_key for image in review.images}) == 8
    assert {image.image_key for image in review.images} == {
        f"user-images/530444/{filename}" for filename in REVIEW_FILENAMES
    }
    for image in review.images:
        assert len(image.url_variants) == 3
        assert len(set(image.url_variants)) == 3
        assert image.preferred_url in image.url_variants
        assert "/imagecache/copyright1/" in image.preferred_url
        assert "/imagecache/200i/" not in image.preferred_url
        for url in image.url_variants:
            assert url in review_html
            assert "user-images/280391/" not in url
            assert "user-images/32155/" not in url
            assert "/product-images/" not in url
            assert "/imagecache/" in url  # No invented original URL.


def test_thumbnail_host_and_cache_variants_are_deduplicated(review_html):
    filename = "BAFWUWIQYYrMJxwZFxIuA.jpg"
    small_url = CDN + "530444/" + filename
    # Put a thumbnail first, so preference cannot depend on encounter order.
    thumbnail = (
        '<a data-gallery="gallery_node4726974field_imgf1">'
        f'<img src="{small_url}"><img data-original="{small_url}"></a>'
    )
    html = review_html.replace(REVIEW_BODY_START, REVIEW_BODY_START + thumbnail, 1)
    review = parse_review_page(html)

    assert len(review.images) == 8
    image = next(image for image in review.images if image.filename == filename)
    assert len(image.url_variants) == 4
    assert small_url in image.url_variants
    assert "/copyright1/" in image.preferred_url
    assert image.preferred_url in review_html


@pytest.mark.parametrize("cache", ["copyright", "200i"])
def test_preferred_url_uses_available_variants_without_inventing_originals(
    review_html, cache
):
    html = review_html.replace("/copyright1/", f"/{cache}/")
    if cache == "200i":
        html = html.replace("/copyright/", "/200i/")
    review = parse_review_page(html)

    assert len(review.images) == 8
    for image in review.images:
        assert f"/imagecache/{cache}/" in image.preferred_url
        assert image.preferred_url in html


def test_recommendations_comments_and_sidebar_do_not_change_result(review_html):
    original = parse_review_page(review_html)
    before, after = review_html.split(REVIEW_END, 1)
    assert "Смотрите также" in after
    assert "user-images/280391/" in after
    assert "user-images/32155/" in after
    # Other reviews by the SAME author also must be excluded.
    assert "user-images/530444/f2gvnbHgtOlb1XDL77hDcQ.jpg" in after
    after = re.sub(r"\b(?:19|20)\d{2}\b", "2099", after)
    after = after.replace("user-images/", "user-images/999/")
    after = after.replace("Смотрите также", "Рекомендация 2098")
    noise = (
        '<aside class="review-node"><div class="reviewBlock">'
        '<a class="review-summary" href="https://irecommend.ru/content/other">2097</a>'
        '<div itemprop="reviewBody">Чужой отзыв 2096</div>'
        '<a data-gallery="gallery_node4726974field_imgf1">'
        '<img src="https://irecommend.ru/sites/default/files/imagecache/copyright1/'
        'user-images/530444/unrelated.jpg"></a></div></aside>'
    )
    html = before.replace(
        '<div class="review-node"', noise + '<div class="review-node"', 1
    )
    assert parse_review_page(html + REVIEW_END + after) == original
    assert parse_review_page(before + "</body></html>") == original


def test_foreign_gallery_inside_review_is_excluded(review_html):
    extra = (
        '<a data-gallery="gallery_node999field_imgf1">'
        '<img src="https://irecommend.ru/sites/default/files/imagecache/copyright1/'
        'user-images/32155/foreign.jpg"></a>'
        '<img src="https://irecommend.ru/sites/default/files/product-images/32155/p.jpg">'
    )
    html = review_html.replace(REVIEW_BODY_START, REVIEW_BODY_START + extra, 1)

    assert parse_review_page(html).images == parse_review_page(review_html).images


def test_product_id_is_optional_and_not_inferred_from_recommendations(review_html):
    html = review_html.replace('id="product-ttl-4726923"', "")
    html = html.replace('id="product-4726923"', "")
    review = parse_review_page(html)

    assert review.product_id is None
    assert review.product_title == "Вино Фанагория F-Style Мерло"


@pytest.mark.parametrize(
    ("old", "new", "error"),
    [
        ('itemprop="reviewBody"', 'itemprop="missing"', "reviewBody"),
        ('itemprop="datePublished"', 'itemprop="missing"', "datePublished"),
        ('itemprop="author"', 'itemprop="missing"', "author"),
        ('class="reviewBlock "', 'class="missing"', "main review"),
        ('rel="canonical"', 'rel="alternate"', "canonical"),
        ('id="product-4726923"', 'id="product-999"', "Conflicting"),
        ('"nid":"4726974"', '"nid":"bad"', "review_id"),
        ('"type":"review"', '"type":"product"', "do not describe a review"),
    ],
)
def test_review_required_metadata_fails_closed(review_html, old, new, error):
    assert old in review_html
    with pytest.raises(ValueError, match=error):
        parse_review_page(review_html.replace(old, new, 1))
