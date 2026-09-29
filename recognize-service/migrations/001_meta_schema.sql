CREATE SCHEMA IF NOT EXISTS meta;

CREATE TABLE IF NOT EXISTS meta.items (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    aliases JSONB NOT NULL DEFAULT '[]',
    normalized_tokens JSONB NOT NULL DEFAULT '[]',
    visual_features JSONB NOT NULL DEFAULT '{}',
    annotations JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft',
    generation_version TEXT,
    source_hash TEXT,
    generated_at TIMESTAMPTZ,
    manually_edited_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, source_item_id)
);

CREATE TABLE IF NOT EXISTS meta.generation_jobs (
    id UUID PRIMARY KEY,
    source TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    total_items INTEGER NOT NULL DEFAULT 0,
    processed_items INTEGER NOT NULL DEFAULT 0,
    failed_items INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_meta_items_source_status
    ON meta.items (source, status);

CREATE INDEX IF NOT EXISTS idx_meta_items_updated_at
    ON meta.items (updated_at DESC);
