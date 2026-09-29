"""Local field workflow; no database access, model training or gallery generation."""

from pathlib import Path

from .artifacts import atomic_write, digest, read_json, write_json
from .field_data import build_field_manifest, ensure_labels, validate_labels
from .field_groups import EVALUATION_MODES, build_source_groups, validate_source_groups
from .field_retrieval import evaluate_field, proxy_errors, retrieve_field


def guard_field_outputs(repo, outputs, inputs=()):
    base = (repo / "backups/lct/field_phase4a2").resolve()
    protected = [(base / "raw").resolve(), *[Path(p).resolve() for p in inputs]]
    for output in outputs:
        path = Path(output).resolve()
        if (
            path == base
            or not path.is_relative_to(base)
            or any(path == p or path.is_relative_to(p) or p.is_relative_to(path) for p in protected)
        ):
            raise ValueError(
                f"Output must stay under field_phase4a2 and cannot overlap immutable inputs: {output}"
            )


def add_commands(commands, repo, baseline):
    base = repo / "backups/lct/field_phase4a2"
    for name in (
        "field-manifest",
        "field-groups",
        "retrieve",
        "review",
        "evaluate-field",
        "proxy-error-report",
        "import-field-labels",
    ):
        parser = commands.add_parser(name)
        parser.add_argument(
            "--gallery-manifest", type=Path, default=baseline / "manifests/gallery-manifest.json"
        )
        parser.add_argument(
            "--manifest", type=Path, default=base / "manifests/field-unlabeled-manifest.json"
        )
        parser.add_argument("--gallery", type=Path, default=baseline / "embeddings/gallery-256")
        parser.add_argument("--queries", type=Path, default=base / "embeddings/field-256")
        parser.add_argument("--labels", type=Path, default=base / "annotations/field-labels.json")
        if name in ("field-groups", "review", "evaluate-field"):
            parser.add_argument(
                "--grouping", type=Path, default=base / "manifests/field-source-groups.json"
            )
        if name == "field-manifest":
            parser.add_argument("--raw-root", type=Path, default=base / "raw")
            parser.add_argument("--expected-count", type=int)
        if name in ("retrieve", "review"):
            parser.add_argument(
                "--retrieval", type=Path, default=base / "retrieval/field-256-top10.json"
            )
        if name == "retrieve":
            parser.add_argument(
                "--summary", type=Path, default=base / "reports/prelabel-summary.json"
            )
        if name == "review":
            parser.add_argument("--raw-root", type=Path, default=base / "raw")
            parser.add_argument("--asset-root", type=Path, default=repo / "asset-store")
            parser.add_argument("--output", type=Path, default=base / "review")
        if name == "evaluate-field":
            parser.add_argument("--mode", choices=EVALUATION_MODES, required=True)
            parser.add_argument(
                "--output", type=Path, help="Defaults to a separate file for the selected mode"
            )
        if name == "proxy-error-report":
            parser.add_argument(
                "--evaluation", type=Path, default=baseline / "evaluations/proxy-256.json"
            )
            parser.add_argument(
                "--ambiguity", type=Path, default=baseline / "manifests/ambiguity-manifest.json"
            )
            parser.add_argument("--output", type=Path, default=base / "reports/proxy-errors.json")
        if name == "import-field-labels":
            parser.add_argument(
                "--input",
                type=Path,
                required=True,
                help="Explicit human export from the review page",
            )


