-- Versioned organizer input, independent of active annotations.
CREATE SCHEMA IF NOT EXISTS contest;
CREATE SCHEMA IF NOT EXISTS contest_raw;

CREATE TABLE contest.import_runs (
    id BIGSERIAL PRIMARY KEY,
    version TEXT NOT NULL UNIQUE CHECK (btrim(version) <> ''),
    source_filename TEXT NOT NULL CHECK (btrim(source_filename) <> ''),
    source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    source_bytes BYTEA NOT NULL,
    parser_config JSONB NOT NULL CHECK (jsonb_typeof(parser_config) = 'object'),
    metadata JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata) = 'object'),
    status TEXT NOT NULL DEFAULT 'importing'
        CHECK (status IN ('importing', 'completed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
    CHECK (completed_at IS NULL OR completed_at >= created_at)
);
CREATE INDEX ON contest.import_runs (source_sha256);

CREATE TABLE contest_raw.catalog_rows (
    import_run_id BIGINT NOT NULL REFERENCES contest.import_runs(id),
    source_row_number INTEGER NOT NULL CHECK (source_row_number > 0),
    source_line_end INTEGER NOT NULL CHECK (source_line_end > 1),
    official_slug TEXT NOT NULL CHECK (btrim(official_slug) <> ''),
    raw_row JSONB NOT NULL CHECK (jsonb_typeof(raw_row) = 'object'),
    row_sha256 TEXT NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (import_run_id, source_row_number),
    UNIQUE (import_run_id, source_row_number, official_slug)
);
CREATE INDEX ON contest_raw.catalog_rows (import_run_id, official_slug);
-- Row hashes intentionally are NOT unique: source duplicates are evidence.

CREATE TABLE contest.catalog_items (
    id BIGSERIAL PRIMARY KEY,
    import_run_id BIGINT NOT NULL REFERENCES contest.import_runs(id),
    official_slug TEXT NOT NULL CHECK (btrim(official_slug) <> ''),
    source_row_number INTEGER NOT NULL,
    title TEXT NOT NULL CHECK (btrim(title) <> ''),
    category TEXT NOT NULL,
    color TEXT NOT NULL,
    region TEXT NOT NULL,
    grapes TEXT NOT NULL,
    description TEXT NOT NULL,
    winery TEXT NOT NULL,
    photo_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (import_run_id, official_slug),
    FOREIGN KEY (import_run_id, source_row_number, official_slug)
        REFERENCES contest_raw.catalog_rows
            (import_run_id, source_row_number, official_slug)
);

CREATE TABLE contest.reference_assets (
    id BIGSERIAL PRIMARY KEY,
    catalog_item_id BIGINT NOT NULL REFERENCES contest.catalog_items(id),
    original_filename TEXT NOT NULL CHECK (btrim(original_filename) <> ''),
    local_path TEXT NOT NULL CHECK (btrim(local_path) <> ''),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    perceptual_hash TEXT CHECK (perceptual_hash IS NULL OR btrim(perceptual_hash) <> ''),
    width INTEGER NOT NULL CHECK (width > 0),
    height INTEGER NOT NULL CHECK (height > 0),
    byte_size BIGINT NOT NULL CHECK (byte_size > 0),
    mime_type TEXT NOT NULL CHECK (mime_type ~ '^image/[^[:space:]]+$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Shared organizer photos may serve multiple catalog items.
    UNIQUE (catalog_item_id, local_path),
    UNIQUE (catalog_item_id, original_filename, sha256)
);
CREATE INDEX ON contest.reference_assets (sha256);

CREATE TABLE contest.item_links (
    catalog_item_id BIGINT PRIMARY KEY REFERENCES contest.catalog_items(id),
    wine_id BIGINT REFERENCES svoe_vino.wines(id) ON DELETE RESTRICT,
    method TEXT NOT NULL CHECK (method IN (
        'exact_slug', 're_slug', 'same_asset', 'metadata_match', 'manual',
        'unmatched', 'new_official_item'
    )),
    confidence NUMERIC CHECK (confidence >= 0 AND confidence <= 1),
    provenance JSONB NOT NULL DEFAULT '{}'
        CHECK (jsonb_typeof(provenance) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((wine_id IS NULL) = (method IN ('unmatched', 'new_official_item'))),
    CHECK (wine_id IS NOT NULL OR confidence IS NULL)
);
CREATE INDEX ON contest.item_links (wine_id);
CREATE INDEX ON contest.item_links (method);
