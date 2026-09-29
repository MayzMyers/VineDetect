import type { FastifyInstance } from "fastify";
import { annotationSummaryQuerySchema, inventoryQuerySchema } from "./inventory.schemas.js";
import { getAnnotationSummaryRecord, listInventoryRecords } from "./inventory.service.js";

export async function inventoryRoutes(app: FastifyInstance) {
  app.get("/management/annotations/summary", async (request) => {
    const query = annotationSummaryQuerySchema.parse(request.query);
    return getAnnotationSummaryRecord(query.source);
  });

  app.get("/management/inventory", async (request) => {
    const query = inventoryQuerySchema.parse(request.query);
    return listInventoryRecords(query);
  });
}
