import { z } from "zod";
import { sourceNameSchema } from "../metadata/metadata.schemas.js";
import { wizardAutomationRunSchema } from "../wizard/wizard.schemas.js";

const DEFAULT_PIPELINE_VERSION = "cv-meta-v2-debug-layers";
const batchSourceSchema = z.union([sourceNameSchema, z.literal("all")]);
const jobItemKeySchema = z.object({
  source: sourceNameSchema,
  sourceItemId: z.string().min(1),
  annotationTrackId: z.string().uuid().optional(),
});

const booleanQuerySchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

export const recognizeJobTypeSchema = z.enum([
  "ANNOTATION_HELPER_PIPELINE",
  "ANNOTATION_LLM_PIPELINE",
  "ANALYZE_LABEL",
  "GENERATE_ALIASES",
  "GENERATE_DETECTION_PROPOSAL",
  "GENERATE_CV_META",
  "GENERATE_ALL_META",
  "REGENERATE_ALL_META",
]);

export const createRecognizeJobSchema = z.object({
  type: recognizeJobTypeSchema,
  target: z.union([
    z.object({
      source: sourceNameSchema,
      sourceItemId: z.string().min(1),
    }),
    z.object({
      filter: z.object({
        source: batchSourceSchema,
        missingCvMeta: z.boolean().optional().default(false),
      }),
    }),
    z.object({
      items: z.array(jobItemKeySchema).min(1).max(10000),
    }),
  ]),
  options: z
    .object({
      force: z.boolean().default(false),
      pipelineVersion: z.string().min(1).default(DEFAULT_PIPELINE_VERSION),
      batchSize: z.number().int().positive().max(10000).default(25),
      presetId: z.string().min(1).optional(),
      presetRevision: z.number().int().positive().optional(),
      configHash: z.string().min(1).optional(),
      pipelineConfigSnapshot: z.record(z.string(), z.unknown()).optional(),
      analysisConfigSnapshot: z.record(z.string(), z.unknown()).optional(),
      annotationId: z.string().uuid().optional(),
      annotationRevision: z.number().int().positive().optional(),
      annotationTrackId: z.string().uuid().optional(),
      annotationVersionId: z.string().uuid().optional(),
      annotationVersionInitialization: z.enum(["empty", "after-package"]).optional(),
      annotationVersionPublishPolicy: z.enum(["review", "auto-on-success"]).optional(),
      llmExecutionMode: z.enum(["session-chain", "one-shot-chain"]).optional(),
      visionEvidence: z.object({ labelMode: z.enum(["off", "score-only", "rerank"]) }).optional(),
      automation: wizardAutomationRunSchema.optional(),
    })
    .optional()
    .default({ force: false, pipelineVersion: DEFAULT_PIPELINE_VERSION, batchSize: 25 }),
}).superRefine((value, context) => {
  const hasPresetId = Boolean(value.options.presetId);
  const hasPresetRevision = value.options.presetRevision !== undefined;
  if (hasPresetId !== hasPresetRevision) {
    context.addIssue({
      code: "custom",
      path: ["options", hasPresetId ? "presetRevision" : "presetId"],
      message: "presetId and presetRevision must be provided together",
    });
  }
  if (value.type === "ANALYZE_LABEL" && "source" in value.target && (!value.options.annotationId || value.options.annotationRevision === undefined)) {
    context.addIssue({ code: "custom", path: ["options", "annotationId"], message: "ANALYZE_LABEL requires annotationId and annotationRevision" });
  }
  if (value.type === "ANALYZE_LABEL" && "filter" in value.target) {
    context.addIssue({ code: "custom", path: ["target"], message: "ANALYZE_LABEL supports one item or an explicit item selection" });
  }
  if (value.type === "ANNOTATION_HELPER_PIPELINE" && (!("source" in value.target) || !value.options.annotationTrackId)) {
    context.addIssue({ code: "custom", path: ["options", "annotationTrackId"], message: "ANNOTATION_HELPER_PIPELINE currently requires one item and annotationTrackId" });
  }
  if (value.type === "ANNOTATION_LLM_PIPELINE") {
    if ("filter" in value.target) context.addIssue({ code: "custom", path: ["target"], message: "ANNOTATION_LLM_PIPELINE requires explicit annotation cards" });
    if ("source" in value.target && !value.options.annotationTrackId && !value.options.annotationVersionId) context.addIssue({ code: "custom", path: ["options", "annotationTrackId"], message: "ANNOTATION_LLM_PIPELINE requires annotationTrackId or annotationVersionId" });
  }
});

export const listJobItemsQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listJobsQuerySchema = z.object({
  status: z.enum(["queued", "running", "completed", "completed_with_errors", "failed", "cancelled"]).optional(),
  type: recognizeJobTypeSchema.optional(),
  scope: z.enum(["batch-parent", "batch-child", "single-item"]).optional(),
  source: sourceNameSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const retryRecognizeJobSchema = z.object({
  mode: z.enum(["current-version", "new-version"]),
}).strict();

export const estimateRecognizeJobsQuerySchema = z.object({
  source: batchSourceSchema,
  missingCvMeta: booleanQuerySchema.default(true),
  force: booleanQuerySchema.default(false),
  pipelineVersion: z.string().min(1).default(DEFAULT_PIPELINE_VERSION),
  batchSize: z.coerce.number().int().positive().max(10000).default(25),
  type: recognizeJobTypeSchema.default("GENERATE_ALL_META"),
  presetId: z.string().uuid().optional(),
  presetRevision: z.coerce.number().int().positive().optional(),
}).superRefine((value, context) => {
  if (value.type === "ANALYZE_LABEL" || value.type === "ANNOTATION_HELPER_PIPELINE" || value.type === "ANNOTATION_LLM_PIPELINE") {
    context.addIssue({ code: "custom", path: ["type"], message: `${value.type} is not supported by source/global estimate` });
  }
  if (Boolean(value.presetId) !== (value.presetRevision !== undefined)) {
    context.addIssue({
      code: "custom",
      path: [value.presetId ? "presetRevision" : "presetId"],
      message: "presetId and presetRevision must be provided together",
    });
  }
});
