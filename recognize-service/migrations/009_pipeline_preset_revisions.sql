CREATE TABLE IF NOT EXISTS meta.pipeline_preset_revisions (
    id UUID PRIMARY KEY,
    preset_id UUID NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    layer TEXT NOT NULL CHECK (layer IN (
        'label-roi',
        'ocr-region',
        'ocr-recognition',
        'source-matching',
        'alias-generation',
        'pipeline'
    )),
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'deprecated')),
    engine_kind TEXT NOT NULL,
    engine_version TEXT,
    config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
    created_from_source TEXT,
    created_from_source_item_id TEXT,
    created_by TEXT,
    based_on_revision INTEGER,
    validation_dataset_version TEXT,
    validation_metrics JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (preset_id, revision),
    CHECK (
        (created_from_source IS NULL AND created_from_source_item_id IS NULL)
        OR (created_from_source IS NOT NULL AND created_from_source_item_id IS NOT NULL)
    ),
    CHECK (validation_metrics IS NULL OR jsonb_typeof(validation_metrics) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_pipeline_preset_revisions_latest
    ON meta.pipeline_preset_revisions (layer, preset_id, revision DESC);

CREATE INDEX IF NOT EXISTS idx_pipeline_preset_revisions_status
    ON meta.pipeline_preset_revisions (status, layer, created_at DESC);

INSERT INTO meta.pipeline_preset_revisions (
    id,
    preset_id,
    revision,
    layer,
    name,
    description,
    status,
    engine_kind,
    engine_version,
    config,
    created_by,
    created_at
)
VALUES (
    '96d59f6a-99dd-4bb6-a79b-f0bbf0d4f101',
    '62ceefac-970e-474b-9049-46eb128b32d0',
    1,
    'label-roi',
    'Default label ROI',
    'Built-in baseline for OpenCV label ROI proposals.',
    'validated',
    'opencv',
    'cv-meta-v2-debug-layers',
    '{
      "schemaVersion": 1,
      "preprocessing": {
        "source": "full-image",
        "resize": {"enabled": true, "maxWidth": 1200, "maxHeight": 1600}
      },
      "color": {
        "colorSpace": "lab",
        "referenceMode": "auto-bottle-color",
        "referenceColors": [],
        "distanceThreshold": 42
      },
      "threshold": {
        "enabled": true,
        "type": "color-distance",
        "value": 42
      },
      "morphology": {
        "enabled": true,
        "operation": "close",
        "kernelWidth": 5,
        "kernelHeight": 5,
        "iterations": 1
      },
      "scoring": {
        "positionWeight": 0.12,
        "areaWeight": 0.16,
        "rectangularityWeight": 0.14,
        "edgeDensityWeight": 0.14,
        "colorDifferenceWeight": 0.24
      },
      "selection": {"minScore": 0.18, "maxCandidates": 12}
    }'::jsonb,
    'system-migration',
    '1970-01-01T00:00:00Z'
)
ON CONFLICT (preset_id, revision) DO NOTHING;
