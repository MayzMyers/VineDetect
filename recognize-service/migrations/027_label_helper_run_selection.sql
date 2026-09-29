ALTER TABLE meta.detection_proposals
    ADD COLUMN IF NOT EXISTS helper_run_id UUID;

DO $$ BEGIN
    ALTER TABLE meta.detection_proposals
        ADD CONSTRAINT detection_proposals_helper_run_id_fkey
        FOREIGN KEY (helper_run_id) REFERENCES meta.wizard_helper_runs(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_detection_proposals_helper_run
    ON meta.detection_proposals (helper_run_id);

COMMENT ON COLUMN meta.detection_proposals.helper_run_id IS
    'Exact immutable AutoDetect helper run whose config and candidates produced helper_candidate_id.';
