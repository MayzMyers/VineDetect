import assert from "node:assert/strict";
import test from "node:test";
import { evaluateStage, initializeQwenConversation } from "../src/stage-planner.js";
import { stageDecisionSchema, validateStageDecision, validateStageObservation } from "../src/stage-decision.js";

const observation = () => ({
  schemaVersion: 1, observationId: "19a35e8b-bfad-48bb-a563-56948873587c", stage: "label",
  candidates: [
    { id: "label-a", rank: 1, score: 0.91 },
    { id: "label-b", rank: 2, score: 0.72 },
  ],
  policy: { allowedActions: ["accept", "human_required"], paramsPatchAllowed: false },
  visuals: {
    sourcePreview: { dataUrl: "data:image/webp;base64,c291cmNl" },
    candidateOverlay: { dataUrl: "data:image/webp;base64,b3ZlcmxheQ==" },
  },
});

const packageObservation = () => ({
  ...observation(), stage: "package",
  candidates: [
    {
      id: "border-flood-1", rank: 1, score: 0.91,
      geometry: { type: "quad", points: [{ x: 10, y: 5 }, { x: 90, y: 5 }, { x: 90, y: 195 }, { x: 10, y: 195 }], bbox: { x: 10, y: 5, width: 80, height: 190 } },
      features: { classification: { type: "bottle", confidence: 0.88 }, contourMetrics: { solidity: 0.8 } },
    },
    { id: "package-count:multiple", rank: 2, score: null, features: { multiplicity: "multiple" } },
  ],
});

test("deterministic adapter preserves the human review boundary", async () => {
  const result = await evaluateStage({ stageObservation: observation() }, "deterministic");
  assert.equal(result.decision.action, "human_required");
  assert.equal(result.decision.candidateId, null);
});

test("Qwen stage adapter receives two images and returns a bounded candidate decision", async () => {
  const requests = [];
  const client = { chat: { completions: { create: async (request) => {
    requests.push(request);
    return { id: "qwen-stage", model: "qwen-test", choices: [{ message: { content: JSON.stringify({ stage: "label", action: "accept", candidateId: "label-a", confidence: 0.93, flags: ["clear_best_candidate"], paramsPatch: null, reviews: [], topologyEdits: [] }) } }], usage: { total_tokens: 50 } };
  } } } };
  const previous = process.env.QWEN_MODEL; process.env.QWEN_MODEL = "qwen-test";
  try {
    const result = await evaluateStage({ stageObservation: observation() }, "qwen", client);
    assert.equal(result.decision.candidateId, "label-a");
    assert.equal(requests[0].messages[1].content.filter((item) => item.type === "image_url").length, 2);
    assert.equal(requests[0].response_format.type, "json_object");
    assert.match(requests[0].messages[1].content.at(-1).text, /Output JSON Schema/);
  } finally { if (previous === undefined) delete process.env.QWEN_MODEL; else process.env.QWEN_MODEL = previous; }
});

test("Qwen adapter removes review payload accidentally attached to accept", async () => {
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls += 1;
    return { id: "qwen-accept-cleanup", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "label", action: "accept", candidateId: "label-a", confidence: 0.93,
      flags: ["clear_best_candidate"], paramsPatch: null,
      reviews: [{ id: "invented", state: "accepted" }], topologyEdits: [{ componentId: 1 }], editOperations: [{ operationId: "bad" }],
    }) } }] };
  } } } };
  const result = await evaluateStage({ stageObservation: observation() }, "qwen", client);
  assert.equal(calls, 1);
  assert.equal(result.decision.action, "accept");
  assert.deepEqual(result.decision.reviews, []);
  assert.deepEqual(result.decision.topologyEdits, []);
  assert.deepEqual(result.decision.editOperations, []);
});

test("Qwen adapter canonicalizes a diagnostic candidate attached to human_required", async () => {
  let calls = 0;
  const client = { chat: { completions: { create: async () => {
    calls += 1;
    return { id: "qwen-human-cleanup", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "label", action: "human_required", candidateId: "label-a", confidence: 0.58,
      flags: ["human_judgment_required"], paramsPatch: { adjustment: "tighten_region", strength: "small" },
      reviews: [{ id: "label-a", state: "accepted" }], topologyEdits: [{ componentId: 1 }], editOperations: [{ operationId: "bad" }],
    }) } }] };
  } } } };
  const result = await evaluateStage({ stageObservation: observation() }, "qwen", client);
  assert.equal(calls, 1);
  assert.equal(result.decision.action, "human_required");
  assert.equal(result.decision.candidateId, null);
  assert.equal(result.decision.paramsPatch, null);
  assert.deepEqual(result.decision.reviews, []);
  assert.deepEqual(result.decision.topologyEdits, []);
  assert.deepEqual(result.decision.editOperations, []);
});

test("Qwen adapter turns an empty Components review into a human boundary", async () => {
  const value = {
    ...observation(), stage: "components",
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
    reviewTargets: [{ id: "component-uuid", displayId: "C1", displayIndex: 1 }],
  };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-empty-components-review", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "components", action: "review", candidateId: "label-a", confidence: .95,
      flags: ["excessive_noise", "missing_regions"], paramsPatch: null,
      reviews: [], topologyEdits: [], editOperations: [],
    }) } }], usage: {},
  }) } } };

  const result = await evaluateStage({ stageObservation: value }, "qwen", client);

  assert.equal(result.decision.action, "human_required");
  assert.equal(result.decision.candidateId, null);
  assert.deepEqual(result.decision.flags, ["excessive_noise", "missing_regions"]);
});

test("Qwen adapter maps an ordinal Elements review ID to its canonical target", async () => {
  const value = {
    ...observation(), stage: "elements",
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
    reviewTargets: [
      { id: "element-uuid-a", displayId: "E1", displayIndex: 1 },
      { id: "element-uuid-b", displayId: "E2", displayIndex: 2 },
    ],
  };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-ordinal-elements-review", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "elements", action: "review", candidateId: "label-a", confidence: .91,
      flags: ["wrong_region"], paramsPatch: null,
      reviews: [{ id: "1", state: "rejected", text: "excess background", transcriptionStatus: null, type: null, role: null }],
      topologyEdits: [], editOperations: [],
    }) } }], usage: {},
  }) } } };

  const result = await evaluateStage({ stageObservation: value }, "qwen", client);

  assert.equal(result.decision.action, "review");
  assert.equal(result.decision.reviews[0].id, "element-uuid-a");
  assert.equal(result.decision.reviews[0].text, null);
});

