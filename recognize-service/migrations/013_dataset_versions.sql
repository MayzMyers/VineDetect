CREATE TABLE IF NOT EXISTS meta.annotation_cohorts (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen', 'archived')),
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    frozen_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS meta.annotation_cohort_items (
    cohort_id UUID NOT NULL REFERENCES meta.annotation_cohorts(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cohort_id, source, source_item_id)
);

CREATE INDEX IF NOT EXISTS idx_annotation_cohort_items_item
    ON meta.annotation_cohort_items (source, source_item_id);

CREATE TABLE IF NOT EXISTS meta.dataset_versions (
    id UUID PRIMARY KEY,
    cohort_id UUID NOT NULL REFERENCES meta.annotation_cohorts(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    schema_version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'frozen' CHECK (status IN ('frozen', 'archived')),
    item_count INTEGER NOT NULL CHECK (item_count >= 0),
    manifest JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(manifest) = 'object'),
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cohort_id, version)
);

CREATE TABLE IF NOT EXISTS meta.dataset_version_items (
    dataset_version_id UUID NOT NULL REFERENCES meta.dataset_versions(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    split TEXT NOT NULL CHECK (split IN ('train', 'validation', 'test')),
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    snapshot_hash TEXT NOT NULL,
    PRIMARY KEY (dataset_version_id, source, source_item_id)
);

CREATE INDEX IF NOT EXISTS idx_dataset_version_items_item
    ON meta.dataset_version_items (source, source_item_id);
