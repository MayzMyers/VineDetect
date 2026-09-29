ALTER TABLE meta.ocr_runs
    ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN meta.ocr_runs.evidence IS
    'Versioned raw OCR pass observations, validity decisions and cross-pass consensus diagnostics.';
