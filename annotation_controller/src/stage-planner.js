import OpenAI from "openai";
import { ConfigurationError, UpstreamError, asObject, asString, intEnv } from "./contract.js";
import { STAGE_DECISION_PROMPT_VERSION, STAGE_SYSTEM_PROMPT, stageDecisionResult, stageDecisionSchema, validateStageObservation } from "./stage-decision.js";

export async function evaluateStage(payload, backend, client, signal) {
  const observation = validateStageObservation(asObject(payload.stageObservation));
  if (backend === "deterministic") return deterministicDecision(observation);
  if (backend === "openai") return evaluateOpenAI(observation, client, signal);
  if (backend === "qwen") return evaluateQwen(observation, client, signal);
  throw new ConfigurationError("Unsupported controller backend");
}

async function evaluateOpenAI(observation, client, signal) {
  const apiKey = asString(process.env.OPENAI_API_KEY);
  if (!client && !apiKey) throw new ConfigurationError("OPENAI_API_KEY is not configured");
  const model = asString(process.env.OPENAI_MODEL) || "gpt-5.6-terra";
  const openai = client ?? new OpenAI({ apiKey, timeout: timeout("OPENAI_TIMEOUT_SECONDS"), maxRetries: intEnv("OPENAI_MAX_RETRIES", 2, 0, 5) });
  let response;
  try {
    response = await openai.responses.create({
      model, instructions: STAGE_SYSTEM_PROMPT,
      input: [{ role: "user", content: content(observation, "input_text", "input_image") }],
      text: { format: { type: "json_schema", name: "vinedetect_stage_decision", strict: true, schema: stageDecisionSchema(observation) }, verbosity: "low" },
      reasoning: { effort: asString(process.env.OPENAI_REASONING_EFFORT) || "low" },
      max_output_tokens: stageOutputTokens("OPENAI_MAX_OUTPUT_TOKENS", observation), store: false,
      metadata: { component: "vinedetect-stage-review", prompt_version: STAGE_DECISION_PROMPT_VERSION },
    }, { signal });
  } catch (error) { throw new UpstreamError(`OpenAI Responses request failed: ${error?.constructor?.name ?? "Error"}`); }
  return stageDecisionResult(parse(response?.output_text, "OpenAI"), response, observation, model, "openai", "vinedetect-openai-stage-controller");
}

async function evaluateQwen(observation, client, signal) {
  const apiKey = asString(process.env.QWEN_API_KEY) || asString(process.env.DASHSCOPE_API_KEY);
  const baseURL = asString(process.env.QWEN_BASE_URL);
  if (!client && !apiKey) throw new ConfigurationError("QWEN_API_KEY or DASHSCOPE_API_KEY is not configured");
  if (!client && !baseURL) throw new ConfigurationError("QWEN_BASE_URL is not configured");
  const model = asString(process.env.QWEN_MODEL) || "qwen3.7-flash";
  const qwen = client ?? new OpenAI({ apiKey, baseURL: baseURL.replace(/\/$/, ""), timeout: timeout("QWEN_TIMEOUT_SECONDS"), maxRetries: intEnv("QWEN_MAX_RETRIES", 2, 0, 5) });
  if ((asString(process.env.QWEN_STAGE_TRANSPORT) || "chat").toLowerCase() === "responses") {
    return evaluateQwenResponses(observation, qwen, model, signal);
  }
  const messages = [{ role: "system", content: STAGE_SYSTEM_PROMPT }, { role: "user", content: content(observation, "text", "image_url") }];
  let previousRaw = null;
  let previousError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await qwen.chat.completions.create({
        model,
        messages: attempt === 0 ? messages : [...messages,
          { role: "assistant", content: JSON.stringify(previousRaw) },
          { role: "user", content: repairPrompt(previousError, observation) },
        ],
        // DashScope Singapore currently supports JSON object mode but not JSON
        // Schema mode. validateStageDecision remains the strict local boundary.
        response_format: { type: "json_object" },
        max_tokens: stageOutputTokens("QWEN_MAX_OUTPUT_TOKENS", observation),
      }, { signal });
    } catch (error) { throw new UpstreamError(`Qwen Chat Completions request failed: ${providerError(error)}`); }
    const rawText = contentText(response?.choices?.[0]?.message?.content);
    let raw;
    try { raw = parse(rawText, "Qwen"); }
    catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      previousRaw = { unparsedOutput: rawText.slice(0, 4000) };
      previousError = error.message;
      if (attempt === 1) throw withRawDecisionEvidence(error, previousRaw, response, attempt + 1);
      continue;
    }
    try {
      return stageDecisionResult(normalizeDecisionForStage(raw, observation), response, observation, model, "qwen", "vinedetect-qwen-stage-controller");
    } catch (error) {
      if (!(error instanceof UpstreamError)) throw error;
      previousRaw = raw;
      previousError = error.message;
      if (attempt === 1) throw withRawDecisionEvidence(error, raw, response, attempt + 1);
    }
  }
  throw new UpstreamError("Qwen decision repair failed");
}

