import type { FastifyInstance, FastifySchema } from "fastify";
import { z } from "zod";
import { getHelperConfigContractForItem } from "../db/helper-config.repository.js";
import { bindAllHelpersToCard, bindHelperToCard, buildHelperConfigContract, helperIdForWizardStage } from "../shared/helperConfigContract.js";
import { buildRouteStageSampleV1 } from "../shared/stageSampleContract.js";
import {
  catalogIdentityReviewSchema,
  createGraphLabelSchema,
  createGraphMetaSchema,
  createGraphOcrSchema,
  createGraphPackageSchema,
  labelAnalysisReviewSchema,
  labelAnalysisRunSchema,
  labelAnnotationSchema,
  labelCvJobCheckpointSchema,
  labelCvJobPreviewSchema,
  labelCvJobReviewSchema,
  ocrRegionReviewSchema,
  ocrSourceAssociationReviewSchema,
  ocrTextReviewSchema,
  reviewAutoOcrSchema,
  reviewGraphLabelCandidatesSchema,
  runAutoOcrSchema,
  runLabelRectificationSchema,
  sourceAnalysisRunSchema,
  sourceAnalysisStateSchema,
  updateGraphEntitySchema,
  manualOcrDedupePreflightSchema,
  reparentGraphOcrSchema,
} from "../modules/metadata/metadata.schemas.js";

type WizardRouteDoc = FastifySchema & {
  "x-wizard-stage": string;
  "x-data-flow": string;
  "x-bff-route": string;
  "x-helper-id": string;
  "x-stage-sample-version": 1;
};

const sourceItemParams = {
  type: "object",
  additionalProperties: false,
  required: ["source", "sourceItemId"],
  properties: {
    source: { type: "string", enum: ["svoe_vino", "roskachestvo"], description: "Catalog source." },
    sourceItemId: { type: "string", minLength: 1, description: "Source catalog item identifier." },
  },
} as const;

const annotationTrackQuery = {
  type: "object",
  additionalProperties: false,
  required: ["track"],
  properties: {
    track: { type: "string", format: "uuid", description: "Stable annotationTrackId. Every wizard read/write is isolated by this track." },
    label: { type: "string", format: "uuid", description: "Optional canonical Label id. CV reads and writes are isolated by this label inside the selected track." },
  },
} as const;

const annotationActorHeaders = {
  type: "object",
  additionalProperties: true,
  properties: {
    "x-auth-role": { type: "string", enum: ["admin", "annotator", "ml-service"], description: "Verified JWT role forwarded by the trusted BFF. Actor type is derived server-side: admin/annotator -> human, ml-service -> ml-agent." },
    "x-auth-subject": { type: "string", maxLength: 80, description: "Verified JWT subject forwarded by the trusted BFF. It becomes the account-scoped execution source." },
    "x-annotation-track-id": { type: "string", format: "uuid", description: "Track mutated by this request. The browser BFF derives it from the track query parameter." },
  },
} as const;

const helperBindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["card", "wizardStage", "helperId", "algorithm", "configSchemaVersion", "config", "role", "provenance", "review", "persisted"],
  properties: {
    card: { type: "object", additionalProperties: false, required: ["source", "sourceItemId"], properties: { source: { type: "string" }, sourceItemId: { type: "string" } } },
    wizardStage: { type: "string", enum: ["label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"] },
    helperId: { type: "string" },
    algorithm: { type: "string" },
    configSchemaVersion: { type: "integer", minimum: 1 },
    config: { type: "object", additionalProperties: true },
    role: { type: "string", enum: ["conditioning-input"] },
    provenance: { type: "object", additionalProperties: true },
    review: { type: "object", additionalProperties: true },
    persisted: { type: "boolean" },
  },
} as const;

const stageValueSchema = {
  type: "object",
  additionalProperties: true,
  description: "Captured stage value or { availability: 'unavailable', reason } when legacy storage has no evidence.",
} as const;

const helperRunSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "runIndex", "config", "candidates", "output", "intermediateStates"],
  properties: {
    id: { type: "string", format: "uuid" },
    runIndex: { type: "integer", minimum: 1 },
    config: stageValueSchema,
    candidates: {
      type: "array",
      items: { type: "object", additionalProperties: true },
      description: "Candidate set produced by this exact helper config run.",
    },
    output: stageValueSchema,
    intermediateStates: {
      type: "array", maxItems: 32,
      description: "Helper-owned internal execution trace. These are evidence states inside the current Wizard stage, not executable commands.",
      items: { type: "object", additionalProperties: false, required: ["id", "parentId", "sequence", "status", "algorithm", "summary"], properties: {
        id: { type: "string" }, parentId: { type: ["string", "null"] }, sequence: { type: "integer", minimum: 0 },
        status: { type: "string", enum: ["pending", "completed", "failed"] }, algorithm: { type: ["string", "null"] },
        summary: { type: "object", additionalProperties: true },
      } },
    },
    artifact: { type: ["object", "null"], additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const helperSelectionSchema = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["runId", "candidateId"],
  properties: {
    runId: { type: "string", format: "uuid" },
    candidateId: { type: "string" },
  },
  description: "Exact helper run and candidate selected for the reviewed output; null for a manual result.",
} as const;

const stageSampleSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "cardId", "card", "stage", "stageInput", "helper", "execution", "humanCorrection", "provenance"],
  properties: {
    schemaVersion: { const: 1 }, cardId: { type: "string" }, card: helperBindingSchema.properties.card,
    stage: helperBindingSchema.properties.wizardStage, stageInput: stageValueSchema,
    helper: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, algorithm: { type: "string" }, version: { type: "string" } } },
    execution: { type: "object", additionalProperties: false, required: ["runs", "selection", "reviewMode", "initialParams", "finalParams", "reviewedOutput"], properties: {
      runs: { type: "array", items: helperRunSchema },
      selection: helperSelectionSchema,
      reviewMode: { type: ["string", "null"], enum: ["accepted", "corrected", "manual", null] },
      defaultParams: stageValueSchema, initialParams: stageValueSchema, finalParams: stageValueSchema,
      autoOutput: stageValueSchema,
      proposal: { type: "object", additionalProperties: false, required: ["executor"], properties: {
        executor: { type: "string", enum: ["human", "llm", "local_ml", "system"] },
        interactionMode: { type: "string", enum: ["auto", "manual", "mixed"] },
        planId: { type: "string", format: "uuid" },
        llmDecision: { type: "object", additionalProperties: false, required: ["mode", "executor"], properties: {
          mode: { type: "string", enum: ["accepted_helper", "modified_helper", "manual_created"] }, executor: { const: "llm" },
        } },
        review: { type: "object", additionalProperties: false, required: ["reviewedBy", "finalEditor", "verdict", "reviewedAt"], properties: {
          reviewedBy: { type: "string", enum: ["human", "llm", "local_ml"] }, reviewerSubject: { type: "string" },
          finalEditor: { type: "string", enum: ["helper", "llm", "human", "local_ml"] },
          verdict: { type: "string", enum: ["llm_correct", "llm_false_accept", "llm_false_correction", "llm_partially_correct"] },
          reviewedAt: { type: "string", format: "date-time" },
        } },
      } },
      reviewedOutput: stageValueSchema,
    } },
    humanCorrection: { type: "object", additionalProperties: false, required: ["reviewed", "paramsEdited", "outputEdited", "changedFields"], properties: {
      reviewed: { type: "boolean" }, paramsEdited: { type: ["boolean", "null"] }, outputEdited: { type: ["boolean", "null"] },
      changedFields: { type: "array", items: { type: "string" } }, reviewedAt: { type: "string" },
    } },
    provenance: { type: "object", additionalProperties: false, required: ["adapter", "persisted", "migrationGap"], properties: {
      adapter: { type: "string" }, persisted: { type: "boolean" }, migrationGap: { type: "boolean" },
    } },
  },
} as const;

const stageExecutionSchema = {
  type: "object",
  additionalProperties: true,
  description: "Native revisioned helper execution. Present for stages connected to meta.wizard_stage_executions; StageSample remains the canonical projection.",
} as const;

const annotationMetaResponseSchema = {
  type: "object",
  additionalProperties: true,
  required: ["id", "tags", "source"],
  properties: {
    id: { type: "string", format: "uuid" },
    tags: { type: "array", items: { type: "string" } },
    note: { type: ["string", "null"] },
    source: { type: "string", enum: ["human", "auto"] },
  },
} as const;

