-- A Label is a generic visual/design region, not necessarily a physical sticker.
-- Every OCR region belongs to one such region. Legacy direct Package OCR is
-- preserved by wrapping it in an unreviewed synthetic region; that geometry is
-- helper context, not trusted Label/VisualRegion detector ground truth.

ALTER TABLE meta.annotation_labels
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'human',
  ADD COLUMN IF NOT EXISTS geometry_review_status TEXT NOT NULL DEFAULT 'reviewed';

ALTER TABLE meta.annotation_labels
  DROP CONSTRAINT IF EXISTS annotation_labels_origin_check;
ALTER TABLE meta.annotation_labels
  ADD CONSTRAINT annotation_labels_origin_check CHECK (
    origin IN ('human', 'helper', 'legacy', 'migrated_from_direct_ocr')
  );

ALTER TABLE meta.annotation_labels
  DROP CONSTRAINT IF EXISTS annotation_labels_geometry_review_status_check;
ALTER TABLE meta.annotation_labels
  ADD CONSTRAINT annotation_labels_geometry_review_status_check CHECK (
    geometry_review_status IN ('suggested', 'reviewed', 'rejected')
  );

UPDATE meta.annotation_labels label
SET origin = CASE
      WHEN package.legacy_annotation_track_id IS NOT NULL
       AND label.id = meta.deterministic_uuid('label-track:' || package.legacy_annotation_track_id::text)
        THEN 'legacy'
      ELSE label.origin
    END,
    geometry_review_status = CASE WHEN label.status = 'reviewed' THEN 'reviewed' ELSE 'suggested' END
FROM meta.annotation_packages package
WHERE package.id = label.package_id;

-- Use the original OCR quad as the synthetic region. Keeping the exact quad
-- avoids inventing additional geometry; a human may enlarge/refine it later.
INSERT INTO meta.annotation_labels (
  id, package_id, geometry, status, origin, geometry_review_status, created_at, updated_at, deleted_at
)
SELECT meta.deterministic_uuid('visual-region:direct-ocr:' || ocr.id::text),
       ocr.package_id,
       ocr.geometry,
       'draft',
       'migrated_from_direct_ocr',
       'suggested',
       ocr.created_at,
       ocr.updated_at,
       ocr.deleted_at
FROM meta.annotation_ocr ocr
WHERE ocr.label_id IS NULL
ON CONFLICT (id) DO NOTHING;

-- The synthetic region and the old OCR quad are identical, therefore the OCR
-- occupies the complete rectified region. Source geometry remains recoverable
-- from the Label quad, while the OCR contract becomes uniformly label-scoped.
UPDATE meta.annotation_ocr ocr
SET label_id = label.id,
    geometry = jsonb_build_object(
      'type', 'quad',
      'points', jsonb_build_array(
        jsonb_build_object('x', 0, 'y', 0),
        jsonb_build_object('x', 1, 'y', 0),
        jsonb_build_object('x', 1, 'y', 1),
        jsonb_build_object('x', 0, 'y', 1)
      ),
      'bbox', jsonb_build_object('x', 0, 'y', 0, 'width', 1, 'height', 1)
    ),
    coordinate_space = jsonb_build_object(
      'type', 'label-rectified',
      'units', 'normalized',
      'labelId', label.id::text,
      'cropRevision', NULL,
      'width', NULL,
      'height', NULL
    ),
    parent_relation_source = 'auto',
    parent_relation_status = 'suggested',
    parent_relation_suggested_label_id = label.id,
    updated_at = now()
FROM meta.annotation_labels label
WHERE ocr.label_id IS NULL
  AND label.id = meta.deterministic_uuid('visual-region:direct-ocr:' || ocr.id::text);

-- Historical candidate/review evidence remains immutable, but every new
-- candidate must point at a Label. Package scope is no longer a valid OCR run.
ALTER TABLE meta.annotation_candidates
  DROP CONSTRAINT IF EXISTS annotation_candidates_suggested_parent_check;
ALTER TABLE meta.annotation_candidates
  ADD CONSTRAINT annotation_candidates_suggested_parent_check CHECK (
    suggested_parent_type IS NULL
    OR (
      suggested_parent_type = 'label'
      AND suggested_package_id IS NOT NULL
      AND suggested_label_id IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE meta.annotation_ocr
  DROP CONSTRAINT IF EXISTS annotation_ocr_coordinate_space_check;
ALTER TABLE meta.annotation_ocr
  ADD CONSTRAINT annotation_ocr_coordinate_space_check CHECK (
    jsonb_typeof(coordinate_space) = 'object'
    AND coordinate_space->>'type' IN ('label-rectified', 'unavailable')
    AND (
      (
        coordinate_space->>'type' = 'label-rectified'
        AND coordinate_space->>'units' = 'normalized'
        AND coordinate_space->>'labelId' = label_id::text
      )
      OR coordinate_space->>'type' = 'unavailable'
    )
  );

ALTER TABLE meta.annotation_ocr ALTER COLUMN label_id SET NOT NULL;

COMMENT ON TABLE meta.annotation_labels IS
  'Visual/design regions inside a Package. UI calls them Labels; they are not limited to physical stickers.';
COMMENT ON COLUMN meta.annotation_labels.origin IS
  'Creation provenance. migrated_from_direct_ocr regions are synthetic and excluded from Label GT until reviewed.';
COMMENT ON COLUMN meta.annotation_labels.geometry_review_status IS
  'Independent trust state for VisualRegion geometry used by task-specific dataset exporters.';