async function evaluateQwenResponses(observation, qwen, model, signal) {
  const session = asObject(asObject(observation.context).llmSession);
  let conversationId = asString(session.providerConversationId);
  const startedAt = Date.now();
  try {
    if (!conversationId) {
      const initialized = await initializeQwenConversation({
        llmSessionId: asString(session.llmSessionId), annotationId: asString(observation.annotationId),
      }, qwen, signal);
      conversationId = initialized.conversationId;
      if (!conversationId) throw new Error("Qwen conversation creation returned no id");
    }
    let previousError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await qwen.responses.create({
        model,
        conversation: conversationId,
        instructions: STAGE_SYSTEM_PROMPT,
        input: [{ role: "user", content: attempt === 0
          ? content(observation, "input_text", "input_image")
          : [{ type: "input_text", text: repairPrompt(previousError, observation) }]
        }],
        max_output_tokens: stageOutputTokens("QWEN_MAX_OUTPUT_TOKENS", observation),
        store: true,
      }, { signal });
      response.__providerConversationId = conversationId;
      response.__latencyMs = Date.now() - startedAt;
      const rawText = asString(response?.output_text);
      let raw;
      try { raw = parse(rawText, "Qwen"); }
      catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        previousError = error.message;
        if (attempt === 1) throw withRawDecisionEvidence(error, { unparsedOutput: rawText.slice(0, 4000) }, response, attempt + 1);
        continue;
      }
      try {
        return stageDecisionResult(normalizeDecisionForStage(raw, observation), response, observation, model, "qwen", "vinedetect-qwen-stage-controller");
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        previousError = error.message;
        if (attempt === 1) throw withRawDecisionEvidence(error, raw, response, attempt + 1);
      }
    }
    throw new UpstreamError("Qwen decision repair failed");
  } catch (error) {
    if (error instanceof UpstreamError && error.evidence) throw error;
    throw new UpstreamError(`Qwen Responses request failed: ${providerError(error)}`);
  }
}

export async function initializeQwenConversation(payload, client, signal) {
  const apiKey = asString(process.env.QWEN_API_KEY) || asString(process.env.DASHSCOPE_API_KEY);
  const baseURL = asString(process.env.QWEN_BASE_URL);
  if (!client && !apiKey) throw new ConfigurationError("QWEN_API_KEY or DASHSCOPE_API_KEY is not configured");
  if (!client && !baseURL) throw new ConfigurationError("QWEN_BASE_URL is not configured");
  if ((asString(process.env.QWEN_STAGE_TRANSPORT) || "chat").toLowerCase() !== "responses") {
    return { schemaVersion: 1, status: "unavailable", provider: "qwen", conversationId: null, model: asString(process.env.QWEN_MODEL) || "qwen3.7-flash", reason: "QWEN_STAGE_TRANSPORT is not responses" };
  }
  const qwen = client ?? new OpenAI({ apiKey, baseURL: baseURL.replace(/\/$/, ""), timeout: timeout("QWEN_TIMEOUT_SECONDS"), maxRetries: intEnv("QWEN_MAX_RETRIES", 2, 0, 5) });
  try {
    const conversation = await qwen.conversations.create({
      metadata: {
        component: "vinedetect-card-session",
        llm_session_id: asString(payload.llmSessionId).slice(0, 64),
        annotation_id: asString(payload.annotationId).slice(0, 64),
      },
    }, { signal });
    const conversationId = asString(conversation?.id);
    if (!conversationId) throw new Error("Qwen conversation creation returned no id");
    return { schemaVersion: 1, status: "attached", provider: "qwen", conversationId, model: asString(process.env.QWEN_MODEL) || "qwen3.7-flash" };
  } catch (error) { throw new UpstreamError(`Qwen Conversation initialization failed: ${providerError(error)}`); }
}

