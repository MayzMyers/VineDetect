import type { FastifyInstance, FastifyReply } from "fastify";
import { addEvaluation, createModelVersion, listTrainingRuns, updateModelStatus, updateTrainingRunStatus } from "../../db/training.repository.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { artifactParamsSchema, artifactReadinessQuerySchema, createEvaluationSchema, createModelVersionSchema, createTrainingRunSchema, modelParamsSchema, runParamsSchema, updateModelStatusSchema, updateTrainingStatusSchema } from "./training.schemas.js";
import { inspectDatasetArtifact } from "./datasetArtifactConsumer.js";
import { createValidatedTrainingRun } from "./training.service.js";

export async function trainingRoutes(app: FastifyInstance) {
  app.get("/management/training/runs", async () => ({ items: await listTrainingRuns() }));
  app.get("/management/training/artifacts/:artifactId/readiness", async (request, reply) => {
    const { artifactId } = artifactParamsSchema.parse(request.params);
    const { task } = artifactReadinessQuerySchema.parse(request.query);
    return handle(reply, () => inspectDatasetArtifact(artifactId, task));
  });
  app.post("/management/training/runs", async (request, reply) => handle(reply, () => createValidatedTrainingRun(createTrainingRunSchema.parse(request.body)), 201));
  app.patch("/management/training/runs/:runId/status", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    return handle(reply, () => updateTrainingRunStatus(runId, updateTrainingStatusSchema.parse(request.body)));
  });
  app.post("/management/training/runs/:runId/evaluations", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    return handle(reply, () => addEvaluation(runId, createEvaluationSchema.parse(request.body)), 201);
  });
  app.post("/management/training/runs/:runId/models", async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    return handle(reply, () => createModelVersion(runId, createModelVersionSchema.parse(request.body)), 201);
  });
  app.patch("/management/training/models/:modelId/status", async (request, reply) => {
    const { modelId } = modelParamsSchema.parse(request.params);
    const { status } = updateModelStatusSchema.parse(request.body);
    return handle(reply, () => updateModelStatus(modelId, status));
  });
}

async function handle(reply: FastifyReply, action: () => Promise<unknown>, successCode = 200) {
  try {
    return reply.code(successCode).send(await action());
  } catch (error) {
    if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
    if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
    throw error;
  }
}
