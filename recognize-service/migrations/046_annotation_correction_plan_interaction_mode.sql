ALTER TABLE meta.annotation_correction_plans
    ADD COLUMN IF NOT EXISTS interaction_mode TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE meta.annotation_correction_plans
    DROP CONSTRAINT IF EXISTS annotation_correction_plans_interaction_mode_check;

ALTER TABLE meta.annotation_correction_plans
    ADD CONSTRAINT annotation_correction_plans_interaction_mode_check
        CHECK (interaction_mode IN ('auto', 'manual', 'mixed'));

COMMENT ON COLUMN meta.annotation_correction_plans.interaction_mode IS
    'How much the executor changed deterministic helper output; orthogonal to executor identity.';

ALTER TABLE meta.wizard_stage_executions
    ADD COLUMN IF NOT EXISTS proposal_interaction_mode TEXT;

ALTER TABLE meta.wizard_stage_executions
    DROP CONSTRAINT IF EXISTS wizard_stage_executions_proposal_interaction_mode_check;

ALTER TABLE meta.wizard_stage_executions
    ADD CONSTRAINT wizard_stage_executions_proposal_interaction_mode_check
        CHECK (proposal_interaction_mode IS NULL OR proposal_interaction_mode IN ('auto', 'manual', 'mixed'));

DROP VIEW IF EXISTS meta.wizard_stage_execution_records;
CREATE VIEW meta.wizard_stage_execution_records AS
SELECT execution.*,
  COALESCE((
    SELECT jsonb_agg(to_jsonb(run) ORDER BY run.run_index)
    FROM meta.wizard_helper_runs run
    WHERE run.stage_execution_id = execution.id
  ), '[]'::jsonb) AS helper_runs
FROM meta.wizard_stage_executions execution;

COMMENT ON COLUMN meta.wizard_stage_executions.proposal_interaction_mode IS
    'Controller correction degree projected from the correction plan into StageSample proposal provenance.';
