CREATE TABLE IF NOT EXISTS meta.wizard_helper_runs (
    id UUID PRIMARY KEY,
    stage_execution_id UUID NOT NULL REFERENCES meta.wizard_stage_executions(id) ON DELETE CASCADE,
    run_index INTEGER NOT NULL CHECK (run_index > 0),
    config JSONB NOT NULL,
    candidates JSONB NOT NULL DEFAULT '[]',
    output JSONB NOT NULL,
    artifact JSONB,
    config_hash TEXT NOT NULL,
    output_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (stage_execution_id, run_index),
    UNIQUE (stage_execution_id, config_hash, output_hash)
);

ALTER TABLE meta.detection_proposals
    ADD COLUMN IF NOT EXISTS helper_candidate_id TEXT;

ALTER TABLE meta.wizard_stage_executions
    ADD COLUMN IF NOT EXISTS selected_run_id UUID,
    ADD COLUMN IF NOT EXISTS selected_candidate_id TEXT,
    ADD COLUMN IF NOT EXISTS review_mode TEXT;

DO $$ BEGIN
    ALTER TABLE meta.wizard_stage_executions
        ADD CONSTRAINT wizard_stage_executions_selected_run_id_fkey
        FOREIGN KEY (selected_run_id) REFERENCES meta.wizard_helper_runs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE meta.wizard_stage_executions
        ADD CONSTRAINT wizard_stage_executions_review_mode_check
        CHECK (review_mode IS NULL OR review_mode IN ('accepted', 'corrected', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_wizard_helper_runs_execution
    ON meta.wizard_helper_runs (stage_execution_id, run_index);

-- The migration runner intentionally replays every SQL file. `execution.*` expands
-- to newly added columns on a later replay, which CREATE OR REPLACE VIEW cannot
-- insert before the derived helper_runs column. Recreate the read model instead.
DROP VIEW IF EXISTS meta.wizard_stage_execution_records;
CREATE VIEW meta.wizard_stage_execution_records AS
SELECT execution.*,
  COALESCE((
    SELECT jsonb_agg(to_jsonb(run) ORDER BY run.run_index)
    FROM meta.wizard_helper_runs run
    WHERE run.stage_execution_id = execution.id
  ), '[]'::jsonb) AS helper_runs
FROM meta.wizard_stage_executions execution;

COMMENT ON TABLE meta.wizard_helper_runs IS
    'Immutable AutoDetect helper runs. Every distinct config/output pair retains its candidates and optional artifact reference.';
