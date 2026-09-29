import OpenAI from "openai";
import { ConfigurationError, OUTPUT_SCHEMA, PROMPT_VERSION, SYSTEM_PROMPT, UpstreamError, asObject, asString, intEnv, normalizeResult } from "./contract.js";

export async function planOpenAI(payload, client, signal) {
  const apiKey = asString(process.env.OPENAI_API_KEY);
  if (!client && !apiKey) throw new ConfigurationError("OPENAI_API_KEY is not configured");
  const model = asString(process.env.OPENAI_MODEL) || "gpt-5.6-terra";
  const openai = client ?? new OpenAI({ apiKey, timeout: intEnv("OPENAI_TIMEOUT_SECONDS", 120, 10, 300) * 1000, maxRetries: intEnv("OPENAI_MAX_RETRIES", 2, 0, 5) });
  const [sourceImage, overlayImage] = controllerImages(payload);
  let response;
  try {
    response = await openai.responses.create({
      model,
      instructions: SYSTEM_PROMPT,
      input: [{ role: "user", content: multimodalContent(payload, sourceImage, overlayImage, "input_text", "input_image") }],
      text: { format: { type: "json_schema", name: "vinedetect_wizard_plan", strict: true, schema: OUTPUT_SCHEMA }, verbosity: "low" },
      reasoning: { effort: asString(process.env.OPENAI_REASONING_EFFORT) || "medium" },
      max_output_tokens: intEnv("OPENAI_MAX_OUTPUT_TOKENS", 12000, 512, 50000),
      store: false,
      metadata: { component: "vinedetect-wizard-llm", prompt_version: PROMPT_VERSION }
    }, { signal });
  } catch (error) { throw new UpstreamError(`OpenAI Responses request failed: ${error?.constructor?.name ?? "Error"}`); }
  const outputText = asString(response?.output_text);
  if (!outputText) throw new UpstreamError("OpenAI response did not contain structured output text");
  return normalizeResult(parseOutput(outputText, "OpenAI"), response, model, "openai", "vinedetect-openai-wizard-controller");
}

export async function planQwen(payload, client, signal) {
  const apiKey = asString(process.env.QWEN_API_KEY) || asString(process.env.DASHSCOPE_API_KEY);
  const baseURL = asString(process.env.QWEN_BASE_URL);
  if (!client && !apiKey) throw new ConfigurationError("QWEN_API_KEY or DASHSCOPE_API_KEY is not configured");
  if (!client && !baseURL) throw new ConfigurationError("QWEN_BASE_URL is not configured");
  const model = asString(process.env.QWEN_MODEL) || "qwen3.7-flash";
  const qwen = client ?? new OpenAI({ apiKey, baseURL: baseURL.replace(/\/$/, ""), timeout: intEnv("QWEN_TIMEOUT_SECONDS", 120, 10, 300) * 1000, maxRetries: intEnv("QWEN_MAX_RETRIES", 2, 0, 5) });
  const [sourceImage, overlayImage] = controllerImages(payload);
  let response;
  try {
    response = await qwen.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: multimodalContent(payload, sourceImage, overlayImage, "text", "image_url") }
      ],
      // DashScope Singapore currently supports JSON object mode but not JSON
      // Schema mode. The response is still validated by normalizeResult below.
      response_format: { type: "json_object" },
      max_tokens: intEnv("QWEN_MAX_OUTPUT_TOKENS", 12000, 512, 50000)
    }, { signal });
  } catch (error) { throw new UpstreamError(`Qwen Chat Completions request failed: ${providerError(error)}`); }
  const outputText = contentText(response?.choices?.[0]?.message?.content);
  if (!outputText) throw new UpstreamError("Qwen response did not contain structured output text");
  return normalizeResult(parseOutput(outputText, "Qwen"), response, model, "qwen", "vinedetect-qwen-wizard-controller");
}

function multimodalContent(payload, sourceImage, overlayImage, textType, imageType) {
  const context = { outputJsonSchema: OUTPUT_SCHEMA, workflowContract: asObject(payload.workflowContract), visionContext: asObject(payload.visionContext), visualContext: visualContextWithoutImages(payload), controllerInput: asObject(payload.input) };
  const image = (url) => imageType === "input_image" ? { type: imageType, image_url: url, detail: "high" } : { type: imageType, image_url: { url } };
  return [
    { type: textType, text: "Clean source preview. Form an independent visual hypothesis before inspecting the overlay." }, image(sourceImage),
    { type: textType, text: "Overlay preview of current canonical/helper state." }, image(overlayImage),
    { type: textType, text: `Return one JSON object matching outputJsonSchema exactly. Dynamic Wizard context:\n${JSON.stringify(context)}` }
  ];
}

function controllerImages(payload) {
  const images = asObject(asObject(payload.visualContext).images);
  const source = asString(asObject(images.sourcePreview).dataUrl);
  const overlay = asString(asObject(images.overlayPreview).dataUrl);
  if (!source.startsWith("data:image/") || !overlay.startsWith("data:image/")) throw new ConfigurationError("Source and overlay preview data URLs are required");
  return [source, overlay];
}

function visualContextWithoutImages(payload) { const value = { ...asObject(payload.visualContext) }; delete value.images; delete value.image; return value; }
function parseOutput(text, provider) { try { return JSON.parse(text); } catch { throw new UpstreamError(`${provider} structured output was not valid JSON`); } }
function contentText(content) { if (typeof content === "string") return content.trim(); if (!Array.isArray(content)) return ""; return content.map((item) => asString(item?.text)).join("").trim(); }
function providerError(error) {
  const status = Number.isInteger(error?.status) ? `HTTP ${error.status}` : "HTTP error";
  const code = asString(error?.code || error?.error?.code);
  const message = asString(error?.error?.message || error?.message);
  return [status, code, message].filter(Boolean).join(" · ").slice(0, 800);
}
