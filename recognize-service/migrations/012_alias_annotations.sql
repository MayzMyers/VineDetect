CREATE TABLE IF NOT EXISTS meta.alias_annotation_sets (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    source_association_set_id UUID REFERENCES meta.ocr_source_association_sets(id) ON DELETE SET NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL DEFAULT 'reviewed' CHECK (status IN ('draft', 'reviewed', 'rejected')),
    reviewed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_item_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_alias_annotation_sets_item_revision
    ON meta.alias_annotation_sets (source, source_item_id, revision DESC);

CREATE TABLE IF NOT EXISTS meta.alias_annotations (
    id UUID PRIMARY KEY,
    annotation_set_id UUID NOT NULL REFERENCES meta.alias_annotation_sets(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    alias_type TEXT NOT NULL CHECK (alias_type IN (
        'source-title', 'source-field', 'ocr-associated', 'composite', 'manual'
    )),
    status TEXT NOT NULL DEFAULT 'reviewed' CHECK (status IN ('reviewed', 'rejected')),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('accepted-generated', 'corrected-generated', 'manual')),
    score DOUBLE PRECISION CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
    source_association_ids UUID[] NOT NULL DEFAULT '{}',
    components JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(components) = 'object'),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alias_annotations_set_order
    ON meta.alias_annotations (annotation_set_id, sort_order, id);
