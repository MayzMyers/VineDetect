import { z } from "zod";
import { annotationHelperRunSchema, graphEntityTypeSchema, manualOcrDedupePreflightSchema } from "../metadata/metadata.schemas.js";
import { bboxFromGeometry, isValidConvexQuad, type QuadGeometry } from "../../shared/quadGeometry.js";

export const wizardCommandSchema = z.object({
  command: z.enum([
    "run_helper", "select_candidate", "update_params", "create_region", "edit_region",
    "delete_region", "merge", "reparent", "set_semantic", "commit",
  ]),
  target: z.object({
    entityType: graphEntityTypeSchema,
    id: z.string().uuid(),
  }).strict().optional(),
  payload: z.unknown().default({}),
}).strict();

export type WizardCommandRequest = z.infer<typeof wizardCommandSchema>;

export const packageMultiplicityCommandSchema = z.object({
  value: z.enum(["single", "multiple"]),
  operation: annotationHelperRunSchema,
}).strict();

const automationStageSchema = z.enum(["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"]);
export const wizardAutomationRunSchema = z.object({
  through: automationStageSchema.optional().default("summary"),
  labelIds: z.array(z.string().uuid()).max(100).optional(),
  objectContextLabelId: z.string().uuid().optional(),
  continueOnError: z.boolean().optional().default(true),
  configs: z.object({
    label: z.record(z.string(), z.unknown()).optional(),
    bottle: z.record(z.string(), z.unknown()).optional(),
    ocr: z.record(z.string(), z.unknown()).optional(),
    cv: z.record(z.string(), z.unknown()).optional(),
  }).strict().optional().default({}),
}).strict();
export type WizardAutomationRunRequest = z.infer<typeof wizardAutomationRunSchema>;

export const correctionPlanExecutorSchema = z.enum(["human", "llm", "local_ml", "system"]);
export const correctionPlanInteractionModeSchema = z.enum(["auto", "manual", "mixed"]);
export const wizardCorrectionOperationSchema = z.object({
  operationId: z.string().min(1).max(120).optional(),
  stage: automationStageSchema,
  labelId: z.string().uuid().optional(),
  command: wizardCommandSchema.shape.command,
  target: wizardCommandSchema.shape.target,
  payload: z.unknown().default({}),
  proposedOutput: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const wizardCorrectionPlanSchema = z.object({
  executor: correctionPlanExecutorSchema.optional(),
  interactionMode: correctionPlanInteractionModeSchema.default("auto"),
  controller: z.object({
    id: z.string().min(1).max(120),
    version: z.string().min(1).max(80).optional(),
    model: z.string().min(1).max(160).optional(),
    promptVersion: z.string().min(1).max(80).optional(),
  }).strict(),
  proposedOutput: z.record(z.string(), z.unknown()).default({}),
  operations: z.array(wizardCorrectionOperationSchema).min(1).max(100),
  continueOnError: z.boolean().default(false),
}).strict();
export type WizardCorrectionPlanRequest = z.infer<typeof wizardCorrectionPlanSchema>;

export const llmHumanReviewSchema = z.object({
  stage: automationStageSchema,
  finalEditor: z.enum(["helper", "llm", "human", "local_ml"]),
  verdict: z.enum(["llm_correct", "llm_false_accept", "llm_false_correction", "llm_partially_correct"]),
}).strict();
export type LlmHumanReviewRequest = z.infer<typeof llmHumanReviewSchema>;

export const wizardVisualRenderSchema = z.object({
  viewport: z.discriminatedUnion("type", [
    z.object({ type: z.literal("source") }).strict(),
    z.object({ type: z.literal("package") }).strict(),
    z.object({ type: z.literal("label"), id: z.string().uuid() }).strict(),
  ]).default({ type: "source" }),
  maxSide: z.number().int().min(256).max(1280).default(768),
  overlays: z.array(z.enum(["package-scope", "object-context", "labels", "ocr"])).max(4)
    .default(["package-scope", "object-context", "labels", "ocr"]),
  selectedLabelId: z.string().uuid().optional(),
  includeRejected: z.boolean().default(false),
}).strict();
export type WizardVisualRenderRequest = z.infer<typeof wizardVisualRenderSchema>;

export const externalControllerPlanRequestSchema = z.object({
  render: wizardVisualRenderSchema.optional().default({
    viewport: { type: "source" }, maxSide: 768,
    overlays: ["package-scope", "object-context", "labels", "ocr"], includeRejected: false,
  }),
  input: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type ExternalControllerPlanRequest = z.infer<typeof externalControllerPlanRequestSchema>;
export const localMlControllerPlanRequestSchema = externalControllerPlanRequestSchema;
export type LocalMlControllerPlanRequest = ExternalControllerPlanRequest;

const externalControllerIdentitySchema = z.object({
  id: z.string().min(1).max(120), version: z.string().min(1).max(80).optional(), model: z.string().min(1).max(160).optional(),
  promptVersion: z.string().min(1).max(80).optional(),
}).strict();
export const externalControllerResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("planned"), controller: externalControllerIdentitySchema,
    interactionMode: correctionPlanInteractionModeSchema.default("auto"),
    proposedOutput: z.record(z.string(), z.unknown()).default({}),
    operations: z.array(wizardCorrectionOperationSchema).min(1).max(100), continueOnError: z.boolean().default(false),
  }).strict(),
  z.object({
    status: z.literal("no_action"), controller: externalControllerIdentitySchema,
    interactionMode: correctionPlanInteractionModeSchema.default("auto"),
    proposedOutput: z.record(z.string(), z.unknown()).default({}), reason: z.string().min(1).max(2000),
    operations: z.array(wizardCorrectionOperationSchema).max(0).default([]),
  }).strict(),
]);
export const localMlControllerResponseSchema = externalControllerResponseSchema;

