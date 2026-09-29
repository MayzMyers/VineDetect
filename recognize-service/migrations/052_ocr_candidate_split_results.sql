ALTER TABLE meta.annotation_candidate_reviews
  ADD COLUMN IF NOT EXISTS result_entity_ids UUID[] NOT NULL DEFAULT '{}';

UPDATE meta.annotation_candidate_reviews
SET result_entity_ids = ARRAY[result_entity_id]
WHERE result_entity_id IS NOT NULL
  AND cardinality(result_entity_ids) = 0;

COMMENT ON COLUMN meta.annotation_candidate_reviews.result_entity_ids IS
  'All canonical outputs derived from one helper candidate. More than one id records a physical split; result_entity_id remains the singular compatibility projection.';
