ALTER TABLE meta.image_annotations ADD COLUMN IF NOT EXISTS rectification JSONB;
ALTER TABLE meta.detection_proposals ADD COLUMN IF NOT EXISTS rectification JSONB;
ALTER TABLE meta.annotation_labels ADD COLUMN IF NOT EXISTS rectification JSONB;

COMMENT ON COLUMN meta.image_annotations.rectification IS 'Reviewed label-level rectification; separate from source ROI geometry.';
COMMENT ON COLUMN meta.detection_proposals.rectification IS 'Immutable helper-proposed label rectification.';
COMMENT ON COLUMN meta.annotation_labels.rectification IS 'Canonical reviewed label rectification used by downstream OCR.';
