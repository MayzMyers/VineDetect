CREATE TABLE IF NOT EXISTS meta.ocr_regions (
  id UUID PRIMARY KEY,
  ocr_run_id UUID NOT NULL REFERENCES meta.ocr_runs(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES meta.ocr_regions(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  bbox JSONB NOT NULL,
  raw_text TEXT NOT NULL DEFAULT '',
  normalized_text TEXT NOT NULL DEFAULT '',
  confidence NUMERIC,
  review_status TEXT NOT NULL DEFAULT 'generated',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocr_regions_run_level
  ON meta.ocr_regions (ocr_run_id, level);
