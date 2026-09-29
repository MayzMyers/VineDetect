ALTER TABLE meta.wizard_helper_runs
    ADD COLUMN IF NOT EXISTS intermediate_states JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS trace_hash TEXT;

UPDATE meta.wizard_helper_runs
SET trace_hash = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
WHERE trace_hash IS NULL;

ALTER TABLE meta.wizard_helper_runs
    ALTER COLUMN trace_hash SET NOT NULL;

ALTER TABLE meta.wizard_helper_runs
    DROP CONSTRAINT IF EXISTS wizard_helper_runs_stage_execution_id_config_hash_output_hash_key;

DO $$ BEGIN
    IF to_regclass('meta.wizard_helper_runs_execution_config_output_trace_key') IS NULL THEN
        ALTER TABLE meta.wizard_helper_runs
            ADD CONSTRAINT wizard_helper_runs_execution_config_output_trace_key
            UNIQUE (stage_execution_id, config_hash, output_hash, trace_hash);
    END IF;
END $$;

COMMENT ON COLUMN meta.wizard_helper_runs.intermediate_states IS
    'Bounded helper-owned execution states. They are evidence inside one Wizard stage, not executable Wizard commands.';
