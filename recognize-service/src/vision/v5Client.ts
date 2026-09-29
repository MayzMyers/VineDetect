import { z } from "zod";
import { env } from "../config/env.js";

export const MAX_RECOGNITION_IMAGE_BYTES = 16 * 1024 * 1024;
const box = z.tuple([z.number().finite(), z.number().finite(), z.number().positive(), z.number().positive()]);
export const targetSchema = z.object({
  width: z.number().int().positive(), height: z.number().int().positive(),
  bottleBox: box.nullable(), originalLabel: box.nullable(), intentLabel: box.nullable(),
  allLabels: z.array(box), targetDetectionMs: z.number().nonnegative(),
}).strict();
const targetResponse = z.object({ target: targetSchema, bottleImageBase64: z.string().nullable() });
const identity = z.object({
  catalogItemId: z.number().int().positive(), officialSlug: z.string().min(1), title: z.string().min(1),
}).strict();
export const v5ResponseSchema = z.object({
  architecture: z.literal("V5-RC1"), result: identity,
  diagnostics: z.object({
    baseline: z.number().int().positive(), baselineMargin: z.number().finite(),
    views: z.record(z.string(), z.array(z.object({
      catalogItemId: z.number().int().positive(), rank: z.number().int().positive(),
      cosineSimilarity: z.number().finite(),
    }).passthrough())),
    timingsMs: z.record(z.string(), z.number().finite().nonnegative()),
    failures: z.array(z.string()),
  }).passthrough(),
});

async function post(path: string, body: unknown, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`${env.SIGLIP_SERVICE_URL}${path}`, {
    method: "POST",
    // CV can keep the Node event loop busy beyond the upstream keep-alive.
    // Do not reuse a socket whose peer may have closed during that work.
    headers: { "content-type": "application/json", connection: "close",
      ...(env.SIGLIP_SERVICE_TOKEN ? { authorization: `Bearer ${env.SIGLIP_SERVICE_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(env.V5_TIMEOUT_MS),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`V5 vision service returned HTTP ${response.status}`);
  return response.json();
}

export async function detectRecognitionTarget(imageBase64: string, fetchImpl = fetch) {
  return targetResponse.parse(await post("/v1/recognition/target", { imageBase64 }, fetchImpl));
}
export async function recognizeV5(
  imageBase64: string,
  target: z.infer<typeof targetSchema>,
  labelRoi: [number, number, number, number] | null,
  fetchImpl = fetch,
) {
  return v5ResponseSchema.parse(await post("/v1/recognition/v5", { imageBase64, target, labelRoi }, fetchImpl));
}
