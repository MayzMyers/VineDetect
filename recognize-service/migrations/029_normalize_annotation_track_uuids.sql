BEGIN;

CREATE TEMP TABLE annotation_track_uuid_rewrite ON COMMIT DROP AS
SELECT id AS old_id,
       (
         substr(md5(source || E'\x1f' || source_item_id), 1, 8) || '-' ||
         substr(md5(source || E'\x1f' || source_item_id), 9, 4) || '-5' ||
         substr(md5(source || E'\x1f' || source_item_id), 14, 3) || '-8' ||
         substr(md5(source || E'\x1f' || source_item_id), 18, 3) || '-' ||
         substr(md5(source || E'\x1f' || source_item_id), 21, 12)
       )::uuid AS new_id
FROM meta.annotation_tracks
WHERE ordinal = 1
  AND id = md5(source || E'\x1f' || source_item_id)::uuid
  AND id <> (
    substr(md5(source || E'\x1f' || source_item_id), 1, 8) || '-' ||
    substr(md5(source || E'\x1f' || source_item_id), 9, 4) || '-5' ||
    substr(md5(source || E'\x1f' || source_item_id), 14, 3) || '-8' ||
    substr(md5(source || E'\x1f' || source_item_id), 18, 3) || '-' ||
    substr(md5(source || E'\x1f' || source_item_id), 21, 12)
  )::uuid;

ALTER TABLE meta.annotation_track_states DROP CONSTRAINT IF EXISTS annotation_track_states_annotation_track_id_fkey;
ALTER TABLE meta.detection_proposals DROP CONSTRAINT IF EXISTS detection_proposals_annotation_track_id_fkey;
ALTER TABLE meta.image_annotations DROP CONSTRAINT IF EXISTS image_annotations_annotation_track_id_fkey;
ALTER TABLE meta.label_crops DROP CONSTRAINT IF EXISTS label_crops_annotation_track_id_fkey;
ALTER TABLE meta.ocr_runs DROP CONSTRAINT IF EXISTS ocr_runs_annotation_track_id_fkey;
ALTER TABLE meta.ocr_text_annotations DROP CONSTRAINT IF EXISTS ocr_text_annotations_annotation_track_id_fkey;
ALTER TABLE meta.ocr_region_annotation_sets DROP CONSTRAINT IF EXISTS ocr_region_annotation_sets_annotation_track_id_fkey;
ALTER TABLE meta.ocr_source_association_sets DROP CONSTRAINT IF EXISTS ocr_source_association_sets_annotation_track_id_fkey;
ALTER TABLE meta.alias_annotation_sets DROP CONSTRAINT IF EXISTS alias_annotation_sets_annotation_track_id_fkey;
ALTER TABLE meta.label_analysis_reviews DROP CONSTRAINT IF EXISTS label_analysis_reviews_annotation_track_id_fkey;
ALTER TABLE meta.catalog_identity_reviews DROP CONSTRAINT IF EXISTS catalog_identity_reviews_annotation_track_id_fkey;
ALTER TABLE meta.wizard_stage_executions DROP CONSTRAINT IF EXISTS wizard_stage_executions_annotation_track_id_fkey;
ALTER TABLE meta.generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_annotation_track_id_fkey;

UPDATE meta.annotation_track_states row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.detection_proposals row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.image_annotations row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.label_crops row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.ocr_runs row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.ocr_text_annotations row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.ocr_region_annotation_sets row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.ocr_source_association_sets row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.alias_annotation_sets row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.label_analysis_reviews row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.catalog_identity_reviews row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.wizard_stage_executions row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.generation_jobs row SET annotation_track_id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.annotation_track_id = rewrite.old_id;
UPDATE meta.annotation_tracks row SET id = rewrite.new_id FROM annotation_track_uuid_rewrite rewrite WHERE row.id = rewrite.old_id;

ALTER TABLE meta.annotation_track_states ADD CONSTRAINT annotation_track_states_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.detection_proposals ADD CONSTRAINT detection_proposals_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.image_annotations ADD CONSTRAINT image_annotations_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.label_crops ADD CONSTRAINT label_crops_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.ocr_runs ADD CONSTRAINT ocr_runs_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.ocr_text_annotations ADD CONSTRAINT ocr_text_annotations_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.ocr_region_annotation_sets ADD CONSTRAINT ocr_region_annotation_sets_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.ocr_source_association_sets ADD CONSTRAINT ocr_source_association_sets_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.alias_annotation_sets ADD CONSTRAINT alias_annotation_sets_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.label_analysis_reviews ADD CONSTRAINT label_analysis_reviews_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.catalog_identity_reviews ADD CONSTRAINT catalog_identity_reviews_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.wizard_stage_executions ADD CONSTRAINT wizard_stage_executions_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE CASCADE;
ALTER TABLE meta.generation_jobs ADD CONSTRAINT generation_jobs_annotation_track_id_fkey FOREIGN KEY (annotation_track_id) REFERENCES meta.annotation_tracks(id) ON DELETE SET NULL;

COMMIT;
