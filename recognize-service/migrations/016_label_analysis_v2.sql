ALTER TABLE meta.ocr_runs
    ADD COLUMN IF NOT EXISTS analysis_job_id UUID REFERENCES meta.generation_jobs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ocr_runs_analysis_job
    ON meta.ocr_runs (analysis_job_id)
    WHERE analysis_job_id IS NOT NULL;
