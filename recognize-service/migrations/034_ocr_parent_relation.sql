ALTER TABLE meta.annotation_ocr
  ADD COLUMN IF NOT EXISTS parent_relation_source TEXT NOT NULL DEFAULT 'human',
  ADD COLUMN IF NOT EXISTS parent_relation_status TEXT NOT NULL DEFAULT 'reviewed',
  ADD COLUMN IF NOT EXISTS parent_relation_suggested_label_id UUID REFERENCES meta.annotation_labels(id) ON DELETE SET NULL;

ALTER TABLE meta.annotation_ocr
  DROP CONSTRAINT IF EXISTS annotation_ocr_parent_relation_source_check,
  DROP CONSTRAINT IF EXISTS annotation_ocr_parent_relation_status_check;

ALTER TABLE meta.annotation_ocr
  ADD CONSTRAINT annotation_ocr_parent_relation_source_check
    CHECK (parent_relation_source IN ('auto', 'human')),
  ADD CONSTRAINT annotation_ocr_parent_relation_status_check
    CHECK (parent_relation_status IN ('suggested', 'reviewed'));

ALTER TABLE meta.annotation_operations
  DROP CONSTRAINT IF EXISTS annotation_operations_operation_type_check;

ALTER TABLE meta.annotation_operations
  ADD CONSTRAINT annotation_operations_operation_type_check CHECK (operation_type IN (
    'add_package', 'add_label', 'add_ocr', 'add_meta',
    'edit_package', 'edit_label', 'edit_ocr', 'edit_meta',
    'delete_package', 'delete_label', 'delete_ocr', 'delete_meta',
    'run_ocr', 'reparent_ocr', 'run_label_rectification'
  ));

COMMENT ON COLUMN meta.annotation_ocr.parent_relation_source IS
  'Provenance of the current Package/Label relation. It is independent from OCR geometry and transcription provenance.';
COMMENT ON COLUMN meta.annotation_ocr.parent_relation_status IS
  'Whether the current OCR parent is only suggested or explicitly reviewed.';
COMMENT ON COLUMN meta.annotation_ocr.parent_relation_suggested_label_id IS
  'Optional same-Package Label proposed by structural refinement while the current parent remains unchanged.';
