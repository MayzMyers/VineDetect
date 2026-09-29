-- A canonical Label is a generic VisualRegion. Classification is reviewed
-- separately so generic regions are never silently exported as physical-label
-- ground truth.

ALTER TABLE meta.annotation_labels
  ADD COLUMN IF NOT EXISTS visual_region_kind TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS visual_region_kind_status TEXT NOT NULL DEFAULT 'unreviewed';

ALTER TABLE meta.annotation_labels
  DROP CONSTRAINT IF EXISTS annotation_labels_visual_region_kind_check;
ALTER TABLE meta.annotation_labels
  ADD CONSTRAINT annotation_labels_visual_region_kind_check CHECK (
    visual_region_kind IN ('physical-label', 'direct-print', 'text-only', 'graphic-only', 'mixed', 'other', 'unknown')
  );

ALTER TABLE meta.annotation_labels
  DROP CONSTRAINT IF EXISTS annotation_labels_visual_region_kind_status_check;
ALTER TABLE meta.annotation_labels
  ADD CONSTRAINT annotation_labels_visual_region_kind_status_check CHECK (
    visual_region_kind_status IN ('unreviewed', 'reviewed')
  );

ALTER TABLE meta.training_runs DROP CONSTRAINT IF EXISTS training_runs_task_check;
ALTER TABLE meta.training_runs ADD CONSTRAINT training_runs_task_check CHECK (task IN (
  'label-roi', 'physical-label-roi', 'ocr-region', 'source-matching', 'alias-ranking',
  'bottle-outline', 'label-elements', 'label-palette'
));

ALTER TABLE meta.model_versions DROP CONSTRAINT IF EXISTS model_versions_task_check;
ALTER TABLE meta.model_versions ADD CONSTRAINT model_versions_task_check CHECK (task IN (
  'label-roi', 'physical-label-roi', 'ocr-region', 'source-matching', 'alias-ranking',
  'bottle-outline', 'label-elements', 'label-palette'
));