const annotationOcrResponseSchema = {
  type: "object",
  additionalProperties: true,
  required: ["id", "geometry", "coordinateSpace", "regionStatus", "transcription", "layout", "parentRelation", "meta"],
  properties: {
    id: { type: "string", format: "uuid" },
    geometry: { type: "object", additionalProperties: true },
    coordinateSpace: { type: "object", additionalProperties: true },
    regionStatus: { type: "string", enum: ["reviewed", "rejected"] },
    transcription: {
      type: "object", additionalProperties: false, required: ["text", "status"],
      properties: { text: { type: ["string", "null"] }, status: { type: "string", enum: ["verified", "partial", "unreadable"] } },
    },
    layout: {
      type: "object", additionalProperties: false, required: ["type", "flow", "baselineAngleDeg", "baseline", "characterOrientation"],
      properties: {
        type: { type: "string", enum: ["word", "string"] },
        flow: { type: "string", enum: ["linear", "curved"] },
        baselineAngleDeg: { type: "number", minimum: -180, maximum: 180 },
        baseline: { anyOf: [{ type: "null" }, { type: "array", minItems: 2, items: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } } }] },
        characterOrientation: { type: "string", enum: ["aligned", "tangent-aligned", "upright", "mixed"] },
      },
    },
    rectification: {
      anyOf: [
        { type: "null" },
        { type: "object", required: ["type", "angleDeg"], properties: { type: { const: "rotation" }, angleDeg: { type: "number", minimum: -180, maximum: 180 } } },
        { type: "object", required: ["type", "matrix"], properties: { type: { const: "affine" }, matrix: { type: "array", minItems: 6, maxItems: 6, items: { type: "number" } } } },
        { type: "object", required: ["type", "homography"], properties: { type: { const: "perspective" }, homography: { type: "array", minItems: 9, maxItems: 9, items: { type: "number" } } } },
        { type: "object", required: ["type", "path", "params"], properties: { type: { const: "curved" }, path: { type: "array", minItems: 2, items: { type: "object", required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } } }, params: { type: "object", additionalProperties: { type: "number" } } } },
      ],
    },
    parentRelation: { type: "object", additionalProperties: true },
    meta: { type: "array", items: annotationMetaResponseSchema },
  },
} as const;

const annotationGraphResponseSchema = {
  type: "object",
  additionalProperties: true,
  required: ["schemaVersion", "item", "packages", "meta", "operations", "validation"],
  properties: {
    schemaVersion: { const: 9 },
    item: { type: "object", additionalProperties: true },
    packages: {
      type: "array",
      items: {
        type: "object", additionalProperties: true,
        properties: {
          scope: { type: "object", description: "Technical helper working scope; not object ground truth.", additionalProperties: true },
          packageType: { type: "object", description: "Coarse classification ground truth only when reviewed.", additionalProperties: true },
          objectContext: { type: "object", description: "Reviewed physical object contour and segmentation status.", additionalProperties: true },
          ocr: { type: "array", maxItems: 0, description: "Deprecated empty compatibility field; OCR belongs to Labels/VisualRegions.", items: annotationOcrResponseSchema },
          labels: {
            type: "array",
            items: { type: "object", additionalProperties: true, properties: {
              origin: { type: "string", enum: ["human", "helper", "legacy", "migrated_from_direct_ocr"] },
              geometryReviewStatus: { type: "string", enum: ["suggested", "reviewed", "rejected"] },
              visualRegionKind: { type: "object", description: "Reviewed classification used to separate generic VisualRegion GT from physical-label GT.", properties: { value: { type: "string", enum: ["physical-label", "direct-print", "text-only", "graphic-only", "mixed", "other", "unknown"] }, status: { type: "string", enum: ["unreviewed", "reviewed"] } } },
              ocr: { type: "array", items: annotationOcrResponseSchema },
              ocrCompositions: { type: "array", description: "Semantic strings composed from ordered physical OCR members; member geometry remains independent.", items: {
                type: "object", additionalProperties: false, required: ["id", "labelId", "memberIds", "text", "transcriptionStatus", "sortOrder", "origin", "sourceOperationId", "createdAt"],
                properties: {
                  id: { type: "string", format: "uuid" }, labelId: { type: "string", format: "uuid" },
                  memberIds: { type: "array", minItems: 2, items: { type: "string", format: "uuid" } },
                  text: { type: ["string", "null"] }, transcriptionStatus: { type: "string", enum: ["verified", "partial", "unreadable"] },
                  sortOrder: { type: "integer", minimum: 0 }, origin: { type: "string", enum: ["human", "llm", "legacy"] },
                  sourceOperationId: { type: ["string", "null"] }, createdAt: { type: "string", format: "date-time" },
                },
              } },
              meta: { type: "array", items: annotationMetaResponseSchema },
            } },
          },
          meta: { type: "array", items: annotationMetaResponseSchema },
        },
      },
    },
    meta: { type: "array", items: annotationMetaResponseSchema },
    operations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          reviewOperations: { type: "array", description: "Compatibility projection of Label merge operations.", items: { type: "object", additionalProperties: true } },
          roiReviewGraph: {
            anyOf: [
              { type: "null" },
              {
                type: "object",
                additionalProperties: false,
                required: ["schemaVersion", "nodes", "operations", "reviewedOutputIds"],
                properties: {
                  schemaVersion: { const: 1 },
                  nodes: { type: "array", description: "Immutable autodetect/manual/canonical/derived ROI nodes.", items: { type: "object", additionalProperties: true } },
                  operations: { type: "array", description: "Ordered actor-attributed reject, edit, merge and approve primitives. Inputs are immutable.", items: { type: "object", additionalProperties: true } },
                  reviewedOutputIds: { type: "array", items: { type: "string" } },
                },
              },
            ],
          },
        },
      },
    },
    validation: { type: "object", additionalProperties: true },
  },
} as const;

