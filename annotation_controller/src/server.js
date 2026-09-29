import Fastify from "fastify";
import { pathToFileURL } from "node:url";
import { ConfigurationError, UpstreamError, asObject, asString } from "./contract.js";
import { planDeterministic } from "./deterministic-planner.js";
import { planOpenAI, planQwen } from "./llm-planner.js";
import { evaluateStage, initializeQwenConversation } from "./stage-planner.js";

export function buildServer() {
  const app = Fastify({ logger: true, bodyLimit: 16 * 1024 * 1024 });
  app.get("/health", async () => health());
  app.post("/annotation/plan", async (request, reply) => {
    const expected = asString(process.env.CONTROLLER_TOKEN);
    if (expected && request.headers.authorization !== `Bearer ${expected}`) return reply.code(401).send({ detail: "Invalid controller token" });
    const body = asObject(request.body);
    if (!Number.isInteger(body.schemaVersion) || body.schemaVersion < 1 || !["annotation-correction-plan", "stage-evaluation", "conversation-initialize"].includes(body.task)) return reply.code(422).send({ detail: "Invalid or unsupported controller request" });
    const backend = backendName();
    const cancellation = new AbortController();
    const abortOnDisconnect = () => {
      if (!reply.raw.writableEnded) cancellation.abort();
    };
    reply.raw.once("close", abortOnDisconnect);
    try {
      if (body.task === "stage-evaluation") return await evaluateStage(body, backend, undefined, cancellation.signal);
      if (body.task === "conversation-initialize") {
        if (backend !== "qwen") return { schemaVersion: 1, status: "unavailable", provider: backend, conversationId: null, model: "configured-controller", reason: "Configured provider has no Qwen Conversation transport" };
        const session = asObject(body.session);
        if (!asString(session.llmSessionId) || !asString(session.annotationId)) return reply.code(422).send({ detail: "Conversation initialization requires llmSessionId and annotationId" });
        return await initializeQwenConversation(session, undefined, cancellation.signal);
      }
      if (backend === "deterministic") return planDeterministic(body);
      if (backend === "openai") return await planOpenAI(body, undefined, cancellation.signal);
      if (backend === "qwen") return await planQwen(body, undefined, cancellation.signal);
      return reply.code(503).send({ detail: "Unsupported controller backend" });
    } catch (error) {
      if (cancellation.signal.aborted) {
        request.log.info({ event: "provider_request_cancelled", task: body.task, backend });
        return;
      }
      if (error instanceof ConfigurationError) {
        request.log.error({ event: "controller_configuration_failed", task: body.task, backend, error: error.message });
        return reply.code(503).send({ detail: error.message });
      }
      if (error instanceof UpstreamError) {
        request.log.warn({ event: "provider_request_failed", task: body.task, backend, error: error.message });
        return reply.code(502).send({ detail: error.message, ...(error.evidence ? { evidence: error.evidence } : {}) });
      }
      request.log.error(error);
      return reply.code(500).send({ detail: "Controller failed unexpectedly" });
    } finally {
      reply.raw.removeListener("close", abortOnDisconnect);
    }
  });
  return app;
}

export function health() {
  const backend = backendName();
  const controller = backend === "openai" ? "vinedetect-openai-wizard-controller" : backend === "qwen" ? "vinedetect-qwen-wizard-controller" : "vinedetect-reference-local-controller";
  const configured = backend === "openai" ? Boolean(asString(process.env.OPENAI_API_KEY)) : backend === "qwen" ? Boolean((asString(process.env.QWEN_API_KEY) || asString(process.env.DASHSCOPE_API_KEY)) && asString(process.env.QWEN_BASE_URL)) : true;
  return { status: "ok", controller, backend, configured: String(configured) };
}

const backendName = () => asString(process.env.CONTROLLER_BACKEND).toLowerCase() || "deterministic";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.PORT ?? "9000", 10);
  await buildServer().listen({ host: "0.0.0.0", port });
}
