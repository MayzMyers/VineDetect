CREATE TABLE IF NOT EXISTS meta.annotation_tracks (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    name TEXT,
    source_asset_ref TEXT,
    target_region JSONB,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in-progress', 'reviewed', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_item_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_annotation_tracks_item
    ON meta.annotation_tracks (source, source_item_id, ordinal);

CREATE TABLE IF NOT EXISTS meta.annotation_track_states (
    annotation_track_id UUID PRIMARY KEY REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE,
    visual_features JSONB NOT NULL DEFAULT '{}'::jsonb,
    annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

WITH item_keys AS (
    SELECT source, source_item_id FROM meta.items
    UNION SELECT source, source_item_id FROM meta.detection_proposals
    UNION SELECT source, source_item_id FROM meta.image_annotations
    UNION SELECT source, source_item_id FROM meta.label_crops
    UNION SELECT source, source_item_id FROM meta.ocr_runs
    UNION SELECT source, source_item_id FROM meta.ocr_text_annotations
    UNION SELECT source, source_item_id FROM meta.ocr_region_annotation_sets
    UNION SELECT source, source_item_id FROM meta.ocr_source_association_sets
    UNION SELECT source, source_item_id FROM meta.alias_annotation_sets
    UNION SELECT source, source_item_id FROM meta.label_analysis_reviews
    UNION SELECT source, source_item_id FROM meta.catalog_identity_reviews
    UNION SELECT source, source_item_id FROM meta.wizard_stage_executions
)
INSERT INTO meta.annotation_tracks (id, source, source_item_id, ordinal, name, status)
SELECT (
         substr(md5(source || E'\x1f' || source_item_id), 1, 8) || '-' ||
         substr(md5(source || E'\x1f' || source_item_id), 9, 4) || '-5' ||
         substr(md5(source || E'\x1f' || source_item_id), 14, 3) || '-8' ||
         substr(md5(source || E'\x1f' || source_item_id), 18, 3) || '-' ||
         substr(md5(source || E'\x1f' || source_item_id), 21, 12)
       )::uuid,
       source, source_item_id, 1, 'Annotation 1',
       CASE WHEN EXISTS (
           SELECT 1 FROM meta.image_annotations annotation
           WHERE annotation.source = item_keys.source
             AND annotation.source_item_id = item_keys.source_item_id
             AND annotation.status = 'reviewed'
       ) THEN 'in-progress' ELSE 'draft' END
FROM item_keys
ON CONFLICT (source, source_item_id, ordinal) DO NOTHING;

INSERT INTO meta.annotation_track_states (annotation_track_id, visual_features, annotations, status, created_at, updated_at)
SELECT track.id, item.visual_features, item.annotations, item.status, item.created_at, item.updated_at
FROM meta.annotation_tracks track
JOIN meta.items item ON item.source = track.source AND item.source_item_id = track.source_item_id
WHERE track.ordinal = 1
ON CONFLICT (annotation_track_id) DO NOTHING;

INSERT INTO meta.annotation_track_states (annotation_track_id)
SELECT id FROM meta.annotation_tracks
ON CONFLICT (annotation_track_id) DO NOTHING;

ALTER TABLE meta.detection_proposals ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.image_annotations ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.label_crops ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.ocr_runs ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.ocr_text_annotations ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.ocr_region_annotation_sets ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.ocr_source_association_sets ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.alias_annotation_sets ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.label_analysis_reviews ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.catalog_identity_reviews ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.wizard_stage_executions ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.generation_jobs ADD COLUMN IF NOT EXISTS annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE SET NULL;

UPDATE meta.detection_proposals row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;
UPDATE meta.image_annotations row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;
UPDATE meta.label_crops row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;
UPDATE meta.ocr_runs row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;
UPDATE meta.ocr_text_annotations row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;
UPDATE meta.ocr_region_annotation_sets row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;
UPDATE meta.ocr_source_association_sets row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;
UPDATE meta.alias_annotation_sets row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;
UPDATE meta.label_analysis_reviews row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;
UPDATE meta.catalog_identity_reviews row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;
UPDATE meta.wizard_stage_executions row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;
UPDATE meta.generation_jobs row SET annotation_track_id = track.id FROM meta.annotation_tracks track WHERE row.annotation_track_id IS NULL AND row.source_item_id IS NOT NULL AND track.source = row.source AND track.source_item_id = row.source_item_id AND track.ordinal = 1;

ALTER TABLE meta.ocr_region_annotation_sets DROP CONSTRAINT IF EXISTS ocr_region_annotation_sets_source_source_item_id_revision_key;
ALTER TABLE meta.ocr_region_annotation_sets DROP CONSTRAINT IF EXISTS ocr_region_annotation_sets_track_revision_key;
ALTER TABLE meta.ocr_region_annotation_sets ADD CONSTRAINT ocr_region_annotation_sets_track_revision_key UNIQUE (annotation_track_id, revision);
ALTER TABLE meta.ocr_source_association_sets DROP CONSTRAINT IF EXISTS ocr_source_association_sets_source_source_item_id_revision_key;
ALTER TABLE meta.ocr_source_association_sets DROP CONSTRAINT IF EXISTS ocr_source_association_sets_track_revision_key;
ALTER TABLE meta.ocr_source_association_sets ADD CONSTRAINT ocr_source_association_sets_track_revision_key UNIQUE (annotation_track_id, revision);
ALTER TABLE meta.alias_annotation_sets DROP CONSTRAINT IF EXISTS alias_annotation_sets_source_source_item_id_revision_key;
ALTER TABLE meta.alias_annotation_sets DROP CONSTRAINT IF EXISTS alias_annotation_sets_track_revision_key;
ALTER TABLE meta.alias_annotation_sets ADD CONSTRAINT alias_annotation_sets_track_revision_key UNIQUE (annotation_track_id, revision);
ALTER TABLE meta.label_analysis_reviews DROP CONSTRAINT IF EXISTS label_analysis_reviews_source_source_item_id_revision_key;
ALTER TABLE meta.label_analysis_reviews DROP CONSTRAINT IF EXISTS label_analysis_reviews_track_revision_key;
ALTER TABLE meta.label_analysis_reviews ADD CONSTRAINT label_analysis_reviews_track_revision_key UNIQUE (annotation_track_id, revision);
ALTER TABLE meta.catalog_identity_reviews DROP CONSTRAINT IF EXISTS catalog_identity_reviews_source_source_item_id_revision_key;
ALTER TABLE meta.catalog_identity_reviews DROP CONSTRAINT IF EXISTS catalog_identity_reviews_track_revision_key;
ALTER TABLE meta.catalog_identity_reviews ADD CONSTRAINT catalog_identity_reviews_track_revision_key UNIQUE (annotation_track_id, revision);
ALTER TABLE meta.wizard_stage_executions DROP CONSTRAINT IF EXISTS wizard_stage_executions_source_source_item_id_stage_revision_key;
ALTER TABLE meta.wizard_stage_executions DROP CONSTRAINT IF EXISTS wizard_stage_executions_track_stage_revision_key;
ALTER TABLE meta.wizard_stage_executions ADD CONSTRAINT wizard_stage_executions_track_stage_revision_key UNIQUE (annotation_track_id, stage, revision);

DROP INDEX IF EXISTS meta.idx_wizard_stage_executions_active;
CREATE UNIQUE INDEX idx_wizard_stage_executions_active
    ON meta.wizard_stage_executions (annotation_track_id, stage)
    WHERE status = 'started';

CREATE INDEX IF NOT EXISTS idx_detection_proposals_track_created ON meta.detection_proposals (annotation_track_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_image_annotations_track_updated ON meta.image_annotations (annotation_track_id, annotation_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_label_crops_track_created ON meta.label_crops (annotation_track_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ocr_runs_track_created ON meta.ocr_runs (annotation_track_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wizard_stage_executions_track ON meta.wizard_stage_executions (annotation_track_id, stage, revision DESC);

DROP VIEW IF EXISTS meta.wizard_stage_execution_records;
CREATE VIEW meta.wizard_stage_execution_records AS
SELECT execution.*,
  COALESCE((
    SELECT jsonb_agg(to_jsonb(run) ORDER BY run.run_index)
    FROM meta.wizard_helper_runs run
    WHERE run.stage_execution_id = execution.id
  ), '[]'::jsonb) AS helper_runs
FROM meta.wizard_stage_executions execution;

COMMENT ON TABLE meta.annotation_tracks IS 'Independent full annotation workflows for one catalog item; source assets may be shared by multiple tracks.';
COMMENT ON TABLE meta.annotation_track_states IS 'Track-scoped JSON state formerly stored only in meta.items visual_features/annotations.';
