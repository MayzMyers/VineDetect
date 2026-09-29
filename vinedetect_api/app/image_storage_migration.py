"""Local image storage migration helpers."""

from __future__ import annotations

import shutil
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol


class ImageStorageMigrationError(ValueError):
    """Raised when a stored image path is unsafe or unsupported."""


class ImageStorageRepository(Protocol):
    def get_wine_image_storage_rows(self) -> list[dict[str, Any]]: ...

    def get_roskachestvo_image_storage_rows(self) -> list[dict[str, Any]]: ...

    def update_wine_image_local_path(
        self,
        image_id: int,
        new_local_path: str,
    ) -> None: ...

    def update_roskachestvo_product_image_local_path(
        self,
        product_id: int,
        new_local_path: str,
    ) -> None: ...


@dataclass
class ImageStorageStats:
    expected: int = 0
    copied: int = 0
    existing: int = 0
    missing: int = 0
    updated: int = 0
    unchanged: int = 0

    def add(self, other: ImageStorageStats) -> None:
        self.expected += other.expected
        self.copied += other.copied
        self.existing += other.existing
        self.missing += other.missing
        self.updated += other.updated
        self.unchanged += other.unchanged


@dataclass
class ImageStorageMigrationReport:
    svoe_vino: ImageStorageStats
    roskachestvo: ImageStorageStats
    dry_run: bool

    @property
    def total(self) -> ImageStorageStats:
        total = ImageStorageStats()
        total.add(self.svoe_vino)
        total.add(self.roskachestvo)
        return total

    @property
    def has_missing(self) -> bool:
        return self.total.missing > 0


def normalize_image_storage_path(source: str, local_path: str) -> str:
    current_path = _safe_relative_path(local_path)
    parts = current_path.split("/")

    if source == "svoe_vino":
        if parts[:2] == ["data", "images"] and len(parts) >= 4:
            return _safe_relative_path("/".join(["svoe_vino", *parts[2:]]))
        if parts[:2] == ["storage", "svoe_vino"]:
            return _safe_relative_path("/".join(parts[1:]))
        if parts[:3] == ["storage", "images", "svoe_vino"]:
            return _safe_relative_path("/".join(parts[2:]))
        if parts[0] == "svoe_vino":
            return current_path

    if source == "roskachestvo":
        if parts[:2] == ["storage", "roskachestvo"]:
            return _safe_relative_path("/".join(parts[1:]))
        if parts[:3] == ["storage", "images", "roskachestvo"]:
            return _safe_relative_path("/".join(parts[2:]))
        if parts[0] == "roskachestvo":
            return current_path

    return current_path


def migrate_image_storage(
    repo: ImageStorageRepository,
    *,
    source_root: str | Path,
    target_root: str | Path,
    dry_run: bool = False,
    extra_roots: Iterable[str | Path] = (),
) -> ImageStorageMigrationReport:
    source_roots = build_source_roots(source_root, extra_roots=extra_roots)
    target_root_path = Path(target_root).expanduser().resolve(strict=False)

    svoe_vino = _migrate_rows(
        repo,
        rows=repo.get_wine_image_storage_rows(),
        source="svoe_vino",
        source_roots=source_roots,
        target_root=target_root_path,
        dry_run=dry_run,
    )
    roskachestvo = _migrate_rows(
        repo,
        rows=repo.get_roskachestvo_image_storage_rows(),
        source="roskachestvo",
        source_roots=source_roots,
        target_root=target_root_path,
        dry_run=dry_run,
    )
    return ImageStorageMigrationReport(
        svoe_vino=svoe_vino,
        roskachestvo=roskachestvo,
        dry_run=dry_run,
    )


def build_source_roots(
    source_root: str | Path,
    *,
    extra_roots: Iterable[str | Path] = (),
) -> list[Path]:
    root = Path(source_root).expanduser()
    candidates = [
        root,
        root / "storage",
        root / "vinedetect_api",
        root / "vinedetect_api" / "storage",
        Path("~/projects/wine_crawler").expanduser(),
        Path("~/projects/wine_crawler/storage").expanduser(),
        *(Path(extra).expanduser() for extra in extra_roots),
    ]

    roots: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        resolved = str(candidate.resolve(strict=False))
        if resolved not in seen:
            seen.add(resolved)
            roots.append(Path(resolved))
    return roots


