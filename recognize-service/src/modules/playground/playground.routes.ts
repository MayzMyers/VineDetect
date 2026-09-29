import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../../shared/errors.js";
import { playgroundRunSchema, playgroundSweepSchema } from "./playground.schemas.js";
import { runCvPlayground, runCvPlaygroundSweep } from "./playground.service.js";

export async function playgroundRoutes(app: FastifyInstance) {
  app.post("/management/cv/playground/run", async (request, reply) => {
    const body = playgroundRunSchema.parse(request.body);
    try {
      return await runCvPlayground(body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });

  app.post("/management/cv/playground/sweep", async (request, reply) => {
    const body = playgroundSweepSchema.parse(request.body);
    try {
      return await runCvPlaygroundSweep(body);
    } catch (error) {
      if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
      throw error;
    }
  });
}
