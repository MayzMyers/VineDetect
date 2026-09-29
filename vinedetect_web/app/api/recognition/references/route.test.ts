import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route.ts";

const payload = { schemaVersion: "references/1", items: [{ slug: "wine", keywords: ["вино", "2020"] }] };

test("BFF uses the server URL and forwards the references contract", async (t) => {
  const previous = process.env.API_INTERNAL_URL;
  process.env.API_INTERNAL_URL = "http://fastapi.internal:8000/";
  t.after(() => {
    if (previous === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = previous;
  });
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.equal(input, "http://fastapi.internal:8000/api/v1/recognition/references");
    assert.equal(init?.cache, "no-store");
    return Response.json(payload);
  });
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), payload);
});

test("BFF preserves upstream failure status without exposing internal error details", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ detail: "internal host details" }, { status: 503 }));
  const response = await GET();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Recognition references unavailable" });
});

test("BFF rejects invalid upstream data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ schemaVersion: "references/1", items: [{ slug: "wine", keywords: null }] }));
  const response = await GET();
  assert.equal(response.status, 502);
});

test("BFF reports network failure without exposing the configured backend URL", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private network address"); });
  const response = await GET();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Recognition references unavailable" });
});
