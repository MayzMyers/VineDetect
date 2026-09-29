CREATE TABLE IF NOT EXISTS roskachestvo_wines (
    id BIGSERIAL PRIMARY KEY,
    rskrf_product_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    barcode TEXT,
    rating NUMERIC,
    raw_json JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_wines_product_id
    ON roskachestvo_wines (rskrf_product_id);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_wines_barcode
    ON roskachestvo_wines (barcode);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_wines_rating
    ON roskachestvo_wines (rating);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_wines_name
    ON roskachestvo_wines (name);
