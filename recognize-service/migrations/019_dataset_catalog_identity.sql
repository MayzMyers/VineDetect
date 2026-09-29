ALTER TABLE meta.dataset_versions
    ALTER COLUMN schema_version SET DEFAULT 2;

COMMENT ON COLUMN meta.dataset_versions.schema_version IS
    'Snapshot contract version. Version 2 adds the optional reviewed catalogIdentity layer.';
