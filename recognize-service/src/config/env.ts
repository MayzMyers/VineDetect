import { z } from "zod";

const envBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return value;
}, z.boolean());
const optionalEnvString = z.preprocess((value) => typeof value === "string" && !value.trim() ? undefined : value, z.string().min(1).optional());
const optionalEnvUrl = z.preprocess((value) => typeof value === "string" && !value.trim() ? undefined : value, z.string().url().optional());

const envSchema = z.object({
  DATABASE_URL: z.string().min(1).default("postgresql://postgres:admin@localhost:5432/wines"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4001),
  NEXT_BFF_ORIGIN: z.string().url().default("http://localhost:3000"),
  INTERNAL_API_KEY: z.string().min(1).default("development-secret"),
  ASSET_ROOT: z.string().min(1).default("../asset-store"),
  DATASET_EXPORT_ROOT: z.string().min(1).default("../exports"),
  WORKER_ENABLED: envBoolean.default(true),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(8).default(2),
  WORKER_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(15_000),
  WORKER_LEASE_MS: z.coerce.number().int().min(10_000).default(120_000),
  WORKER_REAPER_MS: z.coerce.number().int().min(1000).default(30_000),
  CV_PIPELINE_VERSION: z.string().min(1).default("cv-meta-v2-debug-layers"),
  CV_CANONICAL_LONG_SIDE: z.coerce.number().int().positive().default(1600),
  CV_ANALYSIS_LONG_SIDE: z.coerce.number().int().positive().default(1024),
  CV_MAX_FILE_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  CV_MAX_INPUT_PIXELS: z.coerce.number().int().positive().default(40_000_000),
  CV_DEBUG_ARTIFACTS: envBoolean.default(false),
  CV_DEBUG_ROOT: z.string().min(1).default(".generated/cv-meta"),
  CV_OCR_ENABLED: envBoolean.default(false),
  LOCAL_ML_CONTROLLER_URL: optionalEnvUrl,
  LOCAL_ML_CONTROLLER_TOKEN: optionalEnvString,
  LOCAL_ML_CONTROLLER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(60000),
  LOCAL_ML_CONTROLLER_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(2 * 1024 * 1024),
  LLM_WIZARD_CONTROLLER_URL: optionalEnvUrl,
  LLM_WIZARD_CONTROLLER_TOKEN: optionalEnvString,
  // Must exceed the provider-side 120s timeout so the controller can return a
  // classified provider failure instead of being cut off by its caller first.
  LLM_WIZARD_CONTROLLER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(150000),
  LLM_WIZARD_CONTROLLER_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(2 * 1024 * 1024),
  LLM_WIZARD_PROVIDER: z.string().min(1).default("configured-controller"),
  LLM_WIZARD_MODEL: z.string().min(1).default("configured-controller"),
  V5_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).default(120000),
  SIGLIP_ENABLED: envBoolean.default(false),
  SIGLIP_LABEL_RERANK: envBoolean.default(true),
  SIGLIP_REGION_PROPOSALS: envBoolean.default(false),
  SIGLIP_MODE: z.enum(["off", "score-only", "rerank", "proposals"]).default("off"),
  SIGLIP_SERVICE_URL: z.string().url().default("http://vision-service:9200"),
  SIGLIP_SERVICE_TOKEN: optionalEnvString,
  SIGLIP_MODEL: z.string().min(1).default("google/siglip2-base-patch16-256"),
  SIGLIP_MODEL_REVISION: z.string().min(1).default("950d2cab84b57b9d6cf03f95596bfa8fed3204d3"),
  SIGLIP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  DINO_ENABLED: envBoolean.default(false),
  DINO_SERVICE_URL: z.string().url().default("http://vision-service:9200"),
  DINO_MODEL: z.string().min(1).default("IDEA-Research/grounding-dino-tiny"),
  DINO_MODEL_REVISION: z.string().min(1).default("a2bb814dd30d776dcf7e30523b00659f4f141c71"),
  DINO_PROMPT: z.string().min(1).default("main wine label"),
  DINO_THRESHOLD: z.coerce.number().min(0).max(1).default(0.18),
  DINO_TEXT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.15),
  DINO_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
});

export const env = envSchema.parse(process.env);
