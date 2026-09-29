import { pool } from "./pool.js";

export type AnnotationRequestActor = {
  type: "human" | "ml-agent";
  source: string;
};

export async function recordAnnotationTrackActor(trackId: string, actor: AnnotationRequestActor) {
  await pool.query(
    `UPDATE meta.annotation_tracks
     SET execution_actor_type = CASE
           WHEN execution_actor_type IS NULL THEN $2
           WHEN execution_actor_type = $2 THEN execution_actor_type
           ELSE 'hybrid'
         END,
         execution_actor_sources = CASE
           WHEN execution_actor_sources ? $3 THEN execution_actor_sources
           ELSE execution_actor_sources || to_jsonb($3::text)
         END,
         execution_actor_updated_at = now()
     WHERE id = $1`,
    [trackId, actor.type, actor.source],
  );
}

export function annotationRequestActor(headers: Record<string, unknown>): AnnotationRequestActor | null {
  const role = headerValue(headers["x-auth-role"]);
  const subject = headerValue(headers["x-auth-subject"])?.slice(0, 80);
  if (!subject) return null;
  if (role === "admin" || role === "annotator") {
    return { type: "human", source: `annotation-ui:${subject}`.slice(0, 120) };
  }
  if (role === "ml-service") {
    return { type: "ml-agent", source: `annotation-api:${subject}`.slice(0, 120) };
  }
  return null;
}

function headerValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  return null;
}
