"""Validate downloaded image rows against files on disk."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from statistics import mean
from typing import Any


@dataclass(frozen=True)
class ImageStats:
    images_total: int
    status_counts: dict[str, int]
    local_path_filled: int
    files_existing: int
    files_missing: int
    files_zero_size: int
    db_size_total: int
    disk_size_total: int
    size_min: int | None
    size_max: int | None
    size_avg: float | None
    missing_files: list[dict[str, Any]]
    zero_size_files: list[dict[str, Any]]


def collect_image_stats(
    repo: Any,
    base_dir: str | Path = ".",
    kind: str | None = "bottle",
    problem_limit: int = 20,
) -> ImageStats:
    rows = repo.get_image_rows_for_stats(kind=kind)
    base_path = Path(base_dir)
    status_counts: dict[str, int] = {}
    local_path_filled = 0
    files_existing = 0
    files_missing = 0
    files_zero_size = 0
    db_size_total = 0
    disk_size_total = 0
    sizes: list[int] = []
    missing_files: list[dict[str, Any]] = []
    zero_size_files: list[dict[str, Any]] = []
    problem_limit = max(problem_limit, 0)

    for row in rows:
        status = _status(row.get("download_status"))
        status_counts[status] = status_counts.get(status, 0) + 1

        size_bytes = row.get("size_bytes")
        if isinstance(size_bytes, int):
            db_size_total += size_bytes

        local_path = row.get("local_path")
        has_local_path = isinstance(local_path, str) and bool(local_path.strip())
        if has_local_path:
            local_path_filled += 1
            file_path = _resolve_local_path(base_path, local_path)
            if file_path.exists():
                file_size = file_path.stat().st_size
                disk_size_total += file_size
                if file_size > 0:
                    files_existing += 1
                    sizes.append(file_size)
                else:
                    files_zero_size += 1
                    _append_problem(zero_size_files, row, problem_limit)
            else:
                files_missing += 1
                _append_problem(missing_files, row, problem_limit)
        elif status == "ok":
            files_missing += 1
            _append_problem(missing_files, row, problem_limit)

    return ImageStats(
        images_total=len(rows),
        status_counts=status_counts,
        local_path_filled=local_path_filled,
        files_existing=files_existing,
        files_missing=files_missing,
        files_zero_size=files_zero_size,
        db_size_total=db_size_total,
        disk_size_total=disk_size_total,
        size_min=min(sizes) if sizes else None,
        size_max=max(sizes) if sizes else None,
        size_avg=mean(sizes) if sizes else None,
        missing_files=missing_files,
        zero_size_files=zero_size_files,
    )


def format_image_stats(stats: ImageStats) -> str:
    lines = [
        "Image stats",
        "===========",
        f"Images total: {stats.images_total}",
        f"Local path filled: {stats.local_path_filled}",
        f"Files existing: {stats.files_existing}",
        f"Files missing: {stats.files_missing}",
        f"Files zero size: {stats.files_zero_size}",
        f"DB size total: {stats.db_size_total}",
        f"Disk size total: {stats.disk_size_total}",
        f"File size min: {_format_optional_int(stats.size_min)}",
        f"File size max: {_format_optional_int(stats.size_max)}",
        f"File size avg: {_format_optional_float(stats.size_avg)}",
        "",
        "Download statuses:",
        *_format_counts(stats.status_counts),
        "",
        "Missing files:",
        *_format_problem_rows(stats.missing_files),
        "",
        "Zero-size files:",
        *_format_problem_rows(stats.zero_size_files),
    ]
    return "\n".join(lines)


def _status(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return "pending"
    return value


def _resolve_local_path(base_dir: Path, local_path: str) -> Path:
    path = Path(local_path)
    if path.is_absolute():
        return path
    return base_dir / path


def _append_problem(
    problems: list[dict[str, Any]],
    row: dict[str, Any],
    problem_limit: int,
) -> None:
    if len(problems) >= problem_limit:
        return
    problems.append(
        {
            "id": row.get("id"),
            "wine_id": row.get("wine_id"),
            "kind": row.get("kind"),
            "local_path": row.get("local_path"),
            "url": row.get("url"),
        }
    )


def _format_counts(items: dict[str, int]) -> list[str]:
    if not items:
        return ["  no data"]
    return [f"  {name}: {count}" for name, count in items.items()]


def _format_problem_rows(rows: list[dict[str, Any]]) -> list[str]:
    if not rows:
        return ["  no data"]
    return [
        f"  id={row['id']} wine_id={row['wine_id']} path={row['local_path']}"
        for row in rows
    ]


def _format_optional_int(value: int | None) -> str:
    if value is None:
        return "n/a"
    return str(value)


def _format_optional_float(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.2f}"
