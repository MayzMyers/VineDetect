ALTER TABLE meta.annotation_candidate_reviews
  DROP CONSTRAINT IF EXISTS annotation_candidate_reviews_state_check;

ALTER TABLE meta.annotation_candidate_reviews
  ADD CONSTRAINT annotation_candidate_reviews_state_check
  CHECK (state IN ('accepted', 'edited', 'rejected', 'merged'));

COMMENT ON COLUMN meta.annotation_candidate_reviews.state IS
  'merged links a valid repeated helper observation to an existing canonical OCR entity; it is not rejection.';

