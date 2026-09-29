CREATE TABLE IF NOT EXISTS wine_images (
    id BIGSERIAL PRIMARY KEY,
    wine_id BIGINT REFERENCES wines(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    local_path TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (wine_id, kind, url)
);

CREATE INDEX IF NOT EXISTS idx_wine_images_wine_id ON wine_images (wine_id);
CREATE INDEX IF NOT EXISTS idx_wine_images_kind ON wine_images (kind);
CREATE INDEX IF NOT EXISTS idx_wine_images_url ON wine_images (url);
