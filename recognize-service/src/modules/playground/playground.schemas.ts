import { z } from "zod";
import { sourceNameSchema } from "../metadata/metadata.schemas.js";

export const playgroundRunSchema = z.object({
  source: sourceNameSchema,
  sourceItemId: z.string().min(1),
  annotationTrackId: z.string().uuid().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  mode: z.enum(["preview", "full"]).default("preview"),
});

export const playgroundSweepSchema = z.object({
  source: sourceNameSchema,
  sourceItemId: z.string().min(1),
  annotationTrackId: z.string().uuid().optional(),
  baseConfig: z.record(z.string(), z.unknown()).default({}),
  sweeps: z
    .array(
      z.object({
        parameterPath: z.enum([
          "color.distanceThreshold",
          "selection.minScore",
          "morphology.kernelWidth",
          "morphology.kernelHeight",
          "morphology.iterations",
        ]),
        values: z.array(z.number()).min(1).max(9),
      }),
    )
    .min(1)
    .max(4),
  mode: z.enum(["preview", "full"]).default("preview"),
});
