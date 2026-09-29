import assert from "node:assert/strict";
import test from "node:test";
import { loadRecognitionReferences, parseRecognitionReferences } from "./references.ts";

const payload = {
  schemaVersion: "references/1",
  items: [{ slug: "wine-example", keywords: ["Абрау-Дюрсо", "2020", "brut", "brut"] }],
};

test("browser loads references through the relative BFF path without changing saved keywords", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.equal(input, "/api/recognition/references");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.signal, controller.signal);
    return Response.json(payload);
  });
  assert.deepEqual(await loadRecognitionReferences(controller.signal), payload);
});

test("unsupported schemas and non-string keywords are rejected without coercion", () => {
  for (const value of [null, [], { ...payload, schemaVersion: "references/2" },
    { ...payload, items: [{ slug: "wine", keywords: [2020] }] },
    { ...payload, items: [{ slug: 1, keywords: [] }] }]) {
    assert.throws(() => parseRecognitionReferences(value), /Invalid recognition references/);
  }
  assert.deepEqual(parseRecognitionReferences({ ...payload, items: [] }), { ...payload, items: [] });
});

test("upstream failure is surfaced instead of substituted with mock or stale data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  await assert.rejects(loadRecognitionReferences(), /503/);
});
