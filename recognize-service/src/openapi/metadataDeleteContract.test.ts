import assert from "node:assert/strict";
import test from "node:test";
import { OPERATIONAL_METADATA_DELETE_TABLES } from "../db/meta.repository.js";

test("operational metadata deletion clears canonical annotation progress inputs", () => {
  const tables = new Set(OPERATIONAL_METADATA_DELETE_TABLES);
  for (const table of [
    "annotation_meta",
    "annotation_operations",
    "annotation_packages",
    "annotation_tracks",
    "wizard_stage_executions",
    "items",
  ]) {
    assert.equal(tables.has(table as never), true, `${table} must be deleted`);
  }

  assert.ok(
    OPERATIONAL_METADATA_DELETE_TABLES.indexOf("annotation_packages")
      < OPERATIONAL_METADATA_DELETE_TABLES.indexOf("annotation_tracks"),
    "canonical packages must be deleted before tracks because the legacy binding uses ON DELETE SET NULL",
  );
});