test("Qwen adapter performs one bounded repair after a policy violation", async () => {
  const requests = [];
  const decisions = [
    { stage: "label", action: "review", candidateId: "label-a", confidence: 0.7, flags: [], paramsPatch: null, reviews: [], topologyEdits: [], editOperations: [] },
    { stage: "label", action: "accept", candidateId: "label-a", confidence: 0.9, flags: ["clear_best_candidate"], paramsPatch: null, reviews: [], topologyEdits: [], editOperations: [] },
  ];
  const client = { chat: { completions: { create: async (request) => {
    requests.push(request);
    return { id: `qwen-repair-${requests.length}`, model: "qwen-test", choices: [{ message: { content: JSON.stringify(decisions.shift()) } }] };
  } } } };
  const result = await evaluateStage({ stageObservation: observation() }, "qwen", client);
  assert.equal(requests.length, 2);
  assert.equal(result.decision.action, "accept");
  assert.match(requests[1].messages.at(-1).content, /rejected by the deterministic contract validator/);
  assert.match(requests[1].messages.at(-1).content, /allowed actions/);
});

test("Qwen adapter drops legacy Label reviews when an Edit Engine program is present", async () => {
  let calls = 0;
  const value = {
    ...observation(),
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
    operation: { candidates: [{ id: "label-a" }, { id: "label-b" }] },
    editEngine: { primitives: ["accept", "reject", "edit", "merge"] },
  };
  const client = { chat: { completions: { create: async () => {
    calls += 1;
    return { id: "qwen-label-edit", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "label", action: "review", candidateId: "label-a", confidence: 0.9, flags: [], paramsPatch: null,
      reviews: [{ id: "label-a", state: "accepted", text: "catalog text", transcriptionStatus: "verified", type: "text", role: "product_name" }],
      topologyEdits: [], editOperations: [{ operationId: "op-1", type: "accept", inputIds: ["label-a"], adjustment: null }],
    }) } }] };
  } } } };
  const result = await evaluateStage({ stageObservation: value }, "qwen", client);
  assert.equal(calls, 1);
  assert.equal(result.decision.action, "review");
  assert.deepEqual(result.decision.reviews, []);
  assert.equal(result.decision.editOperations.length, 1);
});

test("Qwen adapter maps Label edit-state candidate node IDs to executable candidate IDs", async () => {
  const value = {
    ...observation(),
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
    operation: { candidates: [{ id: "label-a" }, { id: "label-b" }] },
    editEngine: { primitives: ["accept", "reject", "edit", "merge"] },
  };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-label-prefixed-node", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "label", action: "review", candidateId: "label-a", confidence: .9, flags: [], paramsPatch: null,
      reviews: [], topologyEdits: [], editOperations: [
        { operationId: "op-1", type: "accept", inputIds: ["candidate:label-a"], adjustment: null },
      ],
    }) } }], usage: {},
  }) } } };
  const result = await evaluateStage({ stageObservation: value }, "qwen", client);
  assert.deepEqual(result.decision.editOperations[0].inputIds, ["label-a"]);
});

test("Qwen adapter attaches a sanitized raw decision after failed repair", async () => {
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-invalid", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "label", action: "review", candidateId: "label-a", confidence: 0.7,
      flags: [], paramsPatch: null, reviews: [], topologyEdits: [], editOperations: [], secretToken: "must-not-survive",
    }) } }],
  }) } } };
  await assert.rejects(
    () => evaluateStage({ stageObservation: observation() }, "qwen", client),
    (error) => {
      assert.equal(error.evidence.repairAttempts, 2);
      assert.equal(error.evidence.rawProviderResponse.action, "review");
      assert.equal("secretToken" in error.evidence.rawProviderResponse, false);
      return true;
    },
  );
});

test("Qwen adapter repairs syntactically invalid JSON once", async () => {
  const outputs = [
    '{"stage":"label","action":"accept"',
    JSON.stringify({ stage: "label", action: "accept", candidateId: "label-a", confidence: 0.9, flags: [], paramsPatch: null, reviews: [], topologyEdits: [], editOperations: [] }),
  ];
  const requests = [];
  const client = { chat: { completions: { create: async (request) => {
    requests.push(request);
    return { id: `qwen-json-${requests.length}`, model: "qwen-test", choices: [{ message: { content: outputs.shift() } }] };
  } } } };
  const result = await evaluateStage({ stageObservation: observation() }, "qwen", client);
  assert.equal(requests.length, 2);
  assert.equal(result.decision.action, "accept");
  assert.match(requests[1].messages.at(-1).content, /not valid JSON/);
});

test("Morphology review sends source, input mask, and stable-ID comparison board", async () => {
  const requests = [];
  const client = { chat: { completions: { create: async (request) => {
    requests.push(request);
    return { id: "qwen-morphology", model: "qwen-test", choices: [{ message: { content: JSON.stringify({ stage: "morphology", action: "accept", candidateId: "morph-identity", confidence: 0.88, flags: ["clear_best_candidate"], paramsPatch: null, reviews: [], topologyEdits: [], editOperations: [] }) } }], usage: {} };
  } } } };
  const value = {
    ...observation(), stage: "morphology",
    candidates: [{ id: "morph-identity", rank: 1, score: 0.5 }, { id: "morph-close-weak", rank: 2, score: 0.7 }],
    visuals: { ...observation().visuals, inputMask: { dataUrl: "data:image/webp;base64,bWFzaw==" } },
  };
  const previous = process.env.QWEN_MODEL; process.env.QWEN_MODEL = "qwen-test";
  try {
    const result = await evaluateStage({ stageObservation: value }, "qwen", client);
    assert.equal(result.decision.candidateId, "morph-identity");
    const content = requests[0].messages[1].content;
    assert.equal(content.filter((item) => item.type === "image_url").length, 3);
    assert.match(content.find((item) => item.text?.includes("comparison board"))?.text ?? "", /white.*green.*red/i);
  } finally { if (previous === undefined) delete process.env.QWEN_MODEL; else process.env.QWEN_MODEL = previous; }
});

