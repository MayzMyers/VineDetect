ALTER TABLE meta.annotation_labels
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS cv_crop JSONB,
  ADD COLUMN IF NOT EXISTS cv_job JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_annotation_labels_cv_state
  ON meta.annotation_labels (package_id, revision, updated_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN meta.annotation_labels.revision IS 'Revision of reviewed Label geometry/rectification; CV state is invalidated when it changes.';
COMMENT ON COLUMN meta.annotation_labels.cv_crop IS 'Derived rectified crop descriptor for this canonical Label.';
COMMENT ON COLUMN meta.annotation_labels.cv_job IS 'Label-scoped Mask-to-Palette checkpoints and reviewed outputs.';
