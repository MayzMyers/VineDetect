import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { annotationRequestActor, recordAnnotationTrackActor } from "../../db/annotation-actor.repository.js";
import { ConflictError, NotFoundError, UpstreamServiceError } from "../../shared/errors.js";
import { executeWizardCommand } from "./wizard-command.service.js";
import { runFullAutomaticPipeline } from "./wizard-automation.service.js";
import { wizardAutomationRunSchema, wizardCommandSchema } from "./wizard.schemas.js";
import { externalControllerPlanRequestSchema, llmHumanReviewSchema, localMlControllerPlanRequestSchema, wizardCorrectionPlanSchema, wizardVisualRenderSchema } from "./wizard.schemas.js";
import { applyCorrectionPlan, getOwnedCorrectionPlan, resolveCorrectionPlanExecutor, reviewLlmCorrectionPlan, validateAndCreateCorrectionPlan } from "./wizard-correction-plan.service.js";
import { getWizardStageState, getWizardWorkflowContract } from "./wizard.service.js";
import { enqueueRecognizeJob, getRecognizeJob, listAnnotationPipelineJobs } from "../jobs/jobs.service.js";
import { hashConfigSnapshot } from "../../shared/configHash.js";
import { buildVisionContext } from "./wizard-vision-context.service.js";
import { createSystemControllerPlan } from "./wizard-system-controller.service.js";
import { renderWizardVisualContext } from "./wizard-visual.service.js";
import { createLocalMlControllerPlan } from "./wizard-local-ml-controller.service.js";
import { createLlmControllerPlan, initializeLlmProviderConversation } from "./wizard-llm-controller.service.js";
import { attachLlmProviderConversation, closeLlmSession, createLlmStageRun, createOrGetActiveLlmSession, finishLlmStageRun, getActiveLlmSession, getLlmSession } from "../../db/llm-session.repository.js";
import { WIZARD_STAGE_ORDER } from "../../shared/wizardWorkflowContract.js";
import { env } from "../../config/env.js";