test("Mask review ranks immutable visual candidates instead of returning raw threshold parameters", async () => {
  const requests = [];
  const client = { chat: { completions: { create: async (request) => {
    requests.push(request);
    return { id: "qwen-mask", model: "qwen-test", choices: [{ message: { content: JSON.stringify({ stage: "mask", action: "accept", candidateId: "mask-dark-400-medium-144", confidence: 0.9, flags: ["clear_best_candidate"], paramsPatch: null, reviews: [], topologyEdits: [], editOperations: [] }) } }], usage: {} };
  } } } };
  const value = { ...observation(), stage: "mask", candidates: [
    { id: "mask-dark-400-medium-144", rank: 1, score: 0.8, features: { config: { threshold: 144, foregroundPolarity: "dark" } } },
    { id: "mask-light-400-medium-144", rank: 2, score: 0.6, features: { config: { threshold: 144, foregroundPolarity: "light" } } },
  ] };
  const previous = process.env.QWEN_MODEL; process.env.QWEN_MODEL = "qwen-test";
  try {
    const result = await evaluateStage({ stageObservation: value }, "qwen", client);
    assert.equal(result.decision.candidateId, "mask-dark-400-medium-144");
    assert.equal(result.decision.paramsPatch, null);
    assert.equal(requests[0].messages[1].content.filter((item) => item.type === "image_url").length, 2);
  } finally { if (previous === undefined) delete process.env.QWEN_MODEL; else process.env.QWEN_MODEL = previous; }
});

test("Qwen OCR normalization receives every candidate-specific rectified preview", async () => {
  const requests = [];
  const client = { chat: { completions: { create: async (request) => {
    requests.push(request);
    return { id: "qwen-rectification", model: "qwen-test", choices: [{ message: { content: JSON.stringify({ stage: "ocr", action: "accept", candidateId: "rectification-perspective-1", confidence: 0.91, flags: ["clear_best_candidate"], paramsPatch: null, reviews: [], topologyEdits: [], editOperations: [] }) } }], usage: { total_tokens: 80 } };
  } } } };
  const value = {
    ...observation(), stage: "ocr", phase: "label-normalization",
    candidates: [
      { id: "rectification-original", rank: 1, score: 0.5 },
      { id: "rectification-perspective-1", rank: 2, score: 0.9 },
    ],
    visuals: {
      ...observation().visuals,
      rectificationCandidates: [
        { id: "rectification-original", mode: "none", dataUrl: "data:image/webp;base64,b3JpZ2luYWw=" },
        { id: "rectification-perspective-1", mode: "perspective", dataUrl: "data:image/webp;base64,cGVyc3BlY3RpdmU=" },
      ],
    },
  };
  const previous = process.env.QWEN_MODEL; process.env.QWEN_MODEL = "qwen-test";
  try {
    const result = await evaluateStage({ stageObservation: value }, "qwen", client);
    assert.equal(result.decision.candidateId, "rectification-perspective-1");
    const content = requests[0].messages[1].content;
    assert.equal(content.filter((item) => item.type === "image_url").length, 4);
    assert.match(content.find((item) => item.text?.includes("rectification-original"))?.text ?? "", /Original|none/i);
    assert.match(content.find((item) => item.text?.includes("rectification-perspective-1"))?.text ?? "", /perspective/i);
  } finally { if (previous === undefined) delete process.env.QWEN_MODEL; else process.env.QWEN_MODEL = previous; }
});

test("OCR normalization rejects previews that are not bound to immutable candidates", () => {
  const value = {
    ...observation(), stage: "ocr", phase: "label-normalization",
    candidates: [{ id: "rectification-original", rank: 1, score: 0.5 }],
    visuals: {
      ...observation().visuals,
      rectificationCandidates: [{ id: "invented", mode: "perspective", dataUrl: "data:image/webp;base64,YmFk" }],
    },
  };
  assert.throws(() => validateStageObservation(value), /candidate IDs/);
});

test("Qwen Responses transport attaches one provider conversation to the card session", async () => {
  const requests = [];
  const client = {
    conversations: { create: async (request) => { requests.push({ conversation: request }); return { id: "conv-card-1" }; } },
    responses: { create: async (request) => {
      requests.push({ response: request });
      return {
        id: "resp-stage-1", model: "qwen-test",
        output_text: JSON.stringify({ stage: "label", action: "accept", candidateId: "label-a", confidence: 0.93, flags: ["clear_best_candidate"], paramsPatch: null, reviews: [], topologyEdits: [] }),
        usage: { input_tokens: 100, output_tokens: 20 },
      };
    } },
  };
  const previousTransport = process.env.QWEN_STAGE_TRANSPORT;
  const previousModel = process.env.QWEN_MODEL;
  Object.assign(process.env, { QWEN_STAGE_TRANSPORT: "responses", QWEN_MODEL: "qwen-test" });
  try {
    const value = observation();
    value.context = { llmSession: { llmSessionId: "session-1", providerConversationId: null } };
    const result = await evaluateStage({ stageObservation: value }, "qwen", client);
    assert.equal(result.providerEvidence.providerConversationId, "conv-card-1");
    assert.equal(requests[1].response.conversation, "conv-card-1");
    assert.equal(requests[1].response.input[0].content.filter((item) => item.type === "input_image").length, 2);
  } finally {
    if (previousTransport === undefined) delete process.env.QWEN_STAGE_TRANSPORT; else process.env.QWEN_STAGE_TRANSPORT = previousTransport;
    if (previousModel === undefined) delete process.env.QWEN_MODEL; else process.env.QWEN_MODEL = previousModel;
  }
});