def format_image_storage_migration_report(
    report: ImageStorageMigrationReport,
) -> str:
    lines = [
        "Image storage migration",
        "=======================",
        f"Dry run: {'yes' if report.dry_run else 'no'}",
        "",
    ]
    lines.extend(_format_stats("Svoe Vino", report.svoe_vino))
    lines.append("")
    lines.extend(_format_stats("Roskachestvo", report.roskachestvo))
    lines.append("")
    lines.extend(_format_stats("Total", report.total))
    if report.has_missing:
        lines.extend(
            [
                "",
                "Warning: some source files were missing.",
            ],
        )
    return "\n".join(lines)


def _format_stats(title: str, stats: ImageStorageStats) -> list[str]:
    return [
        f"{title}:",
        f"  expected: {stats.expected}",
        f"  copied: {stats.copied}",
        f"  existing: {stats.existing}",
        f"  missing: {stats.missing}",
        f"  updated: {stats.updated}",
        f"  unchanged: {stats.unchanged}",
    ]


def _migrate_rows(
    repo: ImageStorageRepository,
    *,
    rows: list[dict[str, Any]],
    source: str,
    source_roots: list[Path],
    target_root: Path,
    dry_run: bool,
) -> ImageStorageStats:
    stats = ImageStorageStats(expected=len(rows))
    for row in rows:
        local_path = str(row["local_path"])
        current_path = _safe_relative_path(local_path)
        new_path = normalize_image_storage_path(source, local_path)
        target_path = _resolve_target_path(target_root, new_path)
        source_path = _find_source_file(
            current_path=current_path,
            new_path=new_path,
            source_roots=source_roots,
        )

        source_size_matches = (
            source_path is not None
            and target_path.exists()
            and target_path.stat().st_size == source_path.stat().st_size
        )
        if target_path.exists() and (source_path is None or source_size_matches):
            stats.existing += 1
        elif source_path is None:
            stats.missing += 1
            continue
        else:
            stats.copied += 1
            if not dry_run:
                target_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, target_path)

        if current_path == new_path:
            stats.unchanged += 1
        else:
            stats.updated += 1
            if not dry_run:
                _update_row(repo, source=source, row=row, new_path=new_path)

    return stats


def _update_row(
    repo: ImageStorageRepository,
    *,
    source: str,
    row: dict[str, Any],
    new_path: str,
) -> None:
    if source == "svoe_vino":
        repo.update_wine_image_local_path(int(row["id"]), new_path)
        return
    if source == "roskachestvo":
        repo.update_roskachestvo_product_image_local_path(int(row["id"]), new_path)
        return
    msg = f"unknown image storage source: {source}"
    raise ImageStorageMigrationError(msg)


def _find_source_file(
    *,
    current_path: str,
    new_path: str,
    source_roots: list[Path],
) -> Path | None:
    for relative_path in _source_relative_candidates(current_path, new_path):
        for root in source_roots:
            candidate = root / relative_path
            if candidate.is_file():
                return candidate
    return None


def _source_relative_candidates(current_path: str, new_path: str) -> list[Path]:
    candidates = [current_path]
    if current_path.startswith("storage/"):
        candidates.append(current_path.removeprefix("storage/"))
    if current_path.startswith("storage/images/"):
        candidates.append(current_path.removeprefix("storage/images/"))
    candidates.append(new_path)

    paths: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        safe_candidate = _safe_relative_path(candidate)
        if safe_candidate not in seen:
            seen.add(safe_candidate)
            paths.append(Path(*safe_candidate.split("/")))
    return paths


def _resolve_target_path(target_root: Path, relative_path: str) -> Path:
    target_path = target_root.joinpath(*relative_path.split("/")).resolve(strict=False)
    if target_path != target_root and target_root not in target_path.parents:
        msg = f"target path escapes target root: {relative_path}"
        raise ImageStorageMigrationError(msg)
    return target_path


def _safe_relative_path(local_path: str) -> str:
    value = local_path.strip().replace("\\", "/")
    if not value:
        msg = "local_path is blank"
        raise ImageStorageMigrationError(msg)
    if value.startswith("/") or (len(value) >= 2 and value[1] == ":"):
        msg = f"absolute local_path is not allowed: {local_path}"
        raise ImageStorageMigrationError(msg)

    parts = [part for part in value.split("/") if part]
    if any(part == ".." for part in parts):
        msg = f"parent traversal is not allowed: {local_path}"
        raise ImageStorageMigrationError(msg)
    if not parts:
        msg = "local_path is blank"
        raise ImageStorageMigrationError(msg)
    return "/".join(parts)