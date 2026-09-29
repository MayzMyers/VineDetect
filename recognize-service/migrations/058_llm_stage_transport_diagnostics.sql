ALTER TABLE meta.llm_stage_runs
  ADD COLUMN IF NOT EXISTS transport_error JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE meta.llm_stage_runs
  DROP CONSTRAINT IF EXISTS llm_stage_runs_status_check;

ALTER TABLE meta.llm_stage_runs
  ADD CONSTRAINT llm_stage_runs_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'human_required', 'failed', 'cancelled'));

COMMENT ON COLUMN meta.llm_stage_runs.transport_error IS
  'Sanitized structured controller/provider transport failure; raw credentials and response bodies are never persisted.';
