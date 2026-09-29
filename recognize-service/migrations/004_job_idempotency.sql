ALTER TABLE meta.generation_jobs
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS source_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_jobs_idempotency_active
    ON meta.generation_jobs (idempotency_key)
    WHERE idempotency_key IS NOT NULL
      AND status IN ('queued', 'running', 'completed');

CREATE INDEX IF NOT EXISTS idx_meta_items_cv_meta
    ON meta.items (source, source_item_id)
    WHERE visual_features ? 'cvMeta';
