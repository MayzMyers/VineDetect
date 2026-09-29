import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "./route.ts";

const bytes = new Uint8Array([0xff, 0xd8, 0, 1, 255, 0, 0xd9]);
function request(image: Blob | null = new Blob([bytes], { type: "image/jpeg" })) {
  const form = new FormData();
  if (image) form.set("image", image, "original.jpg");
  return new Request("http://localhost/api/recognition/jobs", { method: "POST", body: form });
}
const wine = {
  id: 42, slug: "different-local-slug", official_slug: "official-slug",
  title: "Вино 2021", manufacturer_name: "Producer", category_name: "Sparkling",
  region_name: "Region", description: null, dishes: ["Сыр"],
  official_reference: { local_path: "contest/42/reference.png", url: "http://internal/image.png" },
};

test("one unchanged upload -> Core official slug -> exact linked catalog card", async (t) => {
  const priorCore = process.env.VINEDETECT_CORE_URL;
  const priorApi = process.env.API_INTERNAL_URL;
  process.env.VINEDETECT_CORE_URL = "http://core.internal:8765/";
  process.env.API_INTERNAL_URL = "http://catalog.internal:8000/";
  t.after(() => {
    if (priorCore === undefined) delete process.env.VINEDETECT_CORE_URL; else process.env.VINEDETECT_CORE_URL = priorCore;
    if (priorApi === undefined) delete process.env.API_INTERNAL_URL; else process.env.API_INTERNAL_URL = priorApi;
  });
  const calls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    calls.push(input);
    assert.equal(init?.cache, "no-store");
    if (calls.length === 1) {
      assert.equal(input, "http://core.internal:8765/v1/eval/predict");
      assert.equal(init?.method, "POST");
      const form = init?.body as FormData;
      assert.deepEqual([...form.keys()], ["image"]);
      const uploaded = form.get("image") as File;
      assert.equal(uploaded.name, "original.jpg");
      assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), bytes);
      return Response.json({ slug: "official-slug" });
    }
    assert.equal(input, "http://catalog.internal:8000/api/v1/wines/by-official-slug/official-slug");
    return Response.json(wine);
  });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const result = await response.json();
  assert.equal(result.slug, "official-slug");
  assert.equal(result.product.slug, "official-slug");
  assert.equal(result.product.catalogKey, "svoe_vino:official-slug");
  assert.equal(result.product.id, 42);
  assert.equal(result.product.title, "Вино 2021");
  assert.equal(result.product.image, "/api/catalog/image?path=contest%2F42%2Freference.png");
  assert.deepEqual(result.product.dishes, [{ name: "Сыр", image: null, alt: null }]);
  assert.equal("confidence" in result.product, false);
  assert.equal(calls.length, 2);
});

test("missing/empty/oversized image never invokes Core", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  assert.equal((await POST(request(null))).status, 400);
  assert.equal((await POST(request(new Blob([], { type: "image/jpeg" })))).status, 400);
  assert.equal((await POST(request(new Blob([new Uint8Array(12 * 1024 * 1024 + 1)], { type: "image/jpeg" })))).status, 413);
  assert.equal(fetch.mock.callCount(), 0);
});

test("Core null and invalid responses never trigger a fallback identity", async (t) => {
  const responses = [{ slug: null }, {}, { slug: "" }, { slug: " spaced " }];
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(responses.shift()));
  assert.equal((await POST(request())).status, 422);
  for (let i = 0; i < 3; i++) assert.equal((await POST(request())).status, 502);
  assert.equal(fetch.mock.callCount(), 4);
});

test("Core unavailable is one attempt, never a mock success", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("internal service details"); });
  const response = await POST(request());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Recognition service unavailable" });
  assert.equal(fetch.mock.callCount(), 1);
});

test("configured demo timeout aborts once and is reported as504", async (t) => {
  const prior = process.env.VINEDETECT_CORE_TIMEOUT_MS;
  process.env.VINEDETECT_CORE_TIMEOUT_MS = "10";
  t.after(() => { if (prior === undefined) delete process.env.VINEDETECT_CORE_TIMEOUT_MS; else process.env.VINEDETECT_CORE_TIMEOUT_MS = prior; });
  const fetch = t.mock.method(globalThis, "fetch", async (_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  assert.equal((await POST(request())).status, 504);
  assert.equal(fetch.mock.callCount(), 1);
});

test("catalog missing, conflicting or unavailable fails without guessed cards", async (t) => {
  let calls = 0;
  let catalogStatus = 404;
  let catalogWine = { ...wine };
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls % 2 === 1) return Response.json({ slug: "official-slug" });
    return Response.json(catalogWine, { status: catalogStatus });
  });
  assert.equal((await POST(request())).status, 404);
  catalogStatus = 503;
  assert.equal((await POST(request())).status, 502);
  catalogStatus = 200;
  catalogWine = { ...wine, official_slug: "wrong-wine" };
  assert.equal((await POST(request())).status, 502);
  assert.equal(calls, 6);
});
