ALTER TABLE wines
    ADD COLUMN IF NOT EXISTS source TEXT,
    ADD COLUMN IF NOT EXISTS external_id TEXT,
    ADD COLUMN IF NOT EXISTS source_url TEXT,
    ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;

ALTER TABLE wines
    ALTER COLUMN public_rating TYPE NUMERIC(4, 1)
    USING public_rating::NUMERIC(4, 1);

UPDATE wines
SET source = COALESCE(source, 'vino-svoe'),
    external_id = COALESCE(external_id, slug)
WHERE source IS NULL
   OR external_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wines_source_external_id_unique
    ON wines (source, external_id)
    WHERE source IS NOT NULL
      AND external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wines_source
    ON wines (source);