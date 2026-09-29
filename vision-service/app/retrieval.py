from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Lock

import numpy as np
import torch
from PIL import Image
from transformers import AutoImageProcessor, AutoModel


MODEL_ID = os.getenv(
    "RETRIEVAL_MODEL",
    "google/siglip2-so400m-patch16-naflex",
)

MODEL_REVISION = os.getenv(
    "RETRIEVAL_MODEL_REVISION",
    "cc24074f717b612951c2dead130904ab9b65a81e",
)

GALLERY_ROOT = Path(os.getenv("RETRIEVAL_GALLERY_ROOT", "/app/gallery"))

MAX_PATCHES = int(os.getenv("RETRIEVAL_MAX_PATCHES", "256"))

PRELOAD_RETRIEVAL = os.getenv("RETRIEVAL_PRELOAD", "true").strip().lower() in {
    "1",
    "true",
}

_runtime = None
_runtime_lock = Lock()


def _extract_features(output):
    if torch.is_tensor(output):
        return output

    pooled = getattr(output, "pooler_output", None)
    if pooled is not None:
        return pooled

    image_embeds = getattr(output, "image_embeds", None)
    if image_embeds is not None:
        return image_embeds

    raise RuntimeError(f"Unexpected SigLIP output: {type(output).__name__}")


def _load_gallery():
    from .v5.catalog import validate_gallery

    validate_gallery(GALLERY_ROOT)
    if (
        MODEL_ID != "google/siglip2-so400m-patch16-naflex"
        or MODEL_REVISION != "cc24074f717b612951c2dead130904ab9b65a81e"
        or MAX_PATCHES != 256
    ):
        raise RuntimeError("Frozen retrieval configuration cannot be overridden")
    matrix = np.load(
        GALLERY_ROOT / "embeddings.npy",
        mmap_mode="r",
    )

    raw_rows = json.loads((GALLERY_ROOT / "rows.json").read_text(encoding="utf-8"))

    rows = (
        raw_rows["rows"]
        if isinstance(raw_rows, dict) and isinstance(raw_rows.get("rows"), list)
        else raw_rows
    )

    if not isinstance(rows, list):
        raise RuntimeError("Invalid gallery rows.json")

    if matrix.dtype != np.float32:
        raise RuntimeError(f"Gallery dtype must be float32, got {matrix.dtype}")

    if matrix.ndim != 2 or matrix.shape[1] != 1152:
        raise RuntimeError(f"Invalid gallery shape: {matrix.shape}")

    if matrix.shape[0] != len(rows):
        raise RuntimeError("Gallery matrix/row count mismatch")

    norms = np.linalg.norm(matrix, axis=1)

    if not np.allclose(
        norms,
        1.0,
        atol=2e-6,
        rtol=0,
    ):
        raise RuntimeError("Gallery vectors are not normalized")

    return matrix, rows


def retrieval_runtime():
    global _runtime

    if _runtime is not None:
        return _runtime

    with _runtime_lock:
        if _runtime is not None:
            return _runtime

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        dtype = torch.float16 if device.type == "cuda" else torch.float32

        processor = AutoImageProcessor.from_pretrained(
            MODEL_ID,
            revision=MODEL_REVISION,
        )

        model = AutoModel.from_pretrained(
            MODEL_ID,
            revision=MODEL_REVISION,
            dtype=dtype,
        )

        model = model.to(device).eval()

        if device.type == "cuda":
            torch.backends.cuda.matmul.allow_tf32 = False

        gallery, rows = _load_gallery()

        _runtime = (
            processor,
            model,
            device,
            dtype,
            gallery,
            rows,
        )

    return _runtime


def retrieval_loaded() -> bool:
    return _runtime is not None


def retrieve_top_k(
    image: Image.Image,
    limit: int = 10,
) -> dict:
    (
        processor,
        model,
        device,
        dtype,
        gallery,
        rows,
    ) = retrieval_runtime()

    inputs = processor(
        images=image,
        return_tensors="pt",
        max_num_patches=MAX_PATCHES,
    )

    moved = {}

    for key, value in inputs.items():
        if not torch.is_tensor(value):
            moved[key] = value
        elif torch.is_floating_point(value):
            moved[key] = value.to(
                device=device,
                dtype=dtype,
            )
        else:
            moved[key] = value.to(device)

    with torch.inference_mode():
        output = model.get_image_features(**moved)

    features = _extract_features(output)

    features = torch.nn.functional.normalize(
        features.float(),
        p=2,
        dim=-1,
    )

    query = features[0].detach().cpu().numpy().astype(np.float32, copy=False)

    scores = np.asarray(gallery) @ query

    # Multi-reference ready:
    # several reference rows may map to one catalog SKU.
    # SKU score is the maximum cosine across its references.
    best_by_catalog: dict[int, dict] = {}

    for index, score_value in enumerate(scores):
        row = rows[index]

        catalog_id_raw = row.get("catalog_item_id") if isinstance(row, dict) else None

        if catalog_id_raw is None:
            raise RuntimeError("Gallery row has no catalog_item_id")

        catalog_id = int(catalog_id_raw)
        score = float(score_value)

        previous = best_by_catalog.get(catalog_id)

        if previous is None or score > previous["cosineSimilarity"]:
            best_by_catalog[catalog_id] = {
                "catalogItemId": catalog_id,
                "officialSlug": row.get("official_slug"),
                "title": row.get("title"),
                "winery": row.get("winery"),
                "cosineSimilarity": score,
                "referenceIndex": index,
            }

    ranked = sorted(
        best_by_catalog.values(),
        key=lambda item: (
            -item["cosineSimilarity"],
            item["catalogItemId"],
        ),
    )

    limit = max(1, min(int(limit), 50))

    candidates = []

    for rank, item in enumerate(
        ranked[:limit],
        start=1,
    ):
        candidates.append(
            {
                **item,
                "rank": rank,
            }
        )

    return {
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "device": device.type,
        "dtype": str(dtype).replace("torch.", ""),
        "maxPatches": MAX_PATCHES,
        "galleryReferences": len(rows),
        "galleryCatalogItems": len(best_by_catalog),
        "candidates": candidates,
    }
