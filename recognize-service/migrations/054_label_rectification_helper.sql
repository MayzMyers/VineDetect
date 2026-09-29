ALTER TABLE meta.annotation_operations
  DROP CONSTRAINT IF EXISTS annotation_operations_operation_type_check;

ALTER TABLE meta.annotation_operations
  ADD CONSTRAINT annotation_operations_operation_type_check CHECK (operation_type IN (
    'add_package', 'add_label', 'add_ocr', 'add_meta',
    'edit_package', 'edit_label', 'edit_ocr', 'edit_meta',
    'delete_package', 'delete_label', 'delete_ocr', 'delete_meta',
    'run_ocr', 'reparent_ocr', 'run_label_rectification'
  ));

COMMENT ON CONSTRAINT annotation_operations_operation_type_check ON meta.annotation_operations IS
  'Canonical annotation mutations plus immutable helper observations, including Label-wide surface rectification before OCR.';