const sourceSchema = z.enum(["svoe_vino", "roskachestvo"]);
const stageSchema = z.enum(["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"]);
const paramsSchema = z.object({ source: sourceSchema, sourceItemId: z.string().min(1), annotationId: z.string().uuid(), stage: stageSchema });
const automationParamsSchema = paramsSchema.omit({ stage: true });
const automationJobParamsSchema = automationParamsSchema.extend({ jobId: z.string().uuid() });
const correctionPlanParamsSchema = automationParamsSchema.extend({ planId: z.string().uuid() });
const llmSessionParamsSchema = automationParamsSchema.extend({ sessionId: z.string().uuid() });
const automationJobsQuerySchema = z.object({ limit: z.coerce.number().int().positive().max(100).default(25), offset: z.coerce.number().int().min(0).default(0) });
const querySchema = z.object({ label: z.string().uuid().optional() });
const stageNames = ["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"] as const;
const llmHumanReviewJson = {
  type: "object", additionalProperties: false, required: ["stage", "finalEditor", "verdict"],
  properties: {
    stage: { type: "string", enum: stageNames },
    finalEditor: { type: "string", enum: ["helper", "llm", "human", "local_ml"] },
    verdict: { type: "string", enum: ["llm_correct", "llm_false_accept", "llm_false_correction", "llm_partially_correct"] },
  },
} as const;
const routeParamsJson = {
  type: "object", additionalProperties: false, required: ["source", "sourceItemId", "annotationId", "stage"],
  properties: {
    source: { type: "string", enum: ["svoe_vino", "roskachestvo"] },
    sourceItemId: { type: "string", minLength: 1 },
    annotationId: { type: "string", format: "uuid", description: "Stable annotationTrackId; canonical headless annotation workflow identifier." },
    stage: { type: "string", enum: stageNames },
  },
} as const;
const routeQueryJson = {
  type: "object", additionalProperties: false,
  properties: { label: { type: "string", format: "uuid", description: "Explicit canonical Label id. Required by state validation when a Package has multiple Labels and the stage is Label-scoped." } },
} as const;
const automationParamsJson = {
  type: "object", additionalProperties: false, required: ["source", "sourceItemId", "annotationId"],
  properties: {
    source: routeParamsJson.properties.source, sourceItemId: routeParamsJson.properties.sourceItemId, annotationId: routeParamsJson.properties.annotationId,
  },
} as const;
const automationJobParamsJson = {
  type: "object", additionalProperties: false, required: ["source", "sourceItemId", "annotationId", "jobId"],
  properties: { ...automationParamsJson.properties, jobId: { type: "string", format: "uuid" } },
} as const;
const correctionPlanParamsJson = {
  type: "object", additionalProperties: false, required: ["source", "sourceItemId", "annotationId", "planId"],
  properties: { ...automationParamsJson.properties, planId: { type: "string", format: "uuid" } },
} as const;
const stageGuideJson = {
  type: "object", additionalProperties: false,
  required: ["stage", "displayName", "goal", "scope", "prerequisites", "requirements", "availableActions", "constraints", "helperId", "existingApi"],
  properties: {
    stage: { type: "string", enum: stageNames }, displayName: { type: "string" }, goal: { type: "string" }, scope: { type: "string", enum: ["package", "label", "item"] },
    prerequisites: { type: "array", items: { type: "string", enum: stageNames } }, requirements: { type: "array", items: { type: "string" } },
    availableActions: {
      type: "array",
      items: {
        type: "string",
        enum: ["run_helper", "select_candidate", "update_params", "create_region", "edit_region", "delete_region", "merge", "reparent", "set_semantic", "commit"],
      },
    },
    constraints: { type: "array", items: { type: "string" } }, helperId: { type: "string" }, existingApi: { type: "array", items: { type: "string" } },
  },
} as const;
const errorJson = { type: "object", additionalProperties: false, required: ["error"], properties: { error: { type: "string" } } } as const;
const commandJson = {
  type: "object", additionalProperties: false, required: ["command"],
  properties: {
    command: { type: "string", enum: ["run_helper", "select_candidate", "update_params", "create_region", "edit_region", "delete_region", "merge", "reparent", "set_semantic", "commit"] },
    target: { type: "object", additionalProperties: false, required: ["entityType", "id"], properties: {
      entityType: { type: "string", enum: ["package", "label", "ocr", "meta"] }, id: { type: "string", format: "uuid" },
    } },
    payload: { description: "Stage-specific payload validated by the same schema used by the existing canonical mutation." },
  },
} as const;
const actorHeadersJson = {
  type: "object", additionalProperties: true,
  properties: {
    "x-auth-role": { type: "string", enum: ["admin", "annotator", "ml-service"], description: "Trusted role forwarded by the BFF." },
    "x-auth-subject": { type: "string", minLength: 1, maxLength: 200, description: "Trusted account or service subject used for execution provenance." },
  },
} as const;
const internalApiSecurityJson = [{ internalApiKey: [] }] as const;
const automationRunJson = {
  type: "object", additionalProperties: false,
  properties: {
    through: { type: "string", enum: stageNames, default: "summary" },
    labelIds: { type: "array", maxItems: 100, items: { type: "string", format: "uuid" } },
    objectContextLabelId: { type: "string", format: "uuid" },
    continueOnError: { type: "boolean", default: true },
    configs: { type: "object", additionalProperties: false, properties: {
      label: { type: "object", additionalProperties: true }, bottle: { type: "object", additionalProperties: true },
      ocr: { type: "object", additionalProperties: true }, cv: { type: "object", additionalProperties: true },
    } },
  },
} as const;
const automationJobsQueryJson = {
  type: "object", additionalProperties: false,
  properties: { limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }, offset: { type: "integer", minimum: 0, default: 0 } },
} as const;
const correctionPlanJson = {
  type: "object", additionalProperties: false, required: ["controller", "operations"],
  properties: {
    executor: { type: "string", enum: ["human", "llm", "local_ml", "system"], description: "Must agree with the trusted account role; human accounts cannot impersonate automated controllers." },
    interactionMode: { type: "string", enum: ["auto", "manual", "mixed"], default: "auto", description: "Degree of correction relative to deterministic helper output; independent of executor identity." },
    controller: { type: "object", additionalProperties: false, required: ["id"], properties: {
      id: { type: "string", minLength: 1, maxLength: 120 }, version: { type: "string", minLength: 1, maxLength: 80 }, model: { type: "string", minLength: 1, maxLength: 160 },
      promptVersion: { type: "string", minLength: 1, maxLength: 80 },
    } },
    proposedOutput: { type: "object", additionalProperties: true },
    operations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false, required: ["stage", "command"], properties: {
      operationId: { type: "string", minLength: 1, maxLength: 120 }, stage: { type: "string", enum: stageNames }, labelId: { type: "string", format: "uuid" },
      command: commandJson.properties.command, target: commandJson.properties.target, payload: {}, proposedOutput: { type: "object", additionalProperties: true },
    } } },
    continueOnError: { type: "boolean", default: false },
  },
} as const;
const visualRenderJson = {
  type: "object", additionalProperties: false,
  properties: {
    viewport: { oneOf: [
      { type: "object", additionalProperties: false, required: ["type"], properties: { type: { const: "source" } } },
      { type: "object", additionalProperties: false, required: ["type"], properties: { type: { const: "package" } } },
      { type: "object", additionalProperties: false, required: ["type", "id"], properties: { type: { const: "label" }, id: { type: "string", format: "uuid" } } },
    ], default: { type: "source" } },
    maxSide: { type: "integer", minimum: 256, maximum: 1280, default: 768 },
    overlays: { type: "array", maxItems: 4, uniqueItems: true, items: { type: "string", enum: ["package-scope", "object-context", "labels", "ocr"] } },
    selectedLabelId: { type: "string", format: "uuid" }, includeRejected: { type: "boolean", default: false },
  },
} as const;