test("Qwen conversation can be initialized eagerly before the first stage", async () => {
  const previousTransport = process.env.QWEN_STAGE_TRANSPORT;
  process.env.QWEN_STAGE_TRANSPORT = "responses";
  try {
    const result = await initializeQwenConversation({ llmSessionId: "session-1", annotationId: "annotation-1" }, {
      conversations: { create: async (request) => {
        assert.equal(request.metadata.llm_session_id, "session-1");
        return { id: "conv-eager-1" };
      } },
    });
    assert.equal(result.status, "attached");
    assert.equal(result.conversationId, "conv-eager-1");
  } finally {
    if (previousTransport === undefined) delete process.env.QWEN_STAGE_TRANSPORT; else process.env.QWEN_STAGE_TRANSPORT = previousTransport;
  }
});

test("decision validator normalizes only bounded stage and action aliases", () => {
  const result = validateStageDecision({
    stage: "Label ROI", action: "approved", candidateId: "label-a", confidence: 0.9,
    flags: [], paramsPatch: null, reviews: [], topologyEdits: [],
  }, observation());
  assert.equal(result.stage, "label");
  assert.equal(result.action, "accept");
  assert.throws(() => validateStageDecision({
    stage: "invented", action: "magic", candidateId: null, confidence: 0.9,
    flags: [], paramsPatch: null, reviews: [], topologyEdits: [],
  }, observation()), /received stage=invented, action=magic; expected stage=label/);
});

test("decision schema is scoped by the server-owned runtime policy", () => {
  const value = { ...observation(), policy: {
    allowedActions: ["accept", "rerun", "human_required"], paramsPatchAllowed: true,
    remainingLLMIterations: 1, allowedSemanticAdjustments: ["expand_region"],
  } };
  const schema = stageDecisionSchema(value);
  assert.deepEqual(schema.properties.stage.enum, ["label"]);
  assert.deepEqual(schema.properties.action.enum, ["accept", "rerun", "human_required"]);
  assert.deepEqual(schema.properties.candidateId.enum, ["label-a", "label-b", null]);
  assert.deepEqual(schema.properties.paramsPatch.oneOf[1].properties.adjustment.enum, ["expand_region"]);
});

test("Package LLM observation exposes bounded smart-lasso shapes and one multipackage gate", () => {
  const value = validateStageObservation(packageObservation());
  const schema = stageDecisionSchema(value);
  assert.deepEqual(schema.properties.candidateId.enum, ["border-flood-1", "package-count:multiple", null]);
  assert.equal(value.candidates[0].features.classification.type, "bottle");
  assert.throws(() => validateStageObservation({
    ...packageObservation(),
    candidates: packageObservation().candidates.filter((candidate) => candidate.id !== "package-count:multiple"),
  }), /package-count:multiple/);
  assert.throws(() => validateStageObservation({
    ...packageObservation(),
    candidates: [{ ...packageObservation().candidates[0], features: { classification: { type: "pouch" } } }, packageObservation().candidates[1]],
  }), /bottle\/box/);
});

test("Label LLM observation accepts a bounded helper or reviewed Package contour", () => {
  const value = validateStageObservation({
    ...observation(),
    input: { packageContext: { source: "accepted-package-helper", packageType: "bottle", contour: [[20, 10], [80, 10], [90, 190], [10, 190]] } },
  });
  assert.equal(value.input.packageContext.packageType, "bottle");
  const reviewed = validateStageObservation({
    ...observation(),
    input: { packageContext: { source: "reviewed-package-geometry", packageType: "bottle", contour: [[20, 10], [80, 10], [90, 190], [10, 190]] } },
  });
  assert.equal(reviewed.input.packageContext.source, "reviewed-package-geometry");
  assert.throws(() => validateStageObservation({
    ...observation(),
    input: { packageContext: { source: "unreviewed-helper", packageType: "bottle", contour: [[20, 10], [80, 10], [90, 190]] } },
  }), /reviewed Package contour/);
});

test("controller accepts a future runtime stage without owning the wizard stage list", () => {
  const future = validateStageObservation({ ...observation(), stage: "future_visual_stage", policy: { allowedActions: ["human_required"] } });
  const result = validateStageDecision({
    stage: "future_visual_stage", action: "human_required", candidateId: null, confidence: 1,
    flags: ["human_judgment_required"], paramsPatch: null, reviews: [], topologyEdits: [],
  }, future);
  assert.equal(result.stage, "future_visual_stage");
  assert.equal(result.action, "human_required");
});

test("decision validator rejects invented candidates and parameter patches", () => {
  assert.throws(() => validateStageDecision({ stage: "label", action: "accept", candidateId: "invented", confidence: 1, flags: [], paramsPatch: null, reviews: [], topologyEdits: [] }, observation()));
  assert.throws(() => validateStageDecision({ stage: "label", action: "accept", candidateId: "label-a", confidence: 1, flags: [], paramsPatch: { threshold: 2 } }, observation()));
});

test("Label review accepts only bounded immutable-node Edit Engine operations", () => {
  const label = { ...observation(), editEngine: { version: "edit-engine-v1", primitives: ["accept", "reject", "edit", "merge"] }, policy: {
    allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false,
  } };
  const decision = {
    stage: "label", action: "review", candidateId: "label-a", confidence: .9, flags: ["multiple_targets"], paramsPatch: null,
    reviews: [], topologyEdits: [], editOperations: [
      { operationId: "op-1", type: "merge", inputIds: ["label-a", "label-b"], adjustment: null },
      { operationId: "op-2", type: "edit", inputIds: ["op-1"], adjustment: { direction: "contract", edge: "bottom", strength: "small" } },
      { operationId: "op-3", type: "accept", inputIds: ["op-2"], adjustment: null },
    ],
  };
  assert.equal(validateStageDecision(decision, label).editOperations.length, 3);
  assert.throws(() => validateStageDecision({ ...decision, editOperations: [{ operationId: "op-1", type: "merge", inputIds: ["label-a", "invented"], adjustment: null }] }, label));
});