def run_command(args, repo, baseline):
    gallery = read_json(args.gallery_manifest)
    if gallery["dataset_type"] != "official_gallery" or gallery["row_count"] != 2103:
        raise ValueError("Requires the unchanged complete 2103-row gallery")
    inputs = [args.gallery, args.gallery_manifest, args.queries]
    if args.command == "field-manifest":
        guard_field_outputs(repo, [args.manifest, args.labels], [*inputs, args.raw_root])
        manifest = build_field_manifest(args.raw_root, gallery, args.expected_count)
        # Existing labels must still match before either artifact is written.
        if args.labels.exists():
            validate_labels(read_json(args.labels), manifest, gallery)
        write_json(args.manifest, manifest)
        ensure_labels(args.labels, manifest, gallery)
        return {k: v for k, v in manifest.items() if k != "rows"}
    if args.command == "proxy-error-report":
        guard_field_outputs(
            repo,
            [args.output, args.output.with_suffix(".md")],
            [*inputs, args.evaluation, args.ambiguity],
        )
        result = proxy_errors(read_json(args.evaluation), gallery, read_json(args.ambiguity))
        write_json(args.output, result)
        text = (
            "# Proxy strict Top-1 failures\n\n"
            + result["warning"]
            + "\n\n"
            + result["classification_rule"]
            + "\n\n| Query | Expected | Predicted | Rank | Classification |\n|---|---|---|---:|---|\n"
        )

        def cell(value):
            return str(value).replace("|", "\\|").replace("\n", " ")

        for r in result["failures"]:
            text += (
                "| "
                + " | ".join(
                    cell(v)
                    for v in (
                        r["query_row_id"],
                        r["expected_official_slug"],
                        r["top_10"][0]["official_slug"],
                        r["strict_rank"],
                        r["classification"],
                    )
                )
                + " |\n"
            )
        atomic_write(args.output.with_suffix(".md"), text.encode())
        return {k: v for k, v in result.items() if k != "failures"}
    manifest = read_json(args.manifest)
    if manifest["gallery_sha256"] != digest(gallery["rows"]):
        raise ValueError("Field manifest gallery snapshot differs")
    inputs += [args.manifest]
    if args.command == "field-groups":
        guard_field_outputs(repo, [args.grouping], [*inputs, args.labels])
        grouping = build_source_groups(manifest)
        write_json(args.grouping, grouping)
        return {"grouping": str(args.grouping), **grouping["summary"]}
    if args.command in ("review", "evaluate-field"):
        grouping = validate_source_groups(read_json(args.grouping), manifest)
        inputs += [args.grouping]
    if args.command == "retrieve":
        guard_field_outputs(repo, [args.retrieval, args.summary], inputs)
        report, summary = retrieve_field(args.gallery, args.queries, gallery, manifest)
        write_json(args.retrieval, report)
        write_json(args.summary, summary)
        return summary
    if args.command == "review":
        from .field_review import build_review

        guard_field_outputs(
            repo,
            [args.output, args.labels],
            [*inputs, args.raw_root, args.asset_root, args.retrieval],
        )
        labels = ensure_labels(args.labels, manifest, gallery)
        return build_review(
            manifest,
            gallery,
            read_json(args.retrieval),
            labels,
            args.raw_root,
            args.asset_root,
            args.output,
            grouping=grouping,
        )
    if args.command == "import-field-labels":
        guard_field_outputs(repo, [args.labels], [*inputs, args.input])
        labels = validate_labels(read_json(args.input), manifest, gallery)
        # Preserve previous human work as an immutable content-addressed backup.
        if args.labels.exists():
            previous = read_json(args.labels)
            write_json(args.labels.parent / ("previous-" + digest(previous) + ".json"), previous)
        write_json(args.labels, labels)
        return {"imported": len(labels["rows"]), "labels": str(args.labels)}
    if args.output is None:
        filename = (
            "field-256.json"
            if args.mode == "primary_field"
            else "field-256-low_resolution_robustness.json"
        )
        args.output = repo / "backups/lct/field_phase4a2/evaluations" / filename
    guard_field_outputs(repo, [args.output], [*inputs, args.labels])
    result = evaluate_field(
        args.gallery,
        args.queries,
        gallery,
        manifest,
        read_json(args.labels),
        mode=args.mode,
        grouping=grouping,
    )
    write_json(args.output, result)
    return {k: v for k, v in result.items() if k not in ("results", "failures")}
