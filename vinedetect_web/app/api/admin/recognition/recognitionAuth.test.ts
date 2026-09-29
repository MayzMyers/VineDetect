import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyRecognitionAccessToken } from "./recognitionAuth.ts";

const secret = "test-secret-with-at-least-32-bytes";

function token(payload: Record<string, unknown>, algorithm = "HS256") {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

test("human roles become human annotation actors", () => {
  for (const role of ["admin", "annotator"] as const) {
    assert.deepEqual(
      verifyRecognitionAccessToken(token({ sub: role, role, actor_type: "human", exp: Date.now() / 1000 + 60 }), secret),
      { username: role, role, actorType: "human" },
    );
  }
});

test("ml-service becomes an ml-agent", () => {
  assert.deepEqual(
    verifyRecognitionAccessToken(token({ sub: "pipeline", role: "ml-service", actor_type: "ml-agent", exp: Date.now() / 1000 + 60 }), secret),
    { username: "pipeline", role: "ml-service", actorType: "ml-agent" },
  );
});

test("rejects tampering, expiry, legacy tokens and inconsistent actors", () => {
  assert.equal(verifyRecognitionAccessToken(`${token({ sub: "admin", role: "admin", actor_type: "human", exp: Date.now() / 1000 + 60 })}x`, secret), null);
  assert.equal(verifyRecognitionAccessToken(token({ sub: "admin", role: "admin", actor_type: "human", exp: 1 }), secret), null);
  assert.equal(verifyRecognitionAccessToken(token({ sub: "admin", exp: Date.now() / 1000 + 60 }), secret), null);
  assert.equal(verifyRecognitionAccessToken(token({ sub: "pipeline", role: "ml-service", actor_type: "human", exp: Date.now() / 1000 + 60 }), secret), null);
  assert.equal(verifyRecognitionAccessToken(token({ sub: "admin", role: "admin", actor_type: "human", exp: Date.now() / 1000 + 60 }, "none"), secret), null);
});
