ALTER TABLE meta.ocr_regions
    ADD COLUMN IF NOT EXISTS text_direction TEXT NOT NULL DEFAULT 'right'
        CHECK (text_direction IN ('right', 'left', 'down', 'up', 'mixed')),
    ADD COLUMN IF NOT EXISTS glyph_orientation TEXT NOT NULL DEFAULT 'upright'
        CHECK (glyph_orientation IN ('upright', 'clockwise', 'counterclockwise', 'upside-down', 'mixed'));

ALTER TABLE meta.ocr_region_annotations
    ADD COLUMN IF NOT EXISTS text_direction TEXT NOT NULL DEFAULT 'right'
        CHECK (text_direction IN ('right', 'left', 'down', 'up', 'mixed')),
    ADD COLUMN IF NOT EXISTS glyph_orientation TEXT NOT NULL DEFAULT 'upright'
        CHECK (glyph_orientation IN ('upright', 'clockwise', 'counterclockwise', 'upside-down', 'mixed'));

COMMENT ON COLUMN meta.ocr_region_annotations.text_direction IS
    'Reviewed reading direction relative to the displayed label crop.';
COMMENT ON COLUMN meta.ocr_region_annotations.glyph_orientation IS
    'Reviewed orientation of individual glyphs relative to the displayed label crop.';
