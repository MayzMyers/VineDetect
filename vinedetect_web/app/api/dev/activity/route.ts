import { appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
const fallbackSessionId = `web-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;

type ClientActivityEvent = {
  at?: unknown;
  category?: unknown;
  action?: unknown;
  page?: unknown;
  details?: unknown;
};

export async function POST(request: NextRequest) {
  const enabled = process.env.NODE_ENV !== "production" || process.env.DEV_ACTIVITY_LOG_ENABLED === "true";
  if (!enabled) return Response.json({ error: "Activity logging disabled" }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const rawEvents = body && typeof body === "object" && Array.isArray((body as { events?: unknown }).events)
    ? (body as { events: ClientActivityEvent[] }).events.slice(0, 100)
    : [];
  if (!rawEvents.length) return Response.json({ error: "No events" }, { status: 400 });

  const sessionId = process.env.DEV_ACTIVITY_SESSION_ID || fallbackSessionId;
  const receivedAt = new Date().toISOString();
  const events = rawEvents.map((event) => ({
    sessionId,
    receivedAt,
    at: safeText(event.at, 64) || receivedAt,
    category: safeText(event.category, 32) || "unknown",
    action: safeText(event.action, 64) || "unknown",
    page: safeText(event.page, 1000) || "/",
    details: safeDetails(event.details),
  }));
  const lines = events.map((event) => JSON.stringify(event));
  for (const line of lines) console.log(`[activity] ${line}`);

  const logDir = process.env.DEV_ACTIVITY_LOG_DIR || path.join(tmpdir(), "vinedetect-activity");
  const logPath = path.join(logDir, `ui-activity-${safeFilePart(sessionId)}.jsonl`);
  try {
    await mkdir(logDir, { recursive: true });
    await appendFile(logPath, `${lines.join("\n")}\n`, "utf8");
  } catch (error) {
    console.error("[activity:file-error]", error);
    return Response.json({ error: "Activity file write failed", logPath }, { status: 500 });
  }
  return new Response(null, { status: 204, headers: { "X-Activity-Log": logPath } });
}

function safeText(value: unknown, max: number) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function safeDetails(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const serialized = JSON.stringify(value);
  return serialized.length <= 8_000 ? JSON.parse(serialized) as unknown : { truncated: serialized.slice(0, 8_000) };
}

function safeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
}
