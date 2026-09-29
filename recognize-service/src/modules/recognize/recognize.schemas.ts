import { z } from "zod";

export const recognizeRequestSchema = z.object({
  ocrTokens: z.array(z.string()).default([]),
  visualFeatures: z.record(z.string(), z.unknown()).default({}),
  limit: z.number().int().positive().max(50).default(5),
});

export const recognizeImageRequestSchema = z.object({
  imageBase64: z.string().min(4).max(Math.ceil(16 * 1024 * 1024 / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  diagnostics: z.boolean().default(false),
}).strict();
