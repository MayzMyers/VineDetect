import type { FastifyInstance } from "fastify";
import { createCohort, createDatasetVersion, listCohorts } from "../../db/dataset.repository.js";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import { cohortParamsSchema, createCohortSchema, createDatasetVersionSchema, datasetVersionParamsSchema } from "./datasets.schemas.js";
import { exportDatasetVersion } from "./datasetExport.js";

export async function datasetRoutes(app: FastifyInstance) {
  app.get("/management/datasets/cohorts", async () => ({ items: await listCohorts() }));

  app.post("/management/datasets/cohorts", async (request, reply) => {
    const body = createCohortSchema.parse(request.body);
    return reply.code(201).send(await createCohort(body));
  });

  app.post("/management/datasets/cohorts/:cohortId/versions", async (request, reply) => {
    const { cohortId } = cohortParamsSchema.parse(request.params);
    const body = createDatasetVersionSchema.parse(request.body);
    try {
      return reply.code(201).send(await createDatasetVersion(cohortId, body));
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/datasets/versions/:datasetVersionId/export", async (request, reply) => {
    const { datasetVersionId } = datasetVersionParamsSchema.parse(request.params);
    try {
      return await exportDatasetVersion(datasetVersionId);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}
