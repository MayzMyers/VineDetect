CREATE TABLE IF NOT EXISTS meta.detection_proposals (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    image_url TEXT,
    detector_type TEXT NOT NULL,
    detector_version TEXT NOT NULL,
    bbox JSONB,
    candidates JSONB NOT NULL DEFAULT '[]',
    confidence DOUBLE PRECISION,
    candidate_score DOUBLE PRECISION,
    status TEXT NOT NULL DEFAULT 'generated',
    preset_id TEXT,
    preset_revision INTEGER,
    config_hash TEXT,
    config_snapshot JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_detection_proposals_item_created
    ON meta.detection_proposals (source, source_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meta.image_annotations (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    image_url TEXT,
    annotation_type TEXT NOT NULL DEFAULT 'label-bbox',
    bbox JSONB,
    polygon JSONB,
    status TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    suggestion_id UUID REFERENCES meta.detection_proposals(id) ON DELETE SET NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    reviewed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_image_annotations_item_updated
    ON meta.image_annotations (source, source_item_id, annotation_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_image_annotations_status
    ON meta.image_annotations (annotation_type, status, updated_at DESC);
