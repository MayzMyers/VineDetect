CREATE TABLE IF NOT EXISTS meta.ocr_text_annotations (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  ocr_run_id UUID REFERENCES meta.ocr_runs(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'reviewed',
  source_kind TEXT NOT NULL DEFAULT 'manual',
  revision INTEGER NOT NULL DEFAULT 1,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocr_text_annotations_item_updated
  ON meta.ocr_text_annotations (source, source_item_id, updated_at DESC);
