import { z } from "zod";
import { sourceNameSchema } from "../metadata/metadata.schemas.js";

export const inventoryQuerySchema = z.object({
  source: z.union([sourceNameSchema, z.literal("all")]).default("all"),
  search: z.string().optional(),
  metaStatus: z.string().optional(),
  cvMeta: z.enum(["all", "present", "missing"]).default("all"),
  annotationStatus: z.enum(["missing", "needs-review", "reviewed", "no-label", "invalid-image", "needs-ocr", "needs-ocr-review", "ready-for-export", "not-started", "in-progress", "complete"]).optional(),
  executionActor: z.enum(["human", "ml-agent", "hybrid"]).optional(),
  automationMode: z.enum(["manual", "auto", "mixed"]).optional(),
  recognitionTag: z.string().trim().min(1).max(120).optional(),
  analysisStatus: z.enum(["missing", "needs-review", "accepted", "needs-tuning", "rejected"]).optional(),
  catalogIdentityStatus: z.enum(["missing", "confirmed", "corrected", "no-match", "ambiguous"]).optional(),
  firstPerInitial: z.union([z.boolean(), z.enum(["true", "false"])]).transform((value) => value === true || value === "true").default(false),
  perInitialLimit: z.coerce.number().int().positive().max(100).default(3),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const annotationSummaryQuerySchema = z.object({
  source: z.union([sourceNameSchema, z.literal("all")]).default("all"),
});
