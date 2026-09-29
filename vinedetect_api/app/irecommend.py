"""Parse saved IRecommend product/review HTML without network or database access."""

from __future__ import annotations

import json
import re
from copy import deepcopy
from dataclasses import dataclass
from datetime import date, datetime
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit
from xml.etree.ElementTree import Element, SubElement

from app.matching import extract_years

_BASE_URL = "https://irecommend.ru/"
_VOID_TAGS = frozenset(
    "area base br col embed hr img input link meta param source track wbr".split()
)


@dataclass(frozen=True)
class IRecommendReviewTeaser:
    review_id: str
    product_id: str
    review_url: str
    title: str
    author: str
    publication_date: date
    photos_count: int
    preview_image_urls: list[str]


@dataclass(frozen=True)
class IRecommendProduct:
    product_id: str
    canonical_url: str
    title: str
    brand: str | None
    beverage_type: str | None
    product_image_url: str | None
    reviews: list[IRecommendReviewTeaser]


class _SavedHTMLParser(HTMLParser):
    """Build a small searchable tree from browser-saved HTML, not XML.

    HTMLParser handles entities and script text without executing scripts or
    loading resources. Void elements must not become parents of following nodes.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Element("document")
        self._stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = SubElement(self._stack[-1], tag, {k: v or "" for k, v in attrs})
        if tag not in _VOID_TAGS:
            self._stack.append(node)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self._stack) - 1, 0, -1):
            if self._stack[index].tag == tag:
                del self._stack[index:]
                break

    def handle_data(self, data: str) -> None:
        parent = self._stack[-1]
        if len(parent):
            child = parent[-1]
            child.tail = (child.tail or "") + data
        else:
            parent.text = (parent.text or "") + data


def _has_class(node: Element, name: str) -> bool:
    return name in (node.get("class") or "").split()


def _by_class(root: Element, name: str) -> Element:
    for node in root.iter():
        if _has_class(node, name):
            return node
    raise ValueError(f"Missing IRecommend element: {name}")


def _text(node: Element) -> str:
    return " ".join("".join(node.itertext()).split())


def _required(value: str | None, field: str) -> str:
    if not value or not value.strip():
        raise ValueError(f"Missing IRecommend field: {field}")
    return value.strip()


def _number(value: str | None, field: str) -> str:
    value = _required(value, field)
    if not re.fullmatch(r"[0-9]+", value):
        raise ValueError(f"Invalid IRecommend {field}: {value!r}")
    return value


def _remote_url(value: str | None) -> str | None:
    # Saved src values such as ./Page_files/photo.jpg must never become fake URLs.
    if not value:
        return None
    value = value.strip()
    if not value.startswith(("https://", "http://", "/")):
        return None
    url = urljoin(_BASE_URL, value)
    parsed = urlsplit(url)
    return url if parsed.scheme in {"http", "https"} and parsed.netloc else None


def _parse_review(node: Element, product_id: str) -> IRecommendReviewTeaser:
    review_id = _number(node.get("data-nid"), "review_id")
    review_product_id = _number(node.get("data-product-id"), "review_product_id")
    if review_product_id != product_id:
        raise ValueError(
            f"Review {review_id} belongs to product {review_product_id}, "
            f"expected {product_id}"
        )
    link = _by_class(node, "reviewTextSnippet")
    preview_urls = []
    for image in _by_class(node, "reviewImages").iter("img"):
        url = _remote_url(image.get("data-original")) or _remote_url(image.get("src"))
        if url and url not in preview_urls:
            preview_urls.append(url)
    return IRecommendReviewTeaser(
        review_id=review_id,
        product_id=review_product_id,
        review_url=_required(_remote_url(link.get("href")), "review_url"),
        title=_required(_text(_by_class(link, "reviewTitle")), "review_title"),
        author=_required(_text(_by_class(node, "authorName")), "author"),
        publication_date=datetime.strptime(
            _text(_by_class(node, "created")), "%d.%m.%Y"
        ).date(),
        photos_count=int(_number(node.get("data-photos-count"), "photos_count")),
        preview_image_urls=preview_urls,
    )


def parse_product_page(html: str) -> IRecommendProduct:
    """Parse HTML text supplied by the caller; preserve the visible review order.

    Only teasers inside the main referenced-nodes list are considered. Missing
    required fields or a review/product ID mismatch raise ValueError rather than
    returning potentially misattributed UGC. Optional product metadata is None
    when absent. Image URLs are taken from remote HTML attributes; local saved
    paths are ignored and full-size review URLs are not guessed.
    """
    parser = _SavedHTMLParser()
    parser.feed(html)
    parser.close()
    root = parser.root
    product = _by_class(root, "site-product-header-content-wrapper")
    product_id = _number(
        (product.get("id") or "").removeprefix("product-"), "product_id"
    )
    title = next(
        (node for node in root.iter() if node.get("id") == f"product-ttl-{product_id}"),
        None,
    )
    canonical_url = next(
        (
            _remote_url(node.get("href"))
            for node in root.iter("link")
            if "canonical" in (node.get("rel") or "").split()
        ),
        None,
    )
    brand = beverage_type = product_image_url = None
    for node in product.iter():
        if node.get("itemprop") == "brand":
            name = next(
                (child for child in node.iter() if child.get("itemprop") == "name"),
                None,
            )
            if name is not None:
                brand = _text(name) or None
        if _has_class(node, "vid-38"):
            beverage_type = " ".join(_text(a) for a in node.iter("a")) or None
        if node.tag == "a" and node.get("itemprop") == "contentUrl":
            product_image_url = _remote_url(node.get("href"))

    main_list = _by_class(_by_class(root, "view-referenced-nodes"), "list-comments")
    reviews = [
        _parse_review(node, product_id)
        for node in main_list.iter()
        if _has_class(node, "reviews-list-item")
    ]
    return IRecommendProduct(
        product_id=product_id,
        canonical_url=_required(canonical_url, "canonical_url"),
        title=_required(_text(title) if title is not None else None, "title"),
        brand=brand,
        beverage_type=beverage_type,
        product_image_url=product_image_url,
        reviews=reviews,
    )


@dataclass(frozen=True)
class IRecommendReviewImage:
    image_key: str
    filename: str
    preferred_url: str
    url_variants: list[str]


@dataclass(frozen=True)
class IRecommendReview:
    review_id: str
    canonical_url: str
    product_id: str | None
    product_title: str
    title: str
    author: str
    publication_date: date
    full_text: str
    year_candidates: set[str]
    vintage_candidates: set[str]
    images: list[IRecommendReviewImage]


def _one(nodes: list[Element], field: str) -> Element:
    if len(nodes) != 1:
        raise ValueError(f"Expected one IRecommend {field}, found {len(nodes)}")
    return nodes[0]


def _by_itemprop(root: Element, name: str) -> Element:
    return _one(
        [node for node in root.iter() if name in (node.get("itemprop") or "").split()],
        name,
    )


def _review_id_from_head(head: Element) -> str:
    # Read only the page's structured settings, never evaluate JavaScript.
    for script in head.iter("script"):
        source = script.text or ""
        match = re.search(r"\bDrupal\.settings\s*=\s*", source)
        if match is None:
            continue
        settings, _ = json.JSONDecoder().raw_decode(source[match.end() :])
        site = settings.get("site", {})
        if site.get("type") != "review":
            raise ValueError("IRecommend page settings do not describe a review")
        return _number(str(site.get("nid") or ""), "review_id")
    raise ValueError("Missing IRecommend review page settings")


def _review_body_text(body: Element) -> str:
    # Keep inline punctuation intact, but separate paragraphs, lists and line breaks.
    block_tags = {
        "p",
        "div",
        "blockquote",
        "ul",
        "ol",
        "li",
        "br",
        "hr",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "table",
        "tr",
        "td",
        "th",
    }
    ignored_tags = {"script", "style", "noscript", "svg"}
    chunks: list[str] = []

    def visit(node: Element) -> None:
        if node.tag in ignored_tags or _has_class(
            node, "quote-container-button-wrapper"
        ):
            return
        if node.tag in block_tags:
            chunks.append(" ")
        chunks.append(node.text or "")
        for child in node:
            visit(child)
            chunks.append(child.tail or "")
        if node.tag in block_tags:
            chunks.append(" ")

    visit(body)
    return " ".join("".join(chunks).split())


def image_url_priority(url: str) -> int:
    """Rank observed variants only; lower ranks are preferred."""
    parsed = urlsplit(url)
    if "/imagecache/200i/" in parsed.path:
        return 4
    if parsed.hostname == "cdn-irec.r-99.com":
        if "/imagecache/copyright1/" in parsed.path:
            return 0
        if "/imagecache/copyright/" in parsed.path:
            return 1
    if parsed.hostname == "irecommend.ru" and "/imagecache/copyright1/" in parsed.path:
        return 2
    return 3


def _review_images(review: Element, review_id: str) -> list[IRecommendReviewImage]:
    variants: dict[str, list[str]] = {}
    for gallery in review.iter("a"):
        # This also excludes the product photo, avatars and other authors' teasers.
        if not re.fullmatch(
            rf"gallery_node{re.escape(review_id)}field_imgf[0-9]+",
            gallery.get("data-gallery") or "",
        ):
            continue
        for node in gallery.iter():
            attrs = (
                ("href", "data-src")
                if node.tag == "a"
                else (("data-original", "src") if node.tag == "img" else ())
            )
            for attr in attrs:
                url = _remote_url(node.get(attr))
                if url is None:
                    continue
                path = urlsplit(url).path
                identity = re.fullmatch(
                    r"/sites/default/files/(?:imagecache/[^/]+/)?"
                    r"(user-images/[0-9]+/[^/]+)",
                    path,
                )
                if identity is None:
                    continue
                key = identity.group(1)
                urls = variants.setdefault(key, [])
                if url not in urls:
                    urls.append(url)

    return [
        IRecommendReviewImage(
            image_key=key,
            filename=key.rsplit("/", 1)[1],
            preferred_url=min(urls, key=image_url_priority),
            url_variants=urls,
        )
        for key, urls in variants.items()
    ]


def _review_images_from_scopes(
    scopes: list[Element], review_id: str
) -> list[IRecommendReviewImage]:
    variants: dict[str, list[str]] = {}
    filenames = {}
    for scope in scopes:
        for image in _review_images(scope, review_id):
            filenames[image.image_key] = image.filename
            urls = variants.setdefault(image.image_key, [])
            for url in image.url_variants:
                if url not in urls:
                    urls.append(url)
    return [
        IRecommendReviewImage(
            image_key=key,
            filename=filenames[key],
            preferred_url=min(urls, key=image_url_priority),
            url_variants=urls,
        )
        for key, urls in variants.items()
    ]


def extract_vintage_candidates(text: str) -> set[str]:
    """Prefer explicit harvest/vintage phrases; unrelated years remain raw evidence."""
    pattern = re.compile(
        r"\b(?:(?:год\s+)?урожа[йя](?:\s*,?\s*в\s+нашем\s+случае)?|"
        r"винтаж(?:а)?|vintage)\s*[:–—,-]?\s*"
        r"((?:19|20)[0-9]{2})\b(?![./][0-9])",
        re.IGNORECASE,
    )
    excluded = re.compile(
        r"наград|медал|конкурс|award|competition|розлив|разлив|bottl|публикац",
        re.IGNORECASE,
    )
    years = set()
    for clause in re.split(r"(?<![0-9])\.|\.(?![0-9])|[!?;\n]", text):
        for match in pattern.finditer(clause):
            # Avoid names of awards/events such as 'конкурс Vintage 2016'.
            before = clause[: match.start()].rsplit(",", 1)[-1][-60:]
            after = clause[match.end() :].split(",", 1)[0][:35]
            if not excluded.search(before) and not excluded.search(after):
                years.add(match.group(1))
    return years


def _review_vintage_text(body: Element) -> str:
    """Exclude quoted award lists while retaining the review author's prose."""
    cleaned = deepcopy(body)
    award_context = re.compile(
        r"наград|медал|конкурс|award|competition|дегустац",
        re.IGNORECASE,
    )
    for parent in cleaned.iter():
        for child in list(parent):
            if child.tag in {"blockquote", "ul", "ol"} and award_context.search(
                _text(child)
            ):
                parent.remove(child)
    return _review_body_text(cleaned)


