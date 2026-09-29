CREATE TABLE IF NOT EXISTS wine_external_matches (
    id BIGSERIAL PRIMARY KEY,
    wine_id BIGINT NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    source_product_id TEXT NOT NULL,
    barcode TEXT,
    source_name TEXT NOT NULL,
    match_score NUMERIC NOT NULL,
    match_method TEXT NOT NULL,
    match_details JSONB,
    is_confirmed BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (source, source_product_id, wine_id)
);

CREATE INDEX IF NOT EXISTS idx_wine_external_matches_wine_id
    ON wine_external_matches (wine_id);

CREATE INDEX IF NOT EXISTS idx_wine_external_matches_source_product
    ON wine_external_matches (source, source_product_id);

CREATE INDEX IF NOT EXISTS idx_wine_external_matches_barcode
    ON wine_external_matches (barcode);

CREATE INDEX IF NOT EXISTS idx_wine_external_matches_score
    ON wine_external_matches (match_score);

CREATE INDEX IF NOT EXISTS idx_wine_external_matches_confirmed
    ON wine_external_matches (is_confirmed);
