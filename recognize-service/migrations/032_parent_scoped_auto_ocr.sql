ALTER TABLE meta.annotation_operations
  ADD COLUMN IF NOT EXISTS scope_type TEXT,
  ADD COLUMN IF NOT EXISTS scope_id UUID,
  ADD COLUMN IF NOT EXISTS helper_output JSONB,
  ADD COLUMN IF NOT EXISTS operation_status TEXT NOT NULL DEFAULT 'reviewed';

ALTER TABLE meta.annotation_operations DROP CONSTRAINT IF EXISTS annotation_operations_operation_type_check;
ALTER TABLE meta.annotation_operations ADD CONSTRAINT annotation_operations_operation_type_check CHECK (operation_type IN (
  'add_package', 'add_label', 'add_ocr', 'add_meta',
  'edit_package', 'edit_label', 'edit_ocr', 'edit_meta',
  'delete_package', 'delete_label', 'delete_ocr', 'delete_meta',
  'run_ocr', 'reparent_ocr', 'run_label_rectification'
));
ALTER TABLE meta.annotation_operations DROP CONSTRAINT IF EXISTS annotation_operations_scope_type_check;
ALTER TABLE meta.annotation_operations ADD CONSTRAINT annotation_operations_scope_type_check CHECK (scope_type IS NULL OR scope_type IN ('package', 'label'));
ALTER TABLE meta.annotation_operations DROP CONSTRAINT IF EXISTS annotation_operations_operation_status_check;
ALTER TABLE meta.annotation_operations ADD CONSTRAINT annotation_operations_operation_status_check CHECK (operation_status IN ('draft', 'reviewed', 'failed'));

ALTER TABLE meta.annotation_candidates
  ADD COLUMN IF NOT EXISTS detection_confidence DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS recognition_confidence DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS suggested_parent_type TEXT,
  ADD COLUMN IF NOT EXISTS suggested_package_id UUID,
  ADD COLUMN IF NOT EXISTS suggested_label_id UUID,
  ADD COLUMN IF NOT EXISTS duplicate_of_ocr_id UUID REFERENCES meta.annotation_ocr(id) ON DELETE SET NULL;

ALTER TABLE meta.annotation_candidates DROP CONSTRAINT IF EXISTS annotation_candidates_suggested_parent_check;
ALTER TABLE meta.annotation_candidates ADD CONSTRAINT annotation_candidates_suggested_parent_check CHECK (
  suggested_parent_type IS NULL
  OR (suggested_parent_type = 'package' AND suggested_package_id IS NOT NULL AND suggested_label_id IS NULL)
  OR (suggested_parent_type = 'label' AND suggested_package_id IS NOT NULL AND suggested_label_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS meta.annotation_operation_results (
  operation_id UUID NOT NULL REFERENCES meta.annotation_operations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('package', 'label', 'ocr', 'meta')),
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (operation_id, entity_type, entity_id)
);

ALTER TABLE meta.annotation_operation_results ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS meta.annotation_candidate_reviews (
  operation_id UUID NOT NULL REFERENCES meta.annotation_operations(id) ON DELETE CASCADE,
  candidate_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'edited', 'rejected')),
  final_package_id UUID REFERENCES meta.annotation_packages(id) ON DELETE SET NULL,
  final_label_id UUID REFERENCES meta.annotation_labels(id) ON DELETE SET NULL,
  result_entity_id UUID REFERENCES meta.annotation_ocr(id) ON DELETE SET NULL,
  reviewed_geometry JSONB,
  reviewed_transcription TEXT,
  reviewed_status TEXT CHECK (reviewed_status IN ('verified', 'unreadable', 'no_transcription', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_id, candidate_key)
);

UPDATE meta.annotation_ocr SET status='rejected' WHERE status='skipped';
ALTER TABLE meta.annotation_ocr DROP CONSTRAINT IF EXISTS annotation_ocr_status_check;
ALTER TABLE meta.annotation_ocr ADD CONSTRAINT annotation_ocr_status_check CHECK (status IN ('verified', 'unreadable', 'no_transcription', 'rejected'));

UPDATE meta.annotation_ocr
SET coordinate_space = coordinate_space || CASE
  WHEN coordinate_space->>'type' = 'source-image' THEN '{"units":"pixels"}'::jsonb
  WHEN coordinate_space->>'type' = 'label-rectified' THEN '{"units":"normalized"}'::jsonb
  ELSE '{}'::jsonb
END;

ALTER TABLE meta.annotation_ocr DROP CONSTRAINT IF EXISTS annotation_ocr_coordinate_space_check;
ALTER TABLE meta.annotation_ocr ADD CONSTRAINT annotation_ocr_coordinate_space_check CHECK (
  jsonb_typeof(coordinate_space) = 'object'
  AND coordinate_space->>'type' IN ('source-image', 'label-rectified', 'unavailable')
  AND (
    (coordinate_space->>'type' = 'source-image' AND coordinate_space->>'units' = 'pixels' AND label_id IS NULL)
    OR (
      coordinate_space->>'type' = 'label-rectified'
      AND coordinate_space->>'units' = 'normalized'
      AND label_id IS NOT NULL
      AND coordinate_space->>'labelId' = label_id::text
    )
    OR coordinate_space->>'type' = 'unavailable'
  )
);

CREATE INDEX IF NOT EXISTS idx_annotation_operations_scope ON meta.annotation_operations (scope_type, scope_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_annotation_operation_results_entity ON meta.annotation_operation_results (entity_type, entity_id);

COMMENT ON COLUMN meta.annotation_operations.scope_type IS 'Where a helper searched; independent from the final parent of resulting entities.';
COMMENT ON TABLE meta.annotation_operation_results IS 'Allows one helper/review operation to produce multiple canonical annotation entities.';
COMMENT ON TABLE meta.annotation_candidate_reviews IS 'Per-candidate accepted/edited/rejected supervision and final parent/result linkage.';
COMMENT ON COLUMN meta.annotation_ocr.coordinate_space IS 'Source-image OCR uses source pixels. Label-rectified OCR uses normalized 0..1 coordinates and carries crop dimensions for rendering.';