def parse_review_page(html: str) -> IRecommendReview:
    """Parse one saved review page without I/O.

    The canonical URL identifies the main reviewBlock within review-node.
    Years come only from the review title and reviewBody, not publication
    metadata. Images belong to this review's explicitly identified galleries.
    IDs/required metadata must be unambiguous; absent product IDs return None.
    """
    parser = _SavedHTMLParser()
    parser.feed(html)
    parser.close()
    head = _one(list(parser.root.iter("head")), "head")
    canonical = _one(
        [
            node
            for node in head.iter("link")
            if "canonical" in (node.get("rel") or "").split()
        ],
        "canonical link",
    )
    canonical_url = _required(_remote_url(canonical.get("href")), "canonical_url")
    review_id = _review_id_from_head(head)

    candidates = []
    for container in parser.root.iter():
        if not _has_class(container, "review-node"):
            continue
        # In the saved DOM reviewBlock is a direct child, unlike related teasers.
        for node in container:
            if _has_class(node, "reviewBlock") and any(
                _has_class(link, "review-summary")
                and _remote_url(link.get("href")) == canonical_url
                for link in node.iter("a")
            ):
                candidates.append((container, node))
    if len(candidates) != 1:
        raise ValueError(
            f"Expected one IRecommend main review, found {len(candidates)}"
        )
    container, review = candidates[0]
    body = _by_itemprop(review, "reviewBody")
    product_header = _one(
        [node for node in container if _has_class(node, "productInfo")],
        "review productInfo",
    )
    product_heading = _one(list(product_header.iter("h1")), "product heading")
    product_name = _by_itemprop(product_heading, "name")
    product_title = _required(_text(product_name), "product_title")
    product_ids = set()
    for node in product_header.iter():
        for prefix in ("product-ttl-", "product-"):
            value = node.get("id") or ""
            # product-ttl- must be checked before the shorter product- prefix.
            if value.startswith(prefix):
                product_ids.add(_number(value[len(prefix) :], "product_id"))
                break
    if len(product_ids) > 1:
        raise ValueError("Conflicting IRecommend review product IDs")
    title = _required(_text(_by_class(review, "reviewTitle")), "review_title")
    full_text = _required(_review_body_text(body), "reviewBody")
    image_galleries = [
        node
        for node in review.iter()
        if (_has_class(node, "fieldgroup") and _has_class(node, "group-images"))
        or _has_class(node, "field-field-imgf1")
    ]
    published = _by_itemprop(review, "datePublished")
    return IRecommendReview(
        review_id=review_id,
        canonical_url=canonical_url,
        product_id=next(iter(product_ids), None),
        product_title=product_title,
        title=title,
        author=_required(_text(_by_itemprop(review, "author")), "author"),
        publication_date=datetime.fromisoformat(
            _required(published.get("content"), "datePublished")
        ).date(),
        full_text=full_text,
        year_candidates=extract_years(" ".join((product_title, title, full_text))),
        vintage_candidates=extract_vintage_candidates(
            "\n".join((title, _review_vintage_text(body)))
        ),
        images=_review_images_from_scopes([body, *image_galleries], review_id),
    )
