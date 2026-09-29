CREATE TABLE IF NOT EXISTS wine_barcodes (
    id BIGSERIAL PRIMARY KEY,
    wine_id BIGINT NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
    barcode TEXT NOT NULL,
    source TEXT NOT NULL,
    source_product_id TEXT,
    confidence NUMERIC NOT NULL,
    match_score NUMERIC,
    score_gap NUMERIC,
    match_method TEXT NOT NULL,
    match_details JSONB,
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (wine_id, barcode, source)
);

CREATE INDEX IF NOT EXISTS idx_wine_barcodes_wine_id
    ON wine_barcodes (wine_id);

CREATE INDEX IF NOT EXISTS idx_wine_barcodes_barcode
    ON wine_barcodes (barcode);

CREATE INDEX IF NOT EXISTS idx_wine_barcodes_source
    ON wine_barcodes (source);

CREATE INDEX IF NOT EXISTS idx_wine_barcodes_confidence
    ON wine_barcodes (confidence);

CREATE INDEX IF NOT EXISTS idx_wine_barcodes_source_product
    ON wine_barcodes (source, source_product_id);
