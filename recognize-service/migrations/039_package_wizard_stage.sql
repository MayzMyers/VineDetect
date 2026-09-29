ALTER TABLE meta.wizard_stage_executions
    DROP CONSTRAINT IF EXISTS wizard_stage_executions_stage_check;

ALTER TABLE meta.wizard_stage_executions
    ADD CONSTRAINT wizard_stage_executions_stage_check CHECK (stage IN (
        'package', 'label', 'bottle', 'ocr', 'mask', 'morphology',
        'components', 'elements', 'contours', 'palette', 'summary'
    ));

COMMENT ON CONSTRAINT wizard_stage_executions_stage_check ON meta.wizard_stage_executions IS
    'Package is the technical source-image scope stage preceding Label; Object Context remains bottle compatibility stage.';
