CREATE UNIQUE INDEX IF NOT EXISTS idx_wine_images_id_wine_id_unique
    ON wine_images (id, wine_id);

CREATE TABLE IF NOT EXISTS recognition_assets (
    id BIGSERIAL PRIMARY KEY,
    wine_id BIGINT NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
    wine_image_id BIGINT,
    parent_asset_id BIGINT,
    asset_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    schema_version TEXT NOT NULL DEFAULT 'recognition-asset/1',
    asset_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, wine_id),
    FOREIGN KEY (wine_image_id, wine_id)
        REFERENCES wine_images (id, wine_id)
        ON DELETE SET NULL (wine_image_id),
    FOREIGN KEY (parent_asset_id, wine_id)
        REFERENCES recognition_assets (id, wine_id)
        ON DELETE SET NULL (parent_asset_id),
    CONSTRAINT chk_recognition_assets_status
        CHECK (status IN ('active', 'pending', 'disabled', 'failed', 'deprecated')),
    CONSTRAINT chk_recognition_assets_self_parent
        CHECK (parent_asset_id IS NULL OR parent_asset_id <> id),
    CONSTRAINT chk_recognition_assets_non_blank
        CHECK (
            btrim(asset_type) <> ''
            AND btrim(status) <> ''
            AND btrim(schema_version) <> ''
        )
);

CREATE TABLE IF NOT EXISTS recognition_profiles (
    id BIGSERIAL PRIMARY KEY,
    wine_id BIGINT NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
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
    CONSTRAINT chk_recognition_profiles_non_blank
        CHECK (
            btrim(profile_version) <> ''
            AND btrim(schema_version) <> ''
            AND btrim(status) <> ''
            AND (source_dataset IS NULL OR btrim(source_dataset) <> '')
            AND (
                source_dataset_version IS NULL
                OR btrim(source_dataset_version) <> ''
            )
        )
);

CREATE TABLE IF NOT EXISTS recognition_aliases (
    id BIGSERIAL PRIMARY KEY,
    wine_id BIGINT NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
    alias_type TEXT NOT NULL,
    value TEXT NOT NULL,
    normalized_value TEXT,
    lang TEXT,
    weight NUMERIC(5, 4) NOT NULL DEFAULT 1.0,
    source TEXT NOT NULL DEFAULT 'manual',
    is_positive BOOLEAN NOT NULL DEFAULT true,
    alias_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_recognition_aliases_weight
        CHECK (weight >= 0 AND weight <= 1),
    CONSTRAINT chk_recognition_aliases_non_blank
        CHECK (
            btrim(alias_type) <> ''
            AND btrim(value) <> ''
            AND btrim(source) <> ''
            AND (normalized_value IS NULL OR btrim(normalized_value) <> '')
            AND (lang IS NULL OR btrim(lang) <> '')
        )
);

CREATE TABLE IF NOT EXISTS recognition_annotations (
    id BIGSERIAL PRIMARY KEY,
    wine_id BIGINT NOT NULL REFERENCES wines(id) ON DELETE CASCADE,
    asset_id BIGINT,
    annotation_type TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'active',
    confidence NUMERIC(5, 4),
    schema_version TEXT NOT NULL DEFAULT 'recognition-annotation/1',
    annotation_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (asset_id, wine_id)
        REFERENCES recognition_assets (id, wine_id)
        ON DELETE CASCADE,
    CONSTRAINT chk_recognition_annotations_confidence
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT chk_recognition_annotations_status
        CHECK (status IN ('active', 'needs_review', 'rejected', 'deprecated')),
    CONSTRAINT chk_recognition_annotations_non_blank
        CHECK (
            btrim(annotation_type) <> ''
            AND btrim(source) <> ''
            AND btrim(status) <> ''
            AND btrim(schema_version) <> ''
        )
);

CREATE TABLE IF NOT EXISTS ocr_observations (
    id BIGSERIAL PRIMARY KEY,
    asset_id BIGINT NOT NULL REFERENCES recognition_assets(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    engine_version TEXT,
    language TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    confidence NUMERIC(5, 4),
    schema_version TEXT NOT NULL DEFAULT 'ocr-observation/1',
    observation_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_ocr_observations_confidence
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT chk_ocr_observations_status
        CHECK (status IN ('pending', 'completed', 'failed', 'rejected')),
    CONSTRAINT chk_ocr_observations_non_blank
        CHECK (
            btrim(engine) <> ''
            AND btrim(status) <> ''
            AND btrim(schema_version) <> ''
            AND (engine_version IS NULL OR btrim(engine_version) <> '')
            AND (language IS NULL OR btrim(language) <> '')
        )
);

CREATE TABLE IF NOT EXISTS visual_features (
    id BIGSERIAL PRIMARY KEY,
    asset_id BIGINT NOT NULL REFERENCES recognition_assets(id) ON DELETE CASCADE,
    feature_type TEXT NOT NULL,
    extractor_name TEXT,
    extractor_version TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    schema_version TEXT NOT NULL DEFAULT 'visual-feature/1',
    feature_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_visual_features_status
        CHECK (status IN ('pending', 'completed', 'failed', 'rejected', 'deprecated')),
    CONSTRAINT chk_visual_features_non_blank
        CHECK (
            btrim(feature_type) <> ''
            AND btrim(status) <> ''
            AND btrim(schema_version) <> ''
            AND (extractor_name IS NULL OR btrim(extractor_name) <> '')
            AND (extractor_version IS NULL OR btrim(extractor_version) <> '')
        )
);

CREATE TABLE IF NOT EXISTS asset_processing_jobs (
    id BIGSERIAL PRIMARY KEY,
    asset_id BIGINT NOT NULL REFERENCES recognition_assets(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    processor_name TEXT,
    processor_version TEXT,
    schema_version TEXT NOT NULL DEFAULT 'asset-job/1',
    input_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT chk_asset_processing_jobs_attempts
        CHECK (attempts >= 0),
    CONSTRAINT chk_asset_processing_jobs_status
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'cancelled')),
    CONSTRAINT chk_asset_processing_jobs_non_blank
        CHECK (
            btrim(job_type) <> ''
            AND btrim(status) <> ''
            AND btrim(schema_version) <> ''
            AND (processor_name IS NULL OR btrim(processor_name) <> '')
            AND (processor_version IS NULL OR btrim(processor_version) <> '')
        )
);

