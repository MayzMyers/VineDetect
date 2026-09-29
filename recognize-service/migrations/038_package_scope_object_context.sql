ALTER TABLE meta.annotation_packages
  ADD COLUMN IF NOT EXISTS scope_geometry JSONB,
  ADD COLUMN IF NOT EXISTS scope_source TEXT NOT NULL DEFAULT 'default-full-image',
  ADD COLUMN IF NOT EXISTS package_type TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS package_type_status TEXT NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS package_type_source TEXT,
  ADD COLUMN IF NOT EXISTS package_type_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS object_geometry JSONB,
  ADD COLUMN IF NOT EXISTS object_status TEXT NOT NULL DEFAULT 'missing',
  ADD COLUMN IF NOT EXISTS object_source TEXT,
  ADD COLUMN IF NOT EXISTS object_reviewed_at TIMESTAMPTZ;

UPDATE meta.annotation_packages
SET scope_geometry = geometry,
    scope_source = CASE WHEN geometry IS NULL THEN 'default-full-image' ELSE 'legacy-unclassified' END
WHERE scope_geometry IS NULL;

ALTER TABLE meta.annotation_packages
  DROP CONSTRAINT IF EXISTS annotation_packages_scope_source_check,
  ADD CONSTRAINT annotation_packages_scope_source_check
    CHECK (scope_source IN ('default-full-image', 'auto', 'human', 'legacy-unclassified')),
  DROP CONSTRAINT IF EXISTS annotation_packages_package_type_check,
  ADD CONSTRAINT annotation_packages_package_type_check
    CHECK (package_type IN ('bottle', 'tube', 'box', 'other', 'unknown')),
  DROP CONSTRAINT IF EXISTS annotation_packages_package_type_status_check,
  ADD CONSTRAINT annotation_packages_package_type_status_check
    CHECK (package_type_status IN ('unreviewed', 'reviewed')),
  DROP CONSTRAINT IF EXISTS annotation_packages_package_type_source_check,
  ADD CONSTRAINT annotation_packages_package_type_source_check
    CHECK (package_type_source IS NULL OR package_type_source IN ('human', 'auto')),
  DROP CONSTRAINT IF EXISTS annotation_packages_object_status_check,
  ADD CONSTRAINT annotation_packages_object_status_check
    CHECK (object_status IN ('missing', 'suggested', 'reviewed', 'rejected')),
  DROP CONSTRAINT IF EXISTS annotation_packages_object_source_check,
  ADD CONSTRAINT annotation_packages_object_source_check
    CHECK (object_source IS NULL OR object_source IN ('human', 'auto'));

COMMENT ON COLUMN meta.annotation_packages.scope_geometry IS
  'Technical helper working scope in source-image coordinates; NULL means the full source image and is not object GT.';
COMMENT ON COLUMN meta.annotation_packages.object_geometry IS
  'Reviewed physical package contour used as object segmentation ground truth.';
COMMENT ON COLUMN meta.annotation_packages.package_type IS
  'Coarse package class; usable as classification GT only when package_type_status=reviewed.';