const objectResponse = (description: string, helperId: string) => ({
  200: {
    description,
    type: "object",
    additionalProperties: true,
    properties: helperId === "all"
      ? {
          helperBindings: { type: "array", items: helperBindingSchema },
          stageSamples: { type: "array", items: stageSampleSchema },
          stageExecutions: { type: "array", items: stageExecutionSchema },
          stageSample: stageSampleSchema,
          stageExecution: stageExecutionSchema,
        }
      : { helperBinding: helperBindingSchema, stageSample: stageSampleSchema, stageExecution: stageExecutionSchema },
  },
  400: errorResponse("Invalid request or unavailable required input."),
  401: errorResponse("Missing or invalid x-internal-api-key."),
  404: errorResponse("Source item or workflow state was not found."),
  409: errorResponse("The workflow revision or prerequisite state conflicts with the request."),
  500: errorResponse("Unexpected server failure."),
});

const docs = new Map<string, FastifySchema | WizardRouteDoc>();

addGraph("GET", "/management/items/:source/:sourceItemId/annotations", "Load annotation graph",
  "catalog item -> Package[] -> Label/VisualRegion[] -> OCR[] + CV + Meta[]; operation trace returned separately");
addGraph("POST", "/management/items/:source/:sourceItemId/packages", "Add Package entity",
  "source image + package helper/config/candidates/review -> reviewed Package + operation trace", createGraphPackageSchema);
addGraph("POST", "/management/items/:source/:sourceItemId/packages/:packageId/labels", "Add Label entity",
  "Package geometry + label helper/config/candidates/review -> reviewed Label + operation trace", createGraphLabelSchema, "packageId");
addGraph("POST", "/management/items/:source/:sourceItemId/packages/:packageId/labels/review", "Review detected Label collection",
  "one Package-scoped helper run + accepted|edited|rejected|merged candidate reviews -> partially overlapping accepted fragments auto-merge while containment hypotheses stay separate; optional mergeGroupId joins explicitly reviewed fragments -> zero or more canonical Labels + one multi-result operation trace", reviewGraphLabelCandidatesSchema, "packageId");
addGraph("GET", "/management/items/:source/:sourceItemId/packages/:packageId/ocr", "List OCR across Package VisualRegions",
  "Package id -> all OCR nested under its Label/VisualRegion children; direct is an empty compatibility field", undefined, "packageId");
addGraph("POST", "/management/items/:source/:sourceItemId/labels/:labelId/ocr", "Add Label OCR",
  "Label context + OCR helper/config/candidates/review -> label-owned OCR quad + operation trace", createGraphOcrSchema, "labelId");
addGraph("POST", "/management/items/:source/:sourceItemId/annotation/helpers/ocr/run", "Run Label-scoped Auto OCR",
  "Label/VisualRegion scope + config -> one auto-ocr run + candidates + duplicate warnings", runAutoOcrSchema);
addGraph("POST", "/management/items/:source/:sourceItemId/annotation/helpers/label-rectification/run", "Suggest Label surface correction",
  "reviewed Label quad + CV rectification preset -> immutable Original/Perspective candidates with diagnostics; canonical Label changes only after explicit review", runLabelRectificationSchema);
addGraph("POST", "/management/items/:source/:sourceItemId/annotation/helpers/ocr/review", "Review Auto OCR candidates",
  "one draft run + per-candidate accepted|edited|rejected|merged; merge links to an existing same-Package OCR without mutating it", reviewAutoOcrSchema);
addGraph("POST", "/management/items/:source/:sourceItemId/annotation/ocr/dedupe-preflight", "Preflight manual OCR identity",
  "manual OCR observation -> same domain matcher -> draft candidate with duplicate matches; no canonical OCR is created before resolution", manualOcrDedupePreflightSchema);
addGraph("POST", "/management/items/:source/:sourceItemId/annotation/ocr/:ocrId/reparent", "Review OCR parent relation",
  "canonical OCR + another Label in the same Package -> coordinate-safe reparent_ocr operation; geometry and transcription identity remain unchanged", reparentGraphOcrSchema, "ocrId");
addGraph("POST", "/management/items/:source/:sourceItemId/annotation-meta", "Attach annotation Meta",
  "item/package/label/OCR target + note/tags -> attachable Meta entity + operation trace", createGraphMetaSchema);
