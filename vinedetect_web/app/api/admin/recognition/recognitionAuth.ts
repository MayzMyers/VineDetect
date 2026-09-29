import { createHmac, timingSafeEqual } from "node:crypto";

export type AuthRole = "admin" | "annotator" | "ml-service";
export type RequestPrincipal = {
  username: string;
  role: AuthRole;
  actorType: "human" | "ml-agent";
};

export function verifyRecognitionAccessToken(token: string, secret: string): RequestPrincipal | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: unknown };
    if (header.alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
    const actual = Buffer.from(parts[2], "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const role = payload.role;
    const username = payload.sub;
    if (role !== "admin" && role !== "annotator" && role !== "ml-service") return null;
    if (typeof username !== "string" || !username || typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000) return null;
    const expectedActor = role === "ml-service" ? "ml-agent" : "human";
    if (payload.actor_type !== expectedActor) return null;
    return { username, role, actorType: expectedActor };
  } catch {
    return null;
  }
}
