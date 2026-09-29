import { z } from "zod";

export const taskSchema = z.enum(["label-roi", "physical-label-roi", "ocr-region", "source-matching", "alias-ranking", "bottle-outline", "label-elements", "label-palette"]);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const createTrainingRunSchema = z.object({
  datasetArtifactId: z.string().uuid(),
  task: taskSchema,
  name: z.string().trim().min(1).max(200),
  framework: z.string().trim().min(1).max(100),
  runtime: z.string().trim().max(500).optional(),
  configSnapshot: z.record(z.string(), z.unknown()).default({}),
  codeVersion: z.string().trim().max(200).optional(),
  createdBy: z.string().trim().max(200).optional(),
});

export const updateTrainingStatusSchema = z.object({
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  errorMessage: z.string().trim().min(1).max(4000).optional(),
});

export const createEvaluationSchema = z.object({
  modelVersionId: z.string().uuid().optional(),
  split: z.enum(["train", "validation", "test"]),
  metrics: z.record(z.string(), z.number().finite()),
  sampleCount: z.number().int().min(0),
});

export const createModelVersionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  artifactPath: z.string().trim().min(1).max(2000),
  artifactSha256: sha256Schema,
  runtime: z.string().trim().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const updateModelStatusSchema = z.object({ status: z.enum(["validated", "promoted", "deprecated"]) });
export const runParamsSchema = z.object({ runId: z.string().uuid() });
export const modelParamsSchema = z.object({ modelId: z.string().uuid() });
export const artifactParamsSchema = z.object({ artifactId: z.string().uuid() });
export const artifactReadinessQuerySchema = z.object({ task: taskSchema.optional().default("label-roi") });
