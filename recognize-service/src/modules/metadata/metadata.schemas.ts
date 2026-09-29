import { z } from "zod";
import { bboxFromGeometry, isValidConvexQuad, type QuadGeometry } from "../../shared/quadGeometry.js";

export const sourceNameSchema = z.enum(["svoe_vino", "roskachestvo"]);

export const annotationTrackQuerySchema = z.object({
  track: z.string().uuid(),
  label: z.string().uuid().optional(),
});

export const createAnnotationTrackSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  sourceAssetRef: z.string().trim().min(1).max(2000).optional(),
  targetRegion: z.record(z.string(), z.unknown()).optional(),
});

export const listMetadataQuerySchema = z.object({
  source: sourceNameSchema.optional(),
  status: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const patchMetadataSchema = z.object({
  aliases: z.array(z.string()).optional(),
  normalizedTokens: z.array(z.string()).optional(),
  visualFeatures: z.record(z.string(), z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  status: z.string().optional(),
});

export const manualAnnotationsSchema = z.object({
  schemaVersion: z.literal(1),
  sourceHash: z.string().optional().default(""),
  basedOnPipelineVersion: z.string().optional().default("unknown"),
  regions: z.array(z.record(z.string(), z.unknown())).default([]),
  palettes: z.array(z.record(z.string(), z.unknown())).default([]),
  colorSamples: z.array(z.record(z.string(), z.unknown())).default([]),
  decisions: z.array(z.record(z.string(), z.unknown())).default([]),
  annotationVersion: z.number().int().positive().optional(),
});

const bboxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const labelGeometrySchema = z.object({
  type: z.literal("quad"),
  points: z.tuple([
    z.object({ x: z.number().min(0), y: z.number().min(0) }),
    z.object({ x: z.number().min(0), y: z.number().min(0) }),
    z.object({ x: z.number().min(0), y: z.number().min(0) }),
    z.object({ x: z.number().min(0), y: z.number().min(0) }),
  ]),
  bbox: bboxSchema,
}).superRefine(validateQuadGeometry);

const normalizedLabelPointSchema = z.object({ x: z.number().min(-0.25).max(1.25), y: z.number().min(-0.25).max(1.25) }).strict();
const cylindricalGuidesSchema = z.object({
  centerLine: z.array(normalizedLabelPointSchema).min(2),
  horizontalGuides: z.array(z.array(normalizedLabelPointSchema).min(2)).min(2),
  leftBoundary: z.array(normalizedLabelPointSchema).min(2),
  rightBoundary: z.array(normalizedLabelPointSchema).min(2),
}).strict();
const cylindricalTransformSchema = z.object({
  schemaVersion: z.literal(1), model: z.literal("guided-grid-v1"), coordinateSpace: z.literal("label-perspective-normalized"),
  columns: z.array(z.number().min(0).max(1)).min(2),
  rows: z.array(z.object({ v: z.number().min(0).max(1), points: z.array(normalizedLabelPointSchema).min(2) }).strict()).min(2),
  curvature: z.number().min(0), surfaceWidth: z.number().min(0),
}).strict();
const cylindricalControlsSchema = z.object({ signedCurvature: z.number().min(-1.5).max(1.5), horizontalScale: z.number().min(-1.5).max(1.5) }).strict();
export const labelRectificationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("perspective"), transform: z.object({ schemaVersion: z.literal(1), model: z.literal("quad-homography-v1") }).strict() }).strict(),
  z.object({ type: z.literal("guided-cylindrical"), guides: cylindricalGuidesSchema, controls: cylindricalControlsSchema.optional(), transform: cylindricalTransformSchema }).strict(),
]);

export const polygonGeometrySchema = z.object({
  type: z.literal("polygon"),
  points: z.array(z.object({ x: z.number().min(0), y: z.number().min(0) })).min(3),
  bbox: bboxSchema,
});

export const regionGeometrySchema = z.union([labelGeometrySchema, polygonGeometrySchema]);

export const annotationHelperRunSchema = z.object({
  helperId: z.string().trim().min(1).max(200),
  helperVersion: z.string().trim().min(1).max(200).optional(),
  initialConfig: z.record(z.string(), z.unknown()).optional(),
  finalConfig: z.record(z.string(), z.unknown()).optional(),
  candidates: z.array(z.object({
    id: z.string().trim().min(1).max(300),
    payload: z.record(z.string(), z.unknown()),
    score: z.number().nullable().optional(),
  })).optional(),
  selectedCandidateId: z.string().trim().min(1).max(300).nullable().optional(),
  reviewMode: z.enum(["accepted", "edited", "manual"]),
}).superRefine((run, context) => {
  if (run.reviewMode === "manual" && run.selectedCandidateId) {
    context.addIssue({ code: "custom", path: ["selectedCandidateId"], message: "Manual result cannot select a helper candidate" });
  }
  if (run.selectedCandidateId && !(run.candidates ?? []).some((candidate) => candidate.id === run.selectedCandidateId)) {
    context.addIssue({ code: "custom", path: ["selectedCandidateId"], message: "Selected candidate must belong to this operation" });
  }
});

export const createGraphPackageSchema = z.object({
  geometry: regionGeometrySchema.nullable().optional(),
  packageType: z.object({
    value: z.enum(["bottle", "tube", "box", "other", "unknown"]),
    status: z.enum(["unreviewed", "reviewed"]),
    source: z.enum(["human", "auto"]),
  }).strict().optional(),
  sourceAssetRef: z.string().trim().min(1).max(2000).optional(),
  operation: annotationHelperRunSchema,
});

export const createGraphLabelSchema = z.object({ geometry: regionGeometrySchema, rectification: labelRectificationSchema.nullable().optional(), operation: annotationHelperRunSchema });

