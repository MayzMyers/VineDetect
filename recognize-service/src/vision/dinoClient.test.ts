import assert from "node:assert/strict";
import test from "node:test";
import { detectLabelWithDino } from "./dinoClient.js";

const response = {
  model: "IDEA-Research/grounding-dino-tiny",
  revision: "a2bb814dd30d776dcf7e30523b00659f4f141c71",
  device: "cuda",
  prompt: "main wine label",
  threshold: 0.18,
  textThreshold: 0.15,
  width: 1069,
  height: 3858,
  inferenceMs: 136.2,
  selectionMethod: "geometry-containment",
  selected: {
    _image_width: 1069,
    _image_height: 3858,
    model_score: 0.20253,
    box_xyxy: [223.95, 1849.85, 817.37, 3401.74],
    box_xywh: [223.95, 1849.85, 593.42, 1551.88],
    geometry: {
      width_ratio: 0.555115,
      height_ratio: 0.402251,
      area_ratio: 0.223295,
      center_x: 0.48705,
      center_y: 0.680611,
    },
    geometry_reject_reasons: [],
    support_count: 0,
    containment_bonus: 0,
    selection_score: 0.481007,
  },
  detections: [],
};

test("DINO client accepts a validated selected label ROI", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const result = await detectLabelWithDino({
    imagePath: new URL(import.meta.url).pathname,
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(result.selectionMethod, "geometry-containment");
  assert.equal(result.selected?.geometry.area_ratio, 0.223295);
  assert.equal(result.selected?.box_xywh[2], 593.42);
});

test("DINO client rejects provenance drift", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        ...response,
        revision: "wrong-revision",
      }),
      { status: 200 },
    );

  await assert.rejects(
    detectLabelWithDino({
      imagePath: new URL(import.meta.url).pathname,
      fetchImpl: fetchImpl as typeof fetch,
    }),
    /revision provenance mismatch/,
  );
});

test("DINO client accepts compact wordmark fallback", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        ...response,
        prompt: "wine name text",
        selectionMethod: "compact-wordmark-fallback",
        attemptedPrompts: [
          "main wine label",
          "main white wine label",
          "wine name text",
        ],
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

  const result = await detectLabelWithDino({
    imagePath: new URL(import.meta.url).pathname,
    fetchImpl: fetchImpl as typeof fetch,
  });

  assert.equal(
    result.selectionMethod,
    "compact-wordmark-fallback",
  );

  assert.deepEqual(result.attemptedPrompts, [
    "main wine label",
    "main white wine label",
    "wine name text",
  ]);

  assert.ok(result.selected);
});
