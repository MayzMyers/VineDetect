CREATE TABLE IF NOT EXISTS meta.label_crops (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    image_url TEXT,
    annotation_id UUID REFERENCES meta.image_annotations(id) ON DELETE SET NULL,
    annotation_revision INTEGER,
    bbox JSONB NOT NULL,
    padding NUMERIC,
    width INTEGER,
    height INTEGER,
    asset_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_label_crops_item_created
    ON meta.label_crops (source, source_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meta.ocr_runs (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    crop_id UUID REFERENCES meta.label_crops(id) ON DELETE SET NULL,
    execution_mode TEXT NOT NULL,
    engine TEXT NOT NULL,
    engine_version TEXT,
    config_hash TEXT,
    raw_text TEXT NOT NULL DEFAULT '',
    normalized_text TEXT NOT NULL DEFAULT '',
    confidence NUMERIC,
    status TEXT NOT NULL DEFAULT 'completed',
    runtime_ms INTEGER,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocr_runs_item_created
    ON meta.ocr_runs (source, source_item_id, created_at DESC);