test("Qwen adapter derives the diagnostic Label candidate from a multi-label review", async () => {
  const label = { ...observation(), candidates: [
    { id: "label-a", features: { geometrySemantic: { role: "front-label", verdict: "likely" } } },
    { id: "label-b", features: { geometrySemantic: { role: "neck-label", verdict: "likely" } } },
  ], editEngine: { version: "edit-engine-v1", primitives: ["accept", "reject", "edit", "merge"] }, policy: {
    allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false,
  } };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-label-collection", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "label", action: "review", candidateId: null, confidence: .9, flags: ["multiple_targets"], paramsPatch: null, reviews: [], topologyEdits: [],
      editOperations: [
        { operationId: "op-1", type: "accept", inputIds: ["label-a"] },
        { operationId: "op-2", type: "accept", inputIds: ["label-b"] },
      ],
    }) } }], usage: {},
  }) } } };
  const result = await evaluateStage({ stageObservation: label }, "qwen", client);
  assert.equal(result.decision.candidateId, "label-a");
  assert.deepEqual(result.decision.editOperations.map((operation) => operation.type), ["accept", "accept"]);
  assert.deepEqual(result.decision.editOperations.map((operation) => operation.adjustment), [null, null]);
});

test("Qwen adapter normalizes a Label edit followed by an accept without an adjustment field", async () => {
  const label = { ...observation(), editEngine: { version: "edit-engine-v1", primitives: ["accept", "reject", "edit", "merge"] }, policy: {
    allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false,
  } };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-label-edit", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "label", action: "review", candidateId: "label-a", confidence: .93, flags: ["wrong_region"], paramsPatch: null, reviews: [], topologyEdits: [],
      editOperations: [
        { operationId: "op-1", type: "edit", inputIds: ["label-a"], adjustment: { edge: "top", strength: "medium", direction: "expand" } },
        { operationId: "op-2", type: "accept", inputIds: ["op-1"] },
      ],
    }) } }], usage: {},
  }) } } };

  const result = await evaluateStage({ stageObservation: label }, "qwen", client);

  assert.equal(result.decision.editOperations[0].adjustment.edge, "top");
  assert.equal(result.decision.editOperations[1].adjustment, null);
});

test("semantic rerun is accepted only when the current stage policy allows it", () => {
  const rerunnable = { ...observation(), policy: {
    allowedActions: ["accept", "rerun", "human_required"], paramsPatchAllowed: true,
    remainingLLMIterations: 2, allowedSemanticAdjustments: ["expand_region"],
  } };
  const result = validateStageDecision({
    stage: "label", action: "rerun", candidateId: null, confidence: .8, flags: ["crop_clipped"],
    paramsPatch: { adjustment: "expand_region", strength: "small" },
  }, rerunnable);
  assert.equal(result.action, "rerun");
  assert.equal(result.paramsPatch.adjustment, "expand_region");
  assert.throws(() => validateStageDecision({
    stage: "label", action: "rerun", candidateId: null, confidence: .8, flags: [],
    paramsPatch: { adjustment: "reduce_noise", strength: "small" },
  }, rerunnable));
  assert.throws(() => validateStageDecision({
    stage: "label", action: "rerun", candidateId: null, confidence: .8, flags: [],
    paramsPatch: { adjustment: "expand_region", strength: "small" },
  }, { ...rerunnable, policy: { ...rerunnable.policy, remainingLLMIterations: 0 } }));
});

test("shared adapter accepts a bounded OCR aggregate decision", async () => {
  const ocr = { ...observation(), stage: "ocr", candidates: [{ id: "ocr-run:1", rank: 1, score: 0.8 }] };
  const result = validateStageDecision({ stage: "ocr", action: "accept", candidateId: "ocr-run:1", confidence: 0.8, flags: ["partial_text"], paramsPatch: null, reviews: [], topologyEdits: [] }, ocr);
  assert.equal(result.stage, "ocr");
  assert.deepEqual(result.flags, ["partial_text"]);
});

test("Qwen adapter removes redundant OCR payload from approval operations", async () => {
  const geometry = { type: "quad", points: [{ x: .1, y: .1 }, { x: .4, y: .1 }, { x: .4, y: .2 }, { x: .1, y: .2 }], bbox: { x: .1, y: .1, width: .3, height: .1 } };
  const ocr = {
    ...observation(), stage: "ocr", candidates: [{ id: "ocr-run:1", rank: 1, score: .8 }],
    reviewTargets: [{ id: "ocr-1", text: "VIBES", transcriptionStatus: "verified" }],
    editEngine: { version: "edit-engine-v1", primitives: ["approve_region", "approve_text"] },
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
  };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-ocr-cleanup", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "ocr", action: "review", candidateId: "ocr-run:1", confidence: .9, flags: [], paramsPatch: { threshold: 99 }, reviews: [], topologyEdits: [],
      editOperations: [{ operationId: "op-1", type: "approve_region", inputIds: ["ocr-1"], adjustment: null, geometry, text: "VIBES", transcriptionStatus: "verified", split: null, composition: null }],
    }) } }], usage: {},
  }) } } };
  const result = await evaluateStage({ stageObservation: ocr }, "qwen", client);
  assert.equal(result.decision.editOperations[0].geometry, null);
  assert.equal(result.decision.editOperations[0].text, null);
  assert.equal(result.decision.editOperations[0].transcriptionStatus, null);
  assert.equal(result.decision.paramsPatch, null);
});

test("Qwen adapter repairs an OCR creation that was not explicitly committed", async () => {
  const geometry = { type: "quad", points: [{ x: .1, y: .1 }, { x: .4, y: .1 }, { x: .4, y: .2 }, { x: .1, y: .2 }], bbox: { x: .1, y: .1, width: .3, height: .1 } };
  const ocr = {
    ...observation(), stage: "ocr", candidates: [{ id: "ocr-run:1", rank: 1, score: .8 }],
    reviewTargets: [{ id: "ocr-1", text: "BRUT", transcriptionStatus: "verified" }],
    editEngine: { version: "edit-engine-v1", primitives: ["approve_region", "create_region"] },
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
  };
  const empty = { adjustment: null, geometry: null, text: null, transcriptionStatus: null, split: null, composition: null };
  const base = {
    stage: "ocr", action: "review", candidateId: "ocr-run:1", confidence: .9, flags: [], paramsPatch: null, reviews: [], topologyEdits: [],
    editOperations: [
      { operationId: "op-1", type: "approve_region", inputIds: ["ocr-1"], ...empty },
      { operationId: "op-2", type: "create_region", inputIds: [], adjustment: null, geometry, text: "AGORA WINERY", transcriptionStatus: "verified", split: null, composition: null },
    ],
  };
  const decisions = [base, { ...base, editOperations: [
    ...base.editOperations,
    { operationId: "op-3", type: "approve_region", inputIds: ["op-2"], ...empty },
  ] }];
  const requests = [];
  const client = { chat: { completions: { create: async (request) => {
    requests.push(request);
    return { id: `qwen-ocr-commit-${requests.length}`, model: "qwen-test", choices: [{ message: { content: JSON.stringify(decisions.shift()) } }], usage: {} };
  } } } };
  const result = await evaluateStage({ stageObservation: ocr }, "qwen", client);
  assert.equal(requests.length, 2);
  assert.equal(result.decision.editOperations.length, 3);
  assert.match(requests[1].messages.at(-1).content, /uncommitted: op-2/);
});

