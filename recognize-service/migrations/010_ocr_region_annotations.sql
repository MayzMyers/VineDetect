CREATE TABLE IF NOT EXISTS meta.ocr_region_annotation_sets (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    ocr_run_id UUID REFERENCES meta.ocr_runs(id) ON DELETE SET NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL DEFAULT 'reviewed' CHECK (status IN ('draft', 'reviewed', 'rejected')),
    reviewed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_item_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_ocr_region_annotation_sets_item_revision
    ON meta.ocr_region_annotation_sets (source, source_item_id, revision DESC);

CREATE TABLE IF NOT EXISTS meta.ocr_region_annotations (
    id UUID PRIMARY KEY,
    annotation_set_id UUID NOT NULL REFERENCES meta.ocr_region_annotation_sets(id) ON DELETE CASCADE,
    source_region_ids UUID[] NOT NULL DEFAULT '{}',
    level TEXT NOT NULL CHECK (level IN ('word', 'line', 'string')),
    bbox JSONB NOT NULL CHECK (jsonb_typeof(bbox) = 'object'),
    text TEXT NOT NULL DEFAULT '',
    normalized_text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'reviewed' CHECK (status IN ('reviewed', 'rejected')),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
        'accepted-generated',
        'corrected-generated',
        'manual',
        'merged',
        'split'
    )),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocr_region_annotations_set_order
    ON meta.ocr_region_annotations (annotation_set_id, sort_order, id);
