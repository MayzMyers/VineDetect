export const PROMPT_VERSION = "wizard-multimodal-v1";
export const STAGES = ["package", "label", "bottle", "ocr", "mask", "morphology", "components", "elements", "contours", "palette", "summary"];
export const COMMANDS = ["run_helper", "select_candidate", "update_params", "create_region", "edit_region", "delete_region", "merge", "reparent", "set_semantic", "commit"];
export const ENTITY_TYPES = ["package", "label", "ocr", "meta"];

export const SYSTEM_PROMPT = `You are the multimodal annotation controller for the VineDetect Wizard.
Your output is a proposal, never a direct database mutation. Inspect the clean source preview first and form an independent visual hypothesis. Then compare that hypothesis with VisionContext and the overlay preview.

Use only stages and commands allowed by the supplied workflow contract. Preserve Package, Label and OCR identity. Never invent an existing entity ID. Prefer no_action when the evidence is insufficient or a human review boundary must be respected. Keep operations minimal and ordered. Do not silently accept helper candidates as ground truth.

Operation payloadJson and proposedOutputJson must each contain one valid JSON object encoded as a string. Geometry in Wizard operations must use the coordinate space required by the supplied stage state and workflow contract. A null target means the command creates or runs something without addressing an existing entity.

interactionMode describes relation to deterministic helper output: auto means accepted/used without correction, mixed means helper output was corrected, and manual means the proposed result was created independently of a useful helper result.
Return exactly one JSON object and no surrounding prose or Markdown.`;

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "interactionMode", "visionHypothesis", "comparison", "operations", "reason"],
  properties: {
    status: { type: "string", enum: ["planned", "no_action"] },
    interactionMode: { type: "string", enum: ["auto", "manual", "mixed"] },
    visionHypothesis: {
      type: "object", additionalProperties: false,
      required: ["summary", "regions", "readableText", "uncertainties"],
      properties: {
        summary: { type: "string" },
        regions: { type: "array", maxItems: 100, items: { $ref: "#/$defs/region" } },
        readableText: { type: "array", maxItems: 200, items: { type: "string" } },
        uncertainties: { type: "array", maxItems: 100, items: { type: "string" } }
      }
    },
    comparison: {
      type: "object", additionalProperties: false,
      required: ["summary", "agreements", "disagreements", "warnings"],
      properties: {
        summary: { type: "string" },
        agreements: { type: "array", maxItems: 100, items: { type: "string" } },
        disagreements: { type: "array", maxItems: 100, items: { type: "string" } },
        warnings: { type: "array", maxItems: 100, items: { type: "string" } }
      }
    },
    operations: {
      type: "array", maxItems: 100,
      items: {
        type: "object", additionalProperties: false,
        required: ["operationId", "stage", "labelId", "command", "targetEntityType", "targetId", "payloadJson", "proposedOutputJson"],
        properties: {
          operationId: { type: "string", minLength: 1, maxLength: 120 },
          stage: { type: "string", enum: STAGES },
          labelId: { type: ["string", "null"] },
          command: { type: "string", enum: COMMANDS },
          targetEntityType: { type: ["string", "null"], enum: [...ENTITY_TYPES, null] },
          targetId: { type: ["string", "null"] },
          payloadJson: { type: "string" },
          proposedOutputJson: { type: "string" }
        }
      }
    },
    reason: { type: "string", maxLength: 2000 }
  },
  $defs: {
    region: {
      type: "object", additionalProperties: false,
      required: ["kind", "description", "normalizedQuad", "text", "confidence"],
      properties: {
        kind: { type: "string", enum: ["package", "label", "text", "graphic", "unknown"] },
        description: { type: "string" },
        normalizedQuad: { anyOf: [{ type: "array", minItems: 8, maxItems: 8, items: { type: "number", minimum: 0, maximum: 1 } }, { type: "null" }] },
        text: { type: ["string", "null"] },
        confidence: { type: "number", minimum: 0, maximum: 1 }
      }
    }
  }
};

export class ConfigurationError extends Error {}
export class UpstreamError extends Error {
  constructor(message, evidence = null) {
    super(message);
    this.name = "UpstreamError";
    this.evidence = evidence;
  }
}

export function normalizeResult(raw, response, model, provider, controllerId) {
  const value = asObject(raw);
  if (!["planned", "no_action"].includes(value.status)) throw new UpstreamError(`${provider} structured output has an invalid status`);
  const operations = asArray(value.operations).map(normalizeOperation);
  if (value.status === "planned" && operations.length === 0) throw new UpstreamError(`A planned ${provider} response must contain operations`);
  if (value.status === "no_action" && operations.length > 0) throw new UpstreamError(`A no_action ${provider} response cannot contain operations`);
  const result = {
    status: value.status,
    controller: { id: controllerId, version: "1", model, promptVersion: PROMPT_VERSION },
    interactionMode: ["auto", "manual", "mixed"].includes(value.interactionMode) ? value.interactionMode : "mixed",
    proposedOutput: {
      visionHypothesis: asObject(value.visionHypothesis),
      comparison: asObject(value.comparison),
      [provider]: {
        responseId: asString(response?.id),
        model: asString(response?.model) || model,
        usage: asObject(response?.usage),
        promptVersion: PROMPT_VERSION
      }
    },
    operations
  };
  if (value.status === "planned") result.continueOnError = false;
  else result.reason = asString(value.reason) || `The ${provider} controller found no safe correction to propose.`;
  return result;
}

function normalizeOperation(raw) {
  const value = asObject(raw);
  const operation = {
    operationId: asString(value.operationId),
    stage: value.stage,
    command: value.command,
    payload: parseJsonObject(value.payloadJson, "payloadJson")
  };
  const labelId = asString(value.labelId);
  if (labelId) operation.labelId = labelId;
  const targetId = asString(value.targetId);
  if (ENTITY_TYPES.includes(value.targetEntityType) && targetId) operation.target = { entityType: value.targetEntityType, id: targetId };
  const proposedOutput = parseJsonObject(value.proposedOutputJson, "proposedOutputJson");
  if (Object.keys(proposedOutput).length) operation.proposedOutput = proposedOutput;
  return operation;
}

function parseJsonObject(value, field) {
  let parsed;
  try { parsed = JSON.parse(typeof value === "string" && value.trim() ? value : "{}"); }
  catch { throw new UpstreamError(`${field} is not valid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UpstreamError(`${field} must encode a JSON object`);
  return parsed;
}

export const asObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
export const asArray = (value) => Array.isArray(value) ? value : [];
export const asString = (value) => typeof value === "string" ? value.trim() : "";
export const intEnv = (name, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Math.max(minimum, Math.min(maximum, Number.isFinite(parsed) ? parsed : fallback));
};
