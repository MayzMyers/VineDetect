-- Some dump-based environments retain the truncated PostgreSQL name of the
-- pre-track uniqueness constraint from migration 024. That makes stage
-- revision 1 collide across annotation tracks belonging to the same item.
ALTER TABLE meta.wizard_stage_executions
    DROP CONSTRAINT IF EXISTS wizard_stage_executions_source_source_item_id_stage_revisio_key,
    DROP CONSTRAINT IF EXISTS wizard_stage_executions_source_source_item_id_stage_revision_key,
    DROP CONSTRAINT IF EXISTS wizard_stage_executions_track_stage_revision_key;

DO $$
DECLARE
    stale_constraint RECORD;
BEGIN
    FOR stale_constraint IN
        SELECT constraint_row.conname
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = 'meta.wizard_stage_executions'::regclass
          AND constraint_row.contype = 'u'
          AND pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (source, source_item_id, stage, revision)'
    LOOP
        EXECUTE format(
            'ALTER TABLE meta.wizard_stage_executions DROP CONSTRAINT %I',
            stale_constraint.conname
        );
    END LOOP;
END
$$;

ALTER TABLE meta.wizard_stage_executions
    ADD CONSTRAINT wizard_stage_executions_track_stage_revision_key
    UNIQUE (annotation_track_id, stage, revision);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_constraint constraint_row
        WHERE constraint_row.conrelid = 'meta.wizard_stage_executions'::regclass
          AND constraint_row.contype = 'u'
          AND pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (source, source_item_id, stage, revision)'
    ) THEN
        RAISE EXCEPTION 'stale item-scoped wizard stage revision constraint remains';
    END IF;
END
$$;
