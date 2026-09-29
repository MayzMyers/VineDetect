import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecognitionFlowState,
  recognitionFlowReducer,
  tokenSetSimilarity,
} from "./recognitionFlow.ts";

test("stale job cannot replace the active candidate", () => {
  let state = createRecognitionFlowState("11111111-1111-4111-8111-111111111111", 1);
  state = recognitionFlowReducer(state, { type: "CANDIDATE_FOUND", candidateId: "a", tokens: ["a"] });
  state = recognitionFlowReducer(state, { type: "JOB_STARTED", candidateId: "a", jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  state = recognitionFlowReducer(state, { type: "CANDIDATE_FOUND", candidateId: "b", tokens: ["b"] });
  state = recognitionFlowReducer(state, {
    type: "JOB_UPDATED",
    candidateId: "a",
    job: {
      jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sessionId: state.session.id,
      status: "completed",
      stage: "completed",
      product: { id: 1, catalogKey: "a", slug: "a", title: "Wrong", producer: null, image: null, category: null, region: null, vintage: null, description: null },
    },
  });
  assert.equal(state.candidateId, "b");
  assert.equal(state.product, null);
});

test("late failures from a replaced session or job cannot break the active session", () => {
  const firstSessionId = "11111111-1111-4111-8111-111111111111";
  const nextSessionId = "22222222-2222-4222-8222-222222222222";
  const activeJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let state = createRecognitionFlowState(firstSessionId, 1);
  state = recognitionFlowReducer(state, { type: "RESET", sessionId: nextSessionId, startedAt: 2 });
  state = recognitionFlowReducer(state, { type: "CANDIDATE_FOUND", candidateId: "wine", tokens: ["wine"] });
  state = recognitionFlowReducer(state, { type: "JOB_STARTED", candidateId: "wine", jobId: activeJobId });

  state = recognitionFlowReducer(state, { type: "FAILED", error: "SERVER_UNAVAILABLE", sessionId: firstSessionId });
  assert.equal(state.uiState, "reading");
  assert.equal(state.error, null);

  state = recognitionFlowReducer(state, {
    type: "FAILED",
    error: "SERVER_UNAVAILABLE",
    sessionId: nextSessionId,
    jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  assert.equal(state.uiState, "reading");
  assert.equal(state.error, null);
});

test("token similarity is Jaccard similarity", () => {
  assert.equal(tokenSetSimilarity(["marques", "caceres"], ["marques", "rioja"]), 1 / 3);
});

test("catalog signals form a separate reading stage before an exact hypothesis", () => {
  let state = createRecognitionFlowState("11111111-1111-4111-8111-111111111111", 1);
  state = recognitionFlowReducer(state, { type: "CAMERA_READY" });
  state = recognitionFlowReducer(state, { type: "CATALOG_SIGNALS_UPDATED", signals: ["abrau", "estates"] });
  assert.equal(state.uiState, "reading");
  assert.deepEqual(state.catalogSignals, ["abrau", "estates"]);
  assert.equal(state.candidateId, null);
  state = recognitionFlowReducer(state, { type: "CANDIDATE_FOUND", candidateId: "wine:abrau", tokens: ["abrau", "estates"] });
  assert.equal(state.uiState, "reading");
  assert.equal(state.ocrAccumulationStable, false);
});

test("the first active catalog signal opens reading and camera readiness preserves it", () => {
  let state = createRecognitionFlowState("11111111-1111-4111-8111-111111111111", 1);
  state = recognitionFlowReducer(state, { type: "CATALOG_SIGNALS_UPDATED", signals: ["Abrau"] });
  assert.equal(state.uiState, "reading");
  assert.deepEqual(state.catalogSignals, ["Abrau"]);

  state = recognitionFlowReducer(state, { type: "CAMERA_READY" });
  assert.equal(state.uiState, "reading");
});

test("a completed no-match asks for a rescan instead of waiting", () => {
  let state = createRecognitionFlowState("11111111-1111-4111-8111-111111111111", 1);
  state = recognitionFlowReducer(state, { type: "CANDIDATE_FOUND", candidateId: "wine", tokens: ["wine"] });
  state = recognitionFlowReducer(state, { type: "JOB_STARTED", candidateId: "wine", jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  state = recognitionFlowReducer(state, {
    type: "JOB_UPDATED",
    candidateId: "wine",
    job: {
      jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sessionId: state.session.id,
      status: "completed",
      stage: "completed",
      outcome: "no_match",
    },
  });
  assert.equal(state.uiState, "error");
  assert.equal(state.error, "NO_CATALOG_MATCH");
  state = recognitionFlowReducer(state, { type: "CANDIDATE_STABLE", candidateId: "wine" });
  assert.equal(state.uiState, "error");
});

test("completed backend outcomes map to ambiguous and guidance UI states", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let state = createRecognitionFlowState(sessionId, 1);
  state = recognitionFlowReducer(state, { type: "CAMERA_READY" });
  state = recognitionFlowReducer(state, { type: "CANDIDATE_FOUND", candidateId: "wine", tokens: ["wine"] });
  state = recognitionFlowReducer(state, { type: "JOB_STARTED", candidateId: "wine", jobId });
  state = recognitionFlowReducer(state, { type: "USER_CONFIRMED", candidateId: "wine" });
  state = recognitionFlowReducer(state, {
    type: "JOB_UPDATED",
    candidateId: "wine",
    job: { jobId, sessionId, status: "completed", stage: "completed", outcome: "need_more_data", guidance: { type: "label_bottom" } },
  });
  assert.equal(state.uiState, "guidance");
  assert.equal(state.guidance?.type, "label_bottom");

  state = recognitionFlowReducer(state, { type: "RESET_FLOW" });
  assert.equal(state.uiState, "exploring");
  assert.equal(state.candidateId, null);
  assert.equal(state.session.id, sessionId);
});
