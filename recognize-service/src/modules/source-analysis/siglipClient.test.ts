import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { env } from "../../config/env.js";
import { enrichLabelCandidatesWithSiglip } from "../../vision/siglipClient.js";

test("SigLIP reranks only the existing CV shortlist and preserves ranking provenance", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "siglip-rerank-"));
  const imagePath = path.join(directory, "source.webp");
  try {
    await sharp({ create: { width: 120, height: 240, channels: 3, background: "#633" } }).webp().toFile(imagePath);
    const candidates = [
      candidate("cv-1", .9, 10), candidate("cv-2", .89, 45), candidate("cv-3", .8, 80),
    ];
    const semantic = new Map([["cv-1", .1], ["cv-2", .9], ["cv-3", 0]]);
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { candidates: Array<{ id: string }> };
      return new Response(JSON.stringify({
        model: env.SIGLIP_MODEL, revision: env.SIGLIP_MODEL_REVISION,
        candidates: request.candidates.map(({ id }) => ({ id, positiveScore: semantic.get(id)! + .05, negativeScore: .05, semanticScore: semantic.get(id), scores: { wine_label: semantic.get(id)! + .05, bottle_body: .05 } })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await enrichLabelCandidatesWithSiglip({ imagePath, candidates, mode: "rerank", enabled: true, fetchImpl });
    assert.equal(result.evidence.status, "available");
    assert.deepEqual(result.candidates.map((item) => item.id), ["cv-2", "cv-1", "cv-3"]);
    assert.equal(result.candidates[0]?.ranking.cvRank, 2);
    assert.equal(result.candidates[0]?.ranking.fusionRank, 1);
    assert.equal(result.candidates.length, candidates.length, "reranker must not add or remove ROI candidates");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("SigLIP transport failure leaves CV order usable", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "siglip-fallback-"));
  const imagePath = path.join(directory, "source.webp");
  try {
    await sharp({ create: { width: 100, height: 200, channels: 3, background: "#333" } }).webp().toFile(imagePath);
    const candidates = [candidate("cv-a", .8, 10), candidate("cv-b", .7, 50)];
    const result = await enrichLabelCandidatesWithSiglip({ imagePath, candidates, mode: "rerank", enabled: true, fetchImpl: (async () => { throw new Error("connection refused"); }) as typeof fetch });
    assert.equal(result.evidence.status, "unavailable");
    assert.deepEqual(result.candidates.map((item) => [item.id, item.score]), [["cv-a", .8], ["cv-b", .7]]);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("fusion v2 uses contour zone confidence without sending geometry into SigLIP", async () => {
  sharp.cache(false);
  const directory = await mkdtemp(path.join(os.tmpdir(), "siglip-zone-fusion-"));
  const imagePath = path.join(directory, "source.webp");
  try {
    await sharp({ create: { width: 120, height: 240, channels: 3, background: "#633" } }).webp().toFile(imagePath);
    const candidates = [
      { ...candidate("weak-zone", .8, 10), geometrySemantic: { confidence: .25, verdict: "unlikely" as const, features: { packageZoneConfidence: .2 } } },
      { ...candidate("strong-zone", .8, 55), geometrySemantic: { confidence: .95, verdict: "likely" as const, features: { packageZoneConfidence: .9 } } },
    ];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { candidates: Array<Record<string, unknown>> };
      assert.ok(request.candidates.every((item) => Object.keys(item).sort().join(",") === "id,imageBase64"), "numeric geometry must stay in deterministic fusion, not SigLIP transport");
      return new Response(JSON.stringify({
        model: env.SIGLIP_MODEL, revision: env.SIGLIP_MODEL_REVISION,
        candidates: request.candidates.map(({ id }) => ({ id, positiveScore: .6, negativeScore: .1, semanticScore: .5, scores: { wine_label: .6, bottle_body: .1 } })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const result = await enrichLabelCandidatesWithSiglip({ imagePath, candidates, mode: "rerank", enabled: true, fetchImpl });
    assert.equal(result.candidates[0]?.id, "strong-zone");
    assert.equal(result.candidates[0]?.fusion?.version, "label-fusion-v2");
    assert.deepEqual(result.candidates[0]?.fusion?.weights, { cv: .5, semantic: .35, contourGeometry: .15 });
    assert.equal(result.evidence.fusion.contourGeometryWeight, .15);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function candidate(id: string, score: number, y: number) {
  return { id, score, bbox: { x: 10, y, width: 100, height: 30 } };
}
