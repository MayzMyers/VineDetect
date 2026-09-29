ALTER TABLE meta.ocr_region_annotations
    ADD COLUMN IF NOT EXISTS prediction_bbox JSONB,
    ADD COLUMN IF NOT EXISTS prediction_text TEXT,
    ADD COLUMN IF NOT EXISTS prediction_confidence REAL;

UPDATE meta.ocr_region_annotations annotation
SET prediction_bbox = region.bbox,
    prediction_text = region.raw_text,
    prediction_confidence = region.confidence
FROM meta.ocr_regions region
WHERE cardinality(annotation.source_region_ids) = 1
  AND region.id = annotation.source_region_ids[1]
  AND annotation.prediction_bbox IS NULL;

ALTER TABLE meta.ocr_region_annotations
    DROP CONSTRAINT IF EXISTS ocr_region_annotations_transcription_status_check;

UPDATE meta.ocr_region_annotations
SET transcription_status = CASE
    WHEN transcription_status = 'partially-readable' THEN 'partial'
    WHEN transcription_status = 'unverified' AND NULLIF(BTRIM(text), '') IS NULL THEN 'unreadable'
    WHEN transcription_status = 'unverified' THEN 'verified'
    ELSE transcription_status
END;

ALTER TABLE meta.ocr_region_annotations
    ADD CONSTRAINT ocr_region_annotations_transcription_status_check
    CHECK (transcription_status IN ('verified', 'partial', 'unreadable'));

COMMENT ON COLUMN meta.ocr_region_annotations.prediction_bbox IS 'Immutable machine-proposed bbox; null for manual annotations.';
COMMENT ON COLUMN meta.ocr_region_annotations.prediction_text IS 'Immutable machine OCR text; final human transcription remains in text.';
COMMENT ON COLUMN meta.ocr_region_annotations.prediction_confidence IS 'Machine confidence associated with prediction_text/prediction_bbox.';