const labelEditOperationSchema = z.object({
  operationId: z.string().regex(/^op-[1-9][0-9]?$/),
  type: z.enum(["accept", "reject", "edit", "merge"]),
  inputIds: z.array(z.string().min(1).max(300)).min(1).max(20),
  adjustment: z.object({
    direction: z.enum(["expand", "contract"]),
    edge: z.enum(["all", "top", "right", "bottom", "left"]),
    strength: z.enum(["small", "medium"]),
  }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (value.type === "merge" && value.inputIds.length < 2) context.addIssue({ code: "custom", path: ["inputIds"], message: "merge requires at least two inputs" });
  if (value.type !== "merge" && value.inputIds.length !== 1) context.addIssue({ code: "custom", path: ["inputIds"], message: `${value.type} requires exactly one input` });
  if (value.type === "edit" && !value.adjustment) context.addIssue({ code: "custom", path: ["adjustment"], message: "edit requires a bounded adjustment" });
  if (value.type !== "edit" && value.adjustment) context.addIssue({ code: "custom", path: ["adjustment"], message: `${value.type} cannot include an adjustment` });
});
export type LabelEditOperation = z.infer<typeof labelEditOperationSchema>;

const ocrOperationBase = {
  operationId: z.string().regex(/^op-[1-9][0-9]?$/),
  inputIds: z.array(z.string().min(1).max(300)).max(20),
};
const normalizedOcrEditGeometrySchema = z.object({
  type: z.literal("quad"),
  points: z.tuple([
    z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
    z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
    z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
    z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict(),
  ]),
  bbox: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict(),
}).strict().superRefine((value, context) => {
  if (!isValidConvexQuad(value.points)) {
    context.addIssue({ code: "custom", path: ["points"], message: "OCR create quad must be convex and non-self-intersecting" });
    return;
  }
  const bbox = bboxFromGeometry(value as QuadGeometry);
  if ([bbox.x - value.bbox.x, bbox.y - value.bbox.y, bbox.width - value.bbox.width, bbox.height - value.bbox.height].some((delta) => Math.abs(delta) > 1e-6)) {
    context.addIssue({ code: "custom", path: ["bbox"], message: "OCR create bbox must enclose the quad points" });
  }
});
const ocrEditOperationSchema = z.object({
  ...ocrOperationBase,
  type: z.enum(["approve_region", "approve_text", "reject", "edit_region", "edit_text", "merge_region", "split_region", "create_region", "compose_string", "decompose_string", "set_status"]),
  adjustment: z.object({ direction: z.enum(["expand", "contract"]), edge: z.enum(["all", "top", "right", "bottom", "left"]), strength: z.enum(["small", "medium"]) }).strict().nullable(),
  geometry: normalizedOcrEditGeometrySchema.nullable(),
  text: z.string().max(4000).nullable(),
  transcriptionStatus: z.enum(["verified", "partial", "unreadable"]).nullable(),
  split: z.object({
    axis: z.enum(["horizontal", "vertical"]),
    fractions: z.array(z.number().min(0.1).max(0.9)).min(1).max(3),
  }).strict().nullable().optional(),
  composition: z.object({
    text: z.string().max(4000).nullable(),
    transcriptionStatus: z.enum(["verified", "partial", "unreadable"]),
    sortOrder: z.number().int().min(0).max(999),
  }).strict().nullable().optional(),
}).strict().superRefine((value, context) => {
  const validCardinality = value.type === "merge_region" || value.type === "compose_string" ? value.inputIds.length >= 2 : value.type === "create_region" ? value.inputIds.length === 0 : value.inputIds.length === 1;
  if (!validCardinality) context.addIssue({ code: "custom", path: ["inputIds"], message: `${value.type} has invalid input cardinality` });
  if (value.type === "edit_region" ? !value.adjustment : value.adjustment !== null) context.addIssue({ code: "custom", path: ["adjustment"], message: `${value.type} has invalid adjustment` });
  if (value.type === "create_region" ? !value.geometry : value.geometry !== null) context.addIssue({ code: "custom", path: ["geometry"], message: `${value.type} has invalid geometry` });
  if (value.type === "split_region") {
    if (!value.split) context.addIssue({ code: "custom", path: ["split"], message: "split_region requires split axis and fractions" });
    else if (value.split.fractions.some((fraction, index) => index > 0 && fraction <= value.split!.fractions[index - 1]!)) context.addIssue({ code: "custom", path: ["split", "fractions"], message: "split fractions must be strictly increasing" });
  } else if (value.split != null) context.addIssue({ code: "custom", path: ["split"], message: `${value.type} cannot contain split parameters` });
  if (value.type === "compose_string") {
    if (!value.composition) context.addIssue({ code: "custom", path: ["composition"], message: "compose_string requires composition metadata" });
    else {
      if ((value.composition.transcriptionStatus === "verified" || value.composition.transcriptionStatus === "partial") && !value.composition.text?.trim()) context.addIssue({ code: "custom", path: ["composition", "text"], message: `${value.composition.transcriptionStatus} composition text cannot be empty` });
      if (value.composition.transcriptionStatus === "unreadable" && value.composition.text !== null) context.addIssue({ code: "custom", path: ["composition", "text"], message: "Unreadable composition text must be null" });
    }
  } else if (value.composition != null) context.addIssue({ code: "custom", path: ["composition"], message: `${value.type} cannot contain composition metadata` });
  if (value.type === "edit_text" || value.type === "create_region") {
    if (!value.transcriptionStatus) context.addIssue({ code: "custom", path: ["transcriptionStatus"], message: "edit_text requires transcriptionStatus" });
    if ((value.transcriptionStatus === "verified" || value.transcriptionStatus === "partial") && !value.text?.trim()) context.addIssue({ code: "custom", path: ["text"], message: `${value.transcriptionStatus} OCR text cannot be empty` });
    if (value.transcriptionStatus === "unreadable" && value.text !== null) context.addIssue({ code: "custom", path: ["text"], message: "Unreadable OCR text must be null" });
  } else if (value.text !== null) context.addIssue({ code: "custom", path: ["text"], message: `${value.type} cannot contain text` });
  if (value.type === "set_status" ? !value.transcriptionStatus : value.type !== "edit_text" && value.type !== "create_region" && value.transcriptionStatus !== null) context.addIssue({ code: "custom", path: ["transcriptionStatus"], message: `${value.type} has invalid transcriptionStatus` });
});
export type OcrEditOperation = z.infer<typeof ocrEditOperationSchema>;
export type StageEditOperation = LabelEditOperation | OcrEditOperation;

export const stageLlmDecisionResponseSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("decided"),
  controller: externalControllerIdentitySchema,
  adapter: z.object({ id: z.string().min(1).max(120), stage: automationStageSchema, provider: z.string().min(1).max(80) }).strict(),
  observationId: z.string().uuid(),
  decision: z.object({
    schemaVersion: z.literal(1), stage: automationStageSchema,
    action: z.enum(["accept", "review", "rerun", "human_required"]),
    candidateId: z.string().min(1).max(300).nullable(),
    confidence: z.number().min(0).max(1),
    flags: z.array(z.enum([
      "clear_best_candidate", "ambiguous_candidates", "no_valid_candidate",
      "crop_clipped", "wrong_region", "low_visual_confidence", "human_judgment_required",
      "cuts_target", "includes_excess_background", "wrong_object", "multiple_targets", "geometry_mismatch", "low_visual_certainty",
      "wrong_transcription", "partial_text", "region_misaligned", "unreadable", "language_mismatch",
      "excessive_noise", "missing_regions", "overmerged", "oversmoothed", "palette_mismatch", "inconsistent_summary",
    ])).max(20),
    paramsPatch: z.object({
      adjustment: z.enum([
        "expand_region", "tighten_region", "increase_background_tolerance", "decrease_background_tolerance",
        "include_more_foreground", "include_less_foreground", "invert_foreground", "merge_fragments", "separate_regions",
        "reduce_noise", "preserve_detail", "increase_palette", "decrease_palette",
      ]),
      strength: z.enum(["small", "medium"]),
    }).strict().nullable(),
    reviews: z.array(z.object({
      id: z.string().min(1).max(300), state: z.enum(["accepted", "rejected"]),
      text: z.string().max(300).nullable(), transcriptionStatus: z.enum(["verified", "partial", "unreadable"]).nullable(),
      type: z.enum(["text", "graphic", "separator", "shape", "unknown"]).nullable(),
      role: z.enum(["brand", "product_name", "variety", "producer", "year", "description", "logo", "signature", "ornament", "separator", "unknown", "other"]).nullable(),
    }).strict()).max(100),
    topologyEdits: z.array(z.object({
      componentId: z.number().int().positive(), destinationElementId: z.string().min(1).max(300).nullable(),
      newGroupKey: z.string().regex(/^group-[1-9][0-9]?$/).nullable(),
    }).strict().superRefine((item, context) => {
      if (Boolean(item.destinationElementId) === Boolean(item.newGroupKey)) context.addIssue({ code: "custom", message: "exactly one topology destination is required" });
    })).max(100),
    // The observation-aware limit is enforced by the workflow/controller. Keep
    // this transport schema wide enough for OCR plans that resolve many regions.
    editOperations: z.array(z.union([labelEditOperationSchema, ocrEditOperationSchema])).max(99).default([]),
  }).strict(),
  providerEvidence: z.object({
    responseId: z.string(), model: z.string(), usage: z.record(z.string(), z.unknown()),
    providerConversationId: z.string().min(1).max(300).nullable().optional(),
    requestId: z.string().min(1).max(300).nullable().optional(),
    latencyMs: z.number().int().nonnegative().nullable().optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.adapter.stage !== value.decision.stage) context.addIssue({ code: "custom", path: ["adapter", "stage"], message: "adapter and decision stage must match" });
  if ((value.decision.action === "accept" || value.decision.action === "review") && !value.decision.candidateId) context.addIssue({ code: "custom", path: ["decision", "candidateId"], message: `${value.decision.action} requires candidateId` });
  if (value.decision.action !== "accept" && value.decision.action !== "review" && value.decision.candidateId) context.addIssue({ code: "custom", path: ["decision", "candidateId"], message: `${value.decision.action} cannot select a candidate` });
  if (value.decision.action === "rerun" && !value.decision.paramsPatch) context.addIssue({ code: "custom", path: ["decision", "paramsPatch"], message: "rerun requires a semantic parameter patch" });
  if (value.decision.action !== "rerun" && value.decision.paramsPatch) context.addIssue({ code: "custom", path: ["decision", "paramsPatch"], message: `${value.decision.action} cannot include a parameter patch` });
  if (value.decision.action === "review" && !value.decision.reviews.length && !value.decision.topologyEdits.length && !value.decision.editOperations.length) context.addIssue({ code: "custom", path: ["decision", "reviews"], message: "review requires at least one granular, topology or edit operation" });
  if (value.decision.action !== "review" && (value.decision.reviews.length || value.decision.topologyEdits.length || value.decision.editOperations.length)) context.addIssue({ code: "custom", path: ["decision", "reviews"], message: `${value.decision.action} cannot include review operations` });
  if (value.decision.editOperations.length && value.decision.stage !== "label" && value.decision.stage !== "ocr") context.addIssue({ code: "custom", path: ["decision", "editOperations"], message: "Edit Engine operations are supported only on Label and OCR" });
  if (value.decision.stage === "label" && value.decision.editOperations.some((operation) => !["accept", "reject", "edit", "merge"].includes(operation.type))) context.addIssue({ code: "custom", path: ["decision", "editOperations"], message: "Label decision contains an OCR primitive" });
  if (value.decision.stage === "ocr" && value.decision.editOperations.some((operation) => ["accept", "edit", "merge"].includes(operation.type))) context.addIssue({ code: "custom", path: ["decision", "editOperations"], message: "OCR decision contains a Label primitive" });
});
export type StageLlmDecisionResponse = z.infer<typeof stageLlmDecisionResponseSchema>;

export const wizardManualOcrCreateSchema = z.object({
  annotation: manualOcrDedupePreflightSchema,
  duplicateDecision: z.enum(["create", "merge"]).optional(),
  mergeTargetId: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.duplicateDecision === "merge" && !value.mergeTargetId) {
    context.addIssue({ code: "custom", path: ["mergeTargetId"], message: "Merge decision requires an existing OCR target" });
  }
  if (value.duplicateDecision !== "merge" && value.mergeTargetId) {
    context.addIssue({ code: "custom", path: ["mergeTargetId"], message: "Only merge decision may specify an OCR target" });
  }
});
