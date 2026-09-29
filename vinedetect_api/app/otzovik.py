"""Parse saved Otzovik HTML and build source-specific offline UGC artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urljoin, urlsplit
from xml.etree.ElementTree import Element, SubElement

_BASE_URL = "https://otzovik.com/"
_VOID_TAGS = frozenset(
    "area base br col embed hr img input link meta param source track wbr".split()
)
_VERIFICATION_STATUSES = {"human_confirmed", "human_rejected"}


@dataclass(frozen=True)
class OtzovikImage:
    image_identity: str
    filename: str
    local_asset_path: str | None
    remote_url: str | None
    width: int | None
    height: int | None


@dataclass(frozen=True)
class OtzovikReviewTeaser:
    review_id: str
    review_url: str
    title: str
    published_at: datetime | None
    photo_count_observed: int
    thumbnails: list[OtzovikImage]


@dataclass(frozen=True)
class OtzovikProduct:
    product_name: str
    product_url: str
    product_id: str
    reviews_count: int
    reviews: list[OtzovikReviewTeaser]


@dataclass(frozen=True)
class OtzovikReview:
    review_id: str
    review_url: str
    product_id: str
    product_url: str
    product_name: str
    brand: str | None
    published_at: datetime | None
    review_title: str
    review_text: str
    images: list[OtzovikImage]


class _SavedHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Element("document")
        self._stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = SubElement(
            self._stack[-1],
            tag,
            {key: value or "" for key, value in attrs},
        )
        if tag not in _VOID_TAGS:
            self._stack.append(node)

    def handle_startendtag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        SubElement(self._stack[-1], tag, {key: value or "" for key, value in attrs})

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


def _parse_html(html: str) -> Element:
    parser = _SavedHTMLParser()
    parser.feed(html)
    parser.close()
    return parser.root


def _classes(node: Element) -> set[str]:
    return set((node.get("class") or "").split())


def _has_class(node: Element, name: str) -> bool:
    return name in _classes(node)


def _by_class(root: Element, name: str) -> Element:
    nodes = [node for node in root.iter() if _has_class(node, name)]
    if not nodes:
        raise ValueError(f"Missing Otzovik element: {name}")
    return nodes[0]


def _one(nodes: Sequence[Element], field: str) -> Element:
    if len(nodes) != 1:
        raise ValueError(f"Expected one Otzovik {field}, found {len(nodes)}")
    return nodes[0]


def _text(node: Element) -> str:
    return " ".join("".join(node.itertext()).split())


def _required(value: str | None, field: str) -> str:
    if not value or not value.strip():
        raise ValueError(f"Missing Otzovik field: {field}")
    return value.strip()


def _numeric(value: str | None, field: str) -> str:
    value = _required(value, field)
    if not value.isdigit():
        raise ValueError(f"Invalid Otzovik {field}: {value!r}")
    return value


def _itemprop(root: Element, name: str) -> list[Element]:
    return [
        node
        for node in root.iter()
        if name in (node.get("itemprop") or "").split()
    ]


def _remote_url(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    if not value.startswith(("http://", "https://", "/")):
        return None
    url = urljoin(_BASE_URL, value)
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return url


def _local_path(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip().replace("\\", "/")
    if value.startswith(("http://", "https://", "/", "data:")):
        return None
    while value.startswith("./"):
        value = value[2:]
    return PurePosixPath(value).as_posix() if value else None


def _dimension(value: str | None) -> int | None:
    if not value or not value.isdigit():
        return None
    parsed = int(value)
    return parsed if parsed > 0 else None


def _image_identity(filename: str) -> str:
    return re.sub(r"_t(?=\.[^.]+$)", "", filename, flags=re.IGNORECASE)


def _image(node: Element) -> OtzovikImage:
    values = [node.get(name) for name in ("data-original", "data-src", "src")]
    remote_url = next(
        (_remote_url(value) for value in values if _remote_url(value)),
        None,
    )
    local_asset_path = next(
        (_local_path(value) for value in values if _local_path(value)), None
    )
    source_path = local_asset_path or (
        urlsplit(remote_url).path if remote_url else None
    )
    filename = _required(
        PurePosixPath(source_path).name if source_path else None, "image filename"
    )
    return OtzovikImage(
        image_identity=_image_identity(filename),
        filename=filename,
        local_asset_path=local_asset_path,
        remote_url=remote_url,
        width=_dimension(node.get("width")),
        height=_dimension(node.get("height")),
    )


def _deduplicate_images(nodes: Iterable[Element]) -> list[OtzovikImage]:
    images: dict[str, OtzovikImage] = {}
    for node in nodes:
        image = _image(node)
        previous = images.get(image.image_identity)
        if previous is not None and previous != image:
            raise ValueError(
                f"Conflicting Otzovik image observations: {image.image_identity}"
            )
        images[image.image_identity] = image
    return list(images.values())


def _canonical_url(root: Element) -> str:
    links = [
        node
        for node in root.iter("link")
        if "canonical" in (node.get("rel") or "").split()
    ]
    return _required(_remote_url(_one(links, "canonical link").get("href")), "URL")


def _review_id_from_url(url: str) -> str:
    match = re.search(r"/review_([0-9]+)\.html(?:$|[?#])", url)
    if match is None:
        raise ValueError(f"Invalid Otzovik review URL: {url}")
    return match.group(1)


def _published_at(node: Element) -> datetime | None:
    values = [
        node.get("content"),
        node.get("datetime"),
        node.get("title"),
    ]
    for child in node.iter():
        values.extend((child.get("content"), child.get("datetime"), child.get("title")))
    for value in values:
        if not value:
            continue
        value = value.removeprefix("Дата публикации отзыва: ").strip()
        parsers = (
            datetime.fromisoformat,
            lambda item: datetime.strptime(item, "%d.%m.%Y"),
        )
        for parser in parsers:
            try:
                return parser(value)
            except ValueError:
                continue
    return None


def _parse_product_review(node: Element) -> OtzovikReviewTeaser:
    title_link = _by_class(node, "review-title")
    review_url = _required(_remote_url(title_link.get("href")), "review_url")
    review_id = _review_id_from_url(review_url)
    dates = _itemprop(node, "datePublished")
    published_at = _published_at(dates[0]) if dates else None
    thumbnail_scopes = [
        child for child in node.iter("a") if _has_class(child, "review-thumbs")
    ]
    thumbnail_nodes = [
        image
        for scope in thumbnail_scopes
        for image in scope.iter("img")
    ]
    thumbnails = _deduplicate_images(thumbnail_nodes)
    return OtzovikReviewTeaser(
        review_id=review_id,
        review_url=review_url,
        title=_required(_text(title_link), "review title"),
        published_at=published_at,
        photo_count_observed=len(thumbnails),
        thumbnails=thumbnails,
    )


def parse_product_page(html: str) -> OtzovikProduct:
    """Parse one saved Otzovik product page without loading any resources."""
    root = _parse_html(html)
    product_heading = _by_class(root, "product-name")
    names = _itemprop(product_heading, "name")
    product_name = _required(_text(_one(names, "product name")), "product_name")
    product_url = _canonical_url(root)

    product_ids = {
        value
        for node in root.iter()
        if (value := node.get("data-pid")) and value.isdigit()
    }
    product_id = _numeric(
        next(iter(product_ids)) if len(product_ids) == 1 else None, "product_id"
    )

    counter = _by_class(root, "reviews-counter")
    votes = [node for node in counter.iter() if _has_class(node, "votes")]
    counter_text = _text(votes[0]) if votes else _text(counter)
    match = re.search(r"([0-9]+)", counter_text)
    reviews_count = int(_numeric(match.group(1) if match else None, "reviews_count"))

    review_list = _by_class(root, "review-list-2")
    reviews = [
        _parse_product_review(node)
        for node in list(review_list)
        if "review" in (node.get("itemprop") or "").split()
    ]
    review_ids = [review.review_id for review in reviews]
    if len(review_ids) != len(set(review_ids)):
        raise ValueError("Duplicate Otzovik reviews on product page")
    return OtzovikProduct(
        product_name=product_name,
        product_url=product_url,
        product_id=product_id,
        reviews_count=reviews_count,
        reviews=reviews,
    )


_EXCLUDED_REVIEW_CLASSES = {
    "ad",
    "ads",
    "advertisement",
    "advertising",
    "avatar",
    "comment",
    "comments",
    "otz_panel_inpage",
    "review-avatar",
    "review-comment",
    "review-comments",
}


def _excluded_review_subtree(node: Element) -> bool:
    return (
        node.tag in {"aside", "noscript", "script", "style", "svg"}
        or bool(_classes(node) & _EXCLUDED_REVIEW_CLASSES)
        or "review" in (node.get("itemprop") or "").split()
    )


def _review_body_text(body: Element) -> str:
    block_tags = {
        "p",
        "div",
        "br",
        "blockquote",
        "ul",
        "ol",
        "li",
        "table",
        "tr",
        "td",
        "th",
    }
    chunks: list[str] = []

    def visit(node: Element) -> None:
        if node is not body and _excluded_review_subtree(node):
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


def _review_image_nodes(body: Element) -> list[Element]:
    result: list[Element] = []

    def visit(node: Element) -> None:
        for child in node:
            if _excluded_review_subtree(child):
                continue
            if child.tag == "img" and _has_class(child, "bigimg"):
                result.append(child)
            visit(child)

    visit(body)
    return result


def _review_title(scope: Element, product_name: str) -> str:
    summaries = [node for node in scope.iter() if _has_class(node, "summary")]
    if summaries:
        return _required(_text(summaries[0]), "review_title")
    headings = list(scope.iter("h1"))
    heading = _required(_text(_one(headings, "review heading")), "review heading")
    prefix = f"Отзыв: {product_name} - "
    if not heading.startswith(prefix):
        raise ValueError("Otzovik review heading disagrees with product name")
    return _required(heading[len(prefix) :], "review_title")


def parse_review_page(html: str) -> OtzovikReview:
    """Parse current-review metadata and full-size images from saved HTML only."""
    root = _parse_html(html)
    review_url = _canonical_url(root)
    scopes = [
        node
        for node in root.iter()
        if _has_class(node, "review-contents")
        and "review" in (node.get("itemprop") or "").split()
    ]
    scope = _one(scopes, "review-contents")
    review_id = _numeric(scope.get("data-rid"), "review_id")
    if review_id != _review_id_from_url(review_url):
        raise ValueError("Otzovik canonical URL disagrees with review_id")
    product_id = _numeric(scope.get("data-pid"), "product_id")

    product_heading = _by_class(root, "product-name")
    product_names = _itemprop(product_heading, "name")
    product_name = _required(
        _text(_one(product_names, "product name")), "product_name"
    )
    product_links = [
        node for node in product_heading.iter("a") if _remote_url(node.get("href"))
    ]
    product_url = _required(
        _remote_url(_one(product_links, "product URL").get("href")), "product_url"
    )

    brands = [node for node in root.iter() if _has_class(node, "brand")]
    brand = _text(brands[0]) or None if brands else None
    dates = _itemprop(scope, "datePublished")
    published_at = _published_at(dates[0]) if dates else None
    body = _one(
        [
            node
            for node in scope.iter()
            if _has_class(node, "review-body") and _has_class(node, "description")
        ],
        "review body",
    )
    images = _deduplicate_images(_review_image_nodes(body))
    return OtzovikReview(
        review_id=review_id,
        review_url=review_url,
        product_id=product_id,
        product_url=product_url,
        product_name=product_name,
        brand=brand,
        published_at=published_at,
        review_title=_review_title(scope, product_name),
        review_text=_required(_review_body_text(body), "review_text"),
        images=images,
    )


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def write_jsonl(path: Path, rows: Iterable[Mapping[str, Any]]) -> None:
    content = "".join(_json(dict(row)) + "\n" for row in rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    try:
        temporary.write_text(content, encoding="utf-8", newline="\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def _catalog_by_id(catalog_path: Path) -> dict[int, dict[str, Any]]:
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    if not isinstance(catalog, list):
        raise ValueError("Catalog must be a JSON array")
    result: dict[int, dict[str, Any]] = {}
    for row in catalog:
        catalog_id = row.get("id")
        if type(catalog_id) is not int or catalog_id <= 0 or catalog_id in result:
            raise ValueError("Catalog IDs must be unique positive integers")
        result[catalog_id] = row
    return result


def _verification_map(
    rows: Iterable[Mapping[str, Any]], catalog: Mapping[int, Mapping[str, Any]]
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for source in rows:
        row = dict(source)
        review_id = row.get("review_id", row.get("source_review_id"))
        catalog_item_id = row.get("catalog_item_id")
        status = row.get("verification_status")
        if (
            not isinstance(review_id, str)
            or not review_id.isdigit()
            or type(catalog_item_id) is not int
            or catalog_item_id not in catalog
            or status not in _VERIFICATION_STATUSES
        ):
            raise ValueError("Invalid Otzovik review verification")
        normalized = {
            "review_id": review_id,
            "catalog_item_id": catalog_item_id,
            "verification_status": status,
        }
        if review_id in result and result[review_id] != normalized:
            raise ValueError(f"Conflicting Otzovik verification for {review_id}")
        result[review_id] = normalized
    return result


def build_manifest_rows(
    review_paths: Iterable[Path],
    catalog_path: Path,
    verification_path: Path,
) -> list[dict[str, Any]]:
    repository_root = catalog_path.resolve().parents[2]
    catalog = _catalog_by_id(catalog_path)
    verifications = _verification_map(read_jsonl(verification_path), catalog)
    rows: list[dict[str, Any]] = []
    seen_images: dict[str, str] = {}
    for path in sorted(Path(item) for item in review_paths):
        raw = path.read_bytes()
        review = parse_review_page(raw.decode("utf-8-sig"))
        verification = verifications.get(review.review_id)
        if verification is None:
            verification_status = "unverified"
            catalog_item = None
        else:
            verification_status = verification["verification_status"]
            catalog_item = catalog[verification["catalog_item_id"]]
        for image in review.images:
            owner = seen_images.setdefault(image.image_identity, review.review_id)
            if owner != review.review_id:
                raise ValueError(
                    f"Otzovik image {image.image_identity} belongs to multiple reviews"
                )
            if image.local_asset_path:
                asset_path = (path.parent / image.local_asset_path).resolve()
                try:
                    local_asset_path = asset_path.relative_to(
                        repository_root
                    ).as_posix()
                except ValueError as exc:
                    raise ValueError(
                        f"Otzovik asset is outside the repository: {asset_path}"
                    ) from exc
            else:
                local_asset_path = None
            rows.append(
                {
                    "source": "otzovik",
                    "catalog_item_id": catalog_item["id"] if catalog_item else None,
                    "official_title": catalog_item["title"] if catalog_item else None,
                    "official_slug": (
                        catalog_item["official_slug"] if catalog_item else None
                    ),
                    "product_id": review.product_id,
                    "product_name": review.product_name,
                    "product_url": review.product_url,
                    "review_id": review.review_id,
                    "review_url": review.review_url,
                    "image_identity": image.image_identity,
                    "filename": image.filename,
                    "local_asset_path": local_asset_path,
                    "remote_url": image.remote_url,
                    "width": image.width,
                    "height": image.height,
                    "html_source_filename": path.name,
                    "html_source_sha256": _sha256(raw),
                    "verification_status": verification_status,
                }
            )
    return sorted(
        rows,
        key=lambda row: (
            row["catalog_item_id"] if row["catalog_item_id"] is not None else 10**10,
            int(row["review_id"]),
            row["image_identity"],
        ),
    )


def confirmed_manifest(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    return [
        dict(row)
        for row in rows
        if row.get("verification_status") == "human_confirmed"
        and type(row.get("catalog_item_id")) is int
    ]


def import_local_assets(
    rows: Iterable[Mapping[str, Any]], root: Path
) -> list[dict[str, Any]]:
    from PIL import Image, UnidentifiedImageError

    results = []
    for source in rows:
        row = dict(source)
        relative_source = row.get("local_asset_path")
        source_path = root / relative_source if relative_source else None
        output_relative = (
            Path("data/otzovik/images")
            / row["official_slug"]
            / f"{row['review_id']}__{row['filename']}"
        )
        result = {
            "source": "otzovik",
            "catalog_item_id": row["catalog_item_id"],
            "official_slug": row["official_slug"],
            "review_id": row["review_id"],
            "image_identity": row["image_identity"],
            "source_asset_path": relative_source,
            "output_path": output_relative.as_posix(),
            "status": "missing_local_asset",
            "sha256": None,
            "bytes": None,
            "width": None,
            "height": None,
            "decode_ok": False,
        }
        if source_path is None or not source_path.is_file():
            results.append(result)
            continue
        raw = source_path.read_bytes()
        result["sha256"] = _sha256(raw)
        result["bytes"] = len(raw)
        try:
            with Image.open(source_path) as image:
                image.load()
                result["width"], result["height"] = image.size
                result["decode_ok"] = True
        except (OSError, UnidentifiedImageError):
            result["status"] = "decode_failed"
            results.append(result)
            continue
        output_path = root / output_relative
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if output_path.exists():
            if _sha256(output_path.read_bytes()) != result["sha256"]:
                raise ValueError(f"Conflicting imported asset: {output_relative}")
            result["status"] = "already_imported"
        else:
            shutil.copy2(source_path, output_path)
            result["status"] = "imported"
        results.append(result)
    return results


def build_contact_sheet(
    import_results: Iterable[Mapping[str, Any]], root: Path, output: Path
) -> bool:
    from PIL import Image, ImageDraw, ImageFont

    rows = [
        dict(row)
        for row in import_results
        if row.get("decode_ok")
        and row.get("status") in {"imported", "already_imported"}
    ]
    if len(rows) != 14:
        return False
    rows.sort(
        key=lambda row: (
            row["catalog_item_id"],
            int(row["review_id"]),
            row["image_identity"],
        )
    )
    columns = 4
    cell_width, cell_height = 320, 300
    label_height = 48
    sheet = Image.new(
        "RGB",
        (columns * cell_width, ((len(rows) + columns - 1) // columns) * cell_height),
        "white",
    )
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for index, row in enumerate(rows):
        with Image.open(root / row["output_path"]) as source:
            image = source.convert("RGB")
            image.thumbnail((cell_width - 20, cell_height - label_height - 20))
        column, line = index % columns, index // columns
        left = column * cell_width + (cell_width - image.width) // 2
        top = line * cell_height + 10
        sheet.paste(image, (left, top))
        draw.multiline_text(
            (column * cell_width + 8, line * cell_height + cell_height - label_height),
            f"#{index + 1} review {row['review_id']}\ncatalog {row['catalog_item_id']}",
            fill="black",
            font=font,
            spacing=2,
        )
    destination = root / output
    destination.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(destination, quality=90)
    return True


def _priority(photo_count: int) -> str:
    if photo_count >= 5:
        return "VERY_HIGH"
    if photo_count >= 2:
        return "HIGH"
    if photo_count == 1:
        return "MEDIUM"
    return "UNKNOWN"


def _round_robin_by_sku(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    counts = sorted({row["known_photo_count"] for row in rows}, reverse=True)
    for count in counts:
        by_sku: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for row in rows:
            if row["known_photo_count"] == count:
                by_sku[row["catalog_item_id"]].append(row)
        for values in by_sku.values():
            values.sort(key=lambda row: int(row["review_id"]))
        while any(by_sku.values()):
            for catalog_id in sorted(by_sku):
                if by_sku[catalog_id]:
                    result.append(by_sku[catalog_id].pop(0))
    return result


def build_manual_save_queue(root: Path) -> list[dict[str, Any]]:
    from app.irecommend import parse_product_page as parse_irecommend_product

    catalog = _catalog_by_id(root / "data/irecommend/catalog_items.json")
    otzovik_samples = root / "data/otzovik/samples"
    saved_otzovik = {
        parse_review_page(path.read_text(encoding="utf-8-sig")).review_id
        for path in otzovik_samples.glob("review*.html")
    }
    rows: list[dict[str, Any]] = []

    otzovik_path = otzovik_samples / "product_tete_de_cheval_sweet.html"
    product = parse_product_page(otzovik_path.read_text(encoding="utf-8-sig"))
    if (
        product.product_id != "2034224"
        or product.product_name
        != "Игристое вино сладкое белое TETE de CHEVAL sweet"
    ):
        raise ValueError("Unexpected Otzovik product identity")
    item = catalog[574]
    for review in product.reviews:
        if review.photo_count_observed <= 0 or review.review_id in saved_otzovik:
            continue
        rows.append(
            {
                "priority": _priority(review.photo_count_observed),
                "source": "otzovik",
                "catalog_item_id": item["id"],
                "official_title": item["title"],
                "official_slug": item["official_slug"],
                "product_url": product.product_url,
                "review_id": review.review_id,
                "review_url": review.review_url,
                "review_title": review.title,
                "known_photo_count": review.photo_count_observed,
                "discovery_evidence": {
                    "kind": "observed_review_thumbnails",
                    "source_html": otzovik_path.relative_to(root).as_posix(),
                    "thumbnail_identities": [
                        thumbnail.image_identity for thumbnail in review.thumbnails
                    ],
                },
                "suggested_filename": (
                    f"review_tete_de_cheval_sweet_{review.review_id}.html"
                ),
                "already_saved": False,
            }
        )

    irecommend_targets = [
        (
            2044,
            "2302239",
            root / "data/irecommend/samples/product_shato_taman_saperavi.html",
            "review_shato_taman_saperavi",
        ),
        (
            1911,
            "10218208",
            root / "data/irecommend/samples/product_hay_bay_chardonnay.html",
            "review_hay_bay_chardonnay",
        ),
    ]
    saved_irecommend_ids = {
        match.group(1)
        for path in (root / "data/irecommend/samples").glob("review*.html")
        if (match := re.search(r"_([0-9]+)\.html$", path.name))
    }
    for (
        catalog_item_id,
        expected_product_id,
        product_path,
        filename_prefix,
    ) in irecommend_targets:
        product = parse_irecommend_product(
            product_path.read_text(encoding="utf-8-sig")
        )
        if product.product_id != expected_product_id:
            raise ValueError(
                f"Unexpected IRecommend product identity in {product_path.name}"
            )
        item = catalog[catalog_item_id]
        for review in product.reviews:
            if review.photos_count <= 0 or review.review_id in saved_irecommend_ids:
                continue
            rows.append(
                {
                    "priority": _priority(review.photos_count),
                    "source": "irecommend",
                    "catalog_item_id": item["id"],
                    "official_title": item["title"],
                    "official_slug": item["official_slug"],
                    "product_url": product.canonical_url,
                    "review_id": review.review_id,
                    "review_url": review.review_url,
                    "review_title": review.title,
                    "known_photo_count": review.photos_count,
                    "discovery_evidence": {
                        "kind": "product_page_reported_photo_count",
                        "source_html": product_path.relative_to(root).as_posix(),
                    },
                    "suggested_filename": (
                        f"{filename_prefix}_{review.review_id}.html"
                    ),
                    "already_saved": False,
                }
            )
    return _round_robin_by_sku(rows)


def build_offline_artifacts(root: Path) -> dict[str, Any]:
    root = root.resolve()
    otzovik = root / "data/otzovik"
    samples = otzovik / "samples"
    review_paths = sorted(samples.glob("review*.html"))
    if len(review_paths) != 5:
        raise ValueError(
            f"Expected five saved Otzovik review pages, found {len(review_paths)}"
        )
    verification_path = otzovik / "review_verifications.jsonl"
    if not verification_path.is_file():
        raise ValueError("Missing manual Otzovik review_verifications.jsonl")
    rows = build_manifest_rows(
        review_paths,
        root / "data/irecommend/catalog_items.json",
        verification_path,
    )
    confirmed = confirmed_manifest(rows)
    write_jsonl(otzovik / "manifest.jsonl", rows)
    write_jsonl(otzovik / "manifest.confirmed.jsonl", confirmed)
    imports = import_local_assets(confirmed, root)
    write_jsonl(otzovik / "import_results.jsonl", imports)
    contact_sheet = Path("data/otzovik/contact_sheet_saved_14.jpg")
    contact_sheet_created = build_contact_sheet(imports, root, contact_sheet)
    queue = build_manual_save_queue(root)
    write_jsonl(root / "data/ugc/manual_save_queue.jsonl", queue)
    return {
        "review_pages": len(review_paths),
        "manifest_rows": len(rows),
        "confirmed_rows": len(confirmed),
        "imported_images": sum(
            row["status"] in {"imported", "already_imported"} for row in imports
        ),
        "contact_sheet": contact_sheet.as_posix() if contact_sheet_created else None,
        "queue_rows": len(queue),
        "queue_known_photos": sum(row["known_photo_count"] for row in queue),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("."))
    args = parser.parse_args(argv)
    try:
        result = build_offline_artifacts(args.root)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        parser.error(str(exc))
    print(_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
