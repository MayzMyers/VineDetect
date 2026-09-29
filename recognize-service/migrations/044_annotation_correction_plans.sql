ALTER TABLE meta.wizard_stage_executions
    ADD COLUMN IF NOT EXISTS proposed_output JSONB,
    ADD COLUMN IF NOT EXISTS proposal_executor TEXT,
    ADD COLUMN IF NOT EXISTS proposal_plan_id UUID;

CREATE TABLE IF NOT EXISTS meta.annotation_correction_plans (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    annotation_track_id UUID NOT NULL REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE,
    executor TEXT NOT NULL CHECK (executor IN ('human', 'llm', 'local_ml', 'system')),
    controller JSONB NOT NULL DEFAULT '{}',
    proposed_output JSONB NOT NULL DEFAULT '{}',
    operations JSONB NOT NULL DEFAULT '[]',
    continue_on_error BOOLEAN NOT NULL DEFAULT false,
    validation JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('validated', 'applying', 'applied', 'partially_applied', 'failed')),
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_at TIMESTAMPTZ
);

-- CREATE TABLE IF NOT EXISTS does not evolve constraints when an earlier draft
-- of this migration has already created the table. Normalize them explicitly so
-- the transient applying state and every trusted executor remain replay-safe.
ALTER TABLE meta.annotation_correction_plans
    DROP CONSTRAINT IF EXISTS annotation_correction_plans_executor_check,
    DROP CONSTRAINT IF EXISTS annotation_correction_plans_status_check;

ALTER TABLE meta.annotation_correction_plans
    ADD CONSTRAINT annotation_correction_plans_executor_check
        CHECK (executor IN ('human', 'llm', 'local_ml', 'system')),
    ADD CONSTRAINT annotation_correction_plans_status_check
        CHECK (status IN ('validated', 'applying', 'applied', 'partially_applied', 'failed'));

CREATE INDEX IF NOT EXISTS idx_annotation_correction_plans_track
    ON meta.annotation_correction_plans (annotation_track_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_annotation_correction_plans_item
    ON meta.annotation_correction_plans (source, source_item_id, created_at DESC);

-- Refresh the SELECT execution.* expansion after adding proposal columns. The
-- view is a read model only and is already recreated by migrations 025 and 028.
DROP VIEW IF EXISTS meta.wizard_stage_execution_records;
CREATE VIEW meta.wizard_stage_execution_records AS
SELECT execution.*,
  COALESCE((
    SELECT jsonb_agg(to_jsonb(run) ORDER BY run.run_index)
    FROM meta.wizard_helper_runs run
    WHERE run.stage_execution_id = execution.id
  ), '[]'::jsonb) AS helper_runs
FROM meta.wizard_stage_executions execution;

COMMENT ON TABLE meta.annotation_correction_plans IS
    'Persisted controller proposals. Operations are validated and replayed only through the canonical Wizard Command Executor.';

COMMENT ON COLUMN meta.wizard_stage_executions.proposed_output IS
    'Controller proposal kept separate from deterministic auto_output and canonical reviewed_output.';