test("Qwen adapter expands batched OCR rejects into atomic operations", async () => {
  const ocr = {
    ...observation(), stage: "ocr", candidates: [{ id: "ocr-run:1", rank: 1, score: .8 }],
    reviewTargets: [{ id: "noise-1" }, { id: "noise-2" }, { id: "ocr-1", text: "VIBES" }],
    editEngine: { version: "edit-engine-v1", primitives: ["reject", "approve_region"] },
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
  };
  const empty = { adjustment: null, geometry: null, text: null, transcriptionStatus: null, split: null, composition: null };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-ocr-batch-reject", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "ocr", action: "review", candidateId: "ocr-run:1", confidence: .9, flags: [], paramsPatch: null, reviews: [], topologyEdits: [],
      editOperations: [
        { operationId: "op-1", type: "reject", inputIds: ["noise-1", "noise-2"], ...empty },
        { operationId: "op-2", type: "approve_region", inputIds: ["ocr-1"], ...empty },
      ],
    }) } }], usage: {},
  }) } } };
  const result = await evaluateStage({ stageObservation: ocr }, "qwen", client);
  assert.deepEqual(result.decision.editOperations.map(({ operationId, type, inputIds }) => ({ operationId, type, inputIds })), [
    { operationId: "op-1", type: "reject", inputIds: ["noise-1"] },
    { operationId: "op-2", type: "reject", inputIds: ["noise-2"] },
    { operationId: "op-3", type: "approve_region", inputIds: ["ocr-1"] },
  ]);
});

test("Qwen adapter continues OCR operation IDs and accepts prior iteration nodes", async () => {
  const priorEditOperations = [
    ...Array.from({ length: 14 }, (_, index) => ({
      operationId: `op-${index + 1}`,
      type: index === 7 ? "edit_text" : "reject",
      inputIds: [index === 7 ? "ocr-1" : `noise-${index + 1}`],
      adjustment: null, geometry: null, text: index === 7 ? "VIBES" : null,
      transcriptionStatus: index === 7 ? "verified" : null, split: null, composition: null,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      operationId: `system-rerun-1-${index + 1}`, type: "rerun_ocr", actor: "system",
      inputIds: [`op-${index + 1}`], helper: {}, result: {},
    })),
  ];
  const ocr = {
    ...observation(), stage: "ocr", candidates: [{ id: "ocr-derived:1", rank: 1, score: .8 }],
    reviewTargets: Array.from({ length: 4 }, (_, index) => ({ id: `system-rerun-1-${index + 1}` })),
    context: { priorEditOperations },
    editEngine: { version: "edit-engine-v1", primitives: ["reject", "approve_text", "approve_region"] },
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
  };
  const empty = { adjustment: null, geometry: null, text: null, transcriptionStatus: null, split: null, composition: null };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-ocr-second-iteration", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "ocr", action: "review", candidateId: "ocr-derived:1", confidence: .9, flags: [], paramsPatch: null, reviews: [], topologyEdits: [],
      editOperations: [
        { operationId: "op-15", type: "reject", inputIds: ["system-rerun-1-1", "system-rerun-1-2"], ...empty },
        { operationId: "op-16", type: "approve_text", inputIds: ["op-8"], ...empty },
        { operationId: "op-17", type: "approve_region", inputIds: ["op-8"], ...empty },
      ],
    }) } }], usage: {},
  }) } } };
  const result = await evaluateStage({ stageObservation: ocr }, "qwen", client);
  assert.deepEqual(result.decision.editOperations.map(({ operationId, type, inputIds }) => ({ operationId, type, inputIds })), [
    { operationId: "op-15", type: "reject", inputIds: ["system-rerun-1-1"] },
    { operationId: "op-16", type: "reject", inputIds: ["system-rerun-1-2"] },
    { operationId: "op-17", type: "approve_text", inputIds: ["op-8"] },
    { operationId: "op-18", type: "approve_region", inputIds: ["op-8"] },
  ]);
});

test("Qwen adapter expands multi-region OCR text edits into merge then edit", async () => {
  const ocr = {
    ...observation(), stage: "ocr", candidates: [{ id: "ocr-run:1", rank: 1, score: .8 }],
    reviewTargets: [{ id: "ocr-1" }, { id: "ocr-2" }, { id: "ocr-3" }],
    editEngine: { version: "edit-engine-v1", primitives: ["merge_region", "edit_text", "approve_region"] },
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
  };
  const empty = { adjustment: null, geometry: null, split: null, composition: null };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-ocr-merge-edit", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "ocr", action: "review", candidateId: "ocr-run:1", confidence: .8, flags: [], paramsPatch: null, reviews: [], topologyEdits: [],
      editOperations: [
        { operationId: "op-1", type: "edit_text", inputIds: ["ocr-1", "ocr-2", "ocr-3"], text: "METODO CLASSICO", transcriptionStatus: "verified", ...empty },
        { operationId: "op-2", type: "approve_region", inputIds: ["op-1"], text: null, transcriptionStatus: null, ...empty },
      ],
    }) } }], usage: {},
  }) } } };
  const result = await evaluateStage({ stageObservation: ocr }, "qwen", client);
  assert.deepEqual(result.decision.editOperations.map(({ operationId, type, inputIds, text }) => ({ operationId, type, inputIds, text })), [
    { operationId: "op-1", type: "merge_region", inputIds: ["ocr-1", "ocr-2", "ocr-3"], text: null },
    { operationId: "op-2", type: "edit_text", inputIds: ["op-1"], text: "METODO CLASSICO" },
    { operationId: "op-3", type: "approve_region", inputIds: ["op-2"], text: null },
  ]);
});

