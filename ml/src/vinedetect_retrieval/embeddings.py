"""Per-assignment durable feature caching and exact ordered matrix bundles."""

from __future__ import annotations

import hashlib
import io
import time
from pathlib import Path

import numpy as np
from tqdm import tqdm

from .artifacts import atomic_write, digest, exclusive_lock, inspect_image, read_json, write_json


def embedding_rows(manifest):
    kind = manifest["dataset_type"]
    rows = manifest["rows"]
    if manifest["row_count"] != len(rows):
        raise ValueError("Manifest count mismatch")
    if kind == "official_gallery":
        identities = [r["catalog_item_id"] for r in rows]
        ordering = identities
        result = [
            {
                "row_id": str(r["catalog_item_id"]),
                "catalog_item_id": r["catalog_item_id"],
                "official_slug": r["official_slug"],
                "path": r["reference_path"],
                "sha256": r["reference_sha256"],
                "width": r["width"],
                "height": r["height"],
            }
            for r in rows
        ]
    elif kind == "proxy_same_source":
        identities = [r["query_id"] for r in rows]
        ordering = [(r["catalog_item_id"], r["historical_image_id"]) for r in rows]
        result = [
            {
                "row_id": r["query_id"],
                "catalog_item_id": r["catalog_item_id"],
                "official_slug": r["official_slug"],
                "path": r["historical_local_path"],
                "sha256": r["historical_sha256"],
                "width": r["historical_width"],
                "height": r["historical_height"],
                "official_reference_sha256": r["official_reference_sha256"],
                "byte_identical": r["byte_identical"],
            }
            for r in rows
        ]
    elif kind == "field_real_world":
        identities = [r["field_image_id"] for r in rows]
        ordering = [r["relative_source_path"] for r in rows]
        result = [
            {
                "row_id": r["field_image_id"],
                "field_image_id": r["field_image_id"],
                "original_filename": r["original_filename"],
                "path": r["relative_source_path"],
                "sha256": r["sha256"],
                "width": r["width"],
                "height": r["height"],
            }
            for r in rows
        ]
    else:
        raise ValueError(f"Unsupported dataset type: {kind}")
    if len(set(identities)) != len(rows) or ordering != sorted(ordering):
        raise ValueError("Manifest identities must be unique and canonically ordered")
    if not rows:
        raise ValueError("Empty embedding manifest")
    return result


def validate_vectors(matrix, count, dimension):
    if (
        matrix.dtype != np.float32
        or matrix.shape != (count, dimension)
        or not np.isfinite(matrix).all()
    ):
        raise ValueError("Invalid embedding matrix dtype, shape or values")
    if not np.allclose(np.linalg.norm(matrix, axis=1), 1.0, atol=2e-6, rtol=0):
        raise ValueError("Embedding vectors are not L2-normalized")


def cache_identity(config, dataset_type, row):
    return digest(
        {
            "encoder": config,
            "dataset_type": dataset_type,
            "row_id": row["row_id"],
            "sha256": row["sha256"],
            "width": row["width"],
            "height": row["height"],
        }
    )


def read_cache(file, key, dimension):
    try:
        with np.load(file, allow_pickle=False) as data:
            vector = data["vector"]
            if (
                str(data["key"].item()) != key
                or str(data["vector_sha256"].item()) != hashlib.sha256(vector.tobytes()).hexdigest()
            ):
                raise ValueError("Checkpoint checksum/key mismatch")
            validate_vectors(vector[None], 1, dimension)
            return vector
    except (OSError, ValueError, KeyError, EOFError) as error:
        raise ValueError(
            f"Corrupt embedding checkpoint {file}; remove only this cache entry to recompute"
        ) from error


def write_cache(file, key, vector):
    buffer = io.BytesIO()
    np.savez(
        buffer,
        vector=vector,
        key=np.array(key),
        vector_sha256=np.array(hashlib.sha256(vector.tobytes()).hexdigest()),
    )
    atomic_write(file, buffer.getvalue())


def latencies(values):
    return {
        "count": len(values),
        "mean_seconds": float(np.mean(values)) if values else None,
        "p50_seconds": float(np.quantile(values, 0.5)) if values else None,
        "p95_seconds": float(np.quantile(values, 0.95)) if values else None,
    }


