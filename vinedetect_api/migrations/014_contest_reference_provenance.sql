-- Add provenance for selected official references without rewriting legacy rows.
ALTER TABLE contest.reference_assets
    ADD COLUMN resolution_method TEXT,
    ADD COLUMN provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN review_note TEXT,
    ADD CONSTRAINT reference_assets_resolution_method_check CHECK (
        resolution_method IS NULL OR resolution_method IN (
            'exact_filename', 'normalized_unique', 'shared_reference',
            'sha_equivalent', 'historical_asset_exact',
            'historical_asset_normalized', 'confirmed_visual',
            'manual_equivalent', 'manual_historical_fallback',
            'source_preserving_shared'
        )
    ),
    ADD CONSTRAINT reference_assets_provenance_object_check
        CHECK (jsonb_typeof(provenance) = 'object'),
    ADD CONSTRAINT reference_assets_review_note_check
        CHECK (review_note IS NULL OR btrim(review_note) <> ''),
    ADD CONSTRAINT reference_assets_provenance_pair_check CHECK (
        (resolution_method IS NULL AND provenance = '{}'::jsonb
            AND review_note IS NULL)
        OR (resolution_method IS NOT NULL AND provenance <> '{}'::jsonb)
    ),
    ADD CONSTRAINT reference_assets_managed_path_check CHECK (
        resolution_method IS NULL OR (
            local_path ~ '^contest/[a-z0-9][a-z0-9-]*/sha256/[0-9a-f]{2}/[0-9a-f]{64}\.[a-z0-9]+$'
            AND split_part(local_path, '/', 4) = left(sha256, 2)
            AND split_part(local_path, '/', 5) LIKE sha256 || '.%'
        )
    );

-- Legacy unprovenanced rows remain untouched. The writer rejects conflicts
-- with any existing reference; new selected assignments are unique per item.
CREATE UNIQUE INDEX reference_assets_provenanced_item_uidx
    ON contest.reference_assets (catalog_item_id)
    WHERE resolution_method IS NOT NULL;
CREATE INDEX reference_assets_resolution_method_idx
    ON contest.reference_assets (resolution_method);
