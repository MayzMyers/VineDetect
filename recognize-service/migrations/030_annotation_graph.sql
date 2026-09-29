CREATE OR REPLACE FUNCTION meta.deterministic_uuid(input TEXT)
RETURNS UUID
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT (
    substr(md5(input), 1, 8) || '-' ||
    substr(md5(input), 9, 4) || '-5' ||
    substr(md5(input), 14, 3) || '-8' ||
    substr(md5(input), 18, 3) || '-' ||
    substr(md5(input), 21, 12)
  )::uuid
$$;

CREATE TABLE IF NOT EXISTS meta.annotation_packages (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  legacy_annotation_track_id UUID UNIQUE REFERENCES meta.annotation_tracks(id) ON DELETE SET NULL,
  source_asset_ref TEXT,
  geometry JSONB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_annotation_packages_item
  ON meta.annotation_packages (source, source_item_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS meta.annotation_labels (
  id UUID PRIMARY KEY,
  package_id UUID NOT NULL REFERENCES meta.annotation_packages(id) ON DELETE CASCADE,
  geometry JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'reviewed' CHECK (status IN ('draft', 'reviewed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_annotation_labels_package
  ON meta.annotation_labels (package_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS meta.annotation_ocr (
  id UUID PRIMARY KEY,
  package_id UUID NOT NULL REFERENCES meta.annotation_packages(id) ON DELETE CASCADE,
  label_id UUID REFERENCES meta.annotation_labels(id) ON DELETE CASCADE,
  geometry JSONB NOT NULL,
  transcription TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified', 'unreadable', 'no_transcription', 'skipped')),
  confidence DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_annotation_ocr_package
  ON meta.annotation_ocr (package_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_annotation_ocr_label
  ON meta.annotation_ocr (label_id, created_at) WHERE label_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS meta.annotation_meta (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('item', 'package', 'label', 'ocr')),
  target_id UUID,
  note TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CHECK ((target_type = 'item' AND target_id IS NULL) OR (target_type <> 'item' AND target_id IS NOT NULL)),
  CHECK (jsonb_typeof(tags) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_annotation_meta_item
  ON meta.annotation_meta (source, source_item_id, target_type, target_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS meta.annotation_operations (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'add_package', 'add_label', 'add_ocr', 'add_meta',
    'edit_package', 'edit_label', 'edit_ocr', 'edit_meta',
    'delete_package', 'delete_label', 'delete_ocr', 'delete_meta'
  )),
  parent_entity_type TEXT CHECK (parent_entity_type IN ('item', 'package', 'label', 'ocr', 'meta')),
  parent_entity_id UUID,
  result_entity_type TEXT CHECK (result_entity_type IN ('package', 'label', 'ocr', 'meta')),
  result_entity_id UUID,
  helper_id TEXT NOT NULL,
  helper_version TEXT,
  initial_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected_candidate_id TEXT,
  review_status TEXT NOT NULL CHECK (review_status IN ('accepted', 'edited', 'manual')),
  previous_entity_snapshot JSONB,
  resulting_entity_snapshot JSONB,
  result_deleted_at TIMESTAMPTZ,
  legacy_stage_execution_id UUID REFERENCES meta.wizard_stage_executions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_annotation_operations_item
  ON meta.annotation_operations (source, source_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_annotation_operations_result
  ON meta.annotation_operations (result_entity_type, result_entity_id, created_at);

CREATE TABLE IF NOT EXISTS meta.annotation_candidates (
  id UUID PRIMARY KEY,
  operation_id UUID NOT NULL REFERENCES meta.annotation_operations(id) ON DELETE CASCADE,
  candidate_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  score DOUBLE PRECISION,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operation_id, candidate_key)
);

CREATE OR REPLACE FUNCTION meta.validate_annotation_ocr_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE label_package UUID;
BEGIN
  IF NEW.label_id IS NOT NULL THEN
    SELECT package_id INTO label_package FROM meta.annotation_labels WHERE id = NEW.label_id AND deleted_at IS NULL;
    IF label_package IS NULL OR label_package <> NEW.package_id THEN
      RAISE EXCEPTION 'OCR label must belong to the same package';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_validate_annotation_ocr_parent ON meta.annotation_ocr;
CREATE TRIGGER trg_validate_annotation_ocr_parent
BEFORE INSERT OR UPDATE OF package_id, label_id ON meta.annotation_ocr
FOR EACH ROW EXECUTE FUNCTION meta.validate_annotation_ocr_parent();

INSERT INTO meta.annotation_packages (
  id, source, source_item_id, legacy_annotation_track_id, source_asset_ref, geometry, status, created_at, updated_at
)
SELECT meta.deterministic_uuid('package:' || track.id::text), track.source, track.source_item_id, track.id,
       track.source_asset_ref, track.target_region,
       CASE WHEN track.target_region IS NULL THEN 'draft' ELSE 'reviewed' END,
       track.created_at, track.updated_at
FROM meta.annotation_tracks track
ON CONFLICT (legacy_annotation_track_id) DO NOTHING;

WITH latest_label AS (
  SELECT DISTINCT ON (annotation_track_id) annotation_track_id, id, geometry, bbox, created_at, updated_at
  FROM meta.image_annotations
  WHERE annotation_track_id IS NOT NULL AND annotation_type = 'label-bbox' AND status = 'reviewed'
  ORDER BY annotation_track_id, revision DESC, updated_at DESC
)
INSERT INTO meta.annotation_labels (id, package_id, geometry, status, created_at, updated_at)
SELECT meta.deterministic_uuid('label-track:' || label.annotation_track_id::text), package.id,
       COALESCE(label.geometry, jsonb_build_object('type', 'quad', 'points', jsonb_build_array(
         jsonb_build_object('x', (label.bbox->>'x')::double precision, 'y', (label.bbox->>'y')::double precision),
         jsonb_build_object('x', (label.bbox->>'x')::double precision + (label.bbox->>'width')::double precision, 'y', (label.bbox->>'y')::double precision),
         jsonb_build_object('x', (label.bbox->>'x')::double precision + (label.bbox->>'width')::double precision, 'y', (label.bbox->>'y')::double precision + (label.bbox->>'height')::double precision),
         jsonb_build_object('x', (label.bbox->>'x')::double precision, 'y', (label.bbox->>'y')::double precision + (label.bbox->>'height')::double precision)
       ), 'bbox', label.bbox)),
       'reviewed', label.created_at, label.updated_at
FROM latest_label label
JOIN meta.annotation_packages package ON package.legacy_annotation_track_id = label.annotation_track_id
ON CONFLICT (id) DO NOTHING;

WITH latest_sets AS (
  SELECT DISTINCT ON (annotation_track_id) id, annotation_track_id
  FROM meta.ocr_region_annotation_sets
  WHERE annotation_track_id IS NOT NULL AND status = 'reviewed'
  ORDER BY annotation_track_id, revision DESC, created_at DESC
), regions AS (
  SELECT region.*, set_row.annotation_track_id
  FROM latest_sets set_row
  JOIN meta.ocr_region_annotations region ON region.annotation_set_id = set_row.id
)
INSERT INTO meta.annotation_ocr (
  id, package_id, label_id, geometry, transcription, status, confidence, created_at, updated_at
)
SELECT meta.deterministic_uuid('ocr:' || region.id::text), package.id, label.id,
       region.geometry,
       CASE WHEN region.transcription_status = 'verified' THEN region.text ELSE NULL END,
       CASE
         WHEN region.status = 'rejected' THEN 'skipped'
         WHEN region.transcription_status = 'verified' THEN 'verified'
         WHEN region.transcription_status = 'unreadable' THEN 'unreadable'
         ELSE 'no_transcription'
       END,
       region.prediction_confidence, region.created_at, region.created_at
FROM regions region
JOIN meta.annotation_packages package ON package.legacy_annotation_track_id = region.annotation_track_id
LEFT JOIN meta.annotation_labels label ON label.package_id = package.id AND label.deleted_at IS NULL
WHERE region.geometry IS NOT NULL
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE meta.annotation_packages IS 'Canonical reviewed physical representations inside a catalog item. Annotation tracks are a legacy-compatible editor binding.';
COMMENT ON TABLE meta.annotation_operations IS 'Immutable provenance of how an annotation entity was proposed, reviewed, edited or deleted.';