export async function wizardRoutes(app: FastifyInstance) {
  app.get("/management/annotation-workflow", { schema: {
    tags: ["Wizard API"], summary: "Get canonical annotation workflow contract",
    response: { 200: { type: "object", additionalProperties: false, required: ["schemaVersion", "stages", "commandVocabulary", "executorTypes", "interactionModes", "runtimeDefinitionVersion", "runtimeDefinitions", "runtimeActions", "editEngineVersion", "editPrimitives", "stageEditDefinitions"], properties: {
      schemaVersion: { const: 1 }, stages: { type: "array", items: stageGuideJson }, commandVocabulary: { type: "array", items: { type: "string" } },
      executorTypes: { type: "array", items: { type: "string", enum: ["human", "llm", "local_ml", "system"] } }, interactionModes: { type: "array", items: { type: "string", enum: ["auto", "manual", "mixed"] } },
      runtimeDefinitionVersion: { type: "string" },
      runtimeDefinitions: { type: "array", items: { type: "object", additionalProperties: true } },
      runtimeActions: { type: "array", items: { type: "object", additionalProperties: true } },
      editEngineVersion: { type: "string" },
      editPrimitives: { type: "array", items: { type: "object", additionalProperties: true } },
      stageEditDefinitions: { type: "array", items: { type: "object", additionalProperties: true } },
    } } },
  } }, async () => getWizardWorkflowContract());

  app.get("/management/items/:source/:sourceItemId/annotations/:annotationId/stages/:stage/guide", {
    schema: { tags: ["Wizard API"], summary: "Get compact stage guide for UI, LLM or local ML clients", params: routeParamsJson, querystring: routeQueryJson,
      response: { 200: stageGuideJson, 404: errorJson, 409: errorJson } },
  }, async (request, reply) => {
    const params = paramsSchema.parse(request.params);
    const query = querySchema.parse(request.query);
    try { return (await getWizardStageState(params.source, params.sourceItemId, params.annotationId, params.stage, query.label)).guide; }
    catch (error) { return workflowError(error, reply); }
  });

  app.get("/management/items/:source/:sourceItemId/annotations/:annotationId/stages/:stage", {
    schema: { tags: ["Wizard API"], summary: "Get canonical current stage state and prerequisite validation", params: routeParamsJson, querystring: routeQueryJson,
      response: { 200: { type: "object", additionalProperties: true, required: ["schemaVersion", "annotationId", "card", "stage", "guide", "context", "status", "prerequisites", "validation", "state"], properties: {
        schemaVersion: { const: 1 }, annotationId: { type: "string", format: "uuid" }, card: { type: "object", additionalProperties: false, required: ["source", "sourceItemId"], properties: { source: { type: "string" }, sourceItemId: { type: "string" } } },
        stage: { type: "string", enum: stageNames }, guide: stageGuideJson, context: { type: "object", additionalProperties: true }, status: { type: "string" }, prerequisites: { type: "object", additionalProperties: { type: "string" } }, validation: { type: "object", additionalProperties: true }, state: { type: "object", additionalProperties: true },
      } }, 404: errorJson, 409: errorJson } },
  }, async (request, reply) => {
    const params = paramsSchema.parse(request.params);
    const query = querySchema.parse(request.query);
    try { return await getWizardStageState(params.source, params.sourceItemId, params.annotationId, params.stage, query.label); }
    catch (error) { return workflowError(error, reply); }
  });

  app.post("/management/items/:source/:sourceItemId/annotations/:annotationId/stages/:stage/commands", {
    schema: {
      tags: ["Wizard API"], summary: "Execute one canonical Wizard command through existing server-side mutations",
      description: "Validates track ownership, Label branch, stage prerequisites and command availability before delegating to the canonical stage service. It never writes annotation tables directly.",
      params: routeParamsJson, querystring: routeQueryJson, headers: actorHeadersJson, body: commandJson,
      response: {
        200: { type: "object", additionalProperties: true, required: ["schemaVersion", "commandId", "annotationId", "stage", "command", "result", "state"], properties: {
          schemaVersion: { const: 1 }, commandId: { type: "string", format: "uuid" }, annotationId: { type: "string", format: "uuid" },
          stage: { type: "string", enum: stageNames }, command: { type: "string" }, result: {}, state: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
        } },
        404: errorJson, 409: errorJson,
      },
    },
  }, async (request, reply) => {
    const params = paramsSchema.parse(request.params);
    const query = querySchema.parse(request.query);
    const body = wizardCommandSchema.parse(request.body);
    try {
      const result = await executeWizardCommand(params.source, params.sourceItemId, params.annotationId, params.stage, query.label, body);
      const actor = annotationRequestActor(request.headers);
      if (actor) await recordAnnotationTrackActor(params.annotationId, actor);
      return result;
    } catch (error) { return workflowError(error, reply); }
  });

  app.post("/management/items/:source/:sourceItemId/annotations/:annotationId/automation/run", {
    schema: {
      tags: ["Wizard API"], summary: "Run deterministic helpers as far as canonical reviewed prerequisites allow",
      description: "Produces helper AutoOutput without silently accepting candidates as ground truth. A fresh annotation normally stops after Label candidates; reviewed Label/OCR branches may continue through CV previews.",
      params: automationParamsJson, headers: actorHeadersJson, body: automationRunJson,
      response: {
        200: { type: "object", additionalProperties: true, required: ["schemaVersion", "pipelineRunId", "annotationId", "mode", "through", "startedAt", "finishedAt", "stages", "labelStages", "warnings", "failures", "requiresReview"], properties: {
          schemaVersion: { const: 1 }, pipelineRunId: { type: "string", format: "uuid" }, annotationId: { type: "string", format: "uuid" }, mode: { const: "helper-only" },
          through: { type: "string", enum: stageNames }, startedAt: { type: "string", format: "date-time" }, finishedAt: { type: "string", format: "date-time" },
          stages: { type: "object", additionalProperties: true }, labelStages: { type: "object", additionalProperties: true },
          warnings: { type: "array", items: { type: "string" } }, failures: { type: "array", items: { type: "object", additionalProperties: true } }, requiresReview: { type: "boolean" },
        } },
        404: errorJson, 409: errorJson,
      },
    },
  }, async (request, reply) => {
    const params = automationParamsSchema.parse(request.params);
    const body = wizardAutomationRunSchema.parse(request.body ?? {});
    try {
      const result = await runFullAutomaticPipeline(params.source, params.sourceItemId, params.annotationId, body);
      const actor = annotationRequestActor(request.headers);
      if (actor) await recordAnnotationTrackActor(params.annotationId, actor);
      return result;
    } catch (error) { return workflowError(error, reply); }
  });

  app.post("/management/items/:source/:sourceItemId/annotations/:annotationId/automation/jobs", {
    schema: {
      tags: ["Wizard API"], summary: "Queue a persisted helper-only annotation pipeline job",
      description: "Uses the existing generation_jobs queue and recognize worker. The resulting job stores the complete PipelineRun output; candidates still require explicit Wizard review.",
      params: automationParamsJson, headers: actorHeadersJson, body: automationRunJson,
      response: { 202: { type: "object", additionalProperties: false, required: ["jobId", "status", "reused"], properties: {
        jobId: { type: "string", format: "uuid" }, status: { type: "string" }, reused: { type: "boolean" },
      } }, 404: errorJson, 409: errorJson },
    },
  }, async (request, reply) => {
    const params = automationParamsSchema.parse(request.params);
    const body = wizardAutomationRunSchema.parse(request.body ?? {});
    try {
      await getWizardStageState(params.source, params.sourceItemId, params.annotationId, "package");
      const job = await enqueueRecognizeJob({
        type: "ANNOTATION_HELPER_PIPELINE",
        target: { source: params.source, sourceItemId: params.sourceItemId },
        options: { annotationTrackId: params.annotationId, automation: body, configHash: hashConfigSnapshot(body) },
      });
      const actor = annotationRequestActor(request.headers);
      if (actor) await recordAnnotationTrackActor(params.annotationId, actor);
      return reply.code(202).send(job);
    } catch (error) { return workflowError(error, reply); }
  });

  app.get("/management/items/:source/:sourceItemId/annotations/:annotationId/automation/jobs", {
    schema: {
      tags: ["Wizard API"], summary: "List persisted helper-only pipeline jobs for one annotation track",
      params: automationParamsJson, querystring: automationJobsQueryJson,
      response: { 200: { type: "object", additionalProperties: false, required: ["items", "limit", "offset"], properties: {
        items: { type: "array", items: { type: "object", additionalProperties: true } }, limit: { type: "integer" }, offset: { type: "integer" },
      } }, 404: errorJson },
    },
  }, async (request, reply) => {
    const params = automationParamsSchema.parse(request.params);
    const query = automationJobsQuerySchema.parse(request.query);
    try {
      await getWizardStageState(params.source, params.sourceItemId, params.annotationId, "package");
      return await listAnnotationPipelineJobs({ ...params, annotationTrackId: params.annotationId, ...query });
    } catch (error) { return workflowError(error, reply); }
  });

  app.get("/management/items/:source/:sourceItemId/annotations/:annotationId/automation/jobs/:jobId", {
    schema: {
      tags: ["Wizard API"], summary: "Get a persisted annotation pipeline job",
      params: automationJobParamsJson,
      response: { 200: { type: "object", additionalProperties: true }, 404: errorJson },
    },
  }, async (request, reply) => {
    const params = automationJobParamsSchema.parse(request.params);
    try {
      const job = await getRecognizeJob(params.jobId);
      const target = job.target as Record<string, unknown>;
      const options = job.options as Record<string, unknown>;
      if (target.source !== params.source || target.sourceItemId !== params.sourceItemId || options.annotationTrackId !== params.annotationId || job.type !== "ANNOTATION_HELPER_PIPELINE") {
        throw new NotFoundError("Annotation pipeline job not found");
      }
      return job;
    } catch (error) { return workflowError(error, reply); }
  });

  app.post("/management/items/:source/:sourceItemId/annotations/:annotationId/correction-plans", {
    schema: {
      tags: ["Wizard API"], summary: "Validate and persist a controller correction plan", security: internalApiSecurityJson,
      description: "Separates ProposedOutput from deterministic AutoOutput. Every operation is dry-validated against current stage state, payload schema, ownership and prerequisites before the plan is persisted.",
      params: automationParamsJson, headers: actorHeadersJson, body: correctionPlanJson,
      response: { 201: { type: "object", additionalProperties: true }, 404: errorJson, 409: errorJson },
    },
  }, async (request, reply) => {
    const params = automationParamsSchema.parse(request.params);
    const body = wizardCorrectionPlanSchema.parse(request.body);
    try {
      const executor = resolveCorrectionPlanExecutor(request.headers, body.executor);
      const plan = await validateAndCreateCorrectionPlan(params.source, params.sourceItemId, params.annotationId, executor, body);
      const actor = annotationRequestActor(request.headers);
      if (actor) await recordAnnotationTrackActor(params.annotationId, actor);
      return reply.code(201).send(plan);
    } catch (error) { return workflowError(error, reply); }
  });

  app.get("/management/items/:source/:sourceItemId/annotations/:annotationId/correction-plans/:planId", {
    schema: { tags: ["Wizard API"], summary: "Get one persisted correction plan and replay result", security: internalApiSecurityJson, params: correctionPlanParamsJson,
      response: { 200: { type: "object", additionalProperties: true }, 404: errorJson } },
  }, async (request, reply) => {
    const params = correctionPlanParamsSchema.parse(request.params);
    try { return await getOwnedCorrectionPlan(params.source, params.sourceItemId, params.annotationId, params.planId); }
    catch (error) { return workflowError(error, reply); }
  });

  app.post("/management/items/:source/:sourceItemId/annotations/:annotationId/correction-plans/:planId/apply", {
    schema: {
      tags: ["Wizard API"], summary: "Replay a validated correction plan through Wizard Command Executor", security: internalApiSecurityJson,
      description: "Every operation is replayed through the canonical Wizard Command Executor. Proposal operations retain the plan executor actor, while final approval uses the trusted caller actor. Replay is sequential and explicitly reports partial application. A plan can be claimed only once; retries of a terminal plan return its persisted result without executing commands again.",
      params: correctionPlanParamsJson, headers: actorHeadersJson,
      response: { 200: { type: "object", additionalProperties: true }, 404: errorJson, 409: errorJson },
    },
  }, async (request, reply) => {
    const params = correctionPlanParamsSchema.parse(request.params);
    try {
      const actor = annotationRequestActor(request.headers);
      if (!actor) throw new ConflictError("Trusted actor headers are required to apply a correction plan");
      const result = await applyCorrectionPlan(
        params.source, params.sourceItemId, params.annotationId, params.planId,
        actor.type === "human" ? "human" : "system",
      );
      await recordAnnotationTrackActor(params.annotationId, actor);
      return result;
    } catch (error) { return workflowError(error, reply); }
  });

  app.put("/management/items/:source/:sourceItemId/annotations/:annotationId/correction-plans/:planId/review", {
    schema: {
      tags: ["Wizard API"], summary: "Record human evaluation of an applied LLM correction plan", security: internalApiSecurityJson,
      description: "Stores compact LLM decision quality metadata on the final reviewed stage execution. reviewedBy is derived from trusted actor headers; no intermediate LLM annotation is added to canonical StageSample content.",
      params: correctionPlanParamsJson, headers: actorHeadersJson, body: llmHumanReviewJson,
      response: { 200: { type: "object", additionalProperties: true }, 404: errorJson, 409: errorJson },
    },
  }, async (request, reply) => {
    const params = correctionPlanParamsSchema.parse(request.params);
    const body = llmHumanReviewSchema.parse(request.body);
    try {
      const result = await reviewLlmCorrectionPlan(params.source, params.sourceItemId, params.annotationId, params.planId, request.headers, body);
      const actor = annotationRequestActor(request.headers);
      if (actor) await recordAnnotationTrackActor(params.annotationId, actor);
      return result;
    } catch (error) { return workflowError(error, reply); }
  });

  app.get("/management/items/:source/:sourceItemId/annotations/:annotationId/vision-context", {
    schema: {
      tags: ["Wizard API"], summary: "Build compact canonical VisionContext for a controller",
      description: "Returns source asset references, bounded prior-only catalog evidence, coordinate spaces, Package/Label/OCR geometry, lightweight CV artifact references, stage availability and execution evidence. Heavy raster/debug payloads are intentionally excluded.",
      params: automationParamsJson,
      response: { 200: { type: "object", additionalProperties: true, required: ["schemaVersion", "visionContextId", "generatedAt", "card", "catalogEvidence", "annotationId", "assets", "package", "labels", "stageState", "executionEvidence", "validation"], properties: {
        schemaVersion: { const: 1 }, visionContextId: { type: "string", format: "uuid" }, generatedAt: { type: "string", format: "date-time" },
        card: { type: "object", additionalProperties: true }, catalogEvidence: { type: "object", additionalProperties: true }, annotationId: { type: "string", format: "uuid" }, assets: { type: "object", additionalProperties: true },
        package: { type: "object", additionalProperties: true }, labels: { type: "array", items: { type: "object", additionalProperties: true } },
        stageState: { type: "object", additionalProperties: true }, executionEvidence: { type: "array", items: { type: "object", additionalProperties: true } },
        recentOperations: { type: "array", items: { type: "object", additionalProperties: true } }, validation: { type: "object", additionalProperties: true },
      } }, 404: errorJson },
    },
  }, async (request, reply) => {
    const params = automationParamsSchema.parse(request.params);
    try { return await buildVisionContext(params.source, params.sourceItemId, params.annotationId); }
    catch (error) { return workflowError(error, reply); }
  });

  app.post("/management/items/:source/:sourceItemId/annotations/:annotationId/controllers/system/plan", {
    schema: {
      tags: ["Wizard API"], summary: "Create the next safe helper-only system correction plan", security: internalApiSecurityJson,
      description: "The reference controller consumes VisionContext and plans only the current executable helper frontier. It never accepts candidates or applies the resulting correction plan.",
      params: automationParamsJson, headers: actorHeadersJson,
      response: { 200: { type: "object", additionalProperties: true, required: ["schemaVersion", "controller", "status", "context", "notes", "plan"], properties: {
        schemaVersion: { const: 1 }, controller: { const: "wizard-system-controller-v1" }, status: { type: "string", enum: ["planned", "no-action"] },
        context: { type: "object", additionalProperties: true }, notes: { type: "array", items: { type: "string" } },
        plan: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
      } }, 404: errorJson, 409: errorJson },
    },
  }, async (request, reply) => {
    const params = automationParamsSchema.parse(request.params);
    try {
      if (!annotationRequestActor(request.headers)) throw new ConflictError("Trusted actor headers are required to invoke a controller");
      return await createSystemControllerPlan(params.source, params.sourceItemId, params.annotationId);
    } catch (error) { return workflowError(error, reply); }
  });

  app.post("/management/items/:source/:sourceItemId/annotations/:annotationId/visual-context/render", {
    schema: {
      tags: ["Wizard API"], summary: "Render a controller-ready preview and canonical OverlayModel",
      description: "Creates bounded WebP assets and one explicit source-crop-scale transform. OCR quads in normalized Label space are projected back through the reviewed Label quad; unsupported coordinate spaces are omitted rather than guessed.",
      params: automationParamsJson, body: visualRenderJson,
      response: { 200: { type: "object", additionalProperties: true, required: ["schemaVersion", "renderId", "annotationId", "sourceAssetRef", "viewport", "transform", "assets", "overlayModel"], properties: {
        schemaVersion: { const: 1 }, renderId: { type: "string", format: "uuid" }, annotationId: { type: "string", format: "uuid" }, sourceAssetRef: { type: "string" },
        viewport: { type: "object", additionalProperties: true }, transform: { type: "object", additionalProperties: true },
        assets: { type: "object", additionalProperties: true }, overlayModel: { type: "object", additionalProperties: true },
      } }, 404: errorJson, 409: errorJson },
    },
  }, async (request, reply) => {
    const params = automationParamsSchema.parse(request.params);
    const body = wizardVisualRenderSchema.parse(request.body ?? {});
    try { return await renderWizardVisualContext(params.source, params.sourceItemId, params.annotationId, body); }
    catch (error) { return workflowError(error, reply); }
  });

  app.post("/management/items/:source/:sourceItemId/annotations/:annotationId/controllers/local-ml/plan", {
    schema: {
      tags: ["Wizard API"], summary: "Ask the configured local ML runtime for a validated correction plan", security: internalApiSecurityJson,
      description: "The adapter builds VisionContext and a bounded overlay WebP, calls only LOCAL_ML_CONTROLLER_URL, validates the strict response contract and persists ProposedOutput. It never applies the plan.",
      params: automationParamsJson, headers: actorHeadersJson,
      body: { type: "object", additionalProperties: false, properties: {
        render: visualRenderJson,
        input: { type: "object", additionalProperties: true, description: "Controller-specific inference options; never interpreted as Wizard commands by the adapter." },
      } },
      response: { 200: { type: "object", additionalProperties: true, required: ["schemaVersion", "adapter", "endpointConfigured", "status", "visionContextId", "visualContext", "controller", "plan"], properties: {
        schemaVersion: { const: 1 }, adapter: { const: "local-ml-http-v1" }, endpointConfigured: { const: true }, status: { type: "string", enum: ["planned", "no-action"] }, visionContextId: { type: "string", format: "uuid" },
        visualContext: { type: "object", additionalProperties: true }, controller: { type: "object", additionalProperties: true }, reason: { type: "string" },
        plan: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
      } }, 404: errorJson, 409: errorJson },
    },
  }, async (request, reply) => {
    const params = automationParamsSchema.parse(request.params);
    const body = localMlControllerPlanRequestSchema.parse(request.body ?? {});
    try {
      resolveCorrectionPlanExecutor(request.headers, "local_ml");
      const result = await createLocalMlControllerPlan(params.source, params.sourceItemId, params.annotationId, body);
      const actor = annotationRequestActor(request.headers);
      if (actor) await recordAnnotationTrackActor(params.annotationId, actor);
      return result;
    } catch (error) { return workflowError(error, reply); }
  });

  app.post("/management/items/:source/:sourceItemId/annotations/:annotationId/controllers/llm/plan", {
    schema: {
      tags: ["Wizard API"], summary: "Ask the configured multimodal LLM adapter for a validated correction plan", security: internalApiSecurityJson,
      description: "Stage-scoped LLM review for Package multiplicity, Label, Object Context, OCR and Label-owned CV stages. Package is the first gate: the model must select exactly one physical package or multiple packages; the latter persists the item-level multipackage tag and stops automatic orchestration. The server-owned wizard-runtime registry fixes the current stage, permitted algorithms, actions and transitions; the LLM cannot reorder or extend the Wizard. A helper may expose a bounded nested intermediate-state trace as evidence inside the current stage. Recognize runs the deterministic helper, builds a bounded observation with a clean crop and stable-ID result overlay, and accepts only server-bounded accept, granular review, semantic rerun or human_required decisions. Semantic adjustments are translated into validated helper config and limited to two reruns. Granular review is restricted to known OCR, Component and Element IDs. Elements additionally allow bounded component moves into known Elements or server-created groups; invented component/Element identities are rejected. A final accepted/reviewed result becomes an unapplied correction plan. Summary is advisory. Provider failure falls back to no-action/human review.",
      params: automationParamsJson, headers: actorHeadersJson,
      body: { type: "object", additionalProperties: false, properties: {
        render: visualRenderJson,
        input: { type: "object", additionalProperties: true, description: "Stage context. selectedLabelId is required for Label-owned OCR/CV stages. The controller cannot bypass server-owned decision or command validation.", properties: {
          currentStage: { type: "string", enum: ["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"] },
          selectedLabelId: { type: "string", format: "uuid" },
          llmSessionId: { type: "string", format: "uuid", description: "Optional DB-owned card session. When supplied, this atomic stage invocation is persisted as an LLMStageRun." },
        } },
      } },
      response: { 200: { type: "object", additionalProperties: true, required: ["schemaVersion", "adapter", "endpointConfigured", "status", "visionContextId", "visualContext", "controller", "interactionMode", "plan"], properties: {
        schemaVersion: { const: 1 }, adapter: { type: "string", enum: ["wizard-stage-llm-http-v1", "wizard-llm-http-v1"] }, endpointConfigured: { const: true }, status: { type: "string", enum: ["planned", "no-action"] }, visionContextId: { type: "string", format: "uuid" },
        visualContext: { type: "object", additionalProperties: true }, controller: { type: "object", additionalProperties: true }, interactionMode: { type: "string", enum: ["auto", "manual", "mixed"] }, reason: { type: "string" },
        plan: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] },
      } }, 404: errorJson, 409: errorJson },
    },
  }, async (request, reply) => {
    const params = automationParamsSchema.parse(request.params);
    const body = externalControllerPlanRequestSchema.parse(request.body ?? {});
    const requestedSessionId = typeof body.input.llmSessionId === "string" ? body.input.llmSessionId : null;
    const requestedStage = stageSchema.parse(body.input.currentStage ?? "summary");
    const selectedLabelId = typeof body.input.selectedLabelId === "string" ? body.input.selectedLabelId : null;
    let stageRunId: string | null = null;
    let sessionContext: Record<string, unknown> | undefined;
    try {
      if (!annotationRequestActor(request.headers)) throw new ConflictError("Trusted actor headers are required to invoke a controller");
      if (requestedSessionId) {
        const session = await getLlmSession(requestedSessionId);
        if (!session || session.annotationTrackId !== params.annotationId || session.source !== params.source || session.sourceItemId !== params.sourceItemId || !["active", "blocked"].includes(session.status)) throw new ConflictError("The requested LLM session is not open for this annotation");
        sessionContext = sessionContextEnvelope(session);
        stageRunId = (await createLlmStageRun(session.id, requestedStage, selectedLabelId, [], {
          schemaVersion: 1, stage: requestedStage, labelId: selectedLabelId,
          session: sessionContext,
        })).id;
      }
      const result = await createLlmControllerPlan(params.source, params.sourceItemId, params.annotationId, body, sessionContext);
      if (stageRunId) {
        const trace = llmIterationTrace(result);
        const humanRequired = (result.status === "no-action" && requestedStage !== "summary")
          || (requestedStage === "package" && llmPackageMultiplicity(result) === "multiple");
        const run = await finishLlmStageRun({
          id: stageRunId, status: humanRequired ? "human_required" : "completed", decisions: trace,
          correctionPlanId: result.plan?.id ?? null,
          inputArtifactIds: llmInputArtifacts(result), controllerModel: String((result.controller as Record<string, unknown>)?.model ?? result.controller?.id ?? "configured-controller"),
          ...llmProviderRunEvidence(result),
          stageContext: { [stageContextKey(requestedStage, selectedLabelId)]: { stage: requestedStage, labelId: selectedLabelId, status: humanRequired ? "human_required" : result.status, planId: result.plan?.id ?? null, controller: result.controller, decisions: trace, updatedAt: new Date().toISOString() } },
        });
        Object.assign(result, { llmSessionId: requestedSessionId, stageRun: run });
      }
      const actor = annotationRequestActor(request.headers);
      if (actor) await recordAnnotationTrackActor(params.annotationId, actor);
      return result;
    } catch (error) {
      if (stageRunId) await finishLlmStageRun({ id: stageRunId, status: "failed", decisions: [], error: error instanceof Error ? error.message : "Unknown LLM stage error" });
      return workflowError(error, reply);
    }
  });

  app.post("/management/items/:source/:sourceItemId/annotations/:annotationId/controllers/llm/sessions", {
    schema: {
      tags: ["Wizard API"], summary: "Start or resume the DB-owned LLM session for one annotation card", security: internalApiSecurityJson,
      description: "Creates one active card-level session. Provider chat history is never canonical; each stage request receives context reconstructed from this session and persisted wizard state.",
      params: automationParamsJson, headers: actorHeadersJson,
      response: { 200: { type: "object", additionalProperties: true, required: ["session", "reused"], properties: { session: { type: "object", additionalProperties: true }, reused: { type: "boolean" } } }, 404: errorJson, 409: errorJson },
    },
  }, async (request, reply) => {
    const params = automationParamsSchema.parse(request.params);
    try {
      if (!annotationRequestActor(request.headers)) throw new ConflictError("Trusted actor headers are required to start an LLM session");
      const context = await buildVisionContext(params.source, params.sourceItemId, params.annotationId);
      const created = await createOrGetActiveLlmSession({
        source: params.source, sourceItemId: params.sourceItemId, annotationTrackId: params.annotationId,
        provider: env.LLM_WIZARD_PROVIDER, model: env.LLM_WIZARD_MODEL, adapterVersion: "vision-stage-adapter-v7",
        promptVersion: "stage-output-review-v13", wizardDefinitionVersion: `wizard-${WIZARD_STAGE_ORDER.length}-stages-v1`,
        globalContext: { visionContextId: context.visionContextId, card: context.card, catalogEvidence: context.catalogEvidence, assets: context.assets, stageContexts: {} },
      });
      const session = await ensureProviderConversation(created.session);
      return { session, reused: created.reused };
    } catch (error) { return workflowError(error, reply); }
  });

  app.get("/management/items/:source/:sourceItemId/annotations/:annotationId/controllers/llm/sessions/current", {
    schema: {
      tags: ["Wizard API"], summary: "Read the active LLM session and ordered stage-run trace", security: internalApiSecurityJson,
      params: automationParamsJson,
      response: { 200: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] }, 404: errorJson },
    },
  }, async (request, reply) => {
    const params = automationParamsSchema.parse(request.params);
    try { return await getActiveLlmSession(params.annotationId); }
    catch (error) { return workflowError(error, reply); }
  });

  app.get("/management/items/:source/:sourceItemId/annotations/:annotationId/controllers/llm/sessions/:sessionId", {
    schema: {
      tags: ["Wizard API"], summary: "Read one persisted LLM session and its raw stage-run records", security: internalApiSecurityJson,
      params: { ...automationParamsJson, required: [...automationParamsJson.required, "sessionId"], properties: { ...automationParamsJson.properties, sessionId: { type: "string", format: "uuid" } } },
      response: { 200: { type: "object", additionalProperties: true }, 404: errorJson },
    },
  }, async (request, reply) => {
    const params = llmSessionParamsSchema.parse(request.params);
    try {
      const session = await getLlmSession(params.sessionId);
      if (!session || session.annotationTrackId !== params.annotationId || session.source !== params.source || session.sourceItemId !== params.sourceItemId) throw new NotFoundError("LLM session not found");
      return session;
    } catch (error) { return workflowError(error, reply); }
  });

  app.post("/management/items/:source/:sourceItemId/annotations/:annotationId/controllers/llm/sessions/:sessionId/close", {
    schema: {
      tags: ["Wizard API"], summary: "Complete or cancel an active card-level LLM session", security: internalApiSecurityJson,
      params: { ...automationParamsJson, required: [...automationParamsJson.required, "sessionId"], properties: { ...automationParamsJson.properties, sessionId: { type: "string", format: "uuid" } } },
      headers: actorHeadersJson,
      body: { type: "object", additionalProperties: false, required: ["status"], properties: { status: { type: "string", enum: ["completed", "cancelled"] } } },
      response: { 200: { type: "object", additionalProperties: true }, 404: errorJson, 409: errorJson },
    },
  }, async (request, reply) => {
    const params = llmSessionParamsSchema.parse(request.params);
    const body = z.object({ status: z.enum(["completed", "cancelled"]) }).strict().parse(request.body);
    try {
      if (!annotationRequestActor(request.headers)) throw new ConflictError("Trusted actor headers are required to close an LLM session");
      const session = await getLlmSession(params.sessionId);
      if (!session || session.annotationTrackId !== params.annotationId || session.source !== params.source || session.sourceItemId !== params.sourceItemId) throw new NotFoundError("LLM session not found");
      const closed = await closeLlmSession(session.id, body.status);
      if (!closed) throw new ConflictError("LLM session is not active");
      return closed;
    } catch (error) { return workflowError(error, reply); }
  });
}

