from __future__ import annotations

import json
import socket
from pathlib import Path

import pytest

from app.irecommend_discovery import build_discovery, discover_products, main
from app.irecommend_manifest import write_manifest
from tests.test_irecommend_matching import CATALOG_ROWS

FIXTURES = Path(__file__).parent / "fixtures" / "irecommend"


@pytest.fixture(autouse=True)
def forbid_network(monkeypatch):
    def fail(*args, **kwargs):
        pytest.fail("Discovery must never open a network connection")

    monkeypatch.setattr(socket.socket, "connect", fail)
    monkeypatch.setattr(socket, "create_connection", fail)


def test_dedup_product_urls_keeps_all_local_origins(tmp_path):
    first = tmp_path / "first.html"
    second = tmp_path / "second.html"
    first.write_text(
        '<div class="seealso-block-content"><div class="productName">'
        '<a href="http://irecommend.ru/content/product/?utm_source=saved#photos">Wine</a>'
        '<a href="/content/product">Wine</a></div></div>',
        encoding="utf-8",
    )
    second.write_text(
        '<a class="product-name" href="https://irecommend.ru/content/product">Wine</a>',
        encoding="utf-8",
    )
    rows = discover_products([second, first, first])
    assert len(rows) == 1
    assert rows[0]["source_url"] == "https://irecommend.ru/content/product"
    assert rows[0]["discovered_title"] == "Wine"
    assert [origin["html_path"] for origin in rows[0]["discovered_from"]] == [
        first.as_posix(),
        second.as_posix(),
    ]
    assert all(
        len(origin["html_sha256"]) == 64 for origin in rows[0]["discovered_from"]
    )


def test_review_and_arbitrary_content_links_are_not_discovered(tmp_path):
    path = tmp_path / "review.html"
    path.write_text(
        """
        <head><link rel="canonical" href="/content/current-review"></head>
        <div class="review-node"></div>
        <div class="seealso-block-content">
          <div class="productName"><a href="/content/real-product">Product</a></div>
          <a class="reviewTextSnippet" href="/content/review-teaser">Review title</a>
          <a href="/content/unmarked-link">Wine</a>
          <div class="productName">
            <a class="review-summary" href="/content/other-review">Review</a></div>
          <div class="productName">
            <a href="/content/current-review">Wrong wrapper</a></div>
          <div class="productName">
            <a href="https://example.com/content/foreign">Other site</a></div>
        </div>
    """,
        encoding="utf-8",
    )
    assert [row["source_url"] for row in discover_products([path])] == [
        "https://irecommend.ru/content/real-product"
    ]


@pytest.mark.parametrize(
    "title, expected",
    [
        ("Вино Фанагория Мерло CRU LERMONT", "strong_candidate"),
        ("Вино Фанагория F-Style Мерло", "reject"),
        ("Вино Фанагория Мерло", "reject"),
    ],
)
def test_distinctive_line_and_grape_required_for_strong(tmp_path, title, expected):
    path = tmp_path / "product.html"
    path.write_text(
        f'<div class="productName"><a href="/content/wine">{title}</a></div>',
        encoding="utf-8",
    )
    row = build_discovery([path], CATALOG_ROWS)[0]
    assert row["status"] == expected
    if expected == "strong_candidate":
        assert row["best_catalog_item_id"] == 199
        assert row["best_official_slug"] == CATALOG_ROWS[0]["official_slug"]
        assert row["score"] >= 0.85
    assert row["evidence"]["purpose"] == "discovery_only"
    assert row["evidence"]["requires_product_page_parse"] is True
    assert "verification_status" not in row
    assert "catalog_item_id" not in row


def test_current_fixtures_and_reordered_inputs_are_deterministic(tmp_path):
    paths = sorted(FIXTURES.glob("*.html"))
    rows = build_discovery(paths, CATALOG_ROWS)
    assert rows
    assert len(rows) == len({row["source_url"] for row in rows})
    output = tmp_path / "discovery.jsonl"
    write_manifest(output, rows)
    first = output.read_bytes()
    write_manifest(output, build_discovery(reversed(paths), reversed(CATALOG_ROWS)))
    assert output.read_bytes() == first
    cru = next(
        row
        for row in rows
        if row["source_url"].endswith("/vino-fanagoriya-merlo-cru-lermont")
    )
    assert cru["status"] == "strong_candidate"
    assert cru["best_catalog_item_id"] == 199


def test_cli_reports_counts_and_top_predictions(tmp_path, capsys):
    catalog = tmp_path / "catalog.json"
    catalog.write_text(json.dumps(CATALOG_ROWS), encoding="utf-8")
    output = tmp_path / "discovery.jsonl"
    args = [
        "--samples-dir",
        str(FIXTURES),
        "--catalog",
        str(catalog),
        "--output",
        str(output),
    ]
    assert main(args) == 0
    first = output.read_bytes()
    stdout = capsys.readouterr().out
    assert "unique product URLs:" in stdout
    assert "Top 30 strong_candidate" in stdout
    assert '"predicted official_slug"' in stdout
    assert main(args) == 0
    assert output.read_bytes() == first
