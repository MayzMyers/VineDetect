import { z } from "zod";
import { sourceNameSchema } from "../metadata/metadata.schemas.js";

export const presetLayerSchema = z.enum([
  "label-roi",
  "ocr-region",
  "ocr-recognition",
  "source-matching",
  "alias-generation",
  "pipeline",
]);

export const presetStatusSchema = z.enum(["draft", "validated", "deprecated"]);

const labelRoiPresetConfigSchema = z.object({
  schemaVersion: z.literal(1),
  preprocessing: z.object({
    source: z.enum(["full-image", "bottle-roi"]),
    resize: z.object({
      enabled: z.boolean(),
      maxWidth: z.number().int().positive().max(10000),
      maxHeight: z.number().int().positive().max(10000),
    }),
  }),
  color: z.object({
    colorSpace: z.enum(["gray", "hsv", "lab"]),
    referenceMode: z.enum(["auto-bottle-color", "manual-samples", "fixed-value"]),
    referenceColors: z.array(
      z.object({
        r: z.number().min(0).max(255),
        g: z.number().min(0).max(255),
        b: z.number().min(0).max(255),
        weight: z.number().min(0),
      }),
    ),
    distanceThreshold: z.number().min(0).max(255),
  }),
  threshold: z.object({
    enabled: z.boolean(),
    type: z.enum(["binary", "adaptive-mean", "adaptive-gaussian", "otsu", "color-distance"]),
    value: z.number().min(0).max(255),
  }),
  morphology: z.object({
    enabled: z.boolean(),
    operation: z.enum(["open", "close", "dilate", "erode"]),
    kernelWidth: z.number().int().positive().max(99),
    kernelHeight: z.number().int().positive().max(99),
    iterations: z.number().int().positive().max(20),
  }),
  scoring: z.object({
    positionWeight: z.number().min(0).max(1),
    areaWeight: z.number().min(0).max(1),
    rectangularityWeight: z.number().min(0).max(1),
    edgeDensityWeight: z.number().min(0).max(1),
    colorDifferenceWeight: z.number().min(0).max(1),
  }),
  selection: z.object({
    minScore: z.number().min(0).max(1),
    maxCandidates: z.number().int().positive().max(100),
  }),
});

const createdFromSchema = z.object({
  source: sourceNameSchema,
  sourceItemId: z.string().min(1),
});

const presetFieldsSchema = z.object({
  layer: presetLayerSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  status: presetStatusSchema.default("draft"),
  engineKind: z.string().trim().min(1).max(100),
  engineVersion: z.string().trim().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()),
  createdFrom: createdFromSchema.optional(),
  createdBy: z.string().trim().min(1).max(200).optional(),
  validationDatasetVersion: z.string().trim().min(1).max(200).optional(),
  validationMetrics: z.record(z.string(), z.unknown()).optional(),
});

export const listPresetsQuerySchema = z.object({
  layer: presetLayerSchema.optional(),
  status: presetStatusSchema.optional(),
  includeDeprecated: z
    .preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean())
    .default(false),
});

export const createPresetSchema = presetFieldsSchema;

export const createPresetRevisionSchema = presetFieldsSchema.omit({ layer: true }).partial().extend({
  baseRevision: z.number().int().positive(),
  config: z.record(z.string(), z.unknown()),
});

export const presetIdSchema = z.string().uuid();

export type CreatePresetInput = z.infer<typeof createPresetSchema>;
export type CreatePresetRevisionInput = z.infer<typeof createPresetRevisionSchema>;
export type ListPresetsQuery = z.infer<typeof listPresetsQuerySchema>;

export function validatePresetConfig(layer: z.infer<typeof presetLayerSchema>, config: Record<string, unknown>) {
  if (layer === "label-roi") labelRoiPresetConfigSchema.parse(config);
}
