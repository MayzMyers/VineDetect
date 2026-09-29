ALTER TABLE meta.annotation_ocr
  ADD COLUMN IF NOT EXISTS coordinate_space JSONB,
  ADD COLUMN IF NOT EXISTS legacy_ocr_region_id UUID REFERENCES meta.ocr_region_annotations(id) ON DELETE SET NULL;

UPDATE meta.annotation_ocr ocr
SET legacy_ocr_region_id = region.id
FROM meta.ocr_region_annotations region
WHERE ocr.legacy_ocr_region_id IS NULL
  AND ocr.id IN (
    meta.deterministic_uuid('ocr:' || region.id::text),
    meta.deterministic_uuid('ocr-review:' || region.id::text)
  );

UPDATE meta.annotation_ocr
SET coordinate_space = CASE
  WHEN label_id IS NULL THEN jsonb_build_object('type', 'source-image')
  ELSE jsonb_build_object(
    'type', 'label-rectified',
    'labelId', label_id::text,
    'cropRevision', NULL,
    'width', NULL,
    'height', NULL
  )
END
WHERE coordinate_space IS NULL;

ALTER TABLE meta.annotation_ocr
  ALTER COLUMN coordinate_space SET NOT NULL;

ALTER TABLE meta.annotation_ocr
  DROP CONSTRAINT IF EXISTS annotation_ocr_coordinate_space_check;

ALTER TABLE meta.annotation_ocr
  ADD CONSTRAINT annotation_ocr_coordinate_space_check CHECK (
    jsonb_typeof(coordinate_space) = 'object'
    AND coordinate_space->>'type' IN ('source-image', 'label-rectified', 'unavailable')
    AND (
      (coordinate_space->>'type' = 'source-image' AND label_id IS NULL)
      OR (
        coordinate_space->>'type' = 'label-rectified'
        AND label_id IS NOT NULL
        AND coordinate_space->>'labelId' = label_id::text
      )
      OR coordinate_space->>'type' = 'unavailable'
    )
  );

CREATE INDEX IF NOT EXISTS idx_annotation_ocr_legacy_region
  ON meta.annotation_ocr (legacy_ocr_region_id) WHERE legacy_ocr_region_id IS NOT NULL;

COMMENT ON COLUMN meta.annotation_ocr.coordinate_space IS
  'Persisted coordinate system for geometry. Source-image uses source pixels; label-rectified uses pixels of the referenced crop revision.';
COMMENT ON COLUMN meta.annotation_ocr.legacy_ocr_region_id IS
  'Non-null only for OCR projected from the legacy wizard review. Direct graph OCR remains independent of wizard resync.';