addGraph("DELETE", "/management/items/:source/:sourceItemId/annotation-entities/:entityType/:entityId", "Delete annotation entity",
  "entity delete -> logical cascade + retained operation trace/resultDeletedAt", undefined, "entityType", "entityId");
addGraph("PATCH", "/management/items/:source/:sourceItemId/annotation-entities/:entityType/:entityId", "Edit annotation entity",
  "existing canonical entity + reviewed patch/helper provenance -> updated entity + immutable edit operation", updateGraphEntitySchema, "entityType", "entityId");

add("GET", "/management/metadata/:source/:sourceItemId/annotation-tracks", {
  stage: "tracks", tag: "Annotation Tracks", summary: "List independent annotation tracks",
  flow: "catalog item -> independent full-wizard tracks + progress/preview",
  description: "Lists the full annotation workflows attached to one catalog item. Tracks may share the same source asset.",
  trackScoped: false,
});
add("POST", "/management/metadata/:source/:sourceItemId/annotation-tracks", {
  stage: "tracks", tag: "Annotation Tracks", summary: "Create annotation track",
  flow: "catalog item + optional name/source asset/target region -> empty independent wizard state",
  description: "Creates a stable UUID track without duplicating the source image.",
  trackScoped: false,
});

add("GET", "/management/metadata/:source/:sourceItemId/label-annotation", {
  stage: "2-label", tag: "2. Label", summary: "Load reviewed label ROI",
  flow: "source item -> latest reviewed/manual label annotation",
  description: "Loads the canonical label annotation used as ground truth by every downstream wizard stage.",
});
add("PUT", "/management/metadata/:source/:sourceItemId/label-annotation", {
  stage: "2-label", tag: "2. Label", summary: "Save reviewed label ROI",
  flow: "manual convex quad/no-label/invalid decision -> persisted label annotation revision + derived bbox",
  description: "Persists the manually reviewed label ROI as a canonical four-point convex quad. Its enclosing bbox is derived for compatibility; downstream analysis rectifies the quad and is bound to this annotation id and revision.",
  body: labelAnnotationSchema,
});

add("POST", "/management/metadata/:source/:sourceItemId/label-annotation/source-analysis/run", {
  stage: "2-label-helper", tag: "2. Label", summary: "Run Auto-label helper or Object Context preview",
  flow: "source image + AutoLabelConfig -> low-res label debug/candidates; optional reviewed label ROI + bottle config -> bottle candidates/debug/palette",
  description: "Without verifiedLabel this runs label-multi-family-consensus-v7 when an accepted Package smart-lasso contour is available, otherwise the standalone v4 fallback. V7 combines EDGE/COLOR/TEXT consensus, bidirectional local Package-aware boundary probes, and mutually exclusive tight/boundary-probed ROI review variants. An edge moves only when local material, transition and text-like evidence support it; box candidates use stricter thresholds. The track-linked canonical Package scope is authoritative (null means full image); packageScope in the request is a compatibility fallback only when no linked Package exists. With verifiedLabel it additionally runs the compatibility bottle helper for Object Context and restricts returned candidates to the same Package scope.",
  body: sourceAnalysisRunSchema,
});
add("PUT", "/management/metadata/:source/:sourceItemId/label-annotation/source-analysis", {
  stage: "3-bottle-context", tag: "3. Object Context", summary: "Save reviewed physical-object context",
  flow: "selected bottle contour + config + reviewed colors -> visual_features.labelSourceAnalysis",
  description: "Persists the accepted Object Context state and projects its reviewed contour into canonical Package.objectContext. Compatibility payload keys remain bottleDetection. This is distinct from the technical Package scope and label-crop CV metadata.",
  body: sourceAnalysisStateSchema,
});

