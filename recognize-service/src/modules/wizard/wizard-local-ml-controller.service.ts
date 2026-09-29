import { readFile } from "node:fs/promises";
import { env } from "../../config/env.js";
import { ConflictError } from "../../shared/errors.js";
import type { SourceName } from "../../shared/types.js";
import { resolveGeneratedAssetPath } from "../recognize-node/assets.js";
import { validateAndCreateCorrectionPlan } from "./wizard-correction-plan.service.js";
import { buildVisionContext } from "./wizard-vision-context.service.js";
import { renderWizardVisualContext } from "./wizard-visual.service.js";
import type { LocalMlControllerPlanRequest } from "./wizard.schemas.js";
import { requestExternalController, type ExternalControllerHttpOptions } from "./wizard-external-controller.service.js";

export async function createLocalMlControllerPlan(source: SourceName, sourceItemId: string, annotationId: string, request: LocalMlControllerPlanRequest) {
  if (!env.LOCAL_ML_CONTROLLER_URL) throw new ConflictError("LOCAL_ML_CONTROLLER_URL is not configured");
  const [visionContext, visualContext] = await Promise.all([
    buildVisionContext(source, sourceItemId, annotationId),
    renderWizardVisualContext(source, sourceItemId, annotationId, request.render),
  ]);
  const overlayPath = resolveGeneratedAssetPath(visualContext.assets.overlay.assetPath);
  if (!overlayPath) throw new ConflictError("Rendered controller preview path is unavailable");
  const overlay = await readFile(overlayPath);
  const response = await requestLocalMlController({
    schemaVersion: 1,
    task: "annotation-correction-plan",
    workflowContract: { correctionPlanSchemaVersion: 1, mutationBoundary: "wizard-command-executor", autoApply: false },
    visionContext,
    visualContext: {
      ...visualContext,
      image: { mimeType: "image/webp", dataUrl: `data:image/webp;base64,${overlay.toString("base64")}` },
    },
    input: request.input,
  });
  if (response.status === "no_action") return {
    schemaVersion: 1, adapter: "local-ml-http-v1", endpointConfigured: true, status: "no-action" as const,
    visionContextId: visionContext.visionContextId, visualContext, controller: response.controller,
    proposedOutput: response.proposedOutput, reason: response.reason, plan: null,
  };
  const plan = await validateAndCreateCorrectionPlan(source, sourceItemId, annotationId, "local_ml", {
    executor: "local_ml", interactionMode: response.interactionMode, controller: response.controller, proposedOutput: {
      ...response.proposedOutput, visionContextId: visionContext.visionContextId, visualRenderId: visualContext.renderId,
    }, operations: response.operations, continueOnError: response.continueOnError,
  });
  return {
    schemaVersion: 1, adapter: "local-ml-http-v1", endpointConfigured: true, status: "planned" as const,
    visionContextId: visionContext.visionContextId, visualContext, controller: response.controller, plan,
  };
}

export type LocalMlControllerHttpOptions = Omit<ExternalControllerHttpOptions, "displayName">;

export async function requestLocalMlController(
  payload: Record<string, unknown>,
  options: LocalMlControllerHttpOptions = {
    url: env.LOCAL_ML_CONTROLLER_URL!,
    token: env.LOCAL_ML_CONTROLLER_TOKEN,
    timeoutMs: env.LOCAL_ML_CONTROLLER_TIMEOUT_MS,
    maxResponseBytes: env.LOCAL_ML_CONTROLLER_MAX_RESPONSE_BYTES,
  },
) {
  return requestExternalController(payload, { ...options, displayName: "Local ML controller" });
}
