import { isDeepStrictEqual } from "node:util";
import {
  assertReferenceMatches,
  type OfficialReference,
  type OfficialTarget,
} from "../../shared/officialReference.js";

export type Row = Record<string, any>;
export type Evidence = {
  job: Row;
  track: Row | null;
  package: Row | null;
  version: Row | null;
  proposals: Row[];
  pointers: Row[];
  resolutionMethod: string | null;
};
export type Validation = {
  catalogItemId: string;
  target: OfficialTarget;
  jobId: string;
  status: "success" | "failed" | "inconsistent";
  jobStatus: string;
  jobError: unknown;
  proposalEvidence: Row | null;
  issues: string[];
  proposalId: string | null;
  confidence: number | null;
  bbox: { x: number; y: number; width: number; height: number } | null;
  points: { x: number; y: number }[] | null;
  areaRatio: number | null;
  widthRatio: number | null;
  heightRatio: number | null;
  borderTouch: boolean;
  resolutionMethod: string | null;
};
export const terminal = (status: string) =>
  ["completed", "failed", "cancelled", "completed_with_errors"].includes(
    status,
  );
const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
export function validateProposal(
  expected: OfficialReference,
  target: OfficialTarget,
  e: Evidence,
): Validation {
  const issues: string[] = [];
  try {
    assertReferenceMatches(expected, target);
  } catch {
    issues.push("reference_mismatch");
  }
  const job = e.job;
  if (!isDeepStrictEqual(job.target, target))
    issues.push("job_target_mismatch");
  if (job.job_type !== "GENERATE_DETECTION_PROPOSAL")
    issues.push("job_type_mismatch");
  if (
    job.source !== target.source ||
    job.source_item_id !== target.sourceItemId ||
    job.annotation_track_id !== target.annotationTrackId ||
    job.annotation_version_id !== target.annotationVersionId
  )
    issues.push("job_identity_mismatch");
  if (job.status !== "completed") issues.push("job_not_completed");
  if (job.error !== null) issues.push("job_error");
  if (
    !e.track ||
    e.track.id !== target.annotationTrackId ||
    e.track.source !== target.source ||
    e.track.source_item_id !== target.sourceItemId ||
    e.track.source_asset_ref !== target.referencePath ||
    !["draft", "in-progress"].includes(e.track.status)
  )
    issues.push("track_binding_mismatch");
  if (
    !e.package ||
    e.package.id !== target.packageId ||
    e.package.legacy_annotation_track_id !== target.annotationTrackId ||
    e.package.source !== target.source ||
    e.package.source_item_id !== target.sourceItemId ||
    e.package.source_asset_ref !== target.referencePath ||
    e.package.deleted_at ||
    e.package.status !== "draft"
  )
    issues.push("package_binding_mismatch");
  if (
    !e.version ||
    e.version.id !== target.annotationVersionId ||
    e.version.annotation_track_id !== target.annotationTrackId ||
    e.version.source !== target.source ||
    e.version.source_item_id !== target.sourceItemId ||
    !(
      job.status === "failed"
        ? ["draft", "review_required", "failed"]
        : ["draft", "review_required"]
    ).includes(e.version.status) ||
    !isDeepStrictEqual(e.version.snapshot?.officialReference, target)
  )
    issues.push("version_binding_mismatch");
  const snapshotPackage = e.version?.snapshot?.packages?.find(
    (p: Row) => p.id === target.packageId,
  );
  if (
    !snapshotPackage ||
    snapshotPackage.sourceAssetRef !== target.referencePath ||
    snapshotPackage.legacyAnnotationTrackId !== target.annotationTrackId
  )
    issues.push("version_package_mismatch");
  if (e.pointers.length) issues.push("version_promoted");
  if (!e.proposals.length) issues.push("missing_proposal");
  if (e.proposals.length > 1) issues.push("multiple_proposals");
  const p = e.proposals[0];
  let bbox: Validation["bbox"] = null,
    points: Validation["points"] = null;
  if (p) {
    if (p.image_url !== target.referencePath)
      issues.push("proposal_path_mismatch");
    if (
      p.annotation_track_id !== target.annotationTrackId ||
      p.source !== target.source ||
      p.source_item_id !== target.sourceItemId
    )
      issues.push("proposal_track_mismatch");
    const b = p.bbox;
    if (
      !b ||
      ![b.x, b.y, b.width, b.height].every(finite) ||
      b.width <= 0 ||
      b.height <= 0
    )
      issues.push("invalid_bbox");
    else {
      bbox = { x: b.x, y: b.y, width: b.width, height: b.height };
      if (
        b.x < 0 ||
        b.y < 0 ||
        b.x + b.width > target.width ||
        b.y + b.height > target.height
      )
        issues.push("bbox_out_of_bounds");
    }
    const q = p.geometry?.points;
    if (
      p.geometry?.type !== "quad" ||
      !Array.isArray(q) ||
      q.length !== 4 ||
      !q.every((v: Row) => finite(v.x) && finite(v.y))
    )
      issues.push("invalid_quad");
    else {
      points = q.map((v: Row) => ({ x: v.x, y: v.y }));
      if (
        points!.some(
          (v) =>
            v.x < 0 || v.y < 0 || v.x > target.width || v.y > target.height,
        )
      )
        issues.push("quad_out_of_bounds");
      const crosses = points!.map((a, i) => {
        const b = points![(i + 1) % 4]!,
          c = points![(i + 2) % 4]!;
        return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      });
      if (!(crosses.every((v) => v > 0) || crosses.every((v) => v < 0)))
        issues.push("degenerate_quad");
      if (bbox) {
        const xs = points!.map((v) => v.x),
          ys = points!.map((v) => v.y);
        if (
          Math.abs(Math.min(...xs) - bbox.x) > 1e-6 ||
          Math.abs(Math.min(...ys) - bbox.y) > 1e-6 ||
          Math.abs(Math.max(...xs) - bbox.x - bbox.width) > 1e-6 ||
          Math.abs(Math.max(...ys) - bbox.y - bbox.height) > 1e-6
        )
          issues.push("quad_bbox_mismatch");
      }
    }
    if (!finite(p.confidence)) issues.push("invalid_confidence");
  }
  const bindingIssues = issues.filter(
    (v) => !["job_not_completed", "job_error", "missing_proposal"].includes(v),
  );
  return {
    catalogItemId: target.catalogItemId,
    target,
    jobId: String(job.id),
    status: !issues.length
      ? "success"
      : job.status === "failed" && !bindingIssues.length
        ? "failed"
        : "inconsistent",
    jobStatus: job.status,
    jobError: job.error,
    proposalEvidence: p ?? null,
    issues,
    proposalId: p?.id ?? null,
    confidence: finite(p?.confidence) ? p.confidence : null,
    bbox,
    points,
    areaRatio: bbox
      ? (bbox.width * bbox.height) / (target.width * target.height)
      : null,
    widthRatio: bbox ? bbox.width / target.width : null,
    heightRatio: bbox ? bbox.height / target.height : null,
    borderTouch: Boolean(
      bbox &&
        (bbox.x <= 0 ||
          bbox.y <= 0 ||
          bbox.x + bbox.width >= target.width ||
          bbox.y + bbox.height >= target.height),
    ),
    resolutionMethod: e.resolutionMethod,
  };
}
export function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p,
    l = Math.floor(i);
  return sorted[l]! + (sorted[Math.ceil(i)]! - sorted[l]!) * (i - l);
}
export function distribution(values: (number | null)[]) {
  const a = values.filter(finite).sort((a, b) => a - b);
  return {
    count: a.length,
    min: a[0] ?? null,
    median: quantile(a, 0.5),
    mean: a.length ? a.reduce((s, v) => s + v, 0) / a.length : null,
    max: a.at(-1) ?? null,
    quantiles: Object.fromEntries(
      [0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 1].map((p) => [
        String(p),
        quantile(a, p),
      ]),
    ),
  };
}
export function summarize(batchId: string, results: Validation[]) {
  const rows = [...results].sort(
    (a, b) => Number(a.catalogItemId) - Number(b.catalogItemId),
  );
  const confidence = distribution(rows.map((r) => r.confidence)),
    area = distribution(rows.map((r) => r.areaRatio));
  const q1 = area.quantiles["0.25"],
    q3 = area.quantiles["0.75"],
    iqr = (q3 ?? 0) - (q1 ?? 0);
  const structuralAnomalies: Record<string, number> = {};
  for (const row of rows)
    for (const issue of row.issues)
      structuralAnomalies[issue] = (structuralAnomalies[issue] ?? 0) + 1;
  const groups: Record<string, string[]> = {
    all: rows.map((r) => r.catalogItemId),
    "low-confidence": rows
      .filter(
        (r) =>
          r.confidence !== null && r.confidence <= confidence.quantiles["0.1"]!,
      )
      .map((r) => r.catalogItemId),
    "high-confidence": rows
      .filter(
        (r) =>
          r.confidence !== null && r.confidence >= confidence.quantiles["0.9"]!,
      )
      .map((r) => r.catalogItemId),
    "roi-size-outliers": rows
      .filter(
        (r) =>
          r.areaRatio !== null &&
          (r.areaRatio < (q1 ?? 0) - 1.5 * iqr ||
            r.areaRatio > (q3 ?? 0) + 1.5 * iqr),
      )
      .map((r) => r.catalogItemId),
    "border-touch": rows
      .filter((r) => r.borderTouch)
      .map((r) => r.catalogItemId),
    "failed-inconsistent": rows
      .filter((r) => r.status !== "success")
      .map((r) => r.catalogItemId),
  };
  return {
    batchId,
    requested: rows.length,
    completed: rows.filter((r) => r.status === "success").length,
    failed: rows.filter((r) => r.status === "failed").length,
    inconsistent: rows.filter((r) => r.status === "inconsistent").length,
    missingProposals: rows.filter((r) => r.issues.includes("missing_proposal"))
      .length,
    confidence,
    areaRatio: area,
    structuralAnomalies,
    borderTouch: groups["border-touch"]!.length,
    sampling:
      "Low/high = batch p10/p90 inclusive; area outliers = Tukey 1.5 IQR. Confidence never determines success.",
    groups,
    results: rows,
  };
}
