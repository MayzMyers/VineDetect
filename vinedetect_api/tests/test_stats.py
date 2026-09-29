from __future__ import annotations

from app.main import format_stats
from app.repositories import DatabaseStats


def test_format_stats_outputs_database_summary() -> None:
    stats = DatabaseStats(
        wines_total=1866,
        wines_with_details=1866,
        wines_without_details=0,
        grapes_total=136,
        dishes_total=34,
        wine_grapes_total=2349,
        wine_dishes_total=5382,
        page_statuses={"ok": 117},
        wine_statuses={"detail_ok": 1866},
        top_regions=[("Кубань", 1000), ("Крым", 500)],
        top_categories=[("Красное сухое", 500)],
        top_manufacturers=[("Винодельня LETO", 20)],
    )

    output = format_stats(stats)

    assert "Database stats" in output
    assert "Wines total: 1866" in output
    assert "Wines with details: 1866" in output
    assert "Wines without details: 0" in output
    assert "Grapes: 136" in output
    assert "Dishes: 34" in output
    assert "Wine-grape links: 2349" in output
    assert "Wine-dish links: 5382" in output
    assert "ok: 117" in output
    assert "detail_ok: 1866" in output
    assert "Кубань: 1000" in output
    assert "Крым: 500" in output
    assert "Красное сухое: 500" in output
    assert "Винодельня LETO: 20" in output


def test_format_stats_outputs_no_data_for_empty_sections() -> None:
    stats = DatabaseStats(
        wines_total=0,
        wines_with_details=0,
        wines_without_details=0,
        grapes_total=0,
        dishes_total=0,
        wine_grapes_total=0,
        wine_dishes_total=0,
        page_statuses={},
        wine_statuses={},
        top_regions=[],
        top_categories=[],
        top_manufacturers=[],
    )

    output = format_stats(stats)

    assert "Crawl page statuses:\n  no data" in output
    assert "Crawl wine statuses:\n  no data" in output
    assert "Top regions:\n  no data" in output
    assert "Top categories:\n  no data" in output
    assert "Top manufacturers:\n  no data" in output
    assert output.count("  no data") == 5
