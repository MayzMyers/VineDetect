"""CLI entry points; generation is always an explicit command."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .artifacts import digest, read_json, write_json
from .embeddings import embed_manifest, embedding_rows, load_bundle
from .encoder import MODEL_ID, MODEL_REVISION, SiglipEncoder, environment
from .manifests import build_manifests
from .retrieval import evaluate_bundles, timing_2103

ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS = ROOT / "backups/lct/siglip_phase4a"


def encoder_arguments(parser):
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument("--dtype", choices=["float32", "float16", "bfloat16"], default="float32")
    parser.add_argument("--model-id", default=MODEL_ID)
    parser.add_argument("--revision", default=MODEL_REVISION)
    parser.add_argument("--max-num-patches", type=int, choices=[256, 512], default=256)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--cache-dir", type=Path, default=ROOT / "ml/.cache/huggingface/hub")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--asset-root", type=Path, default=ROOT / "asset-store")
    parser.add_argument("--checkpoints", type=Path, default=ARTIFACTS / "checkpoints")


def make_encoder(args):
    return SiglipEncoder(
        **{
            name: getattr(args, name)
            for name in (
                "model_id",
                "revision",
                "device",
                "dtype",
                "max_num_patches",
                "batch_size",
                "threads",
                "cache_dir",
                "offline",
            )
        }
    )


def smoke(args):
    gallery = read_json(args.manifests / "gallery-manifest.json")
    proxy = read_json(args.manifests / "proxy-query-manifest.json")
    ambiguity = read_json(args.manifests / "ambiguity-manifest.json")
    if gallery["row_count"] != 2103:
        raise ValueError("Smoke expects the validated 2103-row gallery manifest")
    # Eight gallery rows include two identical-image groups. Two historical queries
    # make ten input rows total; never trigger the full gallery implicitly.
    selected = {1, 2, 152, 193, 962, 976, 1842, 1843}
    rows = [r for r in gallery["rows"] if r["catalog_item_id"] in selected]
    if len(rows) != 8:
        raise ValueError("Missing configured smoke assignments")
    sample = {
        **gallery,
        "sample_only": True,
        "gallery_sha256": digest(gallery["rows"]),
        "rows": rows,
        "row_count": len(rows),
    }
    queries = [r for r in proxy["rows"] if r["catalog_item_id"] in selected][:2]
    if len(queries) != 2:
        raise ValueError("Smoke requires two usable historical proxy images")
    sample_proxy = {**proxy, "sample_only": True, "rows": queries, "row_count": len(queries)}
    write_json(args.output / "gallery-sample-manifest.json", sample)
    write_json(args.output / "proxy-sample-manifest.json", sample_proxy)
    encoder = make_encoder(args)
    metadata, benchmark = embed_manifest(
        sample, encoder, args.asset_root, args.output / "gallery", args.checkpoints
    )
    _, proxy_benchmark = embed_manifest(
        sample_proxy, encoder, args.asset_root, args.output / "proxy", args.checkpoints
    )
    self_result = evaluate_bundles(
        args.output / "gallery",
        args.output / "gallery",
        ambiguity,
        args.output / "evaluations/self.json",
        self_check=True,
    )
    proxy_result = evaluate_bundles(
        args.output / "gallery",
        args.output / "proxy",
        ambiguity,
        args.output / "evaluations/proxy_same_source.json",
    )
    timing = timing_2103(load_bundle(args.output / "gallery")[0])
    write_json(args.output / "benchmarks/2103-way-timing.json", timing)
    report = {
        "smoke_only": True,
        "official_gallery_rows_available": 2103,
        "embedded_gallery_rows": len(rows),
        "embedded_proxy_rows": len(queries),
        "embedding_dimension": metadata["dimension"],
        "environment": encoder.environment,
        "gallery_benchmark": benchmark,
        "proxy_benchmark": proxy_benchmark,
        "self_sanity": self_result["self_retrieval_sanity"],
        "synthetic_2103_way_timing": timing,
        "proxy_warning": proxy_result["warning"],
        "full_gallery_executed": False,
    }
    write_json(args.output / "smoke-report.json", report)
    if not report["self_sanity"]["passed"]:
        raise ValueError("Unexplained self-retrieval failures; inspect smoke self evaluation")
    return {
        "smoke_passed": True,
        "gallery_rows": len(rows),
        "proxy_rows": len(queries),
        "dimension": metadata["dimension"],
        "report": str(args.output / "smoke-report.json"),
        "cpu_2103_seconds_extrapolated": benchmark["cpu_2103_seconds_extrapolated"],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Frozen SigLIP2 retrieval baseline; no training or database writes"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    env = commands.add_parser(
        "env", help="Inspect the installed runtime without loading/downloading a model"
    )
    env.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    env.add_argument("--output", type=Path)
    manifests = commands.add_parser("manifests", help="Build validated read-only manifests")
    manifests.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    manifests.add_argument("--asset-root", type=Path, default=ROOT / "asset-store")
    manifests.add_argument("--output", type=Path, default=ARTIFACTS / "manifests")
    embed = commands.add_parser(
        "embed", help="Explicitly embed an entire manifest with resumable per-row checkpoints"
    )
    encoder_arguments(embed)
    embed.add_argument("--manifest", type=Path, required=True)
    embed.add_argument("--output", type=Path, required=True)
    embed.add_argument(
        "--gallery", type=Path, help="Required frozen gallery bundle for field embedding"
    )
    small = commands.add_parser("smoke", help="Only 8 gallery + 2 historical proxy rows")
    encoder_arguments(small)
    small.add_argument("--manifests", type=Path, default=ARTIFACTS / "manifests")
    small.add_argument("--output", type=Path, default=ARTIFACTS / "smoke-cpu-256")
    evaluate = commands.add_parser(
        "evaluate", help="Evaluate completed matrices without loading the model"
    )
    evaluate.add_argument("--gallery", type=Path, required=True)
    evaluate.add_argument("--queries", type=Path, required=True)
    evaluate.add_argument(
        "--ambiguity", type=Path, default=ARTIFACTS / "manifests/ambiguity-manifest.json"
    )
    evaluate.add_argument("--output", type=Path, required=True)
    evaluate.add_argument("--self-check", action="store_true")
    from .field_cli import add_commands, run_command

    add_commands(commands, ROOT, ARTIFACTS)
    args = parser.parse_args(argv)
    try:
        if args.command == "env":
            result = environment(args.device)
            if args.output:
                write_json(args.output, result)
        elif args.command == "manifests":
            if not args.database_url:
                raise ValueError("Set DATABASE_URL (read-only connections are enforced)")
            result = build_manifests(args.database_url, args.asset_root, args.output)
        elif args.command == "embed":
            manifest = read_json(args.manifest)
            embedding_rows(manifest)
            if (
                manifest["dataset_type"] == "official_gallery"
                and not manifest.get("sample_only")
                and manifest["row_count"] != 2103
            ):
                raise ValueError("Full official gallery must contain exactly 2103 assignments")
            if manifest["dataset_type"] == "field_real_world":
                if args.gallery is None:
                    raise ValueError(
                        "Field embedding requires --gallery with the existing frozen bundle"
                    )
                from .field_retrieval import validate_field_encoder

                _, _, gm = load_bundle(args.gallery)
                validate_field_encoder(gm, args)
                # The raw input root is supplied explicitly; outputs cannot overlap it or the gallery.
                from .field_cli import guard_field_outputs

                guard_field_outputs(
                    ROOT, [args.output, args.checkpoints], [args.asset_root, args.gallery]
                )
                encoder = make_encoder(args)
                if (
                    digest(encoder.config) != gm["config_sha256"]
                    or manifest["gallery_sha256"] != gm["source_gallery_sha256"]
                ):
                    raise ValueError("Field encoder or manifest differs from the frozen gallery")
            else:
                encoder = make_encoder(args)
            _, result = embed_manifest(
                manifest, encoder, args.asset_root, args.output, args.checkpoints
            )
        elif args.command == "smoke":
            result = smoke(args)
        elif args.command != "evaluate":
            result = run_command(args, ROOT, ARTIFACTS)
        else:
            result = evaluate_bundles(
                args.gallery,
                args.queries,
                read_json(args.ambiguity),
                args.output,
                self_check=args.self_check,
            )
            if args.self_check and not result["self_retrieval_sanity"]["passed"]:
                raise ValueError("Unexplained self-retrieval failures; inspect evaluation artifact")
            result = {key: value for key, value in result.items() if key != "results"}
        import json

        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), flush=True)
        return 0
    except KeyboardInterrupt:
        print(
            "Interrupted. Completed per-row checkpoints are safe; rerun the same command to resume.",
            file=sys.stderr,
        )
        return 130
    except (OSError, ValueError, RuntimeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
