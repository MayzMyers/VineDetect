ALTER TABLE meta.ocr_region_annotation_sets
    ADD COLUMN IF NOT EXISTS compositions JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(compositions) = 'array'),
    ADD COLUMN IF NOT EXISTS review_operations JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(review_operations) = 'array');

COMMENT ON COLUMN meta.ocr_region_annotation_sets.compositions IS
    'Reviewed semantic WORD-to-STRING composition. Member regions remain independent geometry nodes.';

COMMENT ON COLUMN meta.ocr_region_annotation_sets.review_operations IS
    'Immutable semantic diff from OCR auto nodes to the reviewed state (geometry, transcription and composition operations).';
