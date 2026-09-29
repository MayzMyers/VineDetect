ALTER TABLE meta.ocr_region_annotations
    ALTER COLUMN text DROP NOT NULL,
    ALTER COLUMN normalized_text DROP NOT NULL;

ALTER TABLE meta.ocr_region_annotations
    ADD COLUMN IF NOT EXISTS transcription_status TEXT NOT NULL DEFAULT 'verified'
    CHECK (transcription_status IN ('verified', 'partially-readable', 'unreadable', 'unverified'));

COMMENT ON COLUMN meta.ocr_region_annotations.transcription_status IS
    'Independent transcription ground-truth status. unreadable regions remain positive text-detection samples with nullable text.';
