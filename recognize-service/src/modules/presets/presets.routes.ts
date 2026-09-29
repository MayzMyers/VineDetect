import type { FastifyInstance } from "fastify";
import { ConflictError, NotFoundError } from "../../shared/errors.js";
import {
  createPresetRevisionSchema,
  createPresetSchema,
  listPresetsQuerySchema,
  presetIdSchema,
} from "./presets.schemas.js";
import {
  createPipelinePreset,
  createPipelinePresetRevision,
  listLatestPipelinePresets,
  listPipelinePresetRevisions,
} from "./presets.service.js";

export async function presetRoutes(app: FastifyInstance) {
  app.get("/management/pipeline-presets", async (request) => {
    const query = listPresetsQuerySchema.parse(request.query);
    return { items: await listLatestPipelinePresets(query) };
  });

  app.post("/management/pipeline-presets", async (request, reply) => {
    const body = createPresetSchema.parse(request.body);
    return reply.code(201).send(await createPipelinePreset(body));
  });

  app.get("/management/pipeline-presets/:presetId/revisions", async (request, reply) => {
    const presetId = parsePresetId(request.params);
    try {
      return { items: await listPipelinePresetRevisions(presetId) };
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/pipeline-presets/:presetId/revisions", async (request, reply) => {
    const presetId = parsePresetId(request.params);
    const body = createPresetRevisionSchema.parse(request.body);
    try {
      return reply.code(201).send(await createPipelinePresetRevision(presetId, body));
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}

function parsePresetId(params: unknown) {
  return presetIdSchema.parse((params as { presetId?: string }).presetId);
}
