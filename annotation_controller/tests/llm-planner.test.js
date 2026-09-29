import assert from "node:assert/strict";
import test from "node:test";
import { planOpenAI, planQwen } from "../src/llm-planner.js";

const payload = () => ({
  workflowContract: { workflow: { stages: [] } }, visionContext: { visionContextId: "ctx", labels: [] },
  visualContext: { renderId: "render", images: { sourcePreview: { dataUrl: "data:image/webp;base64,c291cmNl" }, overlayPreview: { dataUrl: "data:image/webp;base64,b3ZlcmxheQ==" } } }, input: {}
});
const output = () => ({
  status: "planned", interactionMode: "mixed",
  visionHypothesis: { summary: "one label", regions: [], readableText: [], uncertainties: [] },
  comparison: { summary: "label missing", agreements: [], disagreements: ["missing label"], warnings: [] },
  operations: [{ operationId: "detect-labels", stage: "label", labelId: null, command: "run_helper", targetEntityType: null, targetId: null, payloadJson: "{}", proposedOutputJson: "{\"reason\":\"missing label\"}" }], reason: ""
});

test("OpenAI Responses request becomes canonical plan", async () => {
  const requests = [];
  const client = { responses: { create: async (request) => { requests.push(request); return { id: "resp-test", model: "gpt-test", output_text: JSON.stringify(output()), usage: { total_tokens: 120 } }; } } };
  const previous = process.env.OPENAI_MODEL; process.env.OPENAI_MODEL = "gpt-test";
  try {
    const result = await planOpenAI(payload(), client);
    assert.equal(result.controller.id, "vinedetect-openai-wizard-controller");
    assert.equal(result.proposedOutput.openai.responseId, "resp-test");
    assert.equal(requests[0].input[0].content.filter((item) => item.type === "input_image").length, 2);
    assert.equal(requests[0].text.format.type, "json_schema");
  } finally { if (previous === undefined) delete process.env.OPENAI_MODEL; else process.env.OPENAI_MODEL = previous; }
});

test("Qwen compatible request uses shared schema and canonical plan", async () => {
  const requests = [];
  const client = { chat: { completions: { create: async (request) => { requests.push(request); return { id: "chat-qwen", model: "qwen-test", choices: [{ message: { content: JSON.stringify(output()) } }], usage: { total_tokens: 120 } }; } } } };
  const previous = process.env.QWEN_MODEL; process.env.QWEN_MODEL = "qwen-test";
  try {
    const result = await planQwen(payload(), client);
    assert.equal(result.controller.id, "vinedetect-qwen-wizard-controller");
    assert.equal(result.proposedOutput.qwen.responseId, "chat-qwen");
    assert.equal(requests[0].messages[1].content.filter((item) => item.type === "image_url").length, 2);
    assert.equal(requests[0].response_format.type, "json_object");
    assert.match(requests[0].messages[1].content.at(-1).text, /outputJsonSchema/);
  } finally { if (previous === undefined) delete process.env.QWEN_MODEL; else process.env.QWEN_MODEL = previous; }
});