export const reviewGraphLabelCandidatesSchema = z.object({
  operation: z.object({
    helperId: z.string().trim().min(1).max(200),
    helperVersion: z.string().trim().min(1).max(200).optional(),
    initialConfig: z.record(z.string(), z.unknown()).optional(),
    finalConfig: z.record(z.string(), z.unknown()).optional(),
    candidates: z.array(z.object({
      id: z.string().trim().min(1).max(300),
      payload: z.record(z.string(), z.unknown()),
      score: z.number().nullable().optional(),
    })).min(1),
    reviewMode: z.enum(["accepted", "edited"]),
  }),
  reviews: z.array(z.object({
    candidateId: z.string().trim().min(1).max(300),
    state: z.enum(["accepted", "edited", "rejected", "merged"]),
    sourceOperationId: z.string().trim().min(1).max(300).optional(),
    geometry: regionGeometrySchema.optional(),
    resultEntityId: z.string().uuid().nullable().optional(),
    mergeGroupId: z.string().trim().min(1).max(120).optional(),
  }).superRefine((review, context) => {
    if ((review.state === "accepted" || review.state === "edited") && !review.geometry) {
      context.addIssue({ code: "custom", path: ["geometry"], message: `${review.state} Label candidate requires reviewed geometry` });
    }
    if (review.state === "merged" && !review.resultEntityId) {
      context.addIssue({ code: "custom", path: ["resultEntityId"], message: "Merged Label candidate requires an existing Label id" });
    }
    if (review.mergeGroupId && review.state !== "accepted" && review.state !== "edited") {
      context.addIssue({ code: "custom", path: ["mergeGroupId"], message: "Only accepted or edited Label candidates may join a merge group" });
    }
  })).min(1),
  mergeReviews: z.array(z.object({
    candidateIds: z.array(z.string().trim().min(1).max(300)).min(2),
    geometry: regionGeometrySchema,
  }).superRefine((review, context) => {
    if (new Set(review.candidateIds).size !== review.candidateIds.length) {
      context.addIssue({ code: "custom", path: ["candidateIds"], message: "A merged ROI may reference each candidate only once" });
    }
  })).optional(),
}).superRefine((value, context) => {
  const candidateIds = (value.operation.candidates ?? []).map((candidate) => candidate.id);
  const reviewIds = value.reviews.map((review) => review.candidateId);
  if (new Set(reviewIds).size !== reviewIds.length) context.addIssue({ code: "custom", path: ["reviews"], message: "Each Label candidate must be reviewed once" });
  if (candidateIds.length !== reviewIds.length || candidateIds.some((id) => !reviewIds.includes(id))) {
    context.addIssue({ code: "custom", path: ["reviews"], message: "Every helper candidate must have a review" });
  }
  for (const [index, mergeReview] of (value.mergeReviews ?? []).entries()) {
    if (mergeReview.candidateIds.some((id) => !candidateIds.includes(id))) {
      context.addIssue({ code: "custom", path: ["mergeReviews", index, "candidateIds"], message: "Merged ROI references an unknown helper candidate" });
    }
  }
});

export const ocrCoordinateSpaceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("label-rectified"),
    units: z.literal("normalized"),
    labelId: z.string().uuid(),
    cropRevision: z.number().int().positive().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  }).strict(),
  z.object({ type: z.literal("unavailable"), reason: z.string().trim().min(1).max(500) }).strict(),
]);

const canonicalOcrTranscriptionSchema = z.object({
  // Keep the null branch first. Fastify's default Ajv coercion otherwise tries
  // the string branch first and mutates JSON `null` into an empty string before
  // this Zod schema performs the status-dependent invariant check.
  text: z.union([z.null(), z.string()]),
  status: z.enum(["verified", "partial", "unreadable"]),
}).strict().superRefine((value, context) => {
  if ((value.status === "verified" || value.status === "partial") && !value.text?.trim()) context.addIssue({ code: "custom", path: ["text"], message: `${value.status} transcription requires text` });
  if (value.status === "unreadable" && value.text !== null) context.addIssue({ code: "custom", path: ["text"], message: "Unreadable transcription must be null" });
});
const canonicalOcrLayoutSchema = z.object({
  type: z.enum(["word", "string"]),
  flow: z.enum(["linear", "curved"]),
  baselineAngleDeg: z.number().min(-180).max(180),
  baseline: z.array(z.object({ x: z.number(), y: z.number() }).strict()).min(2).nullable(),
  characterOrientation: z.enum(["aligned", "tangent-aligned", "upright", "mixed"]),
}).strict().superRefine((value, context) => {
  if (value.flow === "linear" && value.baseline !== null) context.addIssue({ code: "custom", path: ["baseline"], message: "Linear text does not persist a curved baseline" });
  if (value.flow === "linear" && value.characterOrientation === "tangent-aligned") context.addIssue({ code: "custom", path: ["characterOrientation"], message: "Linear text cannot use tangent-aligned glyphs" });
  if (value.flow === "curved" && value.baseline === null) context.addIssue({ code: "custom", path: ["baseline"], message: "Curved text requires a baseline path" });
  if (value.flow === "curved" && value.characterOrientation === "aligned") context.addIssue({ code: "custom", path: ["characterOrientation"], message: "Curved text uses tangent-aligned, upright or mixed glyphs" });
});

export const canonicalOcrRectificationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rotation"), angleDeg: z.number().min(-180).max(180) }).strict(),
  z.object({ type: z.literal("affine"), matrix: z.array(z.number()).length(6) }).strict(),
  z.object({ type: z.literal("perspective"), homography: z.array(z.number()).length(9) }).strict(),
  z.object({ type: z.literal("curved"), path: z.array(z.object({ x: z.number(), y: z.number() }).strict()).min(2), params: z.record(z.string(), z.number()).optional() }).strict(),
]);

