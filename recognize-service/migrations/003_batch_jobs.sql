ALTER TABLE meta.generation_jobs
    ADD COLUMN IF NOT EXISTS parent_job_id UUID REFERENCES meta.generation_jobs(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_generation_jobs_parent_status
    ON meta.generation_jobs (parent_job_id, status);

CREATE INDEX IF NOT EXISTS idx_generation_jobs_source_item
    ON meta.generation_jobs (source, source_item_id);
