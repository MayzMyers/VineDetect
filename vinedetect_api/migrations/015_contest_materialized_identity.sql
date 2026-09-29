-- A materialized official item is resolved to a real historical-catalog wine row.
-- Keep all prior methods and their NULL semantics; no existing rows are rewritten.
ALTER TABLE contest.item_links
    DROP CONSTRAINT item_links_method_check,
    ADD CONSTRAINT item_links_method_check CHECK (method IN (
        'exact_slug', 're_slug', 'same_asset', 'metadata_match', 'manual',
        'unmatched', 'new_official_item', 'materialized_official'
    ));
-- item_links_check already requires a non-NULL wine_id for every resolved method,
-- including materialized_official. new_official_item remains an unresolved proposal.
