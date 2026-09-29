CREATE SCHEMA IF NOT EXISTS roskachestvo;

CREATE TABLE IF NOT EXISTS roskachestvo.products (
    id BIGSERIAL PRIMARY KEY,

    rskrf_product_id TEXT NOT NULL UNIQUE,

    list_name TEXT,
    barcode TEXT,
    list_rating NUMERIC,
    raw_list_json JSONB,

    title TEXT,
    total_rating NUMERIC,
    description TEXT,
    product_link TEXT,
    category_name TEXT,
    manufacturer TEXT,
    characteristics JSONB,
    raw_detail_json JSONB,

    source_page_url TEXT,
    image_source_url TEXT,
    image_local_path TEXT,
    image_content_type TEXT,
    image_size_bytes BIGINT,

    list_status TEXT NOT NULL DEFAULT 'pending',
    list_error TEXT,
    list_fetched_at TIMESTAMPTZ,

    detail_status TEXT NOT NULL DEFAULT 'pending',
    detail_error TEXT,
    detail_fetched_at TIMESTAMPTZ,

    page_status TEXT NOT NULL DEFAULT 'pending',
    page_error TEXT,
    page_fetched_at TIMESTAMPTZ,

    image_download_status TEXT NOT NULL DEFAULT 'pending',
    image_download_error TEXT,
    image_downloaded_at TIMESTAMPTZ,

    image_processing_status TEXT NOT NULL DEFAULT 'pending',
    image_processing_error TEXT,
    image_processed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_roskachestvo_products_product_id_non_blank
        CHECK (btrim(rskrf_product_id) <> ''),

    CONSTRAINT chk_roskachestvo_products_list_status
        CHECK (list_status IN ('pending', 'ok', 'failed', 'skipped')),

    CONSTRAINT chk_roskachestvo_products_detail_status
        CHECK (detail_status IN ('pending', 'ok', 'failed', 'skipped')),

    CONSTRAINT chk_roskachestvo_products_page_status
        CHECK (page_status IN ('pending', 'ok', 'failed', 'skipped')),

    CONSTRAINT chk_roskachestvo_products_image_download_status
        CHECK (image_download_status IN ('pending', 'ok', 'failed', 'skipped')),

    CONSTRAINT chk_roskachestvo_products_image_processing_status
        CHECK (image_processing_status IN ('pending', 'ok', 'failed', 'skipped')),

    CONSTRAINT chk_roskachestvo_products_image_size_non_negative
        CHECK (image_size_bytes IS NULL OR image_size_bytes >= 0)
);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_product_id
    ON roskachestvo.products (rskrf_product_id);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_barcode
    ON roskachestvo.products (barcode);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_title
    ON roskachestvo.products (title);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_list_name
    ON roskachestvo.products (list_name);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_manufacturer
    ON roskachestvo.products (manufacturer);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_category_name
    ON roskachestvo.products (category_name);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_list_status
    ON roskachestvo.products (list_status);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_detail_status
    ON roskachestvo.products (detail_status);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_page_status
    ON roskachestvo.products (page_status);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_image_download_status
    ON roskachestvo.products (image_download_status);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_image_processing_status
    ON roskachestvo.products (image_processing_status);

CREATE INDEX IF NOT EXISTS idx_roskachestvo_products_updated_at
    ON roskachestvo.products (updated_at);
