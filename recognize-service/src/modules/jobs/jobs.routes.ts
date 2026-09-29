import type { FastifyInstance } from "fastify";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import {
  createRecognizeJobSchema,
  estimateRecognizeJobsQuerySchema,
  listJobItemsQuerySchema,
  listJobsQuerySchema,
  retryRecognizeJobSchema,
} from "./jobs.schemas.js";
import {
  cancelRecognizeJob,
  deleteRecognizeJob,
  enqueueRecognizeJob,
  estimateRecognizeJobs,
  getRecognizeJob,
  listRecognizeJobs,
  listRecognizeJobItems,
  retryRecognizeJob,
} from "./jobs.service.js";

export async function jobsRoutes(app: FastifyInstance) {
  app.get("/management/recognize-jobs", async (request) => {
    const query = listJobsQuerySchema.parse(request.query);
    return listRecognizeJobs(query);
  });

  app.get("/management/recognize-jobs/estimate", async (request) => {
    const query = estimateRecognizeJobsQuerySchema.parse(request.query);
    return estimateRecognizeJobs(query);
  });

  app.post("/management/recognize-jobs", {
    schema: {
      tags: ["Jobs"],
      summary: "Queue a recognition or annotation pipeline job",
      description: "For ANNOTATION_LLM_PIPELINE, list batches accept explicit cards and allocate a fresh annotation version per card. A single-card request may bind annotationVersionId and initialize that active draft from empty state. llmExecutionMode selects one persisted provider conversation per card (session-chain) or independent requests chained through persisted Wizard state (one-shot-chain).",
      security: [{ internalApiKey: [] }],
      body: {
        type: "object", additionalProperties: false, required: ["type", "target"],
        properties: {
          type: { type: "string", enum: ["ANNOTATION_HELPER_PIPELINE", "ANNOTATION_LLM_PIPELINE", "ANALYZE_LABEL", "GENERATE_ALIASES", "GENERATE_DETECTION_PROPOSAL", "GENERATE_IMAGE_META", "GENERATE_TEXT_META", "REGENERATE_ALL_META"] },
          target: { type: "object", additionalProperties: true, description: "Single item, source filter, or frozen explicit items. LLM list batches allocate their own version and track." },
          options: {
            type: "object", additionalProperties: true,
            properties: {
              annotationTrackId: { type: "string", format: "uuid" },
              annotationVersionId: { type: "string", format: "uuid" },
              annotationVersionInitialization: { type: "string", enum: ["empty", "after-package"] },
              annotationVersionPublishPolicy: { type: "string", enum: ["review", "auto-on-success"] },
              llmExecutionMode: { type: "string", enum: ["session-chain", "one-shot-chain"], default: "session-chain", description: "Only for ANNOTATION_LLM_PIPELINE." },
              visionEvidence: {
                type: "object", additionalProperties: false,
                properties: { labelMode: { type: "string", enum: ["off", "score-only", "rerank"], default: "off" } },
                description: "Optional SigLIP2 behavior for Label candidate evidence. The selected value is persisted with every child job.",
              },
            },
          },
        },
      },
      response: {
        202: { type: "object", additionalProperties: true, properties: { jobId: { type: "string", format: "uuid" }, status: { type: "string" }, queuedChildren: { type: "integer" } } },
        404: { type: "object", required: ["error"], properties: { error: { type: "string" } } },
        409: { type: "object", required: ["error"], properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const body = createRecognizeJobSchema.parse(request.body);
    try {
      const job = await enqueueRecognizeJob(body);
      return reply.code(202).send(job);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/recognize-jobs/:jobId", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    try {
      return await getRecognizeJob(jobId);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.get("/management/recognize-jobs/:jobId/items", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const query = listJobItemsQuerySchema.parse(request.query);
    try {
      return await listRecognizeJobItems(jobId, query);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/recognize-jobs/:jobId/retry", {
    schema: {
      tags: ["Jobs"], summary: "Retry a terminal job against its current annotation version or as a new version/job",
      security: [{ internalApiKey: [] }],
      body: {
        type: "object", additionalProperties: false, required: ["mode"],
        properties: { mode: { type: "string", enum: ["current-version", "new-version"] } },
      },
      response: {
        200: { type: "object", additionalProperties: true },
        404: { type: "object", required: ["error"], properties: { error: { type: "string" } } },
        409: { type: "object", required: ["error"], properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const body = retryRecognizeJobSchema.parse(request.body);
    try {
      return await retryRecognizeJob(jobId, body.mode);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/recognize-jobs/:jobId/cancel", {
    schema: {
      tags: ["Jobs"], summary: "Cancel an active queued or running job", security: [{ internalApiKey: [] }],
      response: {
        200: { type: "object", additionalProperties: true },
        404: { type: "object", required: ["error"], properties: { error: { type: "string" } } },
        409: { type: "object", required: ["error"], properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    try {
      return await cancelRecognizeJob(jobId);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/management/recognize-jobs/:jobId", async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    try {
      return await deleteRecognizeJob(jobId);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}
