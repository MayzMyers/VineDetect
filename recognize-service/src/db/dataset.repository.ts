import { createHash, randomUUID } from "node:crypto";
import { pool } from "./pool.js";
import { ConflictError, NotFoundError } from "../shared/errors.js";
import type { SourceName } from "../shared/types.js";
import type { HelperConfigContract, HelperConfigRecord } from "../shared/helperConfigContract.js";
import { buildStageSamplesV1 } from "../shared/stageSampleContract.js";
import { getAnnotationGraphWithClient } from "./annotation-graph.repository.js";

type ItemKey = { source: SourceName; sourceItemId: string };

export async function listCohorts() {
  const result = await pool.query(`
    SELECT c.*, COUNT(i.source)::int AS item_count,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', v.id::text, 'name', v.name, 'version', v.version, 'schemaVersion', v.schema_version,
          'status', v.status, 'itemCount', v.item_count, 'manifest', v.manifest, 'createdAt', v.created_at,
          'artifacts', COALESCE((SELECT json_agg(json_build_object(
            'id', a.id::text, 'datasetVersionId', a.dataset_version_id::text, 'artifactType', a.artifact_type,
            'outputPath', a.output_path, 'annotationsSha256', a.annotations_sha256, 'manifest', a.manifest, 'createdAt', a.created_at
          ) ORDER BY a.created_at DESC) FROM meta.dataset_artifacts a WHERE a.dataset_version_id = v.id), '[]'::json)
        ) ORDER BY v.version DESC)
        FROM meta.dataset_versions AS v WHERE v.cohort_id = c.id
      ), '[]'::json) AS versions
    FROM meta.annotation_cohorts AS c
    LEFT JOIN meta.annotation_cohort_items AS i ON i.cohort_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `);
  return result.rows.map((row) => ({
    id: String(row.id), name: String(row.name), description: nullableString(row.description),
    status: String(row.status), itemCount: Number(row.item_count ?? 0), createdBy: nullableString(row.created_by),
    createdAt: dateString(row.created_at), frozenAt: row.frozen_at ? dateString(row.frozen_at) : null,
    versions: Array.isArray(row.versions) ? row.versions : [],
  }));
}

