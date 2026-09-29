ALTER TABLE meta.detection_proposals
    ADD COLUMN IF NOT EXISTS geometry JSONB;

ALTER TABLE meta.image_annotations
    ADD COLUMN IF NOT EXISTS geometry JSONB;

ALTER TABLE meta.ocr_regions
    ADD COLUMN IF NOT EXISTS geometry JSONB;

ALTER TABLE meta.ocr_region_annotations
    ADD COLUMN IF NOT EXISTS geometry JSONB,
    ADD COLUMN IF NOT EXISTS prediction_geometry JSONB;

ALTER TABLE meta.label_crops
    ADD COLUMN IF NOT EXISTS geometry JSONB;

UPDATE meta.detection_proposals
SET geometry = jsonb_build_object(
    'type', 'quad',
    'points', jsonb_build_array(
        jsonb_build_object('x', (bbox->>'x')::numeric, 'y', (bbox->>'y')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric + (bbox->>'width')::numeric, 'y', (bbox->>'y')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric + (bbox->>'width')::numeric, 'y', (bbox->>'y')::numeric + (bbox->>'height')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric, 'y', (bbox->>'y')::numeric + (bbox->>'height')::numeric)
    ),
    'bbox', bbox
)
WHERE geometry IS NULL AND bbox IS NOT NULL;

UPDATE meta.image_annotations
SET geometry = jsonb_build_object(
    'type', 'quad',
    'points', jsonb_build_array(
        jsonb_build_object('x', (bbox->>'x')::numeric, 'y', (bbox->>'y')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric + (bbox->>'width')::numeric, 'y', (bbox->>'y')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric + (bbox->>'width')::numeric, 'y', (bbox->>'y')::numeric + (bbox->>'height')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric, 'y', (bbox->>'y')::numeric + (bbox->>'height')::numeric)
    ),
    'bbox', bbox
)
WHERE geometry IS NULL AND bbox IS NOT NULL;

UPDATE meta.label_crops
SET geometry = jsonb_build_object(
    'type', 'quad',
    'points', jsonb_build_array(
        jsonb_build_object('x', (bbox->>'x')::numeric, 'y', (bbox->>'y')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric + (bbox->>'width')::numeric, 'y', (bbox->>'y')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric + (bbox->>'width')::numeric, 'y', (bbox->>'y')::numeric + (bbox->>'height')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric, 'y', (bbox->>'y')::numeric + (bbox->>'height')::numeric)
    ),
    'bbox', bbox
)
WHERE geometry IS NULL AND bbox IS NOT NULL;

UPDATE meta.ocr_regions
SET geometry = jsonb_build_object(
    'type', 'quad',
    'points', jsonb_build_array(
        jsonb_build_object('x', (bbox->>'x')::numeric, 'y', (bbox->>'y')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric + (bbox->>'width')::numeric, 'y', (bbox->>'y')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric + (bbox->>'width')::numeric, 'y', (bbox->>'y')::numeric + (bbox->>'height')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric, 'y', (bbox->>'y')::numeric + (bbox->>'height')::numeric)
    ),
    'bbox', bbox
)
WHERE geometry IS NULL;

UPDATE meta.ocr_region_annotations
SET geometry = jsonb_build_object(
    'type', 'quad',
    'points', jsonb_build_array(
        jsonb_build_object('x', (bbox->>'x')::numeric, 'y', (bbox->>'y')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric + (bbox->>'width')::numeric, 'y', (bbox->>'y')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric + (bbox->>'width')::numeric, 'y', (bbox->>'y')::numeric + (bbox->>'height')::numeric),
        jsonb_build_object('x', (bbox->>'x')::numeric, 'y', (bbox->>'y')::numeric + (bbox->>'height')::numeric)
    ),
    'bbox', bbox
)
WHERE geometry IS NULL;

UPDATE meta.ocr_region_annotations
SET prediction_geometry = jsonb_build_object(
    'type', 'quad',
    'points', jsonb_build_array(
        jsonb_build_object('x', (prediction_bbox->>'x')::numeric, 'y', (prediction_bbox->>'y')::numeric),
        jsonb_build_object('x', (prediction_bbox->>'x')::numeric + (prediction_bbox->>'width')::numeric, 'y', (prediction_bbox->>'y')::numeric),
        jsonb_build_object('x', (prediction_bbox->>'x')::numeric + (prediction_bbox->>'width')::numeric, 'y', (prediction_bbox->>'y')::numeric + (prediction_bbox->>'height')::numeric),
        jsonb_build_object('x', (prediction_bbox->>'x')::numeric, 'y', (prediction_bbox->>'y')::numeric + (prediction_bbox->>'height')::numeric)
    ),
    'bbox', prediction_bbox
)
WHERE prediction_geometry IS NULL AND prediction_bbox IS NOT NULL;

COMMENT ON COLUMN meta.image_annotations.geometry IS 'Canonical reviewed label geometry: convex clockwise quad in source-image pixels; bbox is derived compatibility data.';
COMMENT ON COLUMN meta.ocr_region_annotations.geometry IS 'Canonical reviewed OCR geometry: convex clockwise quad normalized to the reviewed label crop; bbox is derived compatibility data.';
COMMENT ON COLUMN meta.ocr_region_annotations.prediction_geometry IS 'Immutable machine-proposed quad; null for manual OCR regions.';
