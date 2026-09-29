ALTER TABLE meta.llm_sessions
    ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'qwen',
    ADD COLUMN IF NOT EXISTS provider_conversation_id TEXT,
    ADD COLUMN IF NOT EXISTS model_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS adapter_version TEXT NOT NULL DEFAULT 'vision-stage-adapter-v4',
    ADD COLUMN IF NOT EXISTS current_stage TEXT,
    ADD COLUMN IF NOT EXISTS context_events JSONB NOT NULL DEFAULT '[]';

ALTER TABLE meta.llm_stage_runs
    ADD COLUMN IF NOT EXISTS input_context_snapshot JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS provider_response_id TEXT,
    ADD COLUMN IF NOT EXISTS provider_request_id TEXT,
    ADD COLUMN IF NOT EXISTS usage JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS latency_ms INTEGER;

ALTER TABLE meta.llm_sessions DROP CONSTRAINT IF EXISTS llm_sessions_status_check;
ALTER TABLE meta.llm_sessions ADD CONSTRAINT llm_sessions_status_check
    CHECK (status IN ('created', 'active', 'blocked', 'completed', 'failed', 'cancelled'));

DROP INDEX IF EXISTS meta.idx_llm_sessions_one_active_track;
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_sessions_one_open_track
    ON meta.llm_sessions (annotation_track_id)
    WHERE status IN ('created', 'active', 'blocked');

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_sessions_provider_conversation_owner
    ON meta.llm_sessions (provider, provider_conversation_id)
    WHERE provider_conversation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_stage_runs_one_inflight_session
    ON meta.llm_stage_runs (session_id)
    WHERE status IN ('queued', 'running');

COMMENT ON COLUMN meta.llm_sessions.provider_conversation_id IS
    'Optional provider-side history carrier. Canonical workflow state remains global_context/context_events in this database.';
COMMENT ON COLUMN meta.llm_sessions.context_events IS
    'Append-only compact authoritative stage_completed/stage_corrected/stage_invalidated events.';
COMMENT ON COLUMN meta.llm_stage_runs.input_context_snapshot IS
    'Exact compact DB-owned context supplied for this stage decision; provider history is not sufficient evidence.';
