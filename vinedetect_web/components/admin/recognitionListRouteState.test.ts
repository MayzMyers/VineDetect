import assert from "node:assert/strict";
import test from "node:test";
import { parseRecognitionListRouteState, recognitionDetailSectionHref, recognitionItemHref, recognitionListHref } from "./recognitionListRouteState.ts";

test("recognition list route state round-trips filters and pagination", () => {
  const href = recognitionListHref({ page: 3, query: "cabernet", source: "svoe_vino", status: "reviewed", cvMeta: "present", annotationStatus: "in-progress", executionActor: "human", automationMode: "mixed", recognitionTag: "nonstandard-label", firstPerInitial: true, perInitialLimit: 7 });
  assert.equal(href, "/admin/recognition?page=3&q=cabernet&source=svoe_vino&status=reviewed&cv=present&annotation=in-progress&actor=human&automation=mixed&tag=nonstandard-label&firstPerInitial=1&perInitialLimit=7");
  assert.deepEqual(parseRecognitionListRouteState(new URL(href, "http://localhost").searchParams), {
    page: 3, query: "cabernet", source: "svoe_vino", status: "reviewed", cvMeta: "present", annotationStatus: "in-progress", executionActor: "human", automationMode: "mixed", recognitionTag: "nonstandard-label", firstPerInitial: true, perInitialLimit: 7,
  });
});

test("recognition list route state bounds per-initial size", () => {
  assert.deepEqual(parseRecognitionListRouteState(new URLSearchParams("firstPerInitial=1&perInitialLimit=1000")), {
    page: 1, query: "", source: "all", status: "", cvMeta: "all", annotationStatus: "", executionActor: "", automationMode: "", recognitionTag: "", firstPerInitial: true, perInitialLimit: 3,
  });
});

test("item href retains the exact list return route", () => {
  const href = recognitionItemHref("svoe_vino", "item/with spaces", "annotation", "/admin/recognition?page=2&q=wine");
  const url = new URL(href, "http://localhost");
  assert.equal(url.pathname, "/admin/recognition/svoe_vino/item%2Fwith%20spaces");
  assert.equal(url.searchParams.get("section"), "annotation");
  assert.equal(url.searchParams.get("returnTo"), "/admin/recognition?page=2&q=wine");
});

test("detail section and track navigation retain the exact list return route", () => {
  const href = recognitionDetailSectionHref(
    "svoe_vino",
    "item/with spaces",
    "saved",
    "ce2ddb13-b6d8-49b8-9f46-c1e724f534b8",
    "/admin/recognition?page=29&q=wine&annotation=reviewed",
  );
  const url = new URL(href, "http://localhost");
  assert.equal(url.pathname, "/admin/recognition/svoe_vino/item%2Fwith%20spaces");
  assert.equal(url.searchParams.get("section"), "metadata");
  assert.equal(url.searchParams.get("track"), "ce2ddb13-b6d8-49b8-9f46-c1e724f534b8");
  assert.equal(url.searchParams.get("returnTo"), "/admin/recognition?page=29&q=wine&annotation=reviewed");
});
