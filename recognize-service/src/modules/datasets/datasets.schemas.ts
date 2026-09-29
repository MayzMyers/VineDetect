import { z } from "zod";

const itemKeySchema = z.object({
  source: z.enum(["svoe_vino", "roskachestvo"]),
  sourceItemId: z.string().trim().min(1).max(500),
});

export const createCohortSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  createdBy: z.string().trim().min(1).max(200).optional(),
  items: z.array(itemKeySchema).min(1).max(10000),
}).transform((input) => ({
  ...input,
  items: Array.from(new Map(input.items.map((item) => [`${item.source}\u0000${item.sourceItemId}`, item])).values()),
}));

export const createDatasetVersionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  createdBy: z.string().trim().min(1).max(200).optional(),
});

export const cohortParamsSchema = z.object({ cohortId: z.string().uuid() });
export const datasetVersionParamsSchema = z.object({ datasetVersionId: z.string().uuid() });
