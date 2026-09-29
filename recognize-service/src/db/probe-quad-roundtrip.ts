import { randomUUID } from "node:crypto";
import { closePool, pool } from "./pool.js";
import { normalizeQuadGeometry, sameQuad, type QuadGeometry } from "../shared/quadGeometry.js";
import { buildCylindricalControls, buildCylindricalTransform, defaultCylindricalGuides, normalizeLabelRectification } from "../shared/labelRectificationContract.js";

const labelGeometry: QuadGeometry = {
  type: "quad",
  points: [{ x: 120, y: 90 }, { x: 710, y: 105 }, { x: 680, y: 940 }, { x: 145, y: 915 }],
  bbox: { x: 120, y: 90, width: 590, height: 850 },
};
const ocrGeometry: QuadGeometry = {
  type: "quad",
  points: [{ x: 0.12, y: 0.18 }, { x: 0.84, y: 0.15 }, { x: 0.86, y: 0.29 }, { x: 0.11, y: 0.31 }],
  bbox: { x: 0.11, y: 0.15, width: 0.75, height: 0.16 },
};
const guides = defaultCylindricalGuides();
guides.horizontalGuides[1]![2] = { x: 0.5, y: 0.44 };
const labelRectification = { type: "guided-cylindrical" as const, guides, controls: buildCylindricalControls(guides), transform: buildCylindricalTransform(guides) };

async function main() {
  const client = await pool.connect();
  const source = "svoe_vino";
  const sourceItemId = `quad-roundtrip-${randomUUID()}`;
  const proposalId = randomUUID();
  const annotationId = randomUUID();
  const cropId = randomUUID();
  const ocrRunId = randomUUID();
  const annotationSetId = randomUUID();
  const ocrAnnotationId = randomUUID();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO meta.detection_proposals
       (id, source, source_item_id, detector_type, detector_version, bbox, geometry, rectification, candidates)
       VALUES ($1,$2,$3,'roundtrip-probe','1',$4::jsonb,$5::jsonb,$6::jsonb,'[]'::jsonb)`,
      [proposalId, source, sourceItemId, JSON.stringify(labelGeometry.bbox), JSON.stringify(labelGeometry), JSON.stringify(labelRectification)],
    );
    await client.query(
      `INSERT INTO meta.image_annotations
       (id, source, source_item_id, annotation_type, bbox, geometry, rectification, status, source_kind, suggestion_id)
       VALUES ($1,$2,$3,'label-bbox',$4::jsonb,$5::jsonb,$6::jsonb,'reviewed','corrected-generated',$7)`,
      [annotationId, source, sourceItemId, JSON.stringify(labelGeometry.bbox), JSON.stringify(labelGeometry), JSON.stringify(labelRectification), proposalId],
    );
    await client.query(
      `INSERT INTO meta.label_crops
       (id, source, source_item_id, annotation_id, annotation_revision, bbox, geometry, width, height, asset_path)
       VALUES ($1,$2,$3,$4,1,$5::jsonb,$6::jsonb,560,840,'probe/quad.webp')`,
      [cropId, source, sourceItemId, annotationId, JSON.stringify(labelGeometry.bbox), JSON.stringify(labelGeometry)],
    );
    await client.query(
      `INSERT INTO meta.ocr_runs
       (id, source, source_item_id, crop_id, execution_mode, engine, raw_text, normalized_text, status)
       VALUES ($1,$2,$3,$4,'roundtrip-probe','probe','TEST','test','completed')`,
      [ocrRunId, source, sourceItemId, cropId],
    );
    await client.query(
      `INSERT INTO meta.ocr_region_annotation_sets
       (id, source, source_item_id, ocr_run_id, revision, status)
       VALUES ($1,$2,$3,$4,1,'reviewed')`,
      [annotationSetId, source, sourceItemId, ocrRunId],
    );
    await client.query(
      `INSERT INTO meta.ocr_region_annotations
       (id, annotation_set_id, level, bbox, geometry, text, normalized_text, status, source_kind, transcription_status)
       VALUES ($1,$2,'string',$3::jsonb,$4::jsonb,'TEST','test','reviewed','manual','verified')`,
      [ocrAnnotationId, annotationSetId, JSON.stringify(ocrGeometry.bbox), JSON.stringify(ocrGeometry)],
    );

    const result = await client.query(
      `SELECT a.geometry AS label_geometry, a.rectification AS label_rectification,
              p.rectification AS prediction_rectification, c.geometry AS crop_geometry, r.geometry AS ocr_geometry
       FROM meta.image_annotations a
       JOIN meta.detection_proposals p ON p.id = a.suggestion_id
       JOIN meta.label_crops c ON c.annotation_id = a.id
       JOIN meta.ocr_runs o ON o.crop_id = c.id
       JOIN meta.ocr_region_annotation_sets s ON s.ocr_run_id = o.id
       JOIN meta.ocr_region_annotations r ON r.annotation_set_id = s.id
       WHERE a.id = $1`,
      [annotationId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const storedLabel = normalizeQuadGeometry(row?.label_geometry);
    const storedCrop = normalizeQuadGeometry(row?.crop_geometry);
    const storedOcr = normalizeQuadGeometry(row?.ocr_geometry);
    if (!storedLabel || !sameQuad(storedLabel, labelGeometry)) throw new Error("Label quad failed DB round-trip");
    if (!storedCrop || !sameQuad(storedCrop, labelGeometry)) throw new Error("Crop quad failed DB round-trip");
    if (!storedOcr || !sameQuad(storedOcr, ocrGeometry)) throw new Error("OCR quad failed DB round-trip");
    const storedRectification = normalizeLabelRectification(row?.label_rectification);
    const storedPrediction = normalizeLabelRectification(row?.prediction_rectification);
    if (JSON.stringify(storedRectification) !== JSON.stringify(labelRectification)) throw new Error("Reviewed Label rectification failed DB round-trip");
    if (JSON.stringify(storedPrediction) !== JSON.stringify(labelRectification)) throw new Error("Predicted Label rectification failed DB round-trip");

    console.log(JSON.stringify({
      ok: true,
      rolledBack: true,
      flow: ["label PUT", "detection_proposals.rectification", "image_annotations.rectification", "label_crops.geometry", "ocr_region_annotations.geometry", "reviewed JSON"],
      reviewed: { labelRoi: { geometry: storedLabel, bbox: storedLabel.bbox, rectification: storedRectification }, ocrRegions: [{ geometry: storedOcr, bbox: storedOcr.bbox }] },
    }, null, 2));
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(closePool);
