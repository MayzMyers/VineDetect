import assert from "node:assert/strict";
import test from "node:test";
import { predictRecognitionImage, RecognitionApiError } from "./recognitionApi.ts";

const product = { id: 42, catalogKey: "svoe_vino:official-wine", slug: "official-wine", title: "Catalog wine", producer: null, image: null, category: null, region: null, vintage: null, description: null };

test("original photo bytes are uploaded once with image as the only multipart field", async (t) => {
  const bytes = new Uint8Array([0xff, 0xd8, 12, 0, 254, 0xff, 0xd9]);
  const photo = new File([bytes], "original-photo.jpg", { type: "image/jpeg" });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    requests += 1;
    assert.equal(input, "/api/recognition/jobs");
    assert.equal(init?.method, "POST");
    assert.ok(init.body instanceof FormData);
    assert.deepEqual([...init.body.keys()], ["image"]);
    const uploaded = init.body.get("image");
    assert.ok(uploaded instanceof File);
    assert.equal(uploaded.name, photo.name);
    assert.equal(uploaded.type, photo.type);
    assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), bytes);
    return Response.json({ slug: "official-wine", product });
  });
  assert.deepEqual(await predictRecognitionImage(photo), { slug: "official-wine", product });
  assert.equal(requests, 1);
});

test("the card cannot silently substitute a different catalog identity", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ slug: "official-wine", product: { ...product, slug: "different-wine" } }));
  await assert.rejects(predictRecognitionImage(new Blob(["photo"])), (error) => error instanceof RecognitionApiError && error.code === "INVALID_RESPONSE");
});

test("runtime timeout and busy responses remain errors without client guesses or retries", async (t) => {
  let requests = 0;
  for (const [status, code] of [[504, "RECOGNITION_TIMEOUT"], [409, "SERVICE_BUSY"]] as const) {
    t.mock.method(globalThis, "fetch", async () => {
      requests += 1;
      return Response.json({ error: "Unavailable" }, { status });
    });
    await assert.rejects(predictRecognitionImage(new Blob(["photo"])), (error) => error instanceof RecognitionApiError && error.code === code);
    t.mock.restoreAll();
  }
  assert.equal(requests, 2);
});