export async function createCohort(input: { name: string; description?: string; createdBy?: string; items: ItemKey[] }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const id = randomUUID();
    const cohort = await client.query(
      `INSERT INTO meta.annotation_cohorts (id, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, input.name, input.description ?? null, input.createdBy ?? null],
    );
    for (const item of input.items) {
      await client.query(
        `INSERT INTO meta.annotation_cohort_items (cohort_id, source, source_item_id) VALUES ($1, $2, $3)`,
        [id, item.source, item.sourceItemId],
      );
    }
    await client.query("COMMIT");
    const row = cohort.rows[0];
    return { id, name: String(row.name), description: nullableString(row.description), status: String(row.status), itemCount: input.items.length, createdAt: dateString(row.created_at), versions: [] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createDatasetVersion(cohortId: string, input: { name: string; createdBy?: string }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`dataset:${cohortId}`]);
    const cohort = await client.query(`SELECT * FROM meta.annotation_cohorts WHERE id = $1 FOR UPDATE`, [cohortId]);
    if (!cohort.rowCount) throw new NotFoundError("Annotation cohort not found");
    if (cohort.rows[0].status === "archived") throw new ConflictError("Archived cohort cannot create dataset versions");
    const items = await client.query(
      `SELECT source, source_item_id FROM meta.annotation_cohort_items WHERE cohort_id = $1 ORDER BY source, source_item_id`,
      [cohortId],
    );
    if (!items.rowCount) throw new ConflictError("Cohort has no items");

    const snapshots: Array<{ source: string; sourceItemId: string; split: "train" | "validation" | "test"; snapshot: Record<string, unknown>; hash: string }> = [];
    for (const item of items.rows) {
      const snapshotResult = await client.query(SNAPSHOT_SQL, [item.source, item.source_item_id]);
      const rawSnapshot = snapshotResult.rows[0]?.snapshot as Record<string, unknown> | undefined;
      const annotationGraph = await getAnnotationGraphWithClient(client, String(item.source) as SourceName, String(item.source_item_id));
      const hasReviewedCanonicalLabel = annotationGraph.packages.some((packageItem) => packageItem.labels.some((label) => label.status === "reviewed"));
      if (!rawSnapshot || (rawSnapshot.label === null && !hasReviewedCanonicalLabel)) {
        throw new ConflictError(`Item has no reviewed label annotation: ${item.source}:${item.source_item_id}`);
      }
      const snapshot = { ...attachStageSamples(rawSnapshot, String(item.source), String(item.source_item_id)), schemaVersion: 5, annotationGraph };
      const serialized = stableJson(snapshot);
      snapshots.push({
        source: String(item.source), sourceItemId: String(item.source_item_id), snapshot,
        split: splitForId(`${item.source}:${item.source_item_id}`),
        hash: createHash("sha256").update(serialized).digest("hex"),
      });
    }

    const versionResult = await client.query(`SELECT COALESCE(MAX(version), 0)::int + 1 AS version FROM meta.dataset_versions WHERE cohort_id = $1`, [cohortId]);
    const version = Number(versionResult.rows[0].version);
    const id = randomUUID();
    const manifest = buildManifest(snapshots);
    const inserted = await client.query(
      `INSERT INTO meta.dataset_versions (id, cohort_id, name, version, schema_version, item_count, manifest, created_by)
       VALUES ($1, $2, $3, $4, 5, $5, $6, $7) RETURNING *`,
      [id, cohortId, input.name, version, snapshots.length, JSON.stringify(manifest), input.createdBy ?? null],
    );
    for (const item of snapshots) {
      await client.query(
        `INSERT INTO meta.dataset_version_items (dataset_version_id, source, source_item_id, split, snapshot, snapshot_hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, item.source, item.sourceItemId, item.split, JSON.stringify(item.snapshot), item.hash],
      );
    }
    await client.query(`UPDATE meta.annotation_cohorts SET status = 'frozen', frozen_at = COALESCE(frozen_at, now()) WHERE id = $1`, [cohortId]);
    await client.query("COMMIT");
    const row = inserted.rows[0];
    return { id, cohortId, name: String(row.name), version, schemaVersion: Number(row.schema_version), status: "frozen", itemCount: snapshots.length, manifest, createdAt: dateString(row.created_at) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getDatasetVersionBundle(datasetVersionId: string) {
  const versionResult = await pool.query(
    `SELECT v.*, c.name AS cohort_name FROM meta.dataset_versions v JOIN meta.annotation_cohorts c ON c.id = v.cohort_id WHERE v.id = $1`,
    [datasetVersionId],
  );
  if (!versionResult.rowCount) throw new NotFoundError("Dataset version not found");
  const row = versionResult.rows[0];
  if (row.status !== "frozen") throw new ConflictError("Only frozen dataset versions can be exported");
  const items = await pool.query(
    `SELECT source, source_item_id, split, snapshot, snapshot_hash FROM meta.dataset_version_items WHERE dataset_version_id = $1 ORDER BY source, source_item_id`,
    [datasetVersionId],
  );
  return {
    version: {
      id: String(row.id), cohortId: String(row.cohort_id), cohortName: String(row.cohort_name),
      name: String(row.name), version: Number(row.version), schemaVersion: Number(row.schema_version),
      status: String(row.status), itemCount: Number(row.item_count), manifest: objectValue(row.manifest),
      createdAt: dateString(row.created_at),
    },
    items: items.rows.map((item) => ({
      source: String(item.source), sourceItemId: String(item.source_item_id),
      split: String(item.split) as "train" | "validation" | "test",
      snapshot: objectValue(item.snapshot), snapshotHash: String(item.snapshot_hash),
    })),
  };
}

const SNAPSHOT_SQL = `
  WITH latest_region_set AS (
    SELECT * FROM meta.ocr_region_annotation_sets
    WHERE source = $1 AND source_item_id = $2 AND status = 'reviewed'
    ORDER BY revision DESC LIMIT 1
  ), latest_association_set AS (
    SELECT * FROM meta.ocr_source_association_sets
    WHERE source = $1 AND source_item_id = $2 AND status = 'reviewed'
      AND ocr_region_annotation_set_id = (SELECT id FROM latest_region_set)
    ORDER BY revision DESC LIMIT 1
  ), latest_ocr_run AS (
    SELECT * FROM meta.ocr_runs
    WHERE id = (SELECT ocr_run_id FROM latest_region_set)
  )
  SELECT jsonb_build_object(
    'schemaVersion', 4, 'source', $1::text, 'sourceItemId', $2::text,
    'label', (SELECT to_jsonb(a) FROM meta.image_annotations a WHERE a.source = $1 AND a.source_item_id = $2 AND a.annotation_type = 'label-bbox' AND a.status = 'reviewed' ORDER BY a.revision DESC LIMIT 1),
    'labelRoi', (SELECT jsonb_build_object(
      'schemaVersion', 2,
      'prediction', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', p.id::text, 'candidateId', p.helper_candidate_id, 'roi', p.bbox, 'rectification', p.rectification, 'confidence', p.confidence,
        'algorithm', jsonb_build_object(
          'id', p.detector_type, 'version', p.detector_version,
          'params', COALESCE(p.config_snapshot->'params', p.config_snapshot, '{}'::jsonb),
          'defaultParams', p.config_snapshot->'defaultParams'
        ), 'createdAt', p.created_at
      ) END,
      'annotation', jsonb_build_object('id', a.id::text, 'revision', a.revision, 'roi', a.bbox, 'rectification', a.rectification, 'reviewedAt', a.updated_at, 'reviewedBy', a.reviewed_by),
      'reviewed', true,
      'roiEdited', a.source_kind = 'corrected-generated',
      'source', CASE WHEN p.id IS NULL THEN 'manual' WHEN a.source_kind = 'corrected-generated' THEN 'corrected' ELSE 'auto' END,
      'iou', NULL,
      'labelRoiGt', true
    ) FROM meta.image_annotations a LEFT JOIN meta.detection_proposals p ON p.id = a.suggestion_id
      WHERE a.source = $1 AND a.source_item_id = $2 AND a.annotation_type = 'label-bbox' AND a.status = 'reviewed'
      ORDER BY a.revision DESC LIMIT 1),
    'ocrText', (SELECT to_jsonb(t) FROM meta.ocr_text_annotations t WHERE t.source = $1 AND t.source_item_id = $2 AND t.status = 'reviewed' ORDER BY t.revision DESC LIMIT 1),
    'ocrRegions', (SELECT to_jsonb(s) || jsonb_build_object('regions', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.sort_order, r.id) FROM meta.ocr_region_annotations r WHERE r.annotation_set_id = s.id AND r.status = 'reviewed'), '[]'::jsonb)) FROM latest_region_set s),
    'sourceAssociations', (SELECT to_jsonb(s) || jsonb_build_object('associations', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.sort_order, a.id) FROM meta.ocr_source_associations a WHERE a.association_set_id = s.id AND a.status = 'reviewed'), '[]'::jsonb)) FROM latest_association_set s),
    'aliases', (SELECT to_jsonb(s) || jsonb_build_object('aliases', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.sort_order, a.id) FROM meta.alias_annotations a WHERE a.annotation_set_id = s.id AND a.status = 'reviewed'), '[]'::jsonb)) FROM meta.alias_annotation_sets s WHERE s.source = $1 AND s.source_item_id = $2 AND s.status = 'reviewed' AND s.source_association_set_id IS NOT DISTINCT FROM (SELECT id FROM latest_association_set) ORDER BY s.revision DESC LIMIT 1),
    'catalogIdentity', (SELECT to_jsonb(r) FROM meta.catalog_identity_reviews r WHERE r.source = $1 AND r.source_item_id = $2 ORDER BY r.revision DESC LIMIT 1),
    'analysisReview', (SELECT to_jsonb(r) FROM meta.label_analysis_reviews r WHERE r.source = $1 AND r.source_item_id = $2 ORDER BY r.revision DESC LIMIT 1),
    'stageExecutions', COALESCE((SELECT jsonb_agg(to_jsonb(execution) ORDER BY execution.stage)
      FROM (SELECT DISTINCT ON (e.stage) e.* FROM meta.wizard_stage_execution_records e
        WHERE e.source = $1 AND e.source_item_id = $2 AND e.status <> 'superseded' ORDER BY e.stage, e.revision DESC) execution), '[]'::jsonb),
    'vision', (SELECT jsonb_build_object(
      'annotations', jsonb_build_object(
        'bottle', m.visual_features #> '{labelSourceAnalysis,bottleDetection,annotation}',
        'bottlePalette', COALESCE(m.visual_features #> '{labelSourceAnalysis,bottleDetection,palette}', '[]'::jsonb),
        'componentDecisions', COALESCE(m.visual_features #> '{labelCvJob,review,componentDecisions}', '{}'::jsonb),
        'elements', COALESCE((
          SELECT jsonb_agg(element ORDER BY element->>'id')
          FROM jsonb_array_elements(COALESCE(m.visual_features #> '{labelCvJob,preview,elements}', '[]'::jsonb)) AS element
          WHERE element->>'status' IN ('accepted', 'rejected')
        ), '[]'::jsonb),
        'contours', COALESCE((
          SELECT jsonb_agg(contour ORDER BY contour->>'elementId')
          FROM jsonb_array_elements(COALESCE(m.visual_features #> '{labelCvJob,preview,contours}', '[]'::jsonb)) AS contour
          WHERE contour->>'elementId' IN (
            SELECT element->>'id'
            FROM jsonb_array_elements(COALESCE(m.visual_features #> '{labelCvJob,preview,elements}', '[]'::jsonb)) AS element
            WHERE element->>'status' = 'accepted'
          )
        ), '[]'::jsonb),
        'palette', COALESCE(m.visual_features #> '{labelCvJob,palette}', '[]'::jsonb)
      ),
      'cvMeta', jsonb_build_object(
        'config', COALESCE(m.visual_features #> '{labelCvJob,config}', '{}'::jsonb),
        'helpers', jsonb_build_object(
          'schemaVersion', 1,
          'records',
            (CASE WHEN m.visual_features #> '{labelSourceAnalysis,winningDetection,config}' IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
              'helperId', 'label-roi-detection',
              'algorithm', COALESCE(m.visual_features #>> '{labelSourceAnalysis,algorithm}', 'unknown'),
              'configSchemaVersion', 1,
              'config', m.visual_features #> '{labelSourceAnalysis,winningDetection,config}',
              'role', 'conditioning-input',
              'provenance', jsonb_build_object('source', 'reviewed-run', 'runId', m.visual_features #> '{labelSourceAnalysis,runId}', 'savedAt', m.visual_features #> '{labelSourceAnalysis,savedAt}', 'modelVersionId', NULL),
              'review', jsonb_build_object('status', 'reviewed', 'targetRef', 'label')
            )) ELSE '[]'::jsonb END)
            || (CASE WHEN m.visual_features #> '{labelSourceAnalysis,bottleDetection,config}' IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
              'helperId', 'bottle-outline',
              'algorithm', COALESCE(m.visual_features #>> '{labelSourceAnalysis,bottleDetection,algorithm}', 'unknown'),
              'configSchemaVersion', 1,
              'config', m.visual_features #> '{labelSourceAnalysis,bottleDetection,config}',
              'role', 'conditioning-input',
              'provenance', jsonb_build_object('source', 'reviewed-run', 'runId', m.visual_features #> '{labelSourceAnalysis,runId}', 'savedAt', m.visual_features #> '{labelSourceAnalysis,savedAt}', 'modelVersionId', NULL),
              'review', jsonb_build_object('status', COALESCE(m.visual_features #>> '{labelSourceAnalysis,bottleDetection,annotation,status}', 'unreviewed'), 'targetRef', 'vision.annotations.bottle')
            )) ELSE '[]'::jsonb END)
            || (CASE WHEN (SELECT evidence FROM latest_ocr_run) IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
              'helperId', 'label-ocr-cascade',
              'algorithm', COALESCE((SELECT evidence->>'profileVersion' FROM latest_ocr_run), 'ocr-cascade-unknown'),
              'configSchemaVersion', 1,
              'config', jsonb_build_object('profileVersion', (SELECT evidence->'profileVersion' FROM latest_ocr_run), 'passes', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'id', pass->'id', 'stage', pass->'stage', 'region', pass->'region', 'preprocess', pass->'preprocess', 'psm', pass->'psm', 'minWidth', pass->'minWidth', 'weight', pass->'weight', 'deskewAngleDegrees', pass->'deskewAngleDegrees', 'rotationDegrees', pass->'rotationDegrees'
              )) FROM jsonb_array_elements(COALESCE((SELECT evidence->'passes' FROM latest_ocr_run), '[]'::jsonb)) pass), '[]'::jsonb)),
              'role', 'conditioning-input',
              'provenance', jsonb_build_object('source', 'reviewed-run', 'runId', (SELECT to_jsonb(id::text) FROM latest_ocr_run), 'savedAt', NULL, 'modelVersionId', NULL),
              'review', jsonb_build_object('status', 'reviewed', 'targetRef', 'ocrRegions')
            )) ELSE '[]'::jsonb END)
            || (CASE WHEN m.visual_features #> '{labelCvJob,config}' IS NOT NULL THEN jsonb_build_array(
              jsonb_build_object('helperId','label-mask','algorithm','binary-mask-variant-search-v1','configSchemaVersion',1,'config',jsonb_build_object('maskMode',COALESCE(m.visual_features #> '{labelCvJob,config,maskMode}','"manual"'::jsonb),'threshold',m.visual_features #> '{labelCvJob,config,threshold}','invert',m.visual_features #> '{labelCvJob,config,invert}','maskSize',m.visual_features #> '{labelCvJob,config,maskSize}'),'role','conditioning-input','provenance',jsonb_build_object('source','reviewed-run','runId',m.visual_features #> '{labelCvJob,analysisJobId}','savedAt',m.visual_features #> '{labelCvJob,reviewedAt}','modelVersionId',NULL),'review',jsonb_build_object('status',COALESCE(m.visual_features #>> '{labelCvJob,workflow,checkpoints,mask,status}','unreviewed'),'targetRef','vision.cvMeta.mask')),
              jsonb_build_object('helperId','label-morphology','algorithm','label-morphology-v1','configSchemaVersion',1,'config',jsonb_build_object('morphologyEnabled',m.visual_features #> '{labelCvJob,config,morphologyEnabled}','morphologyOperation',m.visual_features #> '{labelCvJob,config,morphologyOperation}','morphologyKernelWidth',m.visual_features #> '{labelCvJob,config,morphologyKernelWidth}','morphologyKernelHeight',m.visual_features #> '{labelCvJob,config,morphologyKernelHeight}','morphologyIterations',m.visual_features #> '{labelCvJob,config,morphologyIterations}','morphologyMode',m.visual_features #> '{labelCvJob,config,morphologyMode}'),'role','conditioning-input','provenance',jsonb_build_object('source','reviewed-run','runId',m.visual_features #> '{labelCvJob,analysisJobId}','savedAt',m.visual_features #> '{labelCvJob,reviewedAt}','modelVersionId',NULL),'review',jsonb_build_object('status',COALESCE(m.visual_features #>> '{labelCvJob,workflow,checkpoints,morphology,status}','unreviewed'),'targetRef','vision.cvMeta.morphology')),
              jsonb_build_object('helperId','label-components','algorithm','connected-components-v2','configSchemaVersion',1,'config',jsonb_build_object('componentFilterPreset',m.visual_features #> '{labelCvJob,config,componentFilterPreset}','componentMode',m.visual_features #> '{labelCvJob,config,componentMode}','componentConnectivity',m.visual_features #> '{labelCvJob,config,componentConnectivity}','minComponentAreaRatio',m.visual_features #> '{labelCvJob,config,minComponentAreaRatio}','maxComponentAreaRatio',m.visual_features #> '{labelCvJob,config,maxComponentAreaRatio}'),'role','conditioning-input','provenance',jsonb_build_object('source','reviewed-run','runId',m.visual_features #> '{labelCvJob,analysisJobId}','savedAt',m.visual_features #> '{labelCvJob,reviewedAt}','modelVersionId',NULL),'review',jsonb_build_object('status',COALESCE(m.visual_features #>> '{labelCvJob,workflow,checkpoints,components,status}','unreviewed'),'targetRef','vision.annotations.componentDecisions')),
              jsonb_build_object('helperId','label-elements','algorithm','element-grouping-v1','configSchemaVersion',1,'config',jsonb_build_object('groupingPrimary','ocr-overlap','groupingFallback','proximity-alignment'),'role','conditioning-input','provenance',jsonb_build_object('source','reviewed-run','runId',m.visual_features #> '{labelCvJob,analysisJobId}','savedAt',m.visual_features #> '{labelCvJob,reviewedAt}','modelVersionId',NULL),'review',jsonb_build_object('status',COALESCE(m.visual_features #>> '{labelCvJob,workflow,checkpoints,elements,status}','unreviewed'),'targetRef','vision.annotations.elements')),
              jsonb_build_object('helperId','label-contours','algorithm','component-contours-v2','configSchemaVersion',1,'config',jsonb_build_object('maxContourPoints',m.visual_features #> '{labelCvJob,config,maxContourPoints}','contourDetail',m.visual_features #> '{labelCvJob,config,contourDetail}','contourSimplifyRatio',m.visual_features #> '{labelCvJob,config,contourSimplifyRatio}','contourVectorization',m.visual_features #> '{labelCvJob,config,contourVectorization}'),'role','conditioning-input','provenance',jsonb_build_object('source','reviewed-run','runId',m.visual_features #> '{labelCvJob,analysisJobId}','savedAt',m.visual_features #> '{labelCvJob,reviewedAt}','modelVersionId',NULL),'review',jsonb_build_object('status',COALESCE(m.visual_features #>> '{labelCvJob,workflow,checkpoints,contours,status}','unreviewed'),'targetRef','vision.annotations.contours')),
              jsonb_build_object('helperId','label-palette','algorithm','label-palette-v1','configSchemaVersion',1,'config',jsonb_build_object('paletteColors',m.visual_features #> '{labelCvJob,config,paletteColors}','paletteMinRatio',m.visual_features #> '{labelCvJob,config,paletteMinRatio}'),'role','conditioning-input','provenance',jsonb_build_object('source','reviewed-run','runId',m.visual_features #> '{labelCvJob,analysisJobId}','savedAt',m.visual_features #> '{labelCvJob,reviewedAt}','modelVersionId',NULL),'review',jsonb_build_object('status',COALESCE(m.visual_features #>> '{labelCvJob,workflow,checkpoints,palette,status}','unreviewed'),'targetRef','vision.annotations.palette')),
              jsonb_build_object('helperId','label-summary','algorithm','label-summary-v1','configSchemaVersion',1,'config',jsonb_build_object('sourceMatching','tokenized-catalog-v1','verifiedOcrOnly',true),'role','conditioning-input','provenance',jsonb_build_object('source','reviewed-run','runId',m.visual_features #> '{labelCvJob,analysisJobId}','savedAt',m.visual_features #> '{labelCvJob,reviewedAt}','modelVersionId',NULL),'review',jsonb_build_object('status',CASE WHEN m.visual_features #> '{labelCvJob,review}' IS NULL THEN 'unreviewed' ELSE 'reviewed' END,'targetRef','summary'))
            ) ELSE '[]'::jsonb END)
        ),
        'coordinateSpace', m.visual_features #> '{labelCvJob,preview,cvDebug,source}',
        'bottleCoordinateSpace', m.visual_features #> '{labelSourceAnalysis,sourceImage}',
        'morphologyProposal', m.visual_features #> '{labelCvJob,preview,cvDebug,autoMorphologyConfig}',
        'effectiveMorphology', m.visual_features #> '{labelCvJob,preview,cvDebug,effectiveMorphologyConfig}',
        'morphologyProposalScore', m.visual_features #> '{labelCvJob,preview,cvDebug,autoMorphologyScore}',
        'componentProposals', COALESCE(m.visual_features #> '{labelCvJob,preview,components}', '[]'::jsonb),
        'elementProposals', COALESCE(m.visual_features #> '{labelCvJob,preview,elementProposals}', '[]'::jsonb),
        'rawContours', COALESCE(m.visual_features #> '{labelCvJob,preview,contours}', '[]'::jsonb)
      ),
      'provenance', jsonb_build_object(
        'schemaVersion', m.visual_features #> '{labelCvJob,schemaVersion}',
        'annotationId', m.visual_features #> '{labelCvJob,annotationId}',
        'annotationRevision', m.visual_features #> '{labelCvJob,annotationRevision}',
        'analysisJobId', m.visual_features #> '{labelCvJob,analysisJobId}',
        'reviewedAt', m.visual_features #> '{labelCvJob,reviewedAt}'
      )
    ) FROM meta.items m WHERE m.source = $1 AND m.source_item_id = $2)
  ) AS snapshot
`;

function buildManifest(items: Array<{ split: "train" | "validation" | "test"; snapshot: Record<string, unknown> }>) {
  const count = (key: string) => items.filter((item) => item.snapshot[key] !== null).length;
  return {
    schemaVersion: 5, frozenAt: new Date().toISOString(), itemCount: items.length,
    splits: {
      train: items.filter((item) => item.split === "train").length,
      validation: items.filter((item) => item.split === "validation").length,
      test: items.filter((item) => item.split === "test").length,
    },
    layers: { label: count("label"), ocrText: count("ocrText"), ocrRegions: count("ocrRegions"), sourceAssociations: count("sourceAssociations"), aliases: count("aliases"), catalogIdentity: count("catalogIdentity"), vision: count("vision"), stageSamples: items.filter((item) => Array.isArray(item.snapshot.stageSamples) && item.snapshot.stageSamples.length === 11).length, annotationGraph: count("annotationGraph") },
  };
}

function splitForId(id: string): "train" | "validation" | "test" {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const bucket = Math.abs(hash) % 100;
  return bucket < 70 ? "train" : bucket < 90 ? "validation" : "test";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function attachStageSamples(snapshot: Record<string, unknown>, source: string, sourceItemId: string) {
  const vision = objectValue(snapshot.vision);
  const annotations = objectValue(vision.annotations);
  const cvMeta = objectValue(vision.cvMeta);
  const helperRoot = objectValue(cvMeta.helpers);
  const helperContract: HelperConfigContract = {
    schemaVersion: 1,
    records: arrayValue(helperRoot.records).filter(isHelperConfigRecord),
  };
  const sourceAnalysis = {
    bottleDetection: {
      annotation: annotations.bottle ?? null,
      palette: arrayValue(annotations.bottlePalette),
    },
  };
  const cvJob = {
    config: objectValue(cvMeta.config),
    review: { componentDecisions: objectValue(annotations.componentDecisions), elementsReviewed: true, elements: arrayValue(annotations.elements) },
    preview: {
      cvDebug: {
        source: cvMeta.coordinateSpace ?? null,
        autoMorphologyConfig: cvMeta.morphologyProposal ?? null,
        effectiveMorphologyConfig: cvMeta.effectiveMorphology ?? null,
        autoMorphologyScore: cvMeta.morphologyProposalScore ?? null,
      },
      components: arrayValue(cvMeta.componentProposals),
      elements: arrayValue(annotations.elements),
      contours: arrayValue(annotations.contours),
      palette: arrayValue(annotations.palette),
    },
    palette: arrayValue(annotations.palette),
  };
  return {
    ...snapshot,
    stageSamples: buildStageSamplesV1({
      source, sourceItemId, helperContract, labelRoi: snapshot.labelRoi,
      sourceAnalysis, ocrRegions: snapshot.ocrRegions, sourceAssociations: snapshot.sourceAssociations,
      cvJob, finalReview: snapshot.analysisReview, stageExecutions: snapshot.stageExecutions,
    }),
  };
}

function isHelperConfigRecord(value: unknown): value is HelperConfigRecord {
  const item = objectValue(value);
  return typeof item.helperId === "string" && typeof item.algorithm === "string" && objectValue(item.config) !== null;
}

function arrayValue(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function nullableString(value: unknown) { return value === null || value === undefined ? null : String(value); }
function dateString(value: unknown) { return value instanceof Date ? value.toISOString() : String(value ?? ""); }
function objectValue(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
