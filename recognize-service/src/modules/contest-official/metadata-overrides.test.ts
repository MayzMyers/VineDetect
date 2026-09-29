import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "../../db/pool.js";
import { getSourceItem, listSourceItems, findCatalogCandidates } from "../../db/source.repository.js";

// Optional SELECT-only integration against the organizer-truth local dataset.
test("2079 organizer metadata reaches source detail, list and candidate search", {
  skip: !process.env.CONTEST_METADATA_READ_ONLY_TEST,
}, async () => {
  try {
    const readOnly = await pool.query("SHOW default_transaction_read_only");
    assert.equal(readOnly.rows[0].default_transaction_read_only, "on");
    const slug = "igristoe-vino-endemy-bianka-bryut-beloe";
    const raw = await pool.query(`SELECT c.category,c.color,l.wine_id,w.category_name,
      w.alcohol::text,w.color AS historical_color FROM contest.catalog_items c
      JOIN contest.item_links l ON l.catalog_item_id=c.id
      JOIN svoe_vino.wines w ON w.id=l.wine_id WHERE c.id=2079`);
    assert.deepEqual(raw.rows[0], { category: "Розовое", color: "Нежно-розовый",
      wine_id: "328", category_name: "Розовое брют", alcohol: "10.5", historical_color: "Нежно-розовый" });
    const detail = await getSourceItem("svoe_vino", slug);
    assert.ok(detail);
    assert.equal(detail.category, "Розовое брют");
    assert.equal(detail.color, "Нежно-розовый");
    assert.equal(detail.title, "Эндемы Бианка брют белое");
    const listed = await listSourceItems("svoe_vino", 3000);
    assert.equal(listed.length, 2114);
    assert.deepEqual(listed.find(r => r.sourceItemId === slug), detail);
    const candidates = await findCatalogCandidates({ terms: ["Эндемы Бианка"], years: [],
      barcodes: [], include: { source: "svoe_vino", sourceItemId: slug } });
    assert.deepEqual(candidates.find(r => r.sourceItemId === slug), detail);
    const control = await pool.query(`SELECT w.id FROM svoe_vino.wines w
      JOIN contest.effective_wines e ON e.id=w.id
      WHERE to_jsonb(w) IS DISTINCT FROM to_jsonb(e) ORDER BY w.id`);
    assert.deepEqual(control.rows, []);
  } finally {
    await pool.end();
  }
});