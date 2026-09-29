ALTER TABLE meta.annotation_tracks
  ADD COLUMN IF NOT EXISTS execution_actor_type TEXT,
  ADD COLUMN IF NOT EXISTS execution_actor_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS execution_actor_updated_at TIMESTAMPTZ;

ALTER TABLE meta.annotation_tracks
  DROP CONSTRAINT IF EXISTS annotation_tracks_execution_actor_type_check,
  ADD CONSTRAINT annotation_tracks_execution_actor_type_check
    CHECK (execution_actor_type IS NULL OR execution_actor_type IN ('human', 'ml-agent', 'hybrid'));

COMMENT ON COLUMN meta.annotation_tracks.execution_actor_type IS
  'Who executed the annotation workflow: human UI, unattended ML agent, or both. Independent from helper automation/review mode.';
COMMENT ON COLUMN meta.annotation_tracks.execution_actor_sources IS
  'Distinct backend-authenticated client/pipeline identifiers observed while mutating this annotation track.';