CREATE INDEX IF NOT EXISTS idx_recognition_assets_wine_id
    ON recognition_assets (wine_id);
CREATE INDEX IF NOT EXISTS idx_recognition_assets_wine_image_id_wine_id
    ON recognition_assets (wine_image_id, wine_id);
CREATE INDEX IF NOT EXISTS idx_recognition_assets_parent_asset_id_wine_id
    ON recognition_assets (parent_asset_id, wine_id);
CREATE INDEX IF NOT EXISTS idx_recognition_assets_asset_type
    ON recognition_assets (asset_type);
CREATE INDEX IF NOT EXISTS idx_recognition_assets_status
    ON recognition_assets (status);

CREATE INDEX IF NOT EXISTS idx_recognition_profiles_profile_version
    ON recognition_profiles (profile_version);
CREATE INDEX IF NOT EXISTS idx_recognition_profiles_status
    ON recognition_profiles (status);
CREATE INDEX IF NOT EXISTS idx_recognition_profiles_source_dataset
    ON recognition_profiles (source_dataset);

CREATE INDEX IF NOT EXISTS idx_recognition_aliases_wine_id
    ON recognition_aliases (wine_id);
CREATE INDEX IF NOT EXISTS idx_recognition_aliases_alias_type
    ON recognition_aliases (alias_type);
CREATE INDEX IF NOT EXISTS idx_recognition_aliases_source
    ON recognition_aliases (source);
CREATE INDEX IF NOT EXISTS idx_recognition_aliases_value
    ON recognition_aliases (value);

CREATE INDEX IF NOT EXISTS idx_recognition_annotations_wine_id
    ON recognition_annotations (wine_id);
CREATE INDEX IF NOT EXISTS idx_recognition_annotations_asset_id_wine_id
    ON recognition_annotations (asset_id, wine_id);
CREATE INDEX IF NOT EXISTS idx_recognition_annotations_annotation_type
    ON recognition_annotations (annotation_type);
CREATE INDEX IF NOT EXISTS idx_recognition_annotations_status
    ON recognition_annotations (status);
CREATE INDEX IF NOT EXISTS idx_recognition_annotations_source
    ON recognition_annotations (source);

CREATE INDEX IF NOT EXISTS idx_ocr_observations_asset_id
    ON ocr_observations (asset_id);
CREATE INDEX IF NOT EXISTS idx_ocr_observations_engine
    ON ocr_observations (engine);
CREATE INDEX IF NOT EXISTS idx_ocr_observations_status
    ON ocr_observations (status);
CREATE INDEX IF NOT EXISTS idx_ocr_observations_created_at
    ON ocr_observations (created_at);

CREATE INDEX IF NOT EXISTS idx_visual_features_asset_id
    ON visual_features (asset_id);
CREATE INDEX IF NOT EXISTS idx_visual_features_feature_type
    ON visual_features (feature_type);
CREATE INDEX IF NOT EXISTS idx_visual_features_extractor_name
    ON visual_features (extractor_name);
CREATE INDEX IF NOT EXISTS idx_visual_features_status
    ON visual_features (status);
CREATE INDEX IF NOT EXISTS idx_visual_features_created_at
    ON visual_features (created_at);

CREATE INDEX IF NOT EXISTS idx_asset_processing_jobs_asset_id
    ON asset_processing_jobs (asset_id);
CREATE INDEX IF NOT EXISTS idx_asset_processing_jobs_job_type
    ON asset_processing_jobs (job_type);
CREATE INDEX IF NOT EXISTS idx_asset_processing_jobs_status
    ON asset_processing_jobs (status);
CREATE INDEX IF NOT EXISTS idx_asset_processing_jobs_processor_name
    ON asset_processing_jobs (processor_name);
CREATE INDEX IF NOT EXISTS idx_asset_processing_jobs_created_at
    ON asset_processing_jobs (created_at);
