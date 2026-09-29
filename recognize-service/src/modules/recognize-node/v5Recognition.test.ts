import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import sharp from "sharp";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "../../config/env.js";
import { v5ResponseSchema } from "../../vision/v5Client.js";
import { recognizeRoutes } from "../recognize/recognize.routes.js";
import { recognizeImageRequestSchema, recognizeRequestSchema } from "../recognize/recognize.schemas.js";
import { extractCvMetaFromFile, extractRecognitionLabelRoi } from "./cvMeta.js";

const response = {
  architecture: "V5-RC1",
  result: { catalogItemId: 25, officialSlug: "official-wine-slug", title: "Official Wine" },
  diagnostics: { baseline: 1, baselineMargin: .0024, failures: [], timingsMs: { total: 10 },
    views: { full: [{ catalogItemId: 1, rank: 1, cosineSimilarity: .8124 }] } },
};

test("V5 response preserves cosineSimilarity and margin and rejects a renamed score", () => {
  const parsed = v5ResponseSchema.parse(response);
  assert.equal(parsed.diagnostics.views.full?.[0]?.cosineSimilarity, .8124);
  assert.equal(parsed.diagnostics.baselineMargin, .0024);
  assert.throws(() => v5ResponseSchema.parse({
    ...response, diagnostics: { ...response.diagnostics,
      views: { full: [{ catalogItemId: 1, rank: 1, similarity: .8124 }] } },
  }));
});

test("image and legacy request contracts stay distinct", () => {
  assert.deepEqual(recognizeRequestSchema.parse({ ocrTokens: ["wine"] }).ocrTokens, ["wine"]);
  assert.throws(() => recognizeImageRequestSchema.parse({ imageBase64: "not-base64" }));
  assert.throws(() => recognizeImageRequestSchema.parse({ imageBase64: "YWJj", candidates: [1,2] }));
});

test("real /recognize image route returns one official identity; diagnostics require authorization", async () => {
  const app = Fastify();
  await app.register(recognizeRoutes);
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify(String(url).endsWith("/target") ? {
      target: { width: 1, height: 1, bottleBox: null, originalLabel: null, intentLabel: null,
        allLabels: [], targetDetectionMs: 2 }, bottleImageBase64: null,
    } : response), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).png().toBuffer();
    const payload = { imageBase64: image.toString("base64") };
    const result = await app.inject({ method: "POST", url: "/recognize", payload });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json(), { architecture: "V5-RC1", result: response.result });
    assert.equal(calls.length, 2);
    assert.equal((await app.inject({ method: "POST", url: "/recognize",
      payload: { ...payload, diagnostics: true } })).statusCode, 403);
    const diagnostic = await app.inject({ method: "POST", url: "/recognize",
      headers: { "x-internal-api-key": env.INTERNAL_API_KEY }, payload: { ...payload, diagnostics: true } });
    assert.equal(diagnostic.statusCode, 200);
    assert.equal(diagnostic.json().diagnostics.baselineMargin, .0024);
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    const failed = await app.inject({ method: "POST", url: "/recognize", payload });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().result, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
  }
});

test("lightweight front-label ROI matches full CV metadata selection", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "v5-label-"));
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="240"><rect width="120" height="240" fill="white"/><rect x="35" y="10" width="50" height="220" fill="#182c21"/><rect x="40" y="130" width="40" height="60" fill="#e8dab2"/></svg>');
  const image = await sharp(svg).png().toBuffer();
  const file = path.join(dir, "bottle.png");
  try {
    await writeFile(file, image);
    const full = await extractCvMetaFromFile(file, "synthetic-v5");
    assert.deepEqual(await extractRecognitionLabelRoi(image), full.label?.roi);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
