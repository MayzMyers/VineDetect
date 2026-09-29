ALTER TABLE meta.generation_jobs
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'meta'
          AND indexname = 'idx_generation_jobs_idempotency_active'
          AND indexdef NOT ILIKE '%deleted_at IS NULL%'
    ) THEN
        DROP INDEX meta.idx_generation_jobs_idempotency_active;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_idempotency_active
    ON meta.generation_jobs (idempotency_key)
    WHERE idempotency_key IS NOT NULL
      AND deleted_at IS NULL
      AND status IN ('queued', 'running', 'completed');

CREATE INDEX IF NOT EXISTS idx_generation_jobs_visible_created
    ON meta.generation_jobs (created_at DESC)
    WHERE deleted_at IS NULL;
