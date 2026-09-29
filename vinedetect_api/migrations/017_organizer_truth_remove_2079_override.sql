-- Compensating migration: organizer data is authoritative (2026-09-25).
-- Migration 016 and the original DQ2 audit history remain unchanged.
-- Empty/fresh databases are valid; only the exact superseded 2079 overlay
-- may be removed. Raw organizer catalog and historical wine 328 are untouched.
DO $$
DECLARE
    o contest.metadata_overrides%ROWTYPE;
BEGIN
    SELECT * INTO o FROM contest.metadata_overrides WHERE catalog_item_id = 2079;
    IF FOUND THEN
        IF o.contest_version IS DISTINCT FROM 'lct-rshb-2026-09-15'
           OR o.official_slug IS DISTINCT FROM 'igristoe-vino-endemy-bianka-bryut-beloe'
           OR o.wine_id IS DISTINCT FROM 328
           OR o.replacement IS DISTINCT FROM
              '{"category":"Белое","color":"Светло-лимонный"}'::jsonb
           OR NOT EXISTS (
               SELECT 1 FROM contest.catalog_items c
               JOIN contest.item_links l ON l.catalog_item_id=c.id
               JOIN svoe_vino.wines w ON w.id=l.wine_id
               WHERE c.id=2079 AND c.official_slug=o.official_slug
                 AND c.category='Розовое' AND c.color='Нежно-розовый'
                 AND l.wine_id=328 AND l.method='exact_slug'
                 AND w.slug=o.official_slug
                 AND w.category_name='Розовое брют' AND w.color='Нежно-розовый'
                 AND to_jsonb(c) @> o.expected_catalog
                 AND to_jsonb(w) @> o.expected_wine
           ) THEN
            RAISE EXCEPTION 'Organizer-truth rollback STOP: unexpected 2079 override/source state';
        END IF;
        DELETE FROM contest.metadata_overrides WHERE catalog_item_id=2079;
    END IF;
END $$;