def embed_manifest(
    manifest, encoder, root: Path, output: Path, checkpoints: Path, *, show_progress=True
):
    rows = embedding_rows(manifest)
    image_loader = inspect_image
    if manifest["dataset_type"] == "field_real_world":
        from .field_data import inspect_field_image

        image_loader = inspect_field_image
    config_hash, manifest_hash = digest(encoder.config), digest(manifest)
    run_key = digest({"config": config_hash, "manifest": manifest_hash})
    cache = checkpoints / config_hash
    cache.mkdir(parents=True, exist_ok=True)
    with exclusive_lock(output), exclusive_lock(cache):
        base = {
            "schema_version": "siglip-embeddings/1",
            "dataset_type": manifest["dataset_type"],
            "sample_only": bool(manifest.get("sample_only")),
            "config": encoder.config,
            "config_sha256": config_hash,
            "manifest_sha256": manifest_hash,
            "source_gallery_sha256": manifest.get("gallery_sha256", digest(manifest["rows"])),
            "row_count": len(rows),
            "dimension": encoder.dimension,
        }
        write_json(output / "metadata.json", {**base, "complete": False})
        vectors = [None] * len(rows)
        complete, reused, generated = [], 0, 0
        timings, processing_timings = [], []
        run_start = time.perf_counter()
        pending = []
        progress_path = checkpoints / f"progress-{run_key}.json"

        def checkpoint():
            write_json(
                progress_path,
                {
                    "schema_version": "siglip-progress/1",
                    "config_sha256": config_hash,
                    "manifest_sha256": manifest_hash,
                    "completed_row_ids": [rows[i]["row_id"] for i in sorted(complete)],
                    "total": len(rows),
                },
            )

        def process():
            nonlocal generated
            if not pending:
                return
            start = time.perf_counter()
            images = [
                image_loader(root, row["path"], row["sha256"], (row["width"], row["height"]))[1]
                for _, row, _ in pending
            ]
            inference_start = time.perf_counter()
            batch = encoder.encode(images)
            elapsed = time.perf_counter() - inference_start
            validate_vectors(batch, len(pending), encoder.dimension)
            # Each successful row is committed independently; a crash cannot invalidate earlier rows.
            for (index, row, key), vector in zip(pending, batch, strict=True):
                write_cache(cache / f"{key}.npz", key, vector)
                vectors[index] = vector
                complete.append(index)
                generated += 1
            timings.extend([elapsed / len(pending)] * len(pending))
            processing_timings.extend([(time.perf_counter() - start) / len(pending)] * len(pending))
            checkpoint()
            pending.clear()

        for index, row in enumerate(
            tqdm(rows, disable=not show_progress, desc="Frozen SigLIP2 assignments")
        ):
            key = cache_identity(encoder.config, manifest["dataset_type"], row)
            file = cache / f"{key}.npz"
            if file.exists():
                # Hash/readability/dimensions are still checked on a cache hit.
                image_loader(root, row["path"], row["sha256"], (row["width"], row["height"]))
                vectors[index] = read_cache(file, key, encoder.dimension)
                complete.append(index)
                reused += 1
            else:
                pending.append((index, row, key))
                if len(pending) == encoder.batch_size:
                    process()
        process()
        checkpoint()
        matrix = np.stack(vectors)
        validate_vectors(matrix, len(rows), encoder.dimension)
        buffer = io.BytesIO()
        np.save(buffer, matrix, allow_pickle=False)
        raw = buffer.getvalue()
        mapping = [{"index": i, **row} for i, row in enumerate(rows)]
        atomic_write(output / "embeddings.npy", raw)
        write_json(output / "rows.json", mapping)
        metadata = {
            **base,
            "complete": True,
            "matrix_sha256": hashlib.sha256(raw).hexdigest(),
            "row_mapping_sha256": digest(mapping),
        }
        write_json(
            output / "metadata.json", metadata
        )  # Completion marker is the last bundle write.
        total = time.perf_counter() - run_start
        benchmark = {
            "schema_version": "siglip-benchmark/1",
            "dataset_type": manifest["dataset_type"],
            "sample_only": base["sample_only"],
            "config_sha256": config_hash,
            "environment": encoder.environment,
            "model_load_seconds": encoder.load_seconds,
            "dtype": encoder.config["dtype"],
            "max_num_patches": encoder.config["max_num_patches"],
            "batch_size": encoder.batch_size,
            "generated": generated,
            "reused": reused,
            "total_embedding_run_seconds": total,
            "images_per_second_new": generated / sum(processing_timings) if generated else None,
            "inference_latency_per_image": latencies(timings),
            "processing_latency_per_image": latencies(processing_timings),
            "latency_note": "Batch durations divided by batch size; processing includes image read, processor, inference and per-row cache writes.",
            "cpu_2103_seconds_extrapolated": sum(processing_timings) / generated * 2103
            if generated and encoder.device == "cpu"
            else None,
            "memory": encoder.memory(),
            "last_naflex_input_shapes": encoder.last_inputs,
        }
        write_json(output / "benchmark.json", benchmark)
        return metadata, benchmark


def load_bundle(directory: Path):
    metadata = read_json(directory / "metadata.json")
    if not metadata.get("complete"):
        raise ValueError("Embedding bundle is incomplete; resume generation first")
    raw = (directory / "embeddings.npy").read_bytes()
    rows = read_json(directory / "rows.json")
    if (
        hashlib.sha256(raw).hexdigest() != metadata["matrix_sha256"]
        or digest(rows) != metadata["row_mapping_sha256"]
    ):
        raise ValueError("Embedding matrix/row mapping checksum mismatch")
    matrix = np.load(io.BytesIO(raw), allow_pickle=False)
    validate_vectors(matrix, len(rows), metadata["dimension"])
    if len(rows) != metadata["row_count"] or [r["index"] for r in rows] != list(range(len(rows))):
        raise ValueError("Embedding row mapping mismatch")
    return matrix, rows, metadata
