import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NotFoundError } from "../../shared/errors.js";
import { sourceNameSchema } from "../metadata/metadata.schemas.js";
import { generateOne, getJobStatus, queueBatchGeneration } from "./generation.service.js";

const generateItemSchema = z.object({
  source: sourceNameSchema,
  sourceItemId: z.string().min(1),
  overwrite: z.boolean().default(false),
});

const batchSchema = z.object({
  sources: z.array(sourceNameSchema).min(1),
  mode: z.enum(["missing-only", "overwrite"]).default("missing-only"),
  limit: z.number().int().positive().max(5000).default(500),
});

export async function generationRoutes(app: FastifyInstance) {
  app.post("/management/generation/item", async (request, reply) => {
    const body = generateItemSchema.parse(request.body);
    try {
      return await generateOne(body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/generation/batch", async (request) => {
    const body = batchSchema.parse(request.body);
    return queueBatchGeneration(body);
  });

  app.get("/management/generation/jobs/:jobId", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    try {
      return await getJobStatus(jobId);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });
}