test("Qwen adapter lets later OCR edits rescue batched rejects and approves derived nodes", async () => {
  const ocr = {
    ...observation(), stage: "ocr", candidates: [{ id: "ocr-run:1", rank: 1, score: .8 }],
    reviewTargets: [{ id: "noise-1" }, { id: "ocr-1" }, { id: "ocr-2" }],
    editEngine: { version: "edit-engine-v1", primitives: ["reject", "merge_region", "edit_text", "approve_region"] },
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false, maxEditOperations: 20 },
  };
  const empty = { adjustment: null, geometry: null, split: null, composition: null };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-ocr-rescue", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "ocr", action: "review", candidateId: "ocr-run:1", confidence: .8, flags: [], paramsPatch: null, reviews: [], topologyEdits: [],
      editOperations: [
        { operationId: "op-1", type: "reject", inputIds: ["noise-1", "ocr-1", "ocr-2"], text: null, transcriptionStatus: null, ...empty },
        { operationId: "op-2", type: "edit_text", inputIds: ["ocr-1", "ocr-2"], text: "RIESLING", transcriptionStatus: "verified", ...empty },
        { operationId: "op-3", type: "approve_region", inputIds: ["ocr-1", "ocr-2"], text: "RIESLING", transcriptionStatus: "verified", ...empty },
      ],
    }) } }], usage: {},
  }) } } };
  const result = await evaluateStage({ stageObservation: ocr }, "qwen", client);
  assert.deepEqual(result.decision.editOperations.map(({ operationId, type, inputIds }) => ({ operationId, type, inputIds })), [
    { operationId: "op-1", type: "reject", inputIds: ["noise-1"] },
    { operationId: "op-2", type: "merge_region", inputIds: ["ocr-1", "ocr-2"] },
    { operationId: "op-3", type: "edit_text", inputIds: ["op-2"] },
    { operationId: "op-4", type: "approve_region", inputIds: ["op-3"] },
  ]);
});

test("Qwen adapter removes unary OCR string compositions as semantic no-ops", async () => {
  const ocr = {
    ...observation(), stage: "ocr", candidates: [{ id: "ocr-run:1", rank: 1, score: .8 }],
    reviewTargets: [{ id: "ocr-1" }],
    editEngine: { version: "edit-engine-v1", primitives: ["compose_string", "approve_region"] },
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
  };
  const empty = { adjustment: null, geometry: null, text: null, transcriptionStatus: null, split: null, composition: null };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-ocr-unary-composition", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "ocr", action: "review", candidateId: "ocr-run:1", confidence: .8, flags: [], paramsPatch: null, reviews: [], topologyEdits: [],
      editOperations: [
        { operationId: "op-1", type: "compose_string", inputIds: ["ocr-1"], ...empty,
          composition: { text: "VIBES", transcriptionStatus: "verified", sortOrder: 0 } },
        { operationId: "op-2", type: "approve_region", inputIds: ["op-1"], ...empty },
      ],
    }) } }], usage: {},
  }) } } };
  const result = await evaluateStage({ stageObservation: ocr }, "qwen", client);
  assert.deepEqual(result.decision.editOperations.map(({ operationId, type, inputIds }) => ({ operationId, type, inputIds })), [
    { operationId: "op-1", type: "approve_region", inputIds: ["ocr-1"] },
  ]);
});

test("Qwen adapter removes OCR and semantic fields from Components reviews", async () => {
  const components = {
    ...observation(), stage: "components", candidates: [{ id: "components:1", rank: 1, score: .8 }],
    reviewTargets: [{ id: "component-1" }],
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
  };
  const client = { chat: { completions: { create: async () => ({
    id: "qwen-components-cleanup", model: "qwen-test", choices: [{ message: { content: JSON.stringify({
      stage: "components", action: "review", candidateId: "components:1", confidence: .9, flags: [], paramsPatch: null, topologyEdits: [], editOperations: [],
      reviews: [{ id: "component-1", state: "accepted", text: "VIBES", transcriptionStatus: "verified", type: "text", role: "product_name" }],
    }) } }], usage: {},
  }) } } };
  const result = await evaluateStage({ stageObservation: components }, "qwen", client);
  assert.deepEqual(result.decision.reviews[0], { id: "component-1", state: "accepted", text: null, transcriptionStatus: null, type: null, role: null });
});

test("granular OCR review accepts known targets and rejects invented IDs", () => {
  const ocr = {
    ...observation(), stage: "ocr", candidates: [{ id: "ocr-run:1", rank: 1, score: 0.8 }],
    reviewTargets: [{ id: "ocr-1", text: "CABERNET" }],
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
  };
  const decision = { stage: "ocr", action: "review", candidateId: "ocr-run:1", confidence: .8, flags: ["wrong_transcription"], paramsPatch: null,
    reviews: [{ id: "ocr-1", state: "accepted", text: "КАБЕРНЕ", transcriptionStatus: "verified", type: null, role: null }], topologyEdits: [] };
  assert.equal(validateStageDecision(decision, ocr).reviews[0].text, "КАБЕРНЕ");
  assert.throws(() => validateStageDecision({ ...decision, reviews: [{ ...decision.reviews[0], id: "invented" }] }, ocr));
});

