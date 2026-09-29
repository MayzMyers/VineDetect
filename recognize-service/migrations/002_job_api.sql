ALTER TABLE meta.generation_jobs
    ADD COLUMN IF NOT EXISTS job_type TEXT,
    ADD COLUMN IF NOT EXISTS source_item_id TEXT,
    ADD COLUMN IF NOT EXISTS target JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS result JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS pipeline_version TEXT,
    ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_generation_jobs_status_created
    ON meta.generation_jobs (status, created_at DESC);
