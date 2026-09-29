import { contestOfficialRoutes } from "./modules/contest-official/contest-official.routes.js";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { generationRoutes } from "./modules/generation/generation.routes.js";
import { inventoryRoutes } from "./modules/inventory/inventory.routes.js";
import { jobsRoutes } from "./modules/jobs/jobs.routes.js";
import { metadataRoutes } from "./modules/metadata/metadata.routes.js";
import { playgroundRoutes } from "./modules/playground/playground.routes.js";
import { presetRoutes } from "./modules/presets/presets.routes.js";
import { recognizeRoutes } from "./modules/recognize/recognize.routes.js";
import { datasetRoutes } from "./modules/datasets/datasets.routes.js";
import { trainingRoutes } from "./modules/training/training.routes.js";
import { wizardRoutes } from "./modules/wizard/wizard.routes.js";
import { registerWizardOpenApiRoutes } from "./openapi/wizardOpenApi.js";
import { annotationRequestActor, recordAnnotationTrackActor } from "./db/annotation-actor.repository.js";

// Catalog source IDs are human-readable slugs and can legitimately exceed
// Fastify's 100-character default. Keep a finite ceiling, but size it for the
// persisted source contract rather than rejecting valid catalog items.
export const MAX_ROUTE_PARAM_LENGTH = 512;

export function buildApp() {
  const app = Fastify({
    logger: true,
    routerOptions: { maxParamLength: MAX_ROUTE_PARAM_LENGTH },
  });

  app.register(cors, {
    origin: [env.NEXT_BFF_ORIGIN],
  });

  app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "VineDetect Label Annotation Wizard API",
        description: "Live input/output contract and data-flow map for the manual and semi-automatic annotation wizard.",
        version: "8.0.0",
      },
      // Deliberately omit a fixed server URL. Swagger try-it-out then uses the
      // same origin that served the document and cannot cross from Docker to a
      // separate WSL/Harness relay exposing the same development port.
      tags: [
        { name: "Annotation Graph", description: "Canonical Package, Label, OCR and Meta entities with separate operation provenance." },
        { name: "Annotation Tracks", description: "Item 1:N independent full-wizard annotation workflows." },
        { name: "1. Package", description: "Technical source-image working crop; full image is the valid default." },
        { name: "2. Label", description: "Manual reviewed Label/VisualRegion ROI plus independently reviewed region semantics." },
        { name: "3. Object Context", description: "Smart-lasso physical package contour and palette review inside the technical Package scope." },
        { name: "4. OCR", description: "Detector-free OCR, region correction and source-data matching." },
        { name: "5-10. Label CV", description: "Mask, Morphology, Components, Elements, Contours and Palette inside the reviewed label crop." },
        { name: "11. Summary", description: "Aggregate review, catalog identity and Save/Next boundary." },
        { name: "Wizard API", description: "Headless workflow contract, stage guides and server-side stage state/validation shared by UI, LLM and local ML clients." },
        { name: "Jobs", description: "Persisted helper and LLM batch execution over frozen annotation-card selections." },
      ],
      components: {
        securitySchemes: {
          internalApiKey: { type: "apiKey", in: "header", name: "x-internal-api-key", description: "Internal BFF-to-Recognize API key." },
        },
      },
      security: [{ internalApiKey: [] }],
    },
    hideUntagged: true,
  });
  app.register(swaggerUi, {
    routePrefix: "/documentation",
    uiConfig: { docExpansion: "list", deepLinking: true, displayOperationId: true },
  });
  registerWizardOpenApiRoutes(app);

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/management")) return;
    const key = request.headers["x-internal-api-key"];
    if (key !== env.INTERNAL_API_KEY) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    if (!request.url.startsWith("/management") || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    const actor = annotationRequestActor(request.headers);
    const trackId = request.headers["x-annotation-track-id"];
    if (!actor || typeof trackId !== "string") return;
    await recordAnnotationTrackActor(trackId, actor);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", issues: error.issues });
    }
    if (typeof error === "object" && error !== null && "validation" in error && error.validation) {
      return reply.code(400).send({ error: "Validation failed", issues: error.validation });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.get("/health", async () => ({ status: "ok", service: "recognize-service" }));
  app.register(inventoryRoutes);
  app.register(metadataRoutes);
  app.register(generationRoutes);
  app.register(jobsRoutes);
  app.register(playgroundRoutes);
  app.register(presetRoutes);
  app.register(recognizeRoutes);
  app.register(datasetRoutes);
  app.register(trainingRoutes);
  app.register(wizardRoutes);
  app.register(contestOfficialRoutes);

  return app;
}
