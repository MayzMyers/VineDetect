import assert from "node:assert/strict";
import test from "node:test";
import { selectDisplayedAnnotationVersionId } from "./annotationVersionSelection.ts";

const versions = [
  { id: "first", annotationTrackId: "track-1" },
  { id: "active", annotationTrackId: "track-2" },
];

test("Saved Metadata selects the active annotation version instead of the first/default entry", () => {
  assert.equal(selectDisplayedAnnotationVersionId(versions, "active"), "active");
});

test("an explicit historical selection wins while an unavailable selection falls back to active", () => {
  assert.equal(selectDisplayedAnnotationVersionId(versions, "active", { preferredVersionId: "first" }), "first");
  assert.equal(selectDisplayedAnnotationVersionId(versions, "active", { preferredVersionId: "missing" }), "active");
});

test("an official track keeps its track-owned version selection", () => {
  assert.equal(selectDisplayedAnnotationVersionId(versions, "active", { officialTrackId: "track-1" }), "first");
});