function content(observation, textType, imageType) {
  const visuals = asObject(observation.visuals);
  const source = asString(asObject(visuals.sourcePreview).dataUrl);
  const inputMask = asString(asObject(visuals.inputMask).dataUrl);
  const overlay = asString(asObject(visuals.candidateOverlay).dataUrl);
  const rectificationCandidates = Array.isArray(visuals.rectificationCandidates)
    ? visuals.rectificationCandidates.map(asObject).filter((item) => asString(item.dataUrl).startsWith("data:image/"))
    : [];
  const withoutImages = { ...observation, visuals: { renderer: asObject(visuals.renderer) } };
  const image = (url) => imageType === "input_image" ? { type: imageType, image_url: url, detail: "high" } : { type: imageType, image_url: { url } };
  const outputSchema = stageDecisionSchema(observation);
  return [
    { type: textType, text: `Clean ${observation.stage} stage input preview.` }, image(source),
    ...(inputMask.startsWith("data:image/") ? [{ type: textType, text: "Morphology input mask before any candidate transform." }, image(inputMask)] : []),
    { type: textType, text: observation.stage === "morphology"
      ? "Morphology candidate comparison board. Candidate IDs exactly match the structured observation; white is preserved, green added, red removed, dark background."
      : `${observation.stage} helper output. Visible IDs exactly match the structured observation.` }, image(overlay),
    ...rectificationCandidates.flatMap((candidate) => [
      { type: textType, text: `Rectification candidate ${asString(candidate.id)} (${asString(candidate.mode) || "unspecified mode"}). Evaluate this rendered Label-wide OCR input using the same immutable candidate ID.` },
      image(asString(candidate.dataUrl)),
    ]),
    { type: textType, text: `Required output: one JSON object matching this schema exactly. The stage and action enums below are authoritative for this runtime state.\nOutput JSON Schema:\n${JSON.stringify(outputSchema)}\nStageObservation:\n${JSON.stringify(withoutImages)}` },
  ];
}

function deterministicDecision(observation) {
  return {
    schemaVersion: 1, status: "decided",
    controller: { id: "vinedetect-reference-stage-controller", version: "1", model: "deterministic-review-boundary", promptVersion: STAGE_DECISION_PROMPT_VERSION },
    adapter: { id: "vision-stage-adapter-v3", stage: observation.stage, provider: "deterministic" },
    observationId: asString(observation.observationId),
    decision: { schemaVersion: 1, stage: observation.stage, action: "human_required", candidateId: null, confidence: 1, flags: ["human_judgment_required"], paramsPatch: null, reviews: [], topologyEdits: [], editOperations: [] },
    providerEvidence: { responseId: "", model: "deterministic-review-boundary", usage: {} },
  };
}

function timeout(name) { return intEnv(name, 120, 10, 300) * 1000; }
function stageOutputTokens(name, observation) {
  const fallback = observation.stage === "ocr" ? 4000 : ["label", "components", "elements"].includes(observation.stage) ? 2000 : 1000;
  return intEnv(name, fallback, 128, 16000);
}
function parse(value, provider) { try { return JSON.parse(asString(value)); } catch { throw new UpstreamError(`${provider} structured output was not valid JSON`); } }
function providerError(error) {
  const status = Number.isInteger(error?.status) ? `HTTP ${error.status}` : "HTTP error";
  const code = asString(error?.code || error?.error?.code);
  const message = asString(error?.error?.message || error?.message);
  return [status, code, message].filter(Boolean).join(" · ").slice(0, 800);
}
function contentText(value) { if (typeof value === "string") return value.trim(); if (!Array.isArray(value)) return ""; return value.map((item) => asString(item?.text)).join("").trim(); }

