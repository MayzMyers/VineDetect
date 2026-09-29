-- Reviewed field-level overlays. Imported rows and historical wines stay immutable.
CREATE TABLE contest.metadata_overrides (
    catalog_item_id BIGINT PRIMARY KEY REFERENCES contest.catalog_items(id),
    contest_version TEXT NOT NULL,
    official_slug TEXT NOT NULL,
    wine_id BIGINT NOT NULL UNIQUE REFERENCES svoe_vino.wines(id),
    expected_catalog JSONB NOT NULL CHECK (jsonb_typeof(expected_catalog) = 'object'),
    expected_wine JSONB NOT NULL CHECK (jsonb_typeof(expected_wine) = 'object'),
    replacement JSONB NOT NULL CHECK (
        jsonb_typeof(replacement) = 'object'
        AND replacement ?& ARRAY['category','color']
        AND replacement - ARRAY['category','color'] = '{}'::jsonb
        AND jsonb_typeof(replacement->'category') = 'string'
        AND jsonb_typeof(replacement->'color') = 'string'
        AND btrim(replacement->>'category') <> ''
        AND btrim(replacement->>'color') <> ''),
    provenance JSONB NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
    manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$')
);

-- Bind corrections to the reviewed import, identity and source values.
CREATE VIEW contest.active_metadata_overrides AS
SELECT o.* FROM contest.metadata_overrides o
JOIN contest.catalog_items c ON c.id=o.catalog_item_id AND c.official_slug=o.official_slug
JOIN contest.import_runs r ON r.id=c.import_run_id AND r.version=o.contest_version AND r.status='completed'
JOIN contest.item_links l ON l.catalog_item_id=c.id AND l.wine_id=o.wine_id
JOIN svoe_vino.wines w ON w.id=o.wine_id
WHERE to_jsonb(c) @> o.expected_catalog AND to_jsonb(w) @> o.expected_wine
AND NOT EXISTS (SELECT 1 FROM contest.item_links other
                WHERE other.wine_id=o.wine_id AND other.catalog_item_id<>o.catalog_item_id);

CREATE VIEW contest.effective_catalog_items AS
SELECT c.id,c.import_run_id,c.official_slug,c.source_row_number,c.title,
       COALESCE(o.replacement->>'category',c.category) AS category,
       COALESCE(o.replacement->>'color',c.color) AS color,
       c.region,c.grapes,c.description,c.winery,c.photo_name,c.created_at
FROM contest.catalog_items c
LEFT JOIN contest.active_metadata_overrides o ON o.catalog_item_id=c.id;

-- Same typed columns as the historical table; raw JSON remains inspectable.
CREATE VIEW contest.effective_wines AS
SELECT w.id,w.slug,w.title,
       COALESCE(o.replacement->>'category',w.category_name) AS category_name,
       w.manufacturer_name,w.manufacturer_slug,w.region_name,w.alcohol,w.temperature,
       COALESCE(o.replacement->>'color',w.color) AS color,
       w.description,w.public_rating,w.image_url,w.image_alt,
       w.raw_list_json,w.raw_detail_json,w.list_seen_at,w.detail_seen_at,
       w.created_at,w.updated_at,w.source,w.external_id,w.source_url,w.source_updated_at
FROM svoe_vino.wines w
LEFT JOIN contest.active_metadata_overrides o ON o.wine_id=w.id;
