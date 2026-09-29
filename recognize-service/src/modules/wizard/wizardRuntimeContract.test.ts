import assert from "node:assert/strict";
import test from "node:test";
import { buildStageRuntimeSnapshot, normalizeHelperIntermediateStates, transitionStageRuntime, wizardRuntimeAction, wizardRuntimeDefinition } from "../../shared/wizardRuntimeContract.js";

test("runtime registry exposes bounded actions and transitions for Label", () => {
  const definition = wizardRuntimeDefinition("label");
  assert.deepEqual(definition.actions, ["accept", "review", "rerun", "human_required"]);
  assert.equal(transitionStageRuntime("label", "helper_output_ready", "rerun"), "helper_running");
  assert.equal(transitionStageRuntime("label", "helper_running", "helper_completed"), "helper_output_ready");
  assert.deepEqual(wizardRuntimeAction("rerun"), { id: "rerun", flow: "rerun_helper", requiresCandidate: false });
});

test("helper may expose bounded namespaced intermediate states without changing the stage machine", () => {
  const intermediateStates = normalizeHelperIntermediateStates([
    { id: "color.pass-1", status: "completed", algorithm: "color-band-v2", summary: { candidates: 4 } },
    { id: "edge.pass-2", parentId: "color.pass-1", status: "pending", summary: { threshold: 10 } },
    { id: "bad id!", status: "completed" },
  ]);
  assert.equal(intermediateStates.length, 2);
  assert.equal(intermediateStates[1]?.parentId, "color.pass-1");
  const snapshot = buildStageRuntimeSnapshot({ stage: "label", algorithm: "label-multi-family-consensus-v4", intermediateStates });
  assert.equal(snapshot.state, "helper_output_ready");
  assert.deepEqual(snapshot.helper.intermediateStates, intermediateStates);
});
