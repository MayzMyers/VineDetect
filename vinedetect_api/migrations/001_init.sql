CREATE TABLE IF NOT EXISTS wines (
    id BIGSERIAL PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    category_name TEXT,
    manufacturer_name TEXT,
    manufacturer_slug TEXT,
    region_name TEXT,
    alcohol NUMERIC(4, 1),
    temperature TEXT,
    color TEXT,
    description TEXT,
    public_rating NUMERIC(3, 1),
    image_url TEXT,
    image_alt TEXT,
    raw_list_json JSONB,
    raw_detail_json JSONB,
    list_seen_at TIMESTAMPTZ,
    detail_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grapes (
    id BIGSERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wine_grapes (
    wine_id BIGINT NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
    grape_id BIGINT NOT NULL REFERENCES grapes(id) ON DELETE CASCADE,
    PRIMARY KEY (wine_id, grape_id)
);

CREATE TABLE IF NOT EXISTS dishes (
    id BIGSERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wine_dishes (
    wine_id BIGINT NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
    dish_id BIGINT NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
    PRIMARY KEY (wine_id, dish_id)
);

CREATE TABLE IF NOT EXISTS crawl_pages (
    id BIGSERIAL PRIMARY KEY,
    page INTEGER UNIQUE NOT NULL,
    per_page INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    crawled_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crawl_wines (
    id BIGSERIAL PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    crawled_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wines_slug ON wines(slug);
CREATE INDEX IF NOT EXISTS idx_wines_category_name ON wines(category_name);
CREATE INDEX IF NOT EXISTS idx_wines_region_name ON wines(region_name);
CREATE INDEX IF NOT EXISTS idx_wines_manufacturer_name ON wines(manufacturer_name);
CREATE INDEX IF NOT EXISTS idx_wines_title_fts ON wines USING GIN (to_tsvector('simple', title));
