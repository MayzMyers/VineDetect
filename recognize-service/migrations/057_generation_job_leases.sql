ALTER TABLE meta.generation_jobs
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recovery_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_generation_jobs_running_lease
  ON meta.generation_jobs (lease_expires_at)
  WHERE status = 'running' AND deleted_at IS NULL;
