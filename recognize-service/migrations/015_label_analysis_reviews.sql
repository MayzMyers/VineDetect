CREATE TABLE IF NOT EXISTS meta.label_analysis_reviews (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    annotation_id UUID NOT NULL REFERENCES meta.image_annotations(id) ON DELETE CASCADE,
    annotation_revision INTEGER NOT NULL CHECK (annotation_revision > 0),
    job_id UUID NOT NULL REFERENCES meta.generation_jobs(id) ON DELETE RESTRICT,
    config_hash TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('accepted', 'needs-tuning', 'rejected')),
    notes TEXT NOT NULL DEFAULT '',
    reviewed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_item_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_label_analysis_reviews_item_revision
    ON meta.label_analysis_reviews (source, source_item_id, revision DESC);

CREATE INDEX IF NOT EXISTS idx_label_analysis_reviews_status
    ON meta.label_analysis_reviews (status, created_at DESC);