add("POST", "/management/metadata/:source/:sourceItemId/label-annotation/analysis/run", {
  stage: "4-ocr", tag: "4. OCR", summary: "Queue detector-free label analysis",
  flow: "reviewed label ROI -> crop -> OCR/text regions -> source matching -> initial visual features",
  description: "Queues ANALYZE_LABEL for the exact reviewed ROI. It does not run label detection. The worker records the native OCR auto-run execution when the job completes.",
  body: labelAnalysisRunSchema,
});
add("GET", "/management/metadata/:source/:sourceItemId/label-annotation/ocr/regions/review", {
  stage: "4-ocr", tag: "4. OCR", summary: "Load latest reviewed OCR regions",
  flow: "latest immutable OCR region review revision -> editable OCR workspace",
  description: "Returns the immutable reviewed OCR state: physical word/region quads, semantic WORD-to-STRING compositions, and the review-operation trace. Composition never destroys member word geometry.",
});
add("PUT", "/management/metadata/:source/:sourceItemId/label-annotation/ocr/regions/review", {
  stage: "4-ocr", tag: "4. OCR", summary: "Save reviewed OCR regions",
  flow: "current OCR state + geometry/transcription/composition review -> immutable reviewed state + semantic operation trace",
  description: "Saves physical OCR regions as canonical convex quads and semantic strings as references to retained word regions. The backend derives approve/edit/merge/split/create/reject/compose operations against immutable auto nodes, closes the matching OCR execution on final review, and leaves drafts open.",
  body: ocrRegionReviewSchema,
});
add("GET", "/management/metadata/:source/:sourceItemId/label-annotation/ocr/source-associations", {
  stage: "4-ocr", tag: "4. OCR", summary: "Load OCR-to-source matches",
  flow: "reviewed OCR regions + tokenized source fields -> generated and reviewed associations",
  description: "Loads source-data match candidates and the latest review bound to the current OCR-region revision.",
});
add("PUT", "/management/metadata/:source/:sourceItemId/label-annotation/ocr/source-associations", {
  stage: "4-ocr", tag: "4. OCR", summary: "Save OCR-to-source associations",
  flow: "accepted/rejected/corrected region-field links -> immutable association revision",
  description: "Persists explicit OCR-region links to tokenized catalog fields.",
  body: ocrSourceAssociationReviewSchema,
});
add("POST", "/management/metadata/:source/:sourceItemId/label-annotation/ocr/run", {
  stage: "4-ocr-compatibility", tag: "4. OCR", summary: "Run legacy direct OCR",
  flow: "label bbox fallback -> direct OCR snapshot",
  description: "Compatibility endpoint; the main wizard uses ANALYZE_LABEL instead.",
  deprecated: true,
});
add("PUT", "/management/metadata/:source/:sourceItemId/label-annotation/ocr/review", {
  stage: "4-ocr-compatibility", tag: "4. OCR", summary: "Save legacy aggregate OCR text review",
  flow: "aggregate corrected OCR text -> text review revision",
  description: "Compatibility endpoint. The wizard normally derives this text from the reviewed region set.",
  body: ocrTextReviewSchema, deprecated: true,
});

add("POST", "/management/metadata/:source/:sourceItemId/label-annotation/analysis/cv-preview", {
  stage: "5-10-cv-preview", tag: "5-10. Label CV", summary: "Calculate a CV stage preview",
  flow: "reviewed label crop + stage config + upstream review -> preview + immutable first-run execution",
  description: "Runs Mask, Morphology, Components, Elements, Contours or Palette preview. It never approves a checkpoint; every crop-CV stage records first-run evidence for the training trace.",
  body: labelCvJobPreviewSchema,
});
add("PUT", "/management/metadata/:source/:sourceItemId/label-annotation/analysis/cv-checkpoint", {
  stage: "5-10-cv-checkpoint", tag: "5-10. Label CV", summary: "Approve and persist one CV stage",
  flow: "stage config + component/element review + optional palette -> recalculated preview + workflow checkpoint + reviewed execution",
  description: "Recalculates and persists the selected stage, closing its native execution trace. Changing upstream inputs marks dependent checkpoints stale.",
  body: labelCvJobCheckpointSchema,
});
add("PUT", "/management/metadata/:source/:sourceItemId/label-annotation/analysis/cv-job", {
  stage: "10-palette-finalization", tag: "5-10. Label CV", summary: "Persist final label CV job state",
  flow: "final CV config + reviewed components/elements + palette -> compact labelCvJob + referenced debug artifact",
  description: "Final Palette/Summary persistence endpoint. Heavy binary layers are detached into debugArtifact; the recalculated Summary is captured as a started native execution for final review.",
  body: labelCvJobReviewSchema,
});
add("GET", "/management/metadata/:source/:sourceItemId/label-annotation/analysis/cv-job", {
  stage: "5-10-cv-workspace", tag: "5-10. Label CV", summary: "Load one canonical Label CV workspace",
  flow: "card + annotation track + canonical label -> rectified crop + persisted CV job + reviewed OCR overlays",
  description: "Requires the label query parameter. Returns the independent Mask-to-Palette workspace persisted for that canonical Label.",
  responseDescription: "Label-scoped CV workspace with crop, cvJob, summary and labelScope.",
});

