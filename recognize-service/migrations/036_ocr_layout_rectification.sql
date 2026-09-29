ALTER TABLE meta.annotation_ocr
  ADD COLUMN IF NOT EXISTS layout_flow TEXT,
  ADD COLUMN IF NOT EXISTS baseline_angle_deg DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS layout_baseline JSONB,
  ADD COLUMN IF NOT EXISTS character_orientation TEXT,
  ADD COLUMN IF NOT EXISTS rectification JSONB;

UPDATE meta.annotation_ocr SET
  layout_flow = COALESCE(layout_flow, 'linear'),
  baseline_angle_deg = COALESCE(baseline_angle_deg, CASE text_direction
    WHEN 'down' THEN 90 WHEN 'left' THEN 180 WHEN 'up' THEN -90 ELSE 0 END),
  character_orientation = COALESCE(character_orientation, CASE glyph_orientation
    WHEN 'upright' THEN 'upright' WHEN 'mixed' THEN 'mixed' ELSE 'aligned' END)
WHERE layout_flow IS NULL OR baseline_angle_deg IS NULL OR character_orientation IS NULL;

ALTER TABLE meta.annotation_ocr
  ALTER COLUMN layout_flow SET DEFAULT 'linear', ALTER COLUMN layout_flow SET NOT NULL,
  ALTER COLUMN baseline_angle_deg SET DEFAULT 0, ALTER COLUMN baseline_angle_deg SET NOT NULL,
  ALTER COLUMN character_orientation SET DEFAULT 'upright', ALTER COLUMN character_orientation SET NOT NULL;

ALTER TABLE meta.annotation_ocr
  DROP CONSTRAINT IF EXISTS annotation_ocr_layout_flow_check,
  DROP CONSTRAINT IF EXISTS annotation_ocr_baseline_angle_check,
  DROP CONSTRAINT IF EXISTS annotation_ocr_character_orientation_check,
  DROP CONSTRAINT IF EXISTS annotation_ocr_layout_contract_check,
  DROP CONSTRAINT IF EXISTS annotation_ocr_rectification_check;
ALTER TABLE meta.annotation_ocr
  ADD CONSTRAINT annotation_ocr_layout_flow_check CHECK (layout_flow IN ('linear','curved')),
  ADD CONSTRAINT annotation_ocr_baseline_angle_check CHECK (baseline_angle_deg >= -180 AND baseline_angle_deg <= 180),
  ADD CONSTRAINT annotation_ocr_character_orientation_check CHECK (character_orientation IN ('aligned','tangent-aligned','upright','mixed')),
  ADD CONSTRAINT annotation_ocr_layout_contract_check CHECK (
    (layout_flow='linear' AND layout_baseline IS NULL AND character_orientation <> 'tangent-aligned')
    OR (layout_flow='curved' AND layout_baseline IS NOT NULL AND jsonb_typeof(layout_baseline)='array' AND jsonb_array_length(layout_baseline) >= 2 AND character_orientation <> 'aligned')
  ),
  ADD CONSTRAINT annotation_ocr_rectification_check CHECK (rectification IS NULL OR jsonb_typeof(rectification)='object');

ALTER TABLE meta.ocr_region_annotations
  ADD COLUMN IF NOT EXISTS layout_flow TEXT,
  ADD COLUMN IF NOT EXISTS baseline_angle_deg DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS layout_baseline JSONB,
  ADD COLUMN IF NOT EXISTS character_orientation TEXT,
  ADD COLUMN IF NOT EXISTS rectification JSONB,
  ADD COLUMN IF NOT EXISTS prediction_layout JSONB,
  ADD COLUMN IF NOT EXISTS prediction_rectification JSONB;

UPDATE meta.ocr_region_annotations SET
  layout_flow = COALESCE(layout_flow, 'linear'),
  baseline_angle_deg = COALESCE(baseline_angle_deg, CASE text_direction
    WHEN 'down' THEN 90 WHEN 'left' THEN 180 WHEN 'up' THEN -90 ELSE 0 END),
  character_orientation = COALESCE(character_orientation, CASE glyph_orientation
    WHEN 'upright' THEN 'upright' WHEN 'mixed' THEN 'mixed' ELSE 'aligned' END)
WHERE layout_flow IS NULL OR baseline_angle_deg IS NULL OR character_orientation IS NULL;

ALTER TABLE meta.ocr_region_annotations
  ALTER COLUMN layout_flow SET DEFAULT 'linear', ALTER COLUMN layout_flow SET NOT NULL,
  ALTER COLUMN baseline_angle_deg SET DEFAULT 0, ALTER COLUMN baseline_angle_deg SET NOT NULL,
  ALTER COLUMN character_orientation SET DEFAULT 'upright', ALTER COLUMN character_orientation SET NOT NULL;

ALTER TABLE meta.ocr_region_annotations
  DROP CONSTRAINT IF EXISTS ocr_region_annotations_layout_flow_check,
  DROP CONSTRAINT IF EXISTS ocr_region_annotations_baseline_angle_check,
  DROP CONSTRAINT IF EXISTS ocr_region_annotations_character_orientation_check,
  DROP CONSTRAINT IF EXISTS ocr_region_annotations_layout_contract_check,
  DROP CONSTRAINT IF EXISTS ocr_region_annotations_rectification_check,
  DROP CONSTRAINT IF EXISTS ocr_region_annotations_prediction_layout_check,
  DROP CONSTRAINT IF EXISTS ocr_region_annotations_prediction_rectification_check;
ALTER TABLE meta.ocr_region_annotations
  ADD CONSTRAINT ocr_region_annotations_layout_flow_check CHECK (layout_flow IN ('linear','curved')),
  ADD CONSTRAINT ocr_region_annotations_baseline_angle_check CHECK (baseline_angle_deg >= -180 AND baseline_angle_deg <= 180),
  ADD CONSTRAINT ocr_region_annotations_character_orientation_check CHECK (character_orientation IN ('aligned','tangent-aligned','upright','mixed')),
  ADD CONSTRAINT ocr_region_annotations_layout_contract_check CHECK (
    (layout_flow='linear' AND layout_baseline IS NULL AND character_orientation <> 'tangent-aligned')
    OR (layout_flow='curved' AND layout_baseline IS NOT NULL AND jsonb_typeof(layout_baseline)='array' AND jsonb_array_length(layout_baseline) >= 2 AND character_orientation <> 'aligned')
  ),
  ADD CONSTRAINT ocr_region_annotations_rectification_check CHECK (rectification IS NULL OR jsonb_typeof(rectification)='object'),
  ADD CONSTRAINT ocr_region_annotations_prediction_layout_check CHECK (prediction_layout IS NULL OR jsonb_typeof(prediction_layout)='object'),
  ADD CONSTRAINT ocr_region_annotations_prediction_rectification_check CHECK (prediction_rectification IS NULL OR jsonb_typeof(prediction_rectification)='object');

ALTER TABLE meta.annotation_candidate_reviews
  ADD COLUMN IF NOT EXISTS reviewed_rectification JSONB;

COMMENT ON COLUMN meta.annotation_ocr.geometry IS 'Detection GT in the original entity coordinate space. Never rewritten by OCR rectification.';
COMMENT ON COLUMN meta.annotation_ocr.rectification IS 'Reviewed local transform from original OCR region to normalized recognition crop.';
COMMENT ON COLUMN meta.ocr_region_annotations.prediction_rectification IS 'Immutable helper-proposed local OCR transform.';
COMMENT ON COLUMN meta.ocr_region_annotations.prediction_layout IS 'Immutable helper-proposed OCR layout before human correction.';
