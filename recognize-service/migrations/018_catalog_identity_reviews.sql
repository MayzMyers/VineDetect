CREATE TABLE IF NOT EXISTS meta.catalog_identity_reviews (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    analysis_job_id UUID NOT NULL REFERENCES meta.generation_jobs(id) ON DELETE RESTRICT,
    ocr_region_annotation_set_id UUID REFERENCES meta.ocr_region_annotation_sets(id) ON DELETE SET NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL CHECK (status IN ('confirmed', 'corrected', 'no-match', 'ambiguous')),
    selected_source TEXT,
    selected_source_item_id TEXT,
    candidate_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    score DOUBLE PRECISION CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
    notes TEXT NOT NULL DEFAULT '',
    reviewed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_item_id, revision),
    CHECK ((selected_source IS NULL) = (selected_source_item_id IS NULL)),
    CHECK (
      (status IN ('confirmed', 'corrected') AND selected_source IS NOT NULL)
      OR (status IN ('no-match', 'ambiguous') AND selected_source IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_catalog_identity_reviews_item_revision
    ON meta.catalog_identity_reviews (source, source_item_id, revision DESC);

CREATE INDEX IF NOT EXISTS idx_catalog_identity_reviews_selected_item
    ON meta.catalog_identity_reviews (selected_source, selected_source_item_id)
    WHERE selected_source IS NOT NULL;

COMMENT ON TABLE meta.catalog_identity_reviews IS
    'Immutable human-reviewed catalog identity decisions tied to a completed label-analysis job.';
