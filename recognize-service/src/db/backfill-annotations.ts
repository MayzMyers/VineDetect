import { randomUUID } from "node:crypto";
import { closePool, pool } from "./pool.js";

type MetaRow = {
  source: string;
  source_item_id: string;
  visual_features: Record<string, unknown>;
  annotations: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

async function main() {
  const rows = await pool.query<MetaRow>(`
    SELECT source, source_item_id, visual_features, annotations, created_at, updated_at
    FROM meta.items
    ORDER BY source, source_item_id
  `);

  let proposalsCreated = 0;
  let annotationsCreated = 0;

  for (const row of rows.rows) {
    const proposal = extractGeneratedProposal(row);
    if (proposal && !(await hasProposal(row.source, row.source_item_id))) {
      await insertProposal(row, proposal);
      proposalsCreated += 1;
    }

    const annotation = extractReviewedAnnotation(row);
    if (annotation && !(await hasAnnotation(row.source, row.source_item_id))) {
      const suggestionId = await latestProposalId(row.source, row.source_item_id);
      await insertAnnotation(row, annotation, suggestionId);
      annotationsCreated += 1;
    }
  }

  console.log(
    JSON.stringify(
      {
        scanned: rows.rowCount,
        proposalsCreated,
        annotationsCreated,
      },
      null,
      2,
    ),
  );
}

async function hasProposal(source: string, sourceItemId: string) {
  const result = await pool.query(
    "SELECT 1 FROM meta.detection_proposals WHERE source = $1 AND source_item_id = $2 LIMIT 1",
    [source, sourceItemId],
  );
  return Boolean(result.rows[0]);
}

async function hasAnnotation(source: string, sourceItemId: string) {
  const result = await pool.query(
    "SELECT 1 FROM meta.image_annotations WHERE source = $1 AND source_item_id = $2 AND annotation_type = 'label-bbox' LIMIT 1",
    [source, sourceItemId],
  );
  return Boolean(result.rows[0]);
}

async function latestProposalId(source: string, sourceItemId: string) {
  const result = await pool.query(
    `
    SELECT id
    FROM meta.detection_proposals
    WHERE source = $1 AND source_item_id = $2
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [source, sourceItemId],
  );
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

async function insertProposal(row: MetaRow, proposal: Record<string, unknown>) {
  const detector = objectValue(proposal.detector);
  await pool.query(
    `
    INSERT INTO meta.detection_proposals (
      id, source, source_item_id, detector_type, detector_version,
      bbox, confidence, candidate_score, preset_id, preset_revision, config_hash, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `,
    [
      randomUUID(),
      row.source,
      row.source_item_id,
      stringValue(detector?.type) ?? "opencv",
      stringValue(detector?.version) ?? "cv-meta-v2",
      JSON.stringify(proposal.bbox ?? null),
      numberValue(proposal.confidence),
      numberValue(proposal.candidateScore),
      stringValue(proposal.presetId),
      numberValue(proposal.presetRevision),
      stringValue(proposal.configHash),
      stringValue(proposal.generatedAt) ?? row.updated_at,
    ],
  );
}

async function insertAnnotation(row: MetaRow, annotation: Record<string, unknown>, suggestionId: string | null) {
  const sourceKind = stringValue(annotation.source) ?? "manual";
  const status = sourceKind === "no-label" ? "no-object" : "reviewed";
  await pool.query(
    `
    INSERT INTO meta.image_annotations (
      id, source, source_item_id, annotation_type, bbox,
      status, source_kind, suggestion_id, revision, reviewed_by, created_at, updated_at
    )
    VALUES ($1, $2, $3, 'label-bbox', $4, $5, $6, $7, 1, $8, $9, $10)
    `,
    [
      randomUUID(),
      row.source,
      row.source_item_id,
      JSON.stringify(annotation.bbox ?? null),
      status,
      sourceKind,
      suggestionId,
      stringValue(annotation.reviewedBy),
      stringValue(annotation.reviewedAt) ?? row.updated_at,
      stringValue(annotation.reviewedAt) ?? row.updated_at,
    ],
  );
}

function extractGeneratedProposal(row: MetaRow) {
  const legacy = objectValue(row.annotations?.labelAnnotation);
  const generated = objectValue(legacy?.generated);
  if (generated?.bbox) return generated;

  const cvMeta = objectValue(row.visual_features?.cvMeta) ?? row.visual_features;
  const label = objectValue(cvMeta?.label);
  const roi = objectValue(label?.roi);
  if (!roi) return null;
  const source = objectValue(cvMeta?.source);
  const width = numberValue(source?.width) ?? 1000;
  const height = numberValue(source?.height) ?? 1000;
  const detection = objectValue(label?.detection);
  const layout = objectValue(label?.layout);
  const diagnostics = objectValue(cvMeta?.diagnostics);
  return {
    bbox: {
      x: Math.round((numberValue(roi.x) ?? 0) * width),
      y: Math.round((numberValue(roi.y) ?? 0) * height),
      width: Math.round((numberValue(roi.width) ?? 0) * width),
      height: Math.round((numberValue(roi.height) ?? 0) * height),
    },
    detector: {
      type: "opencv",
      version: stringValue(diagnostics?.pipelineVersion) ?? stringValue(cvMeta?.extractorVersion) ?? "cv-meta-v2",
    },
    confidence: numberValue(detection?.confidence),
    candidateScore: numberValue(layout?.selectedScore),
    generatedAt: row.updated_at.toISOString(),
  };
}

function extractReviewedAnnotation(row: MetaRow) {
  const legacy = objectValue(row.annotations?.labelAnnotation);
  return objectValue(legacy?.reviewed);
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
