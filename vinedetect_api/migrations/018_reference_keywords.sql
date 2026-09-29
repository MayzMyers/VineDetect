-- Reuse the recognition_profiles foundation from 009. Restored development DBs
-- may lack that optional table. No existing catalog/recognition data is changed.
CREATE TABLE IF NOT EXISTS svoe_vino.recognition_profiles (
    id BIGSERIAL PRIMARY KEY,
    wine_id BIGINT NOT NULL REFERENCES svoe_vino.wines(id) ON DELETE CASCADE,
    profile_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    source_dataset TEXT,
    source_dataset_version TEXT,
    profile_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (wine_id, profile_version),
    CONSTRAINT chk_recognition_profiles_status
        CHECK (status IN ('draft', 'ready', 'stale', 'disabled', 'deprecated')),
    CONSTRAINT chk_recognition_profiles_non_blank CHECK (
        btrim(profile_version) <> '' AND btrim(schema_version) <> ''
        AND btrim(status) <> ''
        AND (source_dataset IS NULL OR btrim(source_dataset) <> '')
        AND (source_dataset_version IS NULL OR btrim(source_dataset_version) <> '')
    )
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'svoe_vino.recognition_profiles'::regclass
          AND conname = 'chk_reference_keywords_profile'
    ) THEN
        ALTER TABLE svoe_vino.recognition_profiles
        ADD CONSTRAINT chk_reference_keywords_profile CHECK (
            profile_version <> 'reference-keywords/1' OR COALESCE((
                schema_version = 'references/1'
                AND jsonb_typeof(profile_data->'title') = 'string'
                AND jsonb_typeof(profile_data->'keywords') = 'array'
                AND NOT jsonb_path_exists(
                    profile_data->'keywords',
                    '$[*] ? (@.type() != "string" || @ == "")'
                )
            ), false)
        );
    END IF;
END $$;

-- Refresh after changing titles or OCR. The repository detects missing/stale
-- snapshots instead of silently omitting wines or returning empty keywords.
CREATE OR REPLACE VIEW svoe_vino.reference_keywords AS
SELECT wine.slug, profile.profile_data->'keywords' AS keywords
FROM svoe_vino.wines AS wine
JOIN svoe_vino.recognition_profiles AS profile ON profile.wine_id = wine.id
WHERE profile.profile_version = 'reference-keywords/1'
  AND profile.schema_version = 'references/1'
  AND profile.status = 'ready'
  AND profile.profile_data->>'title' = wine.title;
