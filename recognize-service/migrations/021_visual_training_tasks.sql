ALTER TABLE meta.training_runs
    DROP CONSTRAINT IF EXISTS training_runs_task_check;

ALTER TABLE meta.training_runs
    ADD CONSTRAINT training_runs_task_check CHECK (task IN (
        'label-roi',
        'ocr-region',
        'source-matching',
        'alias-ranking',
        'bottle-outline',
        'label-elements',
        'label-palette'
    ));

ALTER TABLE meta.model_versions
    DROP CONSTRAINT IF EXISTS model_versions_task_check;

ALTER TABLE meta.model_versions
    ADD CONSTRAINT model_versions_task_check CHECK (task IN (
        'label-roi',
        'ocr-region',
        'source-matching',
        'alias-ranking',
        'bottle-outline',
        'label-elements',
        'label-palette'
    ));

COMMENT ON COLUMN meta.training_runs.task IS
    'Training target. Visual schema-v3 tasks consume reviewed vision.annotations, never vision.cvMeta proposals.';
