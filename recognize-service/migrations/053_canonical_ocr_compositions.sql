CREATE TABLE IF NOT EXISTS meta.annotation_ocr_compositions (
  id UUID PRIMARY KEY,
  package_id UUID NOT NULL REFERENCES meta.annotation_packages(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES meta.annotation_labels(id) ON DELETE CASCADE,
  member_ids UUID[] NOT NULL,
  transcription TEXT,
  transcription_status TEXT NOT NULL CHECK (transcription_status IN ('verified','partial','unreadable')),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  origin TEXT NOT NULL DEFAULT 'human' CHECK (origin IN ('human','llm','legacy')),
  source_operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CHECK (cardinality(member_ids) >= 2),
  CHECK (
    (transcription_status IN ('verified','partial') AND NULLIF(btrim(transcription),'') IS NOT NULL)
    OR (transcription_status='unreadable' AND transcription IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_annotation_ocr_compositions_label
  ON meta.annotation_ocr_compositions (label_id, sort_order, created_at) WHERE deleted_at IS NULL;

WITH latest_sets AS (
  SELECT DISTINCT ON (annotation_track_id) id, annotation_track_id, compositions
  FROM meta.ocr_region_annotation_sets
  WHERE annotation_track_id IS NOT NULL AND status='reviewed'
  ORDER BY annotation_track_id, revision DESC, created_at DESC
), expanded AS (
  SELECT set_row.id set_id, set_row.annotation_track_id, item.value composition, item.ordinality
  FROM latest_sets set_row
  CROSS JOIN LATERAL jsonb_array_elements(set_row.compositions) WITH ORDINALITY item(value, ordinality)
), resolved AS (
  SELECT expanded.*,
    ARRAY(
      SELECT graph_ocr.id
      FROM jsonb_array_elements_text(expanded.composition->'memberIds') WITH ORDINALITY member(value, ordinality)
      JOIN meta.annotation_ocr graph_ocr ON graph_ocr.legacy_ocr_region_id=member.value::uuid AND graph_ocr.deleted_at IS NULL
      ORDER BY member.ordinality
    ) member_ids
  FROM expanded
  WHERE jsonb_typeof(expanded.composition->'memberIds')='array'
)
INSERT INTO meta.annotation_ocr_compositions
  (id,package_id,label_id,member_ids,transcription,transcription_status,sort_order,origin,source_operation_id)
SELECT meta.deterministic_uuid('legacy-ocr-composition:' || resolved.set_id::text || ':' || resolved.ordinality::text),
       package.id,label.id,resolved.member_ids,
       CASE WHEN resolved.composition->>'transcriptionStatus'='unreadable' THEN NULL ELSE NULLIF(btrim(resolved.composition->>'text'),'') END,
       CASE
         WHEN resolved.composition->>'transcriptionStatus' IN ('verified','partial') AND NULLIF(btrim(resolved.composition->>'text'),'') IS NOT NULL
           THEN resolved.composition->>'transcriptionStatus'
         ELSE 'unreadable'
       END,
       COALESCE((resolved.composition->>'sortOrder')::integer, resolved.ordinality::integer - 1),
       'legacy','migration-053'
FROM resolved
JOIN meta.annotation_packages package ON package.legacy_annotation_track_id=resolved.annotation_track_id AND package.deleted_at IS NULL
JOIN meta.annotation_labels label ON label.package_id=package.id AND label.deleted_at IS NULL
WHERE cardinality(resolved.member_ids) >= 2
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE meta.annotation_ocr_compositions IS
  'Canonical semantic strings composed from ordered physical OCR regions. Deleting a composition never deletes its member regions.';