function normalizeDecisionForStage(raw, observation) {
  const value = asObject(raw);
  const action = asString(value.action).trim().toLowerCase().replace(/[\s-]+/g, "_");
  const normalized = action === "rerun" ? value : { ...value, paramsPatch: null };
  if (["accept", "accepted", "approve", "approved", "select", "selected"].includes(action)) {
    return { ...normalized, reviews: [], topologyEdits: [], editOperations: [] };
  }
  if (["human_required", "human", "needs_review", "manual_review"].includes(action)) {
    return { ...normalized, candidateId: null, paramsPatch: null, reviews: [], topologyEdits: [], editOperations: [] };
  }
  if (action === "rerun") {
    return { ...normalized, candidateId: null, reviews: [], topologyEdits: [], editOperations: [] };
  }
  if (observation.stage === "label" && action === "review" && Array.isArray(value.editOperations) && value.editOperations.length) {
    const editOperations = normalizeLabelEditOperations(value.editOperations, observation);
    const candidateIds = new Set((Array.isArray(observation.candidates) ? observation.candidates : []).map((candidate) => asString(candidate?.id)));
    const selectedCandidateId = candidateIds.has(asString(value.candidateId))
      ? asString(value.candidateId)
      : editOperations.flatMap((operation) => Array.isArray(operation.inputIds) ? operation.inputIds : []).map(asString).find((id) => candidateIds.has(id)) ?? null;
    return { ...normalized, candidateId: selectedCandidateId, reviews: [], topologyEdits: [], editOperations };
  }
  if (observation.stage === "ocr" && action === "review" && Array.isArray(value.editOperations)) {
    return { ...normalized, reviews: [], topologyEdits: [], editOperations: normalizeOcrEditOperations(value.editOperations, observation) };
  }
  if (action === "review" && ["components", "elements"].includes(observation.stage)) {
    const reviews = normalizeGranularReviewIds(value.reviews, observation);
    const topologyEdits = Array.isArray(value.topologyEdits) ? value.topologyEdits : [];
    const editOperations = Array.isArray(value.editOperations) ? value.editOperations : [];
    // A model sometimes describes defects in flags while emitting an empty
    // review program. That is useful diagnostic evidence, but it is not an
    // executable review and must stop at the human boundary instead of 502ing.
    if (!reviews.length && !topologyEdits.length && !editOperations.length) {
      return { ...normalized, action: "human_required", candidateId: null, paramsPatch: null, reviews: [], topologyEdits: [], editOperations: [] };
    }
    if (observation.stage === "components") {
      return { ...normalized, reviews: reviews.map((review) => ({ ...review, text: null, transcriptionStatus: null, type: null, role: null })) };
    }
    return { ...normalized, reviews: reviews.map((review) => ({ ...review, text: null, transcriptionStatus: null })) };
  }
  return normalized;
}

function normalizeGranularReviewIds(reviews, observation) {
  if (!Array.isArray(reviews)) return [];
  const targets = (Array.isArray(observation.reviewTargets) ? observation.reviewTargets : []).map(asObject);
  const aliases = new Map();
  const addAlias = (alias, id) => {
    const key = asString(alias).trim().toLowerCase();
    if (!key) return;
    if (!aliases.has(key)) aliases.set(key, id);
    else if (aliases.get(key) !== id) aliases.set(key, null);
  };
  targets.forEach((target, index) => {
    const id = asString(target.id);
    const ordinal = index + 1;
    addAlias(id, id);
    addAlias(target.displayId, id);
    addAlias(target.displayIndex, id);
    addAlias(String(ordinal), id);
    addAlias(`${observation.stage === "components" ? "c" : "e"}${ordinal}`, id);
  });
  return reviews.map((source) => {
    const review = asObject(source);
    const suppliedId = asString(review.id);
    const canonicalId = aliases.get(suppliedId.trim().toLowerCase());
    return { ...review, id: canonicalId || suppliedId };
  });
}

function normalizeLabelEditOperations(operations, observation) {
  const candidateIds = new Set((Array.isArray(observation.candidates) ? observation.candidates : []).map((candidate) => asString(candidate?.id)));
  const normalizeInput = (input) => {
    const id = asString(input);
    if (!id.startsWith("candidate:")) return id;
    const candidateId = id.slice("candidate:".length);
    return candidateIds.has(candidateId) ? candidateId : id;
  };
  return operations.map((operation) => {
    const value = asObject(operation);
    const type = asString(value.type);
    return {
      ...value,
      inputIds: Array.isArray(value.inputIds) ? value.inputIds.map(normalizeInput) : value.inputIds,
      adjustment: type === "edit" ? value.adjustment ?? null : null,
    };
  });
}

function normalizeOcrEditOperation(operation) {
  const value = asObject(operation);
  const type = asString(value.type);
  return {
    ...value,
    adjustment: type === "edit_region" ? value.adjustment ?? null : null,
    geometry: type === "create_region" ? value.geometry ?? null : null,
    text: ["edit_text", "create_region"].includes(type) ? value.text ?? null : null,
    transcriptionStatus: ["edit_text", "create_region", "set_status"].includes(type) ? value.transcriptionStatus ?? null : null,
    split: type === "split_region" ? value.split ?? null : null,
    composition: type === "compose_string" ? value.composition ?? null : null,
  };
}

