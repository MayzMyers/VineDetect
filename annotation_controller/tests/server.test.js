import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, health } from "../src/server.js";

test("health exposes Qwen configuration", () => {
  const previous = { backend: process.env.CONTROLLER_BACKEND, key: process.env.QWEN_API_KEY, url: process.env.QWEN_BASE_URL };
  Object.assign(process.env, { CONTROLLER_BACKEND: "qwen", QWEN_API_KEY: "test", QWEN_BASE_URL: "https://example.invalid/v1" });
  try { assert.deepEqual(health(), { status: "ok", controller: "vinedetect-qwen-wizard-controller", backend: "qwen", configured: "true" }); }
  finally { restore("CONTROLLER_BACKEND", previous.backend); restore("QWEN_API_KEY", previous.key); restore("QWEN_BASE_URL", previous.url); }
});

test("controller bearer token is enforced", async () => {
  const previous = process.env.CONTROLLER_TOKEN; process.env.CONTROLLER_TOKEN = "internal-secret";
  const app = buildServer();
  try {
    const response = await app.inject({ method: "POST", url: "/annotation/plan", payload: { schemaVersion: 1, task: "annotation-correction-plan", workflowContract: {}, visionContext: {}, visualContext: {}, input: {} } });
    assert.equal(response.statusCode, 401);
  } finally { await app.close(); restore("CONTROLLER_TOKEN", previous); }
});

test("stage evaluation route rejects an empty observation", async () => {
  const previous = { backend: process.env.CONTROLLER_BACKEND, token: process.env.CONTROLLER_TOKEN };
  process.env.CONTROLLER_BACKEND = "deterministic"; delete process.env.CONTROLLER_TOKEN;
  const app = buildServer();
  try {
    const response = await app.inject({ method: "POST", url: "/annotation/plan", payload: { schemaVersion: 1, task: "stage-evaluation", stageObservation: {} } });
    assert.equal(response.statusCode, 502);
  } finally { await app.close(); restore("CONTROLLER_BACKEND", previous.backend); restore("CONTROLLER_TOKEN", previous.token); }
});

function restore(name, value) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
