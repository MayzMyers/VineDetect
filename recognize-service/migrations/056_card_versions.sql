CREATE TABLE IF NOT EXISTS meta.annotation_versions (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('draft','processing','review_required','approved','failed','cancelled','superseded')),
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  annotation_track_id UUID REFERENCES meta.annotation_tracks(id) ON DELETE SET NULL,
  parent_version_id UUID REFERENCES meta.annotation_versions(id) ON DELETE SET NULL,
  source_job_id UUID REFERENCES meta.generation_jobs(id) ON DELETE SET NULL,
  origin TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  operation_since TIMESTAMPTZ,
  UNIQUE (source, source_item_id, revision)
);

ALTER TABLE meta.annotation_versions
  ADD COLUMN IF NOT EXISTS operation_since TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS meta.annotation_version_pointers (
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  active_version_id UUID NOT NULL REFERENCES meta.annotation_versions(id) ON DELETE RESTRICT,
  default_version_id UUID REFERENCES meta.annotation_versions(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_item_id)
);

ALTER TABLE meta.generation_jobs
  ADD COLUMN IF NOT EXISTS annotation_version_id UUID REFERENCES meta.annotation_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_annotation_versions_item_revision
  ON meta.annotation_versions (source, source_item_id, revision DESC);

CREATE TABLE IF NOT EXISTS meta.metadata_item_revisions (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  snapshot JSONB NOT NULL,
  origin TEXT NOT NULL,
  source_job_id UUID REFERENCES meta.generation_jobs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, source_item_id, revision)
);

CREATE TABLE IF NOT EXISTS meta.metadata_version_pointers (
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  active_revision_id UUID NOT NULL REFERENCES meta.metadata_item_revisions(id) ON DELETE RESTRICT,
  default_revision_id UUID NOT NULL REFERENCES meta.metadata_item_revisions(id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_item_id)
);

CREATE INDEX IF NOT EXISTS idx_metadata_item_revisions_item_revision
  ON meta.metadata_item_revisions (source, source_item_id, revision DESC);