add("GET", "/management/metadata/:source/:sourceItemId/label-annotation/analysis", {
  stage: "11-summary", tag: "11. Summary", summary: "Load the aggregate wizard workspace",
  flow: "annotation + analysis + reviewed OCR + matches + bottle/CV metadata -> recalculated Summary workspace",
  description: "Primary wizard hydration endpoint. Returns current/stale state and hydrates referenced CV debug layers for the viewer.",
  responseDescription: "Aggregate LabelAnalysisWorkspace with annotation, analysis, review, stale, latestJob, cvJob, summary, OCR revision id and catalog identity review.",
});
add("GET", "/management/metadata/:source/:sourceItemId/label-annotation/analysis/review", {
  stage: "11-summary", tag: "11. Summary", summary: "Load final analysis review",
  flow: "latest review revision -> Summary decision state",
  description: "Loads the latest accepted/needs-tuning/rejected decision for the current analysis.",
});
add("PUT", "/management/metadata/:source/:sourceItemId/label-annotation/analysis/review", {
  stage: "11-summary", tag: "11. Summary", summary: "Save final analysis review",
  flow: "current annotation/job/config identity + decision -> immutable analysis review revision",
  description: "Final Save/Next boundary. Uses baseRevision conflict protection and closes the native Summary execution with the reviewed decision.",
  body: labelAnalysisReviewSchema,
});
add("GET", "/management/metadata/:source/:sourceItemId/label-annotation/catalog-identity", {
  stage: "11-summary", tag: "11. Summary", summary: "Load reviewed catalog identity",
  flow: "latest identity decision -> Summary/catalog resolution state",
  description: "Returns the latest immutable catalog identity decision bound to OCR evidence.",
});
add("PUT", "/management/metadata/:source/:sourceItemId/label-annotation/catalog-identity", {
  stage: "11-summary", tag: "11. Summary", summary: "Save reviewed catalog identity",
  flow: "ranked catalog candidates + human decision -> immutable identity review",
  description: "Persists confirmed/corrected/no-match/ambiguous catalog resolution.",
  body: catalogIdentityReviewSchema,
});

export function registerWizardOpenApiRoutes(app: FastifyInstance) {
  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
    for (const method of methods) {
      const schema = docs.get(`${String(method).toUpperCase()} ${routeOptions.url}`);
      if (schema) {
        routeOptions.schema = { ...(routeOptions.schema ?? {}), ...schema };
        break;
      }
    }
  });
  app.addHook("preSerialization", async (request, reply, payload) => {
    if (reply.statusCode >= 400 || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
    const schema = request.routeOptions.schema as WizardRouteDoc | undefined;
    const helperKey = schema?.["x-helper-id"];
    if (!helperKey) return payload;
    const params = request.params as { source?: string; sourceItemId?: string };
    if (!params.source || !params.sourceItemId || !["svoe_vino", "roskachestvo"].includes(params.source)) return payload;
    const annotationTrackId = (request.query as { track?: unknown } | undefined)?.track;
    if (typeof annotationTrackId !== "string") return payload;

    let contract;
    let helperId = helperKey;
    let persistedOverride: boolean | undefined;
    const response = payload as Record<string, unknown>;
    if (helperKey === "label-cv-stage") {
      const body = request.body as { stage?: unknown } | undefined;
      helperId = helperIdForWizardStage(body?.stage ?? response.previewStage);
      contract = buildHelperConfigContract({ labelCvJob: response });
      persistedOverride = request.method !== "POST";
    } else if (helperKey === "bottle-outline" && request.url.includes("/source-analysis")) {
      contract = buildHelperConfigContract({ labelSourceAnalysis: response });
      persistedOverride = request.method === "PUT";
    } else if (helperKey === "label-ocr-cascade" && objectValue(response.ocr)?.evidence) {
      const ocr = objectValue(response.ocr) ?? {};
      contract = buildHelperConfigContract({}, ocr.evidence, ocr.id);
      persistedOverride = false;
    } else {
      contract = await getHelperConfigContractForItem(
        params.source as "svoe_vino" | "roskachestvo",
        params.sourceItemId,
        annotationTrackId,
      );
    }

    if (helperKey === "all") {
      const helperBindings = bindAllHelpersToCard(contract, params.source, params.sourceItemId);
      const execution = objectValue(response.stageExecution);
      if (!execution) return { ...response, helperBindings };
      const executionHelperId = typeof execution.helperId === "string" ? execution.helperId : "label-summary";
      const helperBinding = helperBindings.find((binding) => binding.helperId === executionHelperId)
        ?? bindHelperToCard(contract, params.source, params.sourceItemId, executionHelperId);
      return { ...response, helperBindings, helperBinding, stageSample: buildRouteStageSampleV1(helperBinding, response) };
    }
    const helperBinding = bindHelperToCard(contract, params.source, params.sourceItemId, helperId, persistedOverride);
    return { ...response, helperBinding, stageSample: buildRouteStageSampleV1(helperBinding, response, persistedOverride === false) };
  });
}

type AddOptions = {
  stage: string;
  tag: string;
  summary: string;
  flow: string;
  description: string;
  body?: z.ZodType;
  deprecated?: boolean;
  responseDescription?: string;
  trackScoped?: boolean;
};

