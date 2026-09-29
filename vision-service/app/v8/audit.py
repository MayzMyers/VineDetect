"""Validate/repair diagnostic assets from checked records, without model inference."""

import hashlib
import io
import json
import os
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from .backend import jpeg95
from .checkpoint import atomic_json
from .pipeline import pixels
from .target import crop


def valid_assets(directory, trace):
    directory = Path(directory)
    try:
        saved = json.loads((directory / "trace.json").read_text())
        if saved["input_sha256"] != trace["input_sha256"]:
            return False
        if "sources" not in trace:
            return True
        for filename, key in (
            ("target.png", "target_pixel_hash"),
            ("label.png", "label_pixel_hash"),
        ):
            with Image.open(directory / filename) as image:
                if pixels(image.convert("RGB")) != trace[key]:
                    return False
        for filename in ("target-overlay.jpg", "label-overlay.jpg"):
            with Image.open(directory / filename) as image:
                image.verify()
        return True
    except (OSError, ValueError, KeyError):
        return False


def save_image(image, path, format, **options):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as stream:
            image.save(stream, format=format, **options)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def repair_assets(raw, trace, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    if hashlib.sha256(raw).hexdigest() != trace["input_sha256"]:
        raise ValueError("Cannot repair audit from mismatched input")
    if "sources" in trace:
        with Image.open(io.BytesIO(raw)) as original:
            image = ImageOps.exif_transpose(original).convert("RGB")
        if pixels(image) != trace["canonical_pixel_hash"]:
            raise ValueError("Canonical pixel mismatch during audit repair")
        target = trace["target"]
        bottle = jpeg95(crop(image, target["selected_box"]))
        label_info = trace["label"]
        label = crop(bottle, label_info["selected_box"])
        if (
            pixels(bottle) != trace["target_pixel_hash"]
            or pixels(label) != trace["label_pixel_hash"]
        ):
            raise ValueError("Audit crop pixel mismatch")
        save_image(bottle, directory / "target.png", "PNG")
        save_image(label, directory / "label.png", "PNG")
        overlay = image.copy()
        draw = ImageDraw.Draw(overlay)
        for candidate in target["candidates"]:
            x, y, w, h = candidate["box"]
            draw.rectangle(
                (x, y, x + w, y + h),
                outline="lime" if candidate["box"] == target["selected_box"] else "red",
                width=4,
            )
        save_image(overlay, directory / "target-overlay.jpg", "JPEG", quality=90)
        overlay = bottle.copy()
        draw = ImageDraw.Draw(overlay)
        for candidate in label_info["proposals"]:
            x, y, w, h = candidate["box"]
            draw.rectangle(
                (x, y, x + w, y + h),
                outline="lime"
                if label_info["trusted"]
                and candidate["box"] == label_info["selected_box"]
                else "red",
                width=3,
            )
        save_image(overlay, directory / "label-overlay.jpg", "JPEG", quality=90)
    atomic_json(directory / "trace.json", trace)
    if not valid_assets(directory, trace):
        raise ValueError("Audit repair validation failed")


def render_gallery(root, rows, errors, catalog, manual):
    """A local, lazy-loaded audit index. All image transformations are display-only."""
    import html
    from .report import SETS

    root = Path(root)
    error_map = {r["key"]: r for r in errors}
    cards = []
    for row in rows:
        key = row["key"]
        token = hashlib.sha256(key.encode()).hexdigest()
        directory = root / "audit" / token
        trace = json.loads((directory / "trace.json").read_text())
        predicted = trace.get("top1")
        expected = row.get("expected") if row["dataset"] in SETS else None
        title = catalog.get(predicted, {}).get("title", "No target")
        gt_title = catalog.get(expected, {}).get(
            "title", "Smoke only; no accuracy label"
        )
        assets = []
        for filename in ("target-overlay.jpg", "label-overlay.jpg"):
            source = directory / filename
            if source.exists():
                thumbnail = directory / ("preview-" + filename)
                with Image.open(source) as loaded:
                    image = loaded.convert("RGB")
                    image.thumbnail((600, 700))
                    save_image(image, thumbnail, "JPEG", quality=80)
                assets.append(
                    f'<a href="audit/{token}/{filename}"><img loading="lazy" src="audit/{token}/{thumbnail.name}" alt="{html.escape(filename)}"></a>'
                )
        category = error_map.get(key, {}).get(
            "primary", "correct" if expected is not None else "smoke"
        )
        note = manual.get(key, {}).get("evidence", "")
        detail = html.escape(
            json.dumps(
                dict(
                    target=trace["target"].get("reason"),
                    label=trace.get("label", {}).get("reason"),
                    margin=trace.get("margin"),
                ),
                ensure_ascii=False,
            )
        )
        cards.append(
            f'<article data-set="{html.escape(row["dataset"])}" data-error="{str(key in error_map).lower()}" id="{token}">'
            f"<h2>{html.escape(key)}</h2><p><b>{html.escape(category)}</b> · GT: {html.escape(str(gt_title))}<br>"
            f'Final: {html.escape(str(title))}</p><div class="images">{"".join(assets)}</div>'
            f'<p>{html.escape(note)}</p><p class="small">{detail}</p>'
            f'<a href="audit/{token}/trace.json">Complete final trace</a></article>'
        )
    options = "".join(
        f"<option>{html.escape(s)}</option>"
        for s in sorted({r["dataset"] for r in rows})
    )
    document = (
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>V8 target audit</title>'
        "<style>body{font:16px system-ui;margin:24px;background:#f4f5f6;color:#18202a}header{position:sticky;top:0;background:white;padding:12px;border-bottom:2px solid #8796a5}"
        "main{display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:18px}article{background:white;padding:16px;border:1px solid #bcc6d0;border-radius:8px}"
        "h2{font-size:15px;overflow-wrap:anywhere}.images{display:flex;gap:8px;align-items:start}.images a{width:50%}img{width:100%;height:auto}.small{font-size:12px;overflow-wrap:anywhere}select,label{margin-right:16px}</style>"
        "<header><h1>V8 target/label audit</h1><p>Green: selected. Red: other proposals. Target suspicion requires review; detector coverage is not target accuracy.</p>"
        f'<select id="dataset"><option value="">All datasets</option>{options}</select><label><input type="checkbox" id="errors"> Scored errors only</label></header>'
        f"<main>{''.join(cards)}</main><script>"
        'function filter(){const d=document.getElementById("dataset").value,e=document.getElementById("errors").checked;'
        'document.querySelectorAll("article").forEach(x=>x.style.display=(!d||x.dataset.set===d)&&(!e||x.dataset.error==="true")?"":"none")}'
        'document.getElementById("dataset").onchange=filter;document.getElementById("errors").onchange=filter;'
        "</script></html>"
    )
    (root / "target-audit.html").write_text(document, encoding="utf8")