function normalizeOcrEditOperations(operations, observation) {
  const expanded = [];
  const remappedIds = new Map();
  const sources = operations.map(asObject);
  // Models often emit a broad noise rejection first and then rescue a subset
  // with an edit/approval. The later constructive operation wins.
  const constructivelyUsedInputs = new Set(sources.flatMap((source) =>
    asString(source.type) === "reject" || !Array.isArray(source.inputIds) ? [] : source.inputIds.map(asString)));
  const priorOperations = Array.isArray(observation?.context?.priorEditOperations) ? observation.context.priorEditOperations.map(asObject) : [];
  const reservedIds = new Set(priorOperations.map((operation) => asString(operation.operationId)).filter(Boolean));
  let sequence = priorOperations.reduce((maximum, operation) => {
    const match = /^op-([1-9][0-9]?)$/.exec(asString(operation.operationId));
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  const nextOperationId = () => {
    let id;
    do { sequence += 1; id = `op-${sequence}`; } while (reservedIds.has(id));
    reservedIds.add(id);
    return id;
  };
  const remapInput = (input) => {
    const id = asString(input);
    const split = /^(op-[1-9][0-9]?):([1-4])$/.exec(id);
    if (split && remappedIds.has(split[1])) return `${remappedIds.get(split[1])}:${split[2]}`;
    return remappedIds.get(id) ?? id;
  };
  for (const source of sources) {
    const oldId = asString(source.operationId);
    const type = asString(source.type);
    const originalInputs = Array.isArray(source.inputIds) ? source.inputIds.map(asString) : [];
    const retainedInputs = type === "reject" ? originalInputs.filter((input) => !constructivelyUsedInputs.has(input)) : originalInputs;
    const inputs = [...new Set(retainedInputs.map(remapInput))];
    if (type === "reject" && !inputs.length) continue;
    if (["reject", "approve_region", "approve_text"].includes(type) && inputs.length > 1) {
      for (const input of inputs) expanded.push(normalizeOcrEditOperation({ ...source, operationId: nextOperationId(), inputIds: [input] }));
      continue;
    }
    if (type === "edit_text" && inputs.length > 1) {
      const mergeOperationId = nextOperationId();
      expanded.push(normalizeOcrEditOperation({ ...source, operationId: mergeOperationId, type: "merge_region", inputIds: inputs }));
      const editOperationId = nextOperationId();
      remappedIds.set(oldId, editOperationId);
      for (const input of originalInputs) remappedIds.set(input, editOperationId);
      expanded.push(normalizeOcrEditOperation({ ...source, operationId: editOperationId, inputIds: [mergeOperationId] }));
      continue;
    }
    if (["merge_region", "compose_string"].includes(type) && inputs.length === 1) {
      remappedIds.set(oldId, inputs[0]);
      continue;
    }
    const operationId = nextOperationId();
    remappedIds.set(oldId, operationId);
    if (["edit_region", "edit_text", "merge_region", "set_status"].includes(type)) {
      for (const input of originalInputs) remappedIds.set(input, operationId);
    }
    expanded.push(normalizeOcrEditOperation({ ...source, operationId, inputIds: inputs }));
  }
  return expanded;
}

function repairPrompt(error, observation) {
  return `Your previous JSON was rejected by the deterministic contract validator: ${asString(error).slice(0, 500)}. Return one corrected JSON object only. Use stage=${observation.stage}; allowed actions are ${JSON.stringify(asObject(observation.policy).allowedActions ?? [])}. Do not retain fields forbidden by the selected action.`;
}

function withRawDecisionEvidence(error, raw, response, attempts) {
  error.evidence = {
    validationError: error.message,
    repairAttempts: attempts,
    rawProviderResponse: sanitizeEvidence(raw),
    providerResponseId: asString(response?.id) || null,
    providerRequestId: asString(response?._request_id || response?.request_id) || null,
  };
  return error;
}

function sanitizeEvidence(value, depth = 0) {
  if (depth > 6) return "[depth-limit]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeEvidence(item, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(asObject(value)).slice(0, 100)) {
    if (/token|secret|authorization|api.?key|data.?url|image/i.test(key)) continue;
    result[key] = sanitizeEvidence(item, depth + 1);
  }
  return result;
}
