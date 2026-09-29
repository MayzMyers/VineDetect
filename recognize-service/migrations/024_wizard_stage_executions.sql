CREATE TABLE IF NOT EXISTS meta.wizard_stage_executions (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN (
        'label', 'bottle', 'ocr', 'mask', 'morphology',
        'components', 'elements', 'contours', 'palette', 'summary'
    )),
    revision INTEGER NOT NULL CHECK (revision > 0),
    helper_id TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    algorithm_version TEXT,
    status TEXT NOT NULL CHECK (status IN ('started', 'reviewed', 'superseded')),
    stage_input JSONB,
    default_params JSONB,
    initial_params JSONB,
    auto_output JSONB,
    final_params JSONB,
    reviewed_output JSONB,
    human_correction JSONB NOT NULL DEFAULT '{}',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_item_id, stage, revision)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wizard_stage_executions_active
    ON meta.wizard_stage_executions (source, source_item_id, stage)
    WHERE status = 'started';

CREATE INDEX IF NOT EXISTS idx_wizard_stage_executions_item
    ON meta.wizard_stage_executions (source, source_item_id, stage, revision DESC);

COMMENT ON TABLE meta.wizard_stage_executions IS
    'Native helper execution trace. Initial params/output are immutable first-run evidence; final params/reviewed output are written on stage review.';
