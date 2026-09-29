ALTER TABLE meta.wizard_stage_executions
    ADD COLUMN IF NOT EXISTS proposal_review JSONB;

COMMENT ON COLUMN meta.wizard_stage_executions.proposal_review IS
    'Compact controller evaluation metadata. Canonical training content remains initial automation versus final reviewed output.';

DROP VIEW IF EXISTS meta.wizard_stage_execution_records;
CREATE VIEW meta.wizard_stage_execution_records AS
SELECT execution.*,
  COALESCE((
    SELECT jsonb_agg(to_jsonb(run) ORDER BY run.run_index)
    FROM meta.wizard_helper_runs run
    WHERE run.stage_execution_id = execution.id
  ), '[]'::jsonb) AS helper_runs
FROM meta.wizard_stage_executions execution;