function llmIterationTrace(result: Record<string, any>) {
  const controller = result.proposedOutput ?? {};
  const plan = result.plan?.proposedOutput ?? {};
  return readIterationTrace(controller) ?? readIterationTrace(plan) ?? [];
}

function readIterationTrace(evidence: Record<string, any>) {
  if (Array.isArray(evidence.iterationTrace)) return evidence.iterationTrace;
  return Array.isArray(evidence.observation?.iterationTrace) ? evidence.observation.iterationTrace : null;
}

function llmPackageMultiplicity(result: Record<string, any>) {
  const operations = Array.isArray(result.plan?.operations) ? result.plan.operations : [];
  const value = operations
    .map((operation: Record<string, any>) => operation.proposedOutput?.multiplicity)
    .find((item: unknown) => item === "single" || item === "multiple");
  return value === "single" || value === "multiple" ? value : null;
}

function llmInputArtifacts(result: Record<string, any>) {
  const assets = result.visualContext?.assets ?? {};
  return Object.values(assets).flatMap((value) => {
    if (typeof value === "string") return [value];
    if (value && typeof value === "object" && typeof (value as Record<string, unknown>).assetPath === "string") return [String((value as Record<string, unknown>).assetPath)];
    return [];
  });
}

function stageContextKey(stage: string, labelId: string | null) { return labelId ? `${stage}:${labelId}` : stage; }

