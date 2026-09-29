import type { FastifyInstance } from "fastify";
import { env } from "../../config/env.js";
import { MAX_RECOGNITION_IMAGE_BYTES } from "../../vision/v5Client.js";
import { recognizeImageRequestSchema, recognizeRequestSchema } from "./recognize.schemas.js";
import { recognize, recognizeImage } from "./recognize.service.js";

export async function recognizeRoutes(app: FastifyInstance) {
  app.post("/recognize", { bodyLimit: 24 * 1024 * 1024 }, async (request, reply) => {
    if (request.body && typeof request.body === "object" && "imageBase64" in request.body) {
      const body = recognizeImageRequestSchema.parse(request.body);
      if (Buffer.from(body.imageBase64, "base64").length > MAX_RECOGNITION_IMAGE_BYTES) {
        return reply.code(413).send({ error: "Image exceeds 16 MiB" });
      }
      if (body.diagnostics && request.headers["x-internal-api-key"] !== env.INTERNAL_API_KEY) {
        return reply.code(403).send({ error: "Diagnostics require the internal API key" });
      }
      try {
        return await recognizeImage(body.imageBase64, body.diagnostics);
      } catch (error) {
        request.log.error(error, "V5 image recognition unavailable");
        return reply.code(503).send({ error: "Image recognition unavailable" });
      }
    }
    const body = recognizeRequestSchema.parse(request.body);
    return recognize({ ocrTokens: body.ocrTokens, limit: body.limit });
  });
}