test("OCR review accepts an ordered immutable-node Edit Engine program", () => {
  const ocr = {
    ...observation(), stage: "ocr", candidates: [{ id: "ocr-run:1", rank: 1, score: 0.8 }],
    reviewTargets: [
      { id: "ocr-1", text: "CABER", transcriptionStatus: "partial" },
      { id: "ocr-2", text: "NET", transcriptionStatus: "verified" },
    ],
    editEngine: { version: "edit-engine-v1", primitives: ["approve_region", "approve_text", "reject", "edit_region", "edit_text", "merge_region", "split_region", "create_region", "compose_string", "decompose_string", "set_status"] },
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
  };
  const empty = { adjustment: null, geometry: null, text: null, transcriptionStatus: null };
  const decision = {
    stage: "ocr", action: "review", candidateId: "ocr-run:1", confidence: .9, flags: ["partial_text"], paramsPatch: null,
    reviews: [], topologyEdits: [], editOperations: [
      { operationId: "op-1", type: "edit_text", inputIds: ["ocr-1"], adjustment: null, geometry: null, text: "CABERNET", transcriptionStatus: "verified" },
      { operationId: "op-2", type: "merge_region", inputIds: ["op-1", "ocr-2"], ...empty },
      { operationId: "op-3", type: "approve_region", inputIds: ["op-2"], ...empty },
    ],
  };
  assert.equal(validateStageDecision(decision, ocr).editOperations.length, 3);
  assert.throws(() => validateStageDecision({ ...decision, editOperations: [
    { operationId: "op-1", type: "approve_region", inputIds: ["invented"], ...empty },
  ] }, ocr), /unknown or forward node/);
  const geometry = { type: "quad", points: [{ x: .1, y: .1 }, { x: .4, y: .1 }, { x: .4, y: .2 }, { x: .1, y: .2 }], bbox: { x: .1, y: .1, width: .3, height: .1 } };
  assert.equal(validateStageDecision({ ...decision, editOperations: [
    { operationId: "op-1", type: "create_region", inputIds: [], adjustment: null, geometry, text: null, transcriptionStatus: "unreadable" },
    { operationId: "op-2", type: "approve_region", inputIds: ["op-1"], ...empty },
  ] }, ocr).editOperations[0].type, "create_region");
  assert.throws(() => validateStageDecision({ ...decision, editOperations: [
    { operationId: "op-1", type: "approve_region", inputIds: ["ocr-1"], ...empty },
    { operationId: "op-2", type: "create_region", inputIds: [], adjustment: null, geometry, text: "AGORA WINERY", transcriptionStatus: "verified" },
  ] }, ocr), /uncommitted: op-2/);
  assert.throws(() => validateStageDecision({ ...decision, editOperations: [
    { operationId: "op-1", type: "approve_region", inputIds: ["ocr-2"], ...empty },
    { operationId: "op-2", type: "edit_text", inputIds: ["ocr-1"], adjustment: null, geometry: null, text: "CABERNET", transcriptionStatus: "verified" },
  ] }, ocr), /uncommitted: op-2/);
  assert.equal(validateStageDecision({ ...decision, editOperations: [
    { operationId: "op-1", type: "split_region", inputIds: ["ocr-1"], ...empty, split: { axis: "vertical", fractions: [.45] } },
    { operationId: "op-2", type: "approve_region", inputIds: ["op-1:1"], ...empty },
    { operationId: "op-3", type: "approve_region", inputIds: ["op-1:2"], ...empty },
  ] }, ocr).editOperations[0].type, "split_region");
  assert.equal(validateStageDecision({ ...decision, editOperations: [
    { operationId: "op-1", type: "approve_region", inputIds: ["ocr-1"], ...empty },
    { operationId: "op-2", type: "approve_region", inputIds: ["ocr-2"], ...empty },
    { operationId: "op-3", type: "compose_string", inputIds: ["ocr-1", "ocr-2"], ...empty,
      composition: { text: "CABER NET", transcriptionStatus: "verified", sortOrder: 0 } },
  ] }, ocr).editOperations[2].type, "compose_string");
  assert.throws(() => validateStageDecision({ ...decision, editOperations: [
    { operationId: "op-1", type: "rerun_ocr", inputIds: ["ocr-1"], ...empty },
  ] }, ocr), /not exposed/);
});

test("OCR review operation limit scales with the supplied target set", () => {
  const reviewTargets = Array.from({ length: 21 }, (_, index) => ({ id: `ocr-${index + 1}` }));
  const empty = { adjustment: null, geometry: null, text: null, transcriptionStatus: null, split: null, composition: null };
  const editOperations = reviewTargets.map((target, index) => ({
    operationId: `op-${index + 1}`,
    type: index === 0 ? "approve_region" : "reject",
    inputIds: [target.id],
    ...empty,
  }));
  const ocr = {
    ...observation(), stage: "ocr", candidates: [{ id: "ocr-run:1", rank: 1, score: .8 }], reviewTargets,
    editEngine: { version: "edit-engine-v1", primitives: ["approve_region", "reject"] },
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false, maxEditOperations: 50 },
  };
  const decision = { stage: "ocr", action: "review", candidateId: "ocr-run:1", confidence: .9, flags: [], paramsPatch: null, reviews: [], topologyEdits: [], editOperations };
  assert.equal(stageDecisionSchema(ocr).properties.editOperations.maxItems, 50);
  assert.equal(validateStageDecision(decision, ocr).editOperations.length, 21);
  assert.throws(() => validateStageDecision(decision, { ...ocr, policy: { ...ocr.policy, maxEditOperations: 20 } }), /limit of 20/);
});

test("Elements topology review accepts bounded moves and rejects unknown components", () => {
  const elements = {
    ...observation(), stage: "elements", candidates: [{ id: "elements-preview:1" }],
    reviewTargets: [{ id: "element-a" }, { id: "element-b" }], availableComponentIds: [1, 2, 3],
    policy: { allowedActions: ["review", "human_required"], granularReviewAllowed: true, paramsPatchAllowed: false },
  };
  const decision = { stage: "elements", action: "review", candidateId: "elements-preview:1", confidence: .8, flags: [], paramsPatch: null, reviews: [],
    topologyEdits: [{ componentId: 2, destinationElementId: "element-b", newGroupKey: null }] };
  assert.equal(validateStageDecision(decision, elements).topologyEdits[0].componentId, 2);
  assert.throws(() => validateStageDecision({ ...decision, topologyEdits: [{ componentId: 9, destinationElementId: "element-b", newGroupKey: null }] }, elements));
});
