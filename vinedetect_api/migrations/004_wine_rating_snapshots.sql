CREATE TABLE IF NOT EXISTS wine_rating_snapshots (
    id BIGSERIAL PRIMARY KEY,
    wine_id BIGINT NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    rating_value NUMERIC,
    votes_count INTEGER,
    reviews_count INTEGER,
    rating_raw JSONB,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (wine_id, source)
);

CREATE INDEX IF NOT EXISTS idx_wine_rating_snapshots_wine_id
    ON wine_rating_snapshots (wine_id);

CREATE INDEX IF NOT EXISTS idx_wine_rating_snapshots_source
    ON wine_rating_snapshots (source);

CREATE INDEX IF NOT EXISTS idx_wine_rating_snapshots_value
    ON wine_rating_snapshots (rating_value);

CREATE INDEX IF NOT EXISTS idx_wine_rating_snapshots_fetched_at
    ON wine_rating_snapshots (fetched_at);
