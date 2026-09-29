CREATE TABLE IF NOT EXISTS meta.dataset_artifacts (
    id UUID PRIMARY KEY,
    dataset_version_id UUID NOT NULL REFERENCES meta.dataset_versions(id) ON DELETE RESTRICT,
    artifact_type TEXT NOT NULL DEFAULT 'frozen-annotation-dataset',
    output_path TEXT NOT NULL,
    annotations_sha256 TEXT NOT NULL CHECK (annotations_sha256 ~ '^[0-9a-f]{64}$'),
    manifest JSONB NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_version_id, annotations_sha256),
    UNIQUE (output_path)
);

CREATE TABLE IF NOT EXISTS meta.training_runs (
    id UUID PRIMARY KEY,
    dataset_artifact_id UUID NOT NULL REFERENCES meta.dataset_artifacts(id) ON DELETE RESTRICT,
    task TEXT NOT NULL CHECK (task IN ('label-roi', 'ocr-region', 'source-matching', 'alias-ranking')),
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    framework TEXT NOT NULL,
    runtime TEXT,
    config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config_snapshot) = 'object'),
    code_version TEXT,
    created_by TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_training_runs_dataset_artifact
    ON meta.training_runs (dataset_artifact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_training_runs_task_status
    ON meta.training_runs (task, status, created_at DESC);

CREATE TABLE IF NOT EXISTS meta.model_versions (
    id UUID PRIMARY KEY,
    training_run_id UUID NOT NULL REFERENCES meta.training_runs(id) ON DELETE RESTRICT,
    task TEXT NOT NULL CHECK (task IN ('label-roi', 'ocr-region', 'source-matching', 'alias-ranking')),
    name TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'validated', 'promoted', 'deprecated')),
    artifact_path TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
    runtime TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    promoted_at TIMESTAMPTZ,
    UNIQUE (task, name, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_model_versions_promoted_task
    ON meta.model_versions (task) WHERE status = 'promoted';

CREATE TABLE IF NOT EXISTS meta.evaluation_results (
    id UUID PRIMARY KEY,
    training_run_id UUID NOT NULL REFERENCES meta.training_runs(id) ON DELETE RESTRICT,
    model_version_id UUID REFERENCES meta.model_versions(id) ON DELETE RESTRICT,
    split TEXT NOT NULL CHECK (split IN ('train', 'validation', 'test')),
    metrics JSONB NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
    sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evaluation_results_run
    ON meta.evaluation_results (training_run_id, split, created_at DESC);
