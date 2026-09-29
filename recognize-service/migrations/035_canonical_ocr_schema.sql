ALTER TABLE meta.annotation_ocr
  ADD COLUMN IF NOT EXISTS region_status TEXT,
  ADD COLUMN IF NOT EXISTS transcription_status TEXT,
  ADD COLUMN IF NOT EXISTS layout_type TEXT,
  ADD COLUMN IF NOT EXISTS text_direction TEXT,
  ADD COLUMN IF NOT EXISTS glyph_orientation TEXT;

UPDATE meta.annotation_ocr SET
  region_status = CASE WHEN status='rejected' THEN 'rejected' ELSE 'reviewed' END,
  transcription_status = CASE WHEN status='verified' AND NULLIF(btrim(transcription),'') IS NOT NULL THEN 'verified' ELSE 'unreadable' END,
  layout_type = COALESCE(layout_type,'string'),
  text_direction = COALESCE(text_direction,'right'),
  glyph_orientation = COALESCE(glyph_orientation,'upright')
WHERE region_status IS NULL OR transcription_status IS NULL OR layout_type IS NULL OR text_direction IS NULL OR glyph_orientation IS NULL;

-- The old canonical graph deliberately collapsed non-verified transcription to
-- no_transcription. Restore the richer reviewed values wherever the legacy
-- annotation identity is still available instead of inventing them from defaults.
UPDATE meta.annotation_ocr graph_ocr SET
  region_status = CASE WHEN reviewed.status = 'rejected' THEN 'rejected' ELSE 'reviewed' END,
  transcription = CASE
    WHEN reviewed.transcription_status = 'unreadable' THEN NULL
    ELSE NULLIF(btrim(reviewed.text), '')
  END,
  transcription_status = CASE
    WHEN reviewed.transcription_status IN ('verified', 'partial')
      AND NULLIF(btrim(reviewed.text), '') IS NOT NULL
      THEN reviewed.transcription_status
    ELSE 'unreadable'
  END,
  layout_type = CASE WHEN reviewed.level = 'word' THEN 'word' ELSE 'string' END,
  text_direction = reviewed.text_direction,
  glyph_orientation = reviewed.glyph_orientation
FROM meta.ocr_region_annotations reviewed
WHERE graph_ocr.legacy_ocr_region_id = reviewed.id;

ALTER TABLE meta.annotation_ocr
  ALTER COLUMN region_status SET DEFAULT 'reviewed', ALTER COLUMN region_status SET NOT NULL,
  ALTER COLUMN transcription_status SET DEFAULT 'unreadable', ALTER COLUMN transcription_status SET NOT NULL,
  ALTER COLUMN layout_type SET DEFAULT 'string', ALTER COLUMN layout_type SET NOT NULL,
  ALTER COLUMN text_direction SET DEFAULT 'right', ALTER COLUMN text_direction SET NOT NULL,
  ALTER COLUMN glyph_orientation SET DEFAULT 'upright', ALTER COLUMN glyph_orientation SET NOT NULL;

ALTER TABLE meta.annotation_ocr
  DROP CONSTRAINT IF EXISTS annotation_ocr_region_status_check,
  DROP CONSTRAINT IF EXISTS annotation_ocr_transcription_status_check,
  DROP CONSTRAINT IF EXISTS annotation_ocr_layout_type_check,
  DROP CONSTRAINT IF EXISTS annotation_ocr_text_direction_check,
  DROP CONSTRAINT IF EXISTS annotation_ocr_glyph_orientation_check,
  DROP CONSTRAINT IF EXISTS annotation_ocr_transcription_contract_check;

ALTER TABLE meta.annotation_ocr
  ADD CONSTRAINT annotation_ocr_region_status_check CHECK (region_status IN ('reviewed','rejected')),
  ADD CONSTRAINT annotation_ocr_transcription_status_check CHECK (transcription_status IN ('verified','partial','unreadable')),
  ADD CONSTRAINT annotation_ocr_layout_type_check CHECK (layout_type IN ('word','string')),
  ADD CONSTRAINT annotation_ocr_text_direction_check CHECK (text_direction IN ('right','left','down','up','mixed')),
  ADD CONSTRAINT annotation_ocr_glyph_orientation_check CHECK (glyph_orientation IN ('upright','clockwise','counterclockwise','upside-down','mixed')),
  ADD CONSTRAINT annotation_ocr_transcription_contract_check CHECK (
    (transcription_status IN ('verified','partial') AND NULLIF(btrim(transcription),'') IS NOT NULL)
    OR (transcription_status='unreadable' AND transcription IS NULL)
  );

ALTER TABLE meta.annotation_candidate_reviews
  ADD COLUMN IF NOT EXISTS reviewed_region_status TEXT CHECK (reviewed_region_status IS NULL OR reviewed_region_status IN ('reviewed','rejected')),
  ADD COLUMN IF NOT EXISTS reviewed_transcription_status TEXT CHECK (reviewed_transcription_status IS NULL OR reviewed_transcription_status IN ('verified','partial','unreadable')),
  ADD COLUMN IF NOT EXISTS reviewed_layout JSONB;

ALTER TABLE meta.annotation_meta
  ADD COLUMN IF NOT EXISTS provenance_source TEXT NOT NULL DEFAULT 'human';
ALTER TABLE meta.annotation_meta
  DROP CONSTRAINT IF EXISTS annotation_meta_provenance_source_check;
ALTER TABLE meta.annotation_meta
  ADD CONSTRAINT annotation_meta_provenance_source_check CHECK (provenance_source IN ('human','auto'));

COMMENT ON COLUMN meta.annotation_ocr.status IS 'Deprecated storage compatibility mirror. Canonical API uses region_status + transcription_status.';
COMMENT ON COLUMN meta.annotation_ocr.region_status IS 'Review state of the physical OCR region.';
COMMENT ON COLUMN meta.annotation_ocr.transcription_status IS 'Independent readability/recognition ground-truth state.';
COMMENT ON COLUMN meta.annotation_meta.provenance_source IS 'Human or automatic origin of semantic/meta annotation.';