function sessionContextEnvelope(session: NonNullable<Awaited<ReturnType<typeof getLlmSession>>>) {
  return {
    llmSessionId: session.id,
    provider: session.provider,
    providerConversationId: session.providerConversationId,
    currentStage: session.currentStage,
    context: session.globalContext,
    contextEvents: session.contextEvents,
  };
}

function llmProviderRunEvidence(result: Record<string, any>) {
  const proposed = result.plan?.proposedOutput ?? result.proposedOutput ?? {};
  const evidence = proposed.providerEvidence ?? {};
  return {
    providerConversationId: typeof evidence.providerConversationId === "string" ? evidence.providerConversationId : null,
    providerResponseId: typeof evidence.responseId === "string" ? evidence.responseId : null,
    providerRequestId: typeof evidence.requestId === "string" ? evidence.requestId : null,
    usage: evidence.usage && typeof evidence.usage === "object" ? evidence.usage : {},
    latencyMs: Number.isInteger(evidence.latencyMs) ? evidence.latencyMs : null,
  };
}

async function ensureProviderConversation(session: NonNullable<Awaited<ReturnType<typeof getLlmSession>>>) {
  if (session.providerConversationId || session.provider !== "qwen") return session;
  const initialized = await initializeLlmProviderConversation({ llmSessionId: session.id, annotationId: session.annotationTrackId });
  if (initialized.status !== "attached" || !initialized.conversationId) return session;
  const attached = await attachLlmProviderConversation({
    sessionId: session.id, provider: initialized.provider, conversationId: initialized.conversationId, model: initialized.model,
  });
  if (!attached) throw new ConflictError("Provider conversation could not be attached to the open LLM session");
  return attached;
}

function workflowError(error: unknown, reply: FastifyReply) {
  if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
  if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
  if (error instanceof UpstreamServiceError) return reply.code(error.statusCode).send({ error: error.message });
  throw error;
}