const graphEntityRectificationEnvelopeSchema = z.record(z.string(), z.unknown()) as unknown as z.ZodType<
  z.infer<typeof canonicalOcrRectificationSchema> | z.infer<typeof labelRectificationSchema>
>;

export const createGraphOcrSchema = z.object({
  geometry: labelGeometrySchema,
  coordinateSpace: ocrCoordinateSpaceSchema,
  regionStatus: z.enum(["reviewed", "rejected"]),
  transcription: canonicalOcrTranscriptionSchema,
  layout: canonicalOcrLayoutSchema,
  rectification: canonicalOcrRectificationSchema.nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().optional(),
  operation: annotationHelperRunSchema,
});

export const runAutoOcrSchema = z.object({
  scope: z.object({ type: z.literal("label"), id: z.string().uuid() }).strict(),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const runLabelRectificationSchema = z.object({
  scope: z.object({ type: z.literal("label"), id: z.string().uuid() }).strict(),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const runPackageDetectionSchema = z.object({
  scope: z.object({ type: z.literal("package"), id: z.string().uuid() }).strict(),
  config: z.object({
    processingMode: z.enum(["preview", "final"]).optional(),
    previewMaxSize: z.number().int().min(256).max(960).optional(),
    paddingPercent: z.number().min(2).max(20).optional(),
    silhouetteThreshold: z.number().min(2).max(80).optional(),
    connectivity: z.union([z.literal(4), z.literal(8)]).optional(),
    simplifyTolerance: z.number().min(0.5).max(8).optional(),
    canny: z.object({ blurKernel: z.union([z.literal(3), z.literal(5)]).optional(), low: z.number().int().min(1).max(400).optional(), high: z.number().int().min(2).max(800).optional() }).optional(),
    morphology: z.object({ closeKernel: z.union([z.literal(0), z.literal(3), z.literal(5), z.literal(7)]).optional(), iterations: z.number().int().min(1).max(2).optional() }).optional(),
  }).default({}),
});

export const manualOcrDedupePreflightSchema = z.object({
  parent: z.object({ type: z.literal("label"), id: z.string().uuid() }).strict(),
  geometry: labelGeometrySchema,
  coordinateSpace: ocrCoordinateSpaceSchema,
  regionStatus: z.enum(["reviewed", "rejected"]),
  transcription: canonicalOcrTranscriptionSchema,
  layout: canonicalOcrLayoutSchema,
  rectification: canonicalOcrRectificationSchema.nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const reparentGraphOcrSchema = z.object({
  target: z.object({ type: z.literal("label"), id: z.string().uuid() }).strict(),
  operation: annotationHelperRunSchema,
});

const autoOcrFinalParentSchema = z.object({
  type: z.literal("label"), packageId: z.string().uuid(), labelId: z.string().uuid(),
}).strict();

export const reviewAutoOcrSchema = z.object({
  operationId: z.string().uuid(),
  reviews: z.array(z.object({
    candidateId: z.string().trim().min(1).max(300),
    state: z.enum(["accepted", "edited", "rejected", "merged"]),
    sourceOperationId: z.string().trim().min(1).max(300).optional(),
    mergeGroupId: z.string().trim().min(1).max(200).optional(),
    resultEntityId: z.string().uuid().nullable().optional(),
    finalParent: autoOcrFinalParentSchema.nullable().optional(),
    geometry: labelGeometrySchema.optional(),
    regionStatus: z.enum(["reviewed", "rejected"]).optional(),
    transcription: canonicalOcrTranscriptionSchema.optional(),
    layout: canonicalOcrLayoutSchema.optional(),
    rectification: canonicalOcrRectificationSchema.nullable().optional(),
    splitOutputs: z.array(z.object({
      geometry: labelGeometrySchema,
      regionStatus: z.literal("reviewed").default("reviewed"),
      transcription: canonicalOcrTranscriptionSchema,
      layout: canonicalOcrLayoutSchema,
      rectification: canonicalOcrRectificationSchema.nullable().default(null),
      confidence: z.number().min(0).max(1).nullable().default(null),
      sourceOperationId: z.string().min(1).max(300),
    }).strict()).min(2).max(4).optional(),
  }).superRefine((review, context) => {
    if ((review.state === "accepted" || review.state === "edited") && !review.finalParent) context.addIssue({ code: "custom", path: ["finalParent"], message: "Accepted/edited candidate requires final parent" });
    if ((review.state === "rejected" || review.state === "merged") && review.finalParent) context.addIssue({ code: "custom", path: ["finalParent"], message: "Rejected/merged candidate cannot change canonical parent" });
    if (review.state === "merged" && !review.resultEntityId) context.addIssue({ code: "custom", path: ["resultEntityId"], message: "Merged candidate requires target OCR entity" });
    if (review.state !== "merged" && review.resultEntityId) context.addIssue({ code: "custom", path: ["resultEntityId"], message: "Only merged candidate may reference an existing OCR entity" });
    if (review.state === "merged" && (review.geometry !== undefined || review.transcription !== undefined || review.regionStatus !== undefined || review.layout !== undefined || review.rectification !== undefined)) context.addIssue({ code: "custom", message: "Merge cannot mutate canonical OCR geometry, transcription, layout, rectification or region status" });
    if (review.mergeGroupId && review.state !== "accepted" && review.state !== "edited") context.addIssue({ code: "custom", path: ["mergeGroupId"], message: "Physical merge groups require accepted or edited candidates" });
    if (review.splitOutputs && review.state !== "edited") context.addIssue({ code: "custom", path: ["splitOutputs"], message: "Physical split outputs require an edited candidate" });
    if (review.splitOutputs && (review.geometry !== undefined || review.transcription !== undefined)) context.addIssue({ code: "custom", path: ["splitOutputs"], message: "Split outputs replace singular reviewed geometry and transcription" });
  })).min(1).max(1000),
  compositions: z.array(z.object({
    sourceOperationId: z.string().trim().min(1).max(300),
    memberSourceOperationIds: z.array(z.string().trim().min(1).max(300)).min(2).max(100),
    text: z.string().max(4000).nullable(),
    transcriptionStatus: z.enum(["verified", "partial", "unreadable"]),
    sortOrder: z.number().int().min(0).max(999),
  }).strict().superRefine((composition, context) => {
    if (new Set(composition.memberSourceOperationIds).size !== composition.memberSourceOperationIds.length) context.addIssue({ code: "custom", path: ["memberSourceOperationIds"], message: "Composition members must be unique" });
    if ((composition.transcriptionStatus === "verified" || composition.transcriptionStatus === "partial") && !composition.text?.trim()) context.addIssue({ code: "custom", path: ["text"], message: `${composition.transcriptionStatus} composition requires text` });
    if (composition.transcriptionStatus === "unreadable" && composition.text !== null) context.addIssue({ code: "custom", path: ["text"], message: "Unreadable composition must have null text" });
  })).max(100).default([]),
  decomposeCompositionIds: z.array(z.string().uuid()).max(100).default([]),
}).superRefine((value, context) => {
  const counts = new Map<string, number>();
  for (const review of value.reviews) if (review.mergeGroupId) counts.set(review.mergeGroupId, (counts.get(review.mergeGroupId) ?? 0) + 1);
  for (const [groupId, count] of counts) if (count < 2) context.addIssue({ code: "custom", path: ["reviews"], message: `OCR merge group ${groupId} requires at least two candidates` });
  const compositionIds = value.compositions.map((composition) => composition.sourceOperationId);
  if (new Set(compositionIds).size !== compositionIds.length) context.addIssue({ code: "custom", path: ["compositions"], message: "Composition source operation IDs must be unique" });
  if (new Set(value.decomposeCompositionIds).size !== value.decomposeCompositionIds.length) context.addIssue({ code: "custom", path: ["decomposeCompositionIds"], message: "Composition removals must be unique" });
});

const humanOcrEditOperationSchema = z.object({
  operationId: z.string().trim().min(1).max(300),
  type: z.enum(["approve_region", "approve_text", "reject", "edit_region", "edit_text", "merge_region", "split_region", "compose_string", "decompose_string"]),
  inputIds: z.array(z.string().trim().min(1).max(300)).max(100),
  adjustment: z.object({ direction: z.enum(["expand", "contract"]), edge: z.enum(["all", "top", "right", "bottom", "left"]), strength: z.enum(["small", "medium"]) }).strict().nullable().default(null),
  geometry: labelGeometrySchema.nullable().default(null),
  layout: canonicalOcrLayoutSchema.nullable().default(null),
  rectification: canonicalOcrRectificationSchema.nullable().default(null),
  text: z.string().max(4000).nullable().default(null),
  transcriptionStatus: z.enum(["verified", "partial", "unreadable"]).nullable().default(null),
  split: z.object({ axis: z.enum(["horizontal", "vertical"]), fractions: z.array(z.number().min(.1).max(.9)).min(1).max(3) }).strict().nullable().default(null),
  composition: z.object({ text: z.string().max(4000).nullable(), transcriptionStatus: z.enum(["verified", "partial", "unreadable"]), sortOrder: z.number().int().min(0).max(999) }).strict().nullable().default(null),
}).strict().superRefine((operation, context) => {
  const multiInput = operation.type === "merge_region" || operation.type === "compose_string";
  const expectedInputs = operation.type === "decompose_string" || operation.type === "approve_region" || operation.type === "approve_text" || operation.type === "reject" || operation.type === "edit_region" || operation.type === "edit_text" || operation.type === "split_region" ? 1 : null;
  if ((multiInput && operation.inputIds.length < 2) || (expectedInputs !== null && operation.inputIds.length !== expectedInputs)) context.addIssue({ code: "custom", path: ["inputIds"], message: `${operation.type} has invalid input cardinality` });
  if (operation.type === "edit_region") {
    if ((operation.adjustment === null) === (operation.geometry === null)) context.addIssue({ code: "custom", message: "edit_region requires exactly one bounded adjustment or reviewed geometry" });
  } else if (operation.adjustment !== null || operation.geometry !== null || operation.layout !== null || operation.rectification !== null) context.addIssue({ code: "custom", message: `${operation.type} cannot contain region edit data` });
  if (operation.type === "edit_text") {
    if (!operation.transcriptionStatus) context.addIssue({ code: "custom", path: ["transcriptionStatus"], message: "edit_text requires transcriptionStatus" });
    if (operation.transcriptionStatus !== "unreadable" && !operation.text?.trim()) context.addIssue({ code: "custom", path: ["text"], message: "Readable OCR text cannot be empty" });
    if (operation.transcriptionStatus === "unreadable" && operation.text !== null) context.addIssue({ code: "custom", path: ["text"], message: "Unreadable OCR text must be null" });
  } else if (operation.text !== null || operation.transcriptionStatus !== null) context.addIssue({ code: "custom", message: `${operation.type} cannot contain transcription edit data` });
  if (operation.type === "split_region") {
    if (!operation.split) context.addIssue({ code: "custom", path: ["split"], message: "split_region requires split parameters" });
  } else if (operation.split !== null) context.addIssue({ code: "custom", path: ["split"], message: `${operation.type} cannot contain split parameters` });
  if (operation.type === "compose_string") {
    if (!operation.composition) context.addIssue({ code: "custom", path: ["composition"], message: "compose_string requires composition metadata" });
  } else if (operation.composition !== null) context.addIssue({ code: "custom", path: ["composition"], message: `${operation.type} cannot contain composition metadata` });
});

export const reviewAutoOcrActionsSchema = z.object({
  operationId: z.string().uuid(),
  editOperations: z.array(humanOcrEditOperationSchema).max(4000),
  reuseExisting: z.array(z.object({ candidateId: z.string().trim().min(1).max(300), resultEntityId: z.string().uuid() }).strict()).max(1000).default([]),
}).strict().superRefine((value, context) => {
  const operationIds = value.editOperations.map((operation) => operation.operationId);
  if (!operationIds.length && !value.reuseExisting.length) context.addIssue({ code: "custom", path: ["editOperations"], message: "OCR review requires operations or canonical reuse decisions" });
  if (new Set(operationIds).size !== operationIds.length) context.addIssue({ code: "custom", path: ["editOperations"], message: "Edit Engine operation IDs must be unique" });
  const reusedCandidates = value.reuseExisting.map((item) => item.candidateId);
  if (new Set(reusedCandidates).size !== reusedCandidates.length) context.addIssue({ code: "custom", path: ["reuseExisting"], message: "Each candidate may be reused once" });
});

export const createGraphMetaSchema = z.object({
  targetType: z.enum(["item", "package", "label", "ocr"]),
  targetId: z.string().uuid().nullable().optional(),
  note: z.string().max(10000).default(""),
  tags: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  source: z.enum(["human", "auto"]).optional(),
  operation: annotationHelperRunSchema,
});

export const updateGraphEntitySchema = z.object({
  geometry: regionGeometrySchema.nullable().optional(),
  packageType: z.object({
    value: z.enum(["bottle", "tube", "box", "other", "unknown"]),
    status: z.enum(["unreviewed", "reviewed"]),
    source: z.enum(["human", "auto"]),
  }).strict().optional(),
  visualRegionKind: z.object({
    value: z.enum(["physical-label", "direct-print", "text-only", "graphic-only", "mixed", "other", "unknown"]),
    status: z.enum(["unreviewed", "reviewed"]),
  }).strict().optional(),
  sourceAssetRef: z.string().trim().min(1).max(2000).nullable().optional(),
  status: z.enum(["draft", "reviewed"]).optional(),
  regionStatus: z.enum(["reviewed", "rejected"]).optional(),
  transcription: canonicalOcrTranscriptionSchema.optional(),
  layout: canonicalOcrLayoutSchema.optional(),
  // The generic PATCH route serves both Label surface rectification and OCR-local
  // rectification. A nested strict union is unsafe in Fastify/Ajv with
  // removeAdditional: the first failed branch can strip fields needed by the
  // second branch. The route performs exact entity-specific validation after
  // this non-mutating envelope check.
  rectification: graphEntityRectificationEnvelopeSchema.nullable().optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  note: z.string().max(10000).optional(),
  tags: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  operation: annotationHelperRunSchema,
}).superRefine((value, context) => {
  const editableKeys = ["geometry", "packageType", "visualRegionKind", "sourceAssetRef", "status", "regionStatus", "transcription", "layout", "rectification", "confidence", "note", "tags"] as const;
  if (!editableKeys.some((key) => value[key] !== undefined)) {
    context.addIssue({ code: "custom", message: "At least one entity field must be changed" });
  }
});

export const graphEntityTypeSchema = z.enum(["package", "label", "ocr", "meta"]);

type ParsedGraphEntityUpdate = Omit<z.infer<typeof updateGraphEntitySchema>, "rectification"> & {
  rectification?: z.infer<typeof canonicalOcrRectificationSchema> | z.infer<typeof labelRectificationSchema> | null;
};

export function parseGraphEntityUpdate(entityType: z.infer<typeof graphEntityTypeSchema>, input: unknown): ParsedGraphEntityUpdate {
  const parsed = updateGraphEntitySchema.parse(input);
  if (parsed.rectification === undefined) return { ...parsed, rectification: undefined };
  if (entityType === "label") return { ...parsed, rectification: labelRectificationSchema.nullable().parse(parsed.rectification) };
  if (entityType === "ocr") return { ...parsed, rectification: canonicalOcrRectificationSchema.nullable().parse(parsed.rectification) };
  z.never({ error: "Rectification can only be changed on Label or OCR entities" }).parse(parsed.rectification);
  throw new Error("Unreachable rectification validation branch");
}

const labelRoiPredictionSchema = z.object({
  id: z.string().uuid().optional(),
  helperRunId: z.string().uuid().optional(),
  candidateId: z.string().trim().min(1).max(300).optional(),
  roi: bboxSchema,
  geometry: labelGeometrySchema.optional(),
  rectification: labelRectificationSchema.nullable().optional(),
  confidence: z.number().nullable().optional(),
  algorithm: z.object({
    id: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(200).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    defaultParams: z.record(z.string(), z.unknown()).optional(),
  }),
  createdAt: z.string().optional(),
});

export const labelAnnotationSchema = z.object({
  schemaVersion: z.literal(2),
  prediction: labelRoiPredictionSchema.nullable(),
  annotation: z.object({
    id: z.string().uuid().optional(),
    revision: z.number().int().positive().optional(),
    roi: bboxSchema,
    geometry: labelGeometrySchema.optional(),
    rectification: labelRectificationSchema.nullable().optional(),
    reviewedAt: z.string().optional(),
    reviewedBy: z.string().optional(),
  }).nullable(),
  status: z.enum(["unprocessed", "generated", "needs-review", "reviewed", "no-label", "invalid-image"]),
  updatedAt: z.string().optional(),
}).superRefine((state, context) => {
  if (state.status === "reviewed" && !state.annotation) context.addIssue({ code: "custom", path: ["annotation"], message: "Reviewed label ROI requires annotation" });
  if ((state.status === "no-label" || state.status === "invalid-image") && state.annotation) context.addIssue({ code: "custom", path: ["annotation"], message: `${state.status} must not contain a label ROI annotation` });
});

export const detectionProposalSchema = labelRoiPredictionSchema;

export const labelAnalysisReviewSchema = z.object({
  baseRevision: z.number().int().min(0),
  annotationId: z.string().uuid(),
  annotationRevision: z.number().int().positive(),
  jobId: z.string().uuid(),
  configHash: z.string().min(1),
  status: z.enum(["accepted", "needs-tuning", "rejected"]),
  notes: z.string().max(4000).optional(),
  reviewedBy: z.string().trim().min(1).max(200).optional(),
});

const labelAnalysisCvConfigSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().default(3),
  threshold: z.number().int().min(0).max(255),
  invert: z.boolean(),
  maskSize: z.number().int().min(64).max(512),
  maskMode: z.enum(["auto", "candidate", "manual"]).optional(),
  morphologyEnabled: z.boolean().optional(),
  morphologyOperation: z.enum(["open", "close", "dilate", "erode"]).optional(),
  morphologyKernelWidth: z.number().int().min(1).max(21).optional(),
  morphologyKernelHeight: z.number().int().min(1).max(21).optional(),
  morphologyIterations: z.number().int().min(1).max(5).optional(),
  morphologyMode: z.enum(["auto", "manual"]).optional(),
  morphologyPipeline: z.array(z.object({
    operation: z.enum(["open", "close", "dilate", "erode"]),
    kernel: z.tuple([z.number().int().min(1).max(21), z.number().int().min(1).max(21)]),
    iterations: z.number().int().min(1).max(5),
  })).max(3).optional(),
  componentFilterPreset: z.enum(["none", "light", "normal", "strong", "custom"]).optional(),
  componentMode: z.enum(["auto", "candidate", "manual"]).optional(),
  componentConnectivity: z.union([z.literal(4), z.literal(8)]).optional(),
  minComponentAreaRatio: z.number().min(0).max(0.25).optional(),
  maxComponentAreaRatio: z.number().min(0.01).max(1).optional(),
  maxContourPoints: z.number().int().min(32).max(2048),
  contourDetail: z.enum(["precise", "balanced", "simplified", "custom"]).optional(),
  contourSimplifyRatio: z.number().min(0.0005).max(0.05).optional(),
  contourVectorization: z.enum(["polygon", "bezier"]).optional(),
  paletteColors: z.number().int().min(1).max(12),
  paletteMinRatio: z.number().min(0).max(0.5).optional(),
});

export const manualMetadataExportQuerySchema = z.object({
  source: sourceNameSchema.optional(),
});

export const labelAnalysisRunSchema = z.object({
  force: z.boolean().optional().default(false),
  config: labelAnalysisCvConfigSchema.optional(),
});

export const sourceAnalysisRunSchema = z.object({
  verifiedLabel: bboxSchema.optional(),
  packageScope: bboxSchema.optional(),
  visionEvidence: z.object({
    labelMode: z.enum(["off", "score-only", "rerank"]),
  }).optional(),
  labelConfig: z.object({
    schemaVersion: z.literal(1).optional(),
    previewMaxSide: z.number().int().min(256).max(960).optional(),
    chromaTolerance: z.number().min(4).max(80).optional(),
    minimumLightness: z.number().min(40).max(240).optional(),
    minRegionWidthRatio: z.number().min(0.1).max(0.9).optional(),
    maxRegionWidthRatio: z.number().min(0.5).max(1).optional(),
    rowGapRatio: z.number().min(0.01).max(0.3).optional(),
    minimumBandCoverage: z.number().min(0.15).max(0.95).optional(),
    envelopeCoverage: z.number().min(0.2).max(1).optional(),
    envelopeSizeMultiplier: z.number().min(1).max(4).optional(),
  }).optional(),
  outerConfig: z.object({
    processingMode: z.enum(["preview", "final"]).optional(),
    previewMaxSize: z.number().int().min(256).max(960).optional(),
    colorDistanceThreshold: z.number().min(4).max(120).optional(),
    backgroundThreshold: z.number().min(4).max(120).optional(),
    labelExclusionDilate: z.number().int().min(0).max(20).optional(),
    curveSegments: z.number().int().min(6).max(20).optional(),
    paddingPercent: z.number().min(2).max(20).optional(),
    silhouetteThreshold: z.number().min(2).max(80).optional(),
    connectivity: z.union([z.literal(4), z.literal(8)]).optional(),
    simplifyTolerance: z.number().min(0.5).max(8).optional(),
    closeKernel: z.number().int().min(0).max(15).optional(),
    canny: z.object({
      blurKernel: z.union([z.literal(3), z.literal(5)]).optional(),
      low: z.number().int().min(1).max(400).optional(),
      high: z.number().int().min(2).max(800).optional(),
    }).optional(),
    morphology: z.object({
      closeKernel: z.union([z.literal(0), z.literal(3), z.literal(5), z.literal(7)]).optional(),
      iterations: z.number().int().min(1).max(2).optional(),
    }).optional(),
  }).optional(),
});
export const sourceAnalysisStateSchema = z.record(z.string(), z.unknown());

export const deleteMetadataItemsSchema = z.object({
  items: z.array(z.object({
    source: sourceNameSchema,
    sourceItemId: z.string().trim().min(1).max(1000),
  })).min(1).max(500),
});

export const labelCvJobPreviewSchema = z.object({
  stage: z.enum(["mask", "morphology", "components", "elements", "contours", "palette"]).optional().default("palette"),
  config: labelAnalysisCvConfigSchema,
  review: z.object({
    componentDecisions: z.record(z.string(), z.enum(["accepted", "rejected"])).optional(),
    elementsReviewed: z.boolean().optional(),
    elements: z.array(z.object({
      id: z.string().min(1).max(200), sourceComponentIds: z.array(z.number().int().positive()).min(1),
      type: z.enum(["text", "graphic", "separator", "shape", "unknown", "logo", "illustration", "border", "signature", "badge", "other"]),
      role: z.enum(["brand", "product_name", "variety", "producer", "year", "description", "logo", "signature", "ornament", "separator", "unknown", "other"]).optional(),
      status: z.enum(["accepted", "rejected", "unreviewed"]),
      // Legacy element-level OCR link/confidence; normalized into provenance on save.
      textRegionId: z.string().max(200).optional(), text: z.string().max(2000).optional(), confidence: z.number().min(0).max(100).nullable().optional(),
      provenance: z.object({
        source: z.enum(["manual", "ocr", "geometry", "model", "imported"]).optional(),
        // Read compatibility for the short-lived early schema-v4 shape.
        method: z.enum(["manual", "ocr", "geometry", "model"]).optional(),
        confidence: z.number().min(0).max(1).optional(),
        sourceRef: z.object({ kind: z.literal("ocr-region"), id: z.string().min(1).max(200) }).optional(),
        grouping: z.object({
          method: z.enum(["manual", "ocr-overlap", "proximity", "containment", "alignment", "model"]),
          confidence: z.number().min(0).max(1).optional(),
        }).optional(),
      }).refine((value) => Boolean(value.source || value.method), { message: "provenance.source is required" }).optional(),
      // Accepted only while old saved reviews are migrated on their next save.
      groupingMeta: z.object({ method: z.enum(["ocr", "proximity", "geometry", "manual", "model"]), score: z.number().min(0).max(1).optional() }).optional(),
    })).optional(),
  }).optional(),
});

export const labelCvJobCheckpointSchema = labelCvJobPreviewSchema.extend({
  palette: z.array(z.object({
    rgb: z.tuple([
      z.number().int().min(0).max(255),
      z.number().int().min(0).max(255),
      z.number().int().min(0).max(255),
    ]),
    ratio: z.number().min(0).max(1).nullable().optional(),
    source: z.enum(["detected", "eyedropper"]).optional().default("detected"),
  })).max(32).optional(),
});

export const labelCvJobReviewSchema = z.object({
  config: labelCvJobPreviewSchema.shape.config,
  review: labelCvJobPreviewSchema.shape.review,
  palette: z.array(z.object({
    rgb: z.tuple([
      z.number().int().min(0).max(255),
      z.number().int().min(0).max(255),
      z.number().int().min(0).max(255),
    ]),
    ratio: z.number().min(0).max(1).nullable().optional(),
    source: z.enum(["detected", "eyedropper"]).optional().default("detected"),
  })).max(32),
});

export const ocrTextReviewSchema = z.object({
  text: z.string(),
  ocrRunId: z.string().uuid().nullable().optional(),
  sourceKind: z.enum(["manual", "corrected-generated", "accepted-generated"]).optional(),
  status: z.enum(["reviewed", "empty", "rejected"]).optional(),
  reviewedBy: z.string().optional(),
});

const normalizedOcrRegionBboxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine((bbox) => bbox.x + bbox.width <= 1.000001 && bbox.y + bbox.height <= 1.000001, {
    message: "OCR region bbox must stay inside the normalized crop",
  });

const normalizedOcrRegionGeometrySchema = z.object({
  type: z.literal("quad"),
  points: z.tuple([
    z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
    z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
    z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
    z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  ]),
  bbox: normalizedOcrRegionBboxSchema,
}).superRefine(validateQuadGeometry);

export const ocrRegionReviewSchema = z.object({
  baseRevision: z.number().int().min(0),
  ocrRunId: z.string().uuid().nullable().optional(),
  status: z.enum(["draft", "reviewed", "rejected"]).default("reviewed"),
  reviewedBy: z.string().trim().min(1).max(200).optional(),
  regions: z
    .array(
      z.object({
        clientId: z.string().min(1).max(200).optional(),
        sourceRegionIds: z.array(z.string().uuid()).max(100).default([]),
        level: z.enum(["word", "line", "string"]),
        prediction: z.object({
          bbox: normalizedOcrRegionBboxSchema,
          geometry: normalizedOcrRegionGeometrySchema.optional(),
          text: z.string().max(4000).nullable(),
            confidence: z.number().min(0).max(100).nullable().optional(),
            layout: canonicalOcrLayoutSchema.optional(),
            rectification: canonicalOcrRectificationSchema.nullable().optional(),
        }).nullable(),
        annotation: z.object({
          bbox: normalizedOcrRegionBboxSchema,
          geometry: normalizedOcrRegionGeometrySchema.optional(),
          text: z.string().max(4000).nullable(),
          transcriptionStatus: z.enum(["verified", "partial", "unreadable"]),
        }).superRefine((annotation, context) => {
          if (annotation.transcriptionStatus === "verified" && !annotation.text?.trim()) context.addIssue({ code: "custom", path: ["text"], message: "Verified transcription requires text" });
          if (annotation.transcriptionStatus === "unreadable" && annotation.text !== null) context.addIssue({ code: "custom", path: ["text"], message: "Unreadable transcription must be null" });
        }),
        textDirection: z.enum(["right", "left", "down", "up", "mixed"]).default("right"),
        glyphOrientation: z.enum(["upright", "clockwise", "counterclockwise", "upside-down", "mixed"]).default("upright"),
        layout: canonicalOcrLayoutSchema.optional(),
        rectification: canonicalOcrRectificationSchema.nullable().optional(),
        sortOrder: z.number().int().min(0).optional(),
      }),
    )
    .max(1000),
  compositions: z.array(z.object({
    clientId: z.string().min(1).max(200),
    kind: z.literal("string"),
    memberClientIds: z.array(z.string().min(1).max(200)).min(2).max(100)
      .refine((ids) => new Set(ids).size === ids.length, "Composition members must be unique"),
    text: z.string().max(4000).nullable(),
    transcriptionStatus: z.enum(["verified", "partial", "unreadable"]),
    sortOrder: z.number().int().min(0).optional(),
  }).superRefine((composition, context) => {
    if (composition.transcriptionStatus === "verified" && !composition.text?.trim()) context.addIssue({ code: "custom", path: ["text"], message: "Verified string requires text" });
    if (composition.transcriptionStatus === "unreadable" && composition.text !== null) context.addIssue({ code: "custom", path: ["text"], message: "Unreadable string must have null text" });
  })).max(500).default([]),
}).superRefine((review, context) => {
  const regionIds = new Set(review.regions.map((region, index) => region.clientId ?? `region:${index}`));
  for (const [compositionIndex, composition] of review.compositions.entries()) {
    for (const [memberIndex, memberId] of composition.memberClientIds.entries()) {
      if (!regionIds.has(memberId)) context.addIssue({ code: "custom", path: ["compositions", compositionIndex, "memberClientIds", memberIndex], message: "Composition member must reference a reviewed region clientId" });
    }
  }
});

const sourceFieldSchema = z.enum([
  "title", "manufacturer", "category", "region", "year", "barcode",
  "color", "description", "alias", "normalized-token",
]);

export const ocrSourceAssociationReviewSchema = z.object({
  baseRevision: z.number().int().min(0),
  ocrRegionAnnotationSetId: z.string().uuid().nullable().optional(),
  status: z.enum(["draft", "reviewed", "rejected"]).default("reviewed"),
  reviewedBy: z.string().trim().min(1).max(200).optional(),
  associations: z.array(z.object({
    ocrRegionAnnotationId: z.string().uuid().nullable().optional(),
    regionTextSnapshot: z.string().max(4000),
    sourceField: sourceFieldSchema,
    sourceValue: z.string().trim().min(1).max(10000),
    status: z.enum(["reviewed", "rejected"]).default("reviewed"),
    sourceKind: z.enum(["accepted-suggested", "corrected-suggested", "manual"]),
    matchKind: z.enum(["exact", "contains", "token-overlap", "manual"]),
    score: z.number().min(0).max(1).nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })).max(1000),
});

export const catalogIdentityReviewSchema = z.object({
  baseRevision: z.number().int().min(0),
  analysisJobId: z.string().uuid(),
  ocrRegionAnnotationSetId: z.string().uuid().nullable().optional(),
  status: z.enum(["confirmed", "corrected", "no-match", "ambiguous"]),
  selectedSource: sourceNameSchema.nullable().optional(),
  selectedSourceItemId: z.string().trim().min(1).max(1000).nullable().optional(),
  candidateSnapshot: z.record(z.string(), z.unknown()).optional(),
  score: z.number().min(0).max(1).nullable().optional(),
  notes: z.string().max(10000).optional(),
  reviewedBy: z.string().trim().min(1).max(200).optional(),
});

export const aliasReviewSchema = z.object({
  baseRevision: z.number().int().min(0),
  sourceAssociationSetId: z.string().uuid().nullable().optional(),
  status: z.enum(["draft", "reviewed", "rejected"]).default("reviewed"),
  reviewedBy: z.string().trim().min(1).max(200).optional(),
  aliases: z.array(z.object({
    value: z.string().trim().min(1).max(10000),
    aliasType: z.enum(["source-title", "source-field", "ocr-associated", "composite", "manual"]),
    status: z.enum(["reviewed", "rejected"]).default("reviewed"),
    sourceKind: z.enum(["accepted-generated", "corrected-generated", "manual"]),
    score: z.number().min(0).max(1).nullable().optional(),
    sourceAssociationIds: z.array(z.string().uuid()).max(100).default([]),
    components: z.record(z.string(), z.unknown()).optional(),
    sortOrder: z.number().int().min(0).optional(),
  })).max(1000),
});

function validateQuadGeometry(geometry: QuadGeometry, context: z.RefinementCtx) {
  if (!isValidConvexQuad(geometry.points)) {
    context.addIssue({
      code: "custom",
      path: ["points"],
      message: "Quad must be convex, non-self-intersecting, and have four distinct corners",
    });
    return;
  }
  const derived = bboxFromGeometry(geometry);
  const epsilon = 1e-6;
  if (
    Math.abs(derived.x - geometry.bbox.x) > epsilon
    || Math.abs(derived.y - geometry.bbox.y) > epsilon
    || Math.abs(derived.width - geometry.bbox.width) > epsilon
    || Math.abs(derived.height - geometry.bbox.height) > epsilon
  ) {
    context.addIssue({
      code: "custom",
      path: ["bbox"],
      message: "Geometry bbox must be the enclosing bbox derived from quad points",
    });
  }
}
