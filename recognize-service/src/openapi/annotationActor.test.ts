import assert from "node:assert/strict";
import test from "node:test";
import { annotationRequestActor } from "../db/annotation-actor.repository.js";

test("annotation actor is derived from trusted role and subject", () => {
  assert.deepEqual(
    annotationRequestActor({ "x-auth-role": "annotator", "x-auth-subject": "reviewer-1" }),
    { type: "human", source: "annotation-ui:reviewer-1" },
  );
  assert.deepEqual(
    annotationRequestActor({ "x-auth-role": "ml-service", "x-auth-subject": "label-pipeline-v1" }),
    { type: "ml-agent", source: "annotation-api:label-pipeline-v1" },
  );
});

test("caller-supplied actor headers cannot override the authenticated role", () => {
  assert.deepEqual(
    annotationRequestActor({
      "x-auth-role": "annotator",
      "x-auth-subject": "reviewer-1",
      "x-annotation-actor-type": "ml-agent",
      "x-annotation-actor-source": "spoofed",
    }),
    { type: "human", source: "annotation-ui:reviewer-1" },
  );
  assert.equal(annotationRequestActor({ "x-annotation-actor-type": "human" }), null);
});
