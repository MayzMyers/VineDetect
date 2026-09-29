CREATE TABLE IF NOT EXISTS meta.ocr_source_association_sets (
    id UUID PRIMARY KEY,
    source TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    ocr_region_annotation_set_id UUID REFERENCES meta.ocr_region_annotation_sets(id) ON DELETE SET NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    status TEXT NOT NULL DEFAULT 'reviewed' CHECK (status IN ('draft', 'reviewed', 'rejected')),
    reviewed_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_item_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_ocr_source_association_sets_item_revision
    ON meta.ocr_source_association_sets (source, source_item_id, revision DESC);

CREATE TABLE IF NOT EXISTS meta.ocr_source_associations (
    id UUID PRIMARY KEY,
    association_set_id UUID NOT NULL REFERENCES meta.ocr_source_association_sets(id) ON DELETE CASCADE,
    ocr_region_annotation_id UUID REFERENCES meta.ocr_region_annotations(id) ON DELETE SET NULL,
    region_text_snapshot TEXT NOT NULL DEFAULT '',
    source_field TEXT NOT NULL CHECK (source_field IN (
        'title', 'manufacturer', 'category', 'region', 'year', 'barcode',
        'color', 'description', 'alias', 'normalized-token'
    )),
    source_value TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'reviewed' CHECK (status IN ('reviewed', 'rejected')),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('accepted-suggested', 'corrected-suggested', 'manual')),
    match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'contains', 'token-overlap', 'manual')),
    score DOUBLE PRECISION CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocr_source_associations_set_order
    ON meta.ocr_source_associations (association_set_id, sort_order, id);
