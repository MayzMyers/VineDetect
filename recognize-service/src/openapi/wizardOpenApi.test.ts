import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../app.js";

test("wizard OpenAPI exposes ordered stages and canonical request contracts", async () => {
  const app = buildApp();
  await app.ready();
  try {
    const document = app.swagger() as {
      openapi?: string;
      paths?: Record<string, Record<string, Record<string, unknown>>>;
      tags?: Array<{ name?: string }>;
      security?: Array<Record<string, string[]>>;
      components?: { securitySchemes?: Record<string, Record<string, unknown>> };
    };

    assert.equal(document.openapi, "3.1.0");
    assert.deepEqual(document.security, [{ internalApiKey: [] }]);
    assert.deepEqual(document.components?.securitySchemes?.internalApiKey, {
      type: "apiKey", in: "header", name: "x-internal-api-key", description: "Internal BFF-to-Recognize API key.",
    });
    assert.deepEqual(document.tags?.map((tag) => tag.name), ["Annotation Graph", "Annotation Tracks", "1. Package", "2. Label", "3. Object Context", "4. OCR", "5-10. Label CV", "11. Summary", "Wizard API", "Jobs"]);

    const paths = document.paths ?? {};
    const workflow = paths["/management/annotation-workflow"]?.get;
    const stageGuide = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/stages/{stage}/guide"]?.get;
    const stageState = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/stages/{stage}"]?.get;
    const stageCommand = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/stages/{stage}/commands"]?.post;
    const automationRun = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/automation/run"]?.post;
    const automationJob = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/automation/jobs"]?.post;
    const automationJobs = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/automation/jobs"]?.get;
    const automationJobState = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/automation/jobs/{jobId}"]?.get;
    const correctionPlan = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/correction-plans"]?.post;
    const correctionPlanState = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/correction-plans/{planId}"]?.get;
    const correctionPlanApply = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/correction-plans/{planId}/apply"]?.post;
    const correctionPlanReview = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/correction-plans/{planId}/review"]?.put;
    const visionContext = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/vision-context"]?.get;
    const systemController = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/controllers/system/plan"]?.post;
    const visualRender = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/visual-context/render"]?.post;
    const localMlController = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/controllers/local-ml/plan"]?.post;
    const llmController = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/controllers/llm/plan"]?.post;
    const llmSessionStart = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/controllers/llm/sessions"]?.post;
    const llmSessionCurrent = paths["/management/items/{source}/{sourceItemId}/annotations/{annotationId}/controllers/llm/sessions/current"]?.get;
    const recognizeJob = paths["/management/recognize-jobs"]?.post;
    assert.equal((workflow?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((stageGuide?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((stageState?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((stageCommand?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((automationRun?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((automationJob?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((automationJobs?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((automationJobState?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((correctionPlan?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((correctionPlanState?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((correctionPlanApply?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((correctionPlanReview?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.deepEqual(correctionPlanApply?.security, [{ internalApiKey: [] }]);
    assert.deepEqual(correctionPlanReview?.security, [{ internalApiKey: [] }]);
    assert.equal((visionContext?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((systemController?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((visualRender?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((localMlController?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.deepEqual(localMlController?.security, [{ internalApiKey: [] }]);
    assert.equal((llmController?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.deepEqual(llmController?.security, [{ internalApiKey: [] }]);
    assert.equal((llmSessionStart?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.equal((llmSessionCurrent?.tags as string[] | undefined)?.[0], "Wizard API");
    assert.deepEqual(llmSessionStart?.security, [{ internalApiKey: [] }]);
    assert.match(JSON.stringify(workflow?.responses), /"executorTypes".*"llm".*"local_ml"/);
    assert.match(JSON.stringify(workflow?.responses), /"editEngineVersion".*"editPrimitives".*"stageEditDefinitions"/);
    for (const operation of [stageGuide, stageState, stageCommand]) {
      const parameters = JSON.stringify(operation?.parameters);
      assert.match(parameters, /"name":"annotationId"/);
      assert.match(parameters, /"name":"stage"/);
      assert.match(parameters, /"name":"label"/);
    }
    assert.match(JSON.stringify(stageCommand?.requestBody), /"run_helper".*"select_candidate".*"commit"/);
    assert.match(JSON.stringify(stageCommand?.requestBody), /"target".*"payload"/);
    assert.match(JSON.stringify(stageCommand?.parameters), /x-auth-role/);
    assert.match(JSON.stringify(stageCommand?.parameters), /x-auth-subject/);
    assert.match(JSON.stringify(automationRun?.requestBody), /"through".*"labelIds".*"objectContextLabelId".*"configs"/);
    assert.match(JSON.stringify(automationRun?.responses), /"helper-only"/);
    assert.match(JSON.stringify(automationJob?.responses), /"jobId".*"reused"/);
    assert.match(JSON.stringify(automationJobs?.parameters), /"limit".*"offset"/);
    assert.match(JSON.stringify(correctionPlan?.requestBody), /"executor".*"interactionMode".*"controller".*"proposedOutput".*"operations"/);
    assert.match(JSON.stringify(correctionPlan?.requestBody), /"llm".*"local_ml".*"system"/);
    assert.match(JSON.stringify(correctionPlanApply?.description), /Command Executor/);
    assert.match(JSON.stringify(correctionPlanReview?.requestBody), /finalEditor.*llm_false_accept.*llm_false_correction/);
    assert.match(JSON.stringify(visionContext?.responses), /visionContextId.*executionEvidence/);
    assert.match(JSON.stringify(systemController?.responses), /wizard-system-controller-v1.*planned.*no-action/);
    assert.match(JSON.stringify(systemController?.description), /never accepts candidates/);
    assert.match(JSON.stringify(visualRender?.requestBody), /viewport.*maxSide.*package-scope.*object-context.*selectedLabelId/);
    assert.match(JSON.stringify(visualRender?.responses), /sourceAssetRef.*transform.*overlayModel/);
    assert.match(JSON.stringify(localMlController?.requestBody), /render.*viewport.*input/);
    assert.match(JSON.stringify(localMlController?.responses), /local-ml-http-v1.*visionContextId.*visualContext.*controller.*plan/);
    assert.match(String(localMlController?.description), /never applies the plan/);
    assert.match(JSON.stringify(llmController?.requestBody), /render.*viewport.*input.*llmSessionId/);
    assert.match(JSON.stringify(llmController?.responses), /wizard-llm-http-v1.*visionContextId.*visualContext.*interactionMode.*plan/);
    assert.match(String(llmController?.description), /Stage-scoped.*Object Context.*OCR.*CV stages.*unapplied correction plan/);
    assert.match(String(llmController?.description), /Package is the first gate.*multipackage tag.*stops automatic orchestration/);
    assert.match(String(llmSessionStart?.description), /Provider chat history is never canonical/);
    assert.match(JSON.stringify(llmSessionCurrent?.responses), /stageRuns|additionalProperties/);
    assert.equal((recognizeJob?.tags as string[] | undefined)?.[0], "Jobs");
    assert.match(JSON.stringify(recognizeJob?.requestBody), /ANNOTATION_LLM_PIPELINE.*llmExecutionMode.*session-chain.*one-shot-chain/);
    const graphTags = paths["/management/items/{source}/{sourceItemId}/annotations"]?.get?.tags as string[] | undefined;
    assert.equal(graphTags?.[0], "Annotation Graph");
    const graphResponse = paths["/management/items/{source}/{sourceItemId}/annotations"]?.get?.responses as Record<string, unknown> | undefined;
    assert.match(JSON.stringify(graphResponse?.["200"]), /"schemaVersion".*"enum":\[9\]/);
    assert.match(JSON.stringify(graphResponse?.["200"]), /"roiReviewGraph".*"reviewedOutputIds"/);
    assert.match(JSON.stringify(graphResponse?.["200"]), /"packageType"/);
    assert.match(JSON.stringify(graphResponse?.["200"]), /"objectContext"/);
    assert.match(JSON.stringify(graphResponse?.["200"]), /Technical helper working scope/);
    assert.match(JSON.stringify(graphResponse?.["200"]), /"regionStatus"/);
    assert.match(JSON.stringify(graphResponse?.["200"]), /"transcription"/);
    assert.match(JSON.stringify(graphResponse?.["200"]), /"layout"/);
    assert.match(JSON.stringify(graphResponse?.["200"]), /"meta"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/packages"]?.post?.requestBody), /"reviewMode"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/labels/{labelId}/ocr"]?.post?.requestBody), /"partial"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/labels/{labelId}/ocr"]?.post?.requestBody), /"regionStatus"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/labels/{labelId}/ocr"]?.post?.requestBody), /"label-rectified"/);
    assert.equal(paths["/management/items/{source}/{sourceItemId}/packages/{packageId}/ocr"]?.post, undefined);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/annotation-meta"]?.post?.requestBody), /"human"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/annotation/helpers/ocr/run"]?.post?.requestBody), /"scope"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/annotation/helpers/label-rectification/run"]?.post?.requestBody), /"scope"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/annotation/helpers/label-rectification/run"]?.post), /Suggest Label surface correction/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/annotation/helpers/ocr/review"]?.post?.requestBody), /"finalParent"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/annotation/helpers/ocr/review"]?.post?.requestBody), /"merged"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/annotation/helpers/ocr/review"]?.post?.requestBody), /"resultEntityId"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/packages/{packageId}/labels/review"]?.post?.requestBody), /"reviews"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/packages/{packageId}/labels/review"]?.post?.requestBody), /"merged"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/annotation/ocr/dedupe-preflight"]?.post?.requestBody), /"coordinateSpace"/);
    assert.match(JSON.stringify(paths["/management/items/{source}/{sourceItemId}/annotation/ocr/{ocrId}/reparent"]?.post?.requestBody), /"target"/);
    const labelReview = paths["/management/metadata/{source}/{sourceItemId}/label-annotation"]?.put;
    assert.match(JSON.stringify(labelReview?.parameters), /"track"/);
    const labelSchema = (labelReview?.requestBody as { content?: Record<string, { schema?: { required?: string[]; properties?: Record<string, unknown> } }> })
      ?.content?.["application/json"]?.schema;
    assert.deepEqual(labelSchema?.required, ["schemaVersion", "prediction", "annotation", "status"]);
    assert.deepEqual(Object.keys(labelSchema?.properties ?? {}), ["schemaVersion", "prediction", "annotation", "status", "updatedAt"]);
    assert.equal(labelSchema?.properties?.generated, undefined);
    assert.equal(labelSchema?.properties?.reviewed, undefined);
    assert.equal(labelSchema?.properties?.source, undefined);
    assert.match(JSON.stringify(labelSchema), /"geometry"/);
    assert.match(JSON.stringify(labelSchema), /"quad"/);
    assert.match(JSON.stringify(labelSchema), /"helperRunId"/);
    assert.match(JSON.stringify(labelSchema), /"candidateId"/);
    const graphLabelReview = paths["/management/items/{source}/{sourceItemId}/packages/{packageId}/labels/review"]?.post;
    assert.match(JSON.stringify(graphLabelReview?.requestBody), /"mergeReviews"/);
    const sourceHelper = paths["/management/metadata/{source}/{sourceItemId}/label-annotation/source-analysis/run"]?.post;
    const sourceHelperSchema = (sourceHelper?.requestBody as { content?: Record<string, { schema?: unknown }> })?.content?.["application/json"]?.schema;
    assert.match(JSON.stringify(sourceHelperSchema), /"labelConfig"/);
    assert.match(JSON.stringify(sourceHelperSchema), /"chromaTolerance"/);
    assert.equal(sourceHelper?.["x-helper-id"], "label-roi-detection");

    const ocrReview = paths["/management/metadata/{source}/{sourceItemId}/label-annotation/ocr/regions/review"]?.put;
    const ocrSchema = (ocrReview?.requestBody as { content?: Record<string, { schema?: unknown }> })?.content?.["application/json"]?.schema;
    assert.match(JSON.stringify(ocrSchema), /"geometry"/);
    assert.match(JSON.stringify(ocrSchema), /"points"/);

    const preview = paths["/management/metadata/{source}/{sourceItemId}/label-annotation/analysis/cv-preview"]?.post;
    assert.match(JSON.stringify(preview?.parameters), /x-auth-role/);
    assert.match(JSON.stringify(preview?.parameters), /x-auth-subject/);
    assert.match(JSON.stringify(preview?.parameters), /ml-agent/);
    assert.equal(preview?.["x-wizard-stage"], "5-10-cv-preview");
    assert.equal(preview?.["x-helper-id"], "label-cv-stage");
    assert.equal(preview?.["x-stage-sample-version"], 1);
    assert.match(JSON.stringify(preview?.parameters), /"label"/);
    assert.equal((preview?.requestBody as { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> })
      ?.content?.["application/json"]?.schema?.properties?.stage !== undefined, true);

    const cvWorkspace = paths["/management/metadata/{source}/{sourceItemId}/label-annotation/analysis/cv-job"]?.get;
    assert.match(JSON.stringify(cvWorkspace?.parameters), /"label"/);
    assert.match(String(cvWorkspace?.description), /canonical Label/);

    const workspace = paths["/management/metadata/{source}/{sourceItemId}/label-annotation/analysis"]?.get;
    assert.match(JSON.stringify(workspace?.parameters), /"track"/);
    assert.equal(workspace?.["x-wizard-stage"], "11-summary");
    assert.equal(workspace?.["x-helper-id"], "all");
    assert.match(String(workspace?.description), /annotation \+ analysis/);
    const workspaceResponse = (workspace?.responses as Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }>)?.["200"];
    assert.equal(workspaceResponse?.content?.["application/json"]?.schema?.properties?.helperBindings !== undefined, true);
    assert.equal(workspaceResponse?.content?.["application/json"]?.schema?.properties?.stageSamples !== undefined, true);
    assert.equal(workspaceResponse?.content?.["application/json"]?.schema?.properties?.stageExecutions !== undefined, true);
    assert.equal(workspaceResponse?.content?.["application/json"]?.schema?.properties?.stageSample !== undefined, true);
    assert.equal(workspaceResponse?.content?.["application/json"]?.schema?.properties?.stageExecution !== undefined, true);
    const previewResponse = (preview?.responses as Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }>)?.["200"];
    assert.equal(previewResponse?.content?.["application/json"]?.schema?.properties?.stageExecution !== undefined, true);
    const stageSample = workspaceResponse?.content?.["application/json"]?.schema?.properties?.stageSample as { properties?: Record<string, { properties?: Record<string, { items?: { properties?: Record<string, unknown> } }> }> } | undefined;
    assert.equal(stageSample?.properties?.execution?.properties?.runs !== undefined, true);
    assert.equal(stageSample?.properties?.execution?.properties?.selection !== undefined, true);
    assert.equal(stageSample?.properties?.execution?.properties?.reviewMode !== undefined, true);
    assert.equal(stageSample?.properties?.execution?.properties?.proposedOutput, undefined);
    assert.equal(stageSample?.properties?.execution?.properties?.proposal !== undefined, true);
    assert.match(JSON.stringify(stageSample?.properties?.execution?.properties?.proposal), /llmDecision/);
    assert.match(JSON.stringify(stageSample?.properties?.execution?.properties?.proposal), /llm_false_accept/);
    assert.equal(stageSample?.properties?.execution?.properties?.runs?.items?.properties?.config !== undefined, true);
    assert.equal(stageSample?.properties?.execution?.properties?.runs?.items?.properties?.candidates !== undefined, true);
    assert.equal(stageSample?.properties?.execution?.properties?.runs?.items?.properties?.output !== undefined, true);
    const labelResponse = (labelReview?.responses as Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }>)?.["200"];
    assert.equal(labelResponse?.content?.["application/json"]?.schema?.properties?.stageSample !== undefined, true);
    for (const operations of Object.values(paths)) for (const operation of Object.values(operations)) {
      if (operation["x-helper-id"]) assert.equal(operation["x-stage-sample-version"], 1);
    }
  } finally {
    await app.close();
  }
});
