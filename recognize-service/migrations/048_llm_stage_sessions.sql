CREATE TABLE IF NOT EXISTS meta.llm_sessions (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    annotation_track_id UUID NOT NULL REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    wizard_definition_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    global_context JSONB NOT NULL DEFAULT '{}',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT llm_sessions_status_check CHECK (status IN ('active', 'completed', 'failed', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_sessions_one_active_track
    ON meta.llm_sessions (annotation_track_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_llm_sessions_track_history
    ON meta.llm_sessions (annotation_track_id, started_at DESC);

CREATE TABLE IF NOT EXISTS meta.llm_stage_runs (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES meta.llm_sessions(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    label_id UUID,
    status TEXT NOT NULL DEFAULT 'running',
    iteration_count INTEGER NOT NULL DEFAULT 0,
    input_artifact_ids JSONB NOT NULL DEFAULT '[]',
    decisions JSONB NOT NULL DEFAULT '[]',
    correction_plan_id UUID REFERENCES meta.annotation_correction_plans(id) ON DELETE SET NULL,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    CONSTRAINT llm_stage_runs_status_check CHECK (status IN ('queued', 'running', 'completed', 'human_required', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_llm_stage_runs_session
    ON meta.llm_stage_runs (session_id, started_at ASC);

COMMENT ON TABLE meta.llm_sessions IS
    'Canonical DB-owned context for one card-level LLM wizard session; provider chat history is not a source of truth.';

COMMENT ON TABLE meta.llm_stage_runs IS
    'Atomic stage-level LLM executions. Correction plans remain the only mutation boundary.';