function add(method: string, path: string, options: AddOptions) {
  const bffPath = path.replace("/management", "/api/admin/recognition");
  const helperId = docHelperId(options.stage);
  docs.set(`${method} ${path}`, {
    tags: [options.tag],
    summary: options.summary,
    description: `${options.description}\n\nData flow: ${options.flow}\n\nNext.js BFF mirror: \`${bffPath}\`.`,
    operationId: operationId(method, options.stage, path),
    ...(options.deprecated !== undefined ? { deprecated: options.deprecated } : {}),
    security: [{ internalApiKey: [] }],
    ...(method === "GET" ? {} : { headers: annotationActorHeaders }),
    params: sourceItemParams,
    ...(options.trackScoped === false ? {} : { querystring: annotationTrackQuery }),
    ...(options.body ? { body: toJsonSchema(options.body) } : {}),
    response: objectResponse(options.responseDescription ?? "Current state produced by this pipeline operation.", helperId),
    "x-wizard-stage": options.stage,
    "x-data-flow": options.flow,
    "x-bff-route": bffPath,
    "x-helper-id": helperId,
    "x-stage-sample-version": 1,
  } as WizardRouteDoc);
}

function addGraph(method: string, path: string, summary: string, flow: string, body?: z.ZodType, ...extraParams: string[]) {
  const properties: Record<string, unknown> = { ...sourceItemParams.properties };
  for (const name of extraParams) properties[name] = name === "entityType"
    ? { type: "string", enum: ["package", "label", "ocr", "meta"] }
    : { type: "string", format: "uuid" };
  docs.set(`${method} ${path}`, {
    tags: ["Annotation Graph"], summary,
    description: `Entity and operation are persisted independently.\n\nData flow: ${flow}.`,
    operationId: `${method.toLowerCase()}AnnotationGraph${summary.replace(/[^a-zA-Z0-9]+(.)/g, (_match, char: string) => char.toUpperCase())}`,
    security: [{ internalApiKey: [] }],
    ...(method === "GET" ? {} : { headers: annotationActorHeaders }),
    params: { type: "object", additionalProperties: false, required: ["source", "sourceItemId", ...extraParams], properties },
    ...(body ? { body: toJsonSchema(body) } : {}),
    response: {
      200: summary === "Load annotation graph"
        ? { description: "Canonical annotation graph v9 with explicit ROI review lineage and compatibility reviewOperations provenance.", ...annotationGraphResponseSchema }
        : { description: "Annotation graph/entity result.", type: "object", additionalProperties: true },
      201: { description: "Created annotation entity and operation.", type: "object", additionalProperties: true },
      400: errorResponse("Invalid annotation graph request."), 401: errorResponse("Missing or invalid x-internal-api-key."),
      404: errorResponse("Item, parent or annotation entity was not found."), 500: errorResponse("Unexpected server failure."),
    },
    "x-data-flow": flow,
  });
}

function docHelperId(stage: string) {
  if (stage === "tracks") return "";
  if (stage.startsWith("1-")) return "package-scope";
  if (stage.startsWith("2-")) return "label-roi-detection";
  if (stage.startsWith("3-")) return "bottle-outline";
  if (stage.startsWith("4-")) return "label-ocr-cascade";
  if (stage === "10-palette-finalization") return "label-palette";
  if (stage.startsWith("5-10-")) return "label-cv-stage";
  return stage === "11-summary" ? "all" : "label-summary";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toJsonSchema(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json.$schema;
  normalizeDraft7Tuples(json);
  return json;
}

function normalizeDraft7Tuples(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(normalizeDraft7Tuples);
    return;
  }
  if (!value || typeof value !== "object") return;
  const schema = value as Record<string, unknown>;
  if (Array.isArray(schema.items)) {
    schema.minItems ??= schema.items.length;
    schema.maxItems ??= schema.items.length;
    schema.additionalItems ??= false;
  }
  Object.values(schema).forEach(normalizeDraft7Tuples);
}

function errorResponse(description: string) {
  return {
    description,
    type: "object",
    additionalProperties: false,
    required: ["error"],
    properties: { error: { type: "string" }, issues: { type: "array", items: {} } },
  };
}

function operationId(method: string, stage: string, path: string) {
  const suffix = path.split("/label-annotation")[1]?.replace(/[:/]+(.)/g, (_match, char: string) => char.toUpperCase()) || "labelAnnotation";
  return `${method.toLowerCase()}${stage.replace(/[^a-zA-Z0-9]+(.)/g, (_match, char: string) => char.toUpperCase())}${suffix[0]?.toUpperCase() ?? ""}${suffix.slice(1)}`;
}
