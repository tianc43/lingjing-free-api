import { z } from "zod";

export interface AppConfig {
  host: string;
  port: number;
  apiKey: string;
  sessionMode: "browser-state" | "cookie-file";
  storageStatePath: string;
  cookieFilePath: string;
  sessionProfilePath: string;
  dbPath: string;
  maxConcurrency: number;
  modelCacheTtlMs: number;
  assetDiscoveryTimeoutMs: number;
  unknownCapacityHoldMs: number;
  taskPollIntervalMs: number;
  imageWaitTimeoutMs: number;
  videoWaitTimeoutMs: number;
  maxImageBytes: number;
  maxVideoBytes: number;
  jsonBodyLimitBytes: number;
  maxRequestMediaBytes: number;
  maxTempBytes: number;
  maxQueuedRequests: number;
  logLevel: string;
  docsEnabled: boolean;
}

const positiveInteger = z.coerce.number().int().positive();
const nonNegativeInteger = z.coerce.number().int().nonnegative();

const configSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: positiveInteger.default(8000),
  LINGJING_API_KEY: z.string().min(1),
  SESSION_MODE: z.enum(["browser-state", "cookie-file"]).default("browser-state"),
  LINGJING_STORAGE_STATE: z.string().default("./data/auth/storage-state.json"),
  LINGJING_COOKIE_FILE: z.string().default("./data/auth/cookie.txt"),
  LINGJING_SESSION_PROFILE: z.string().default("./data/auth/session-profile.json"),
  DB_PATH: z.string().default("./data/lingjing.db"),
  LINGJING_MAX_CONCURRENCY: positiveInteger.default(5),
  MODEL_CACHE_TTL_MS: positiveInteger.default(300_000),
  ASSET_DISCOVERY_TIMEOUT_MS: positiveInteger.default(60_000),
  UNKNOWN_CAPACITY_HOLD_MS: positiveInteger.default(900_000),
  TASK_POLL_INTERVAL_MS: positiveInteger.default(5_000),
  IMAGE_WAIT_TIMEOUT_MS: positiveInteger.default(300_000),
  VIDEO_WAIT_TIMEOUT_MS: positiveInteger.default(900_000),
  MAX_IMAGE_BYTES: positiveInteger.default(20_971_520),
  MAX_VIDEO_BYTES: positiveInteger.default(209_715_200),
  JSON_BODY_LIMIT_BYTES: positiveInteger.default(33_554_432),
  MAX_REQUEST_MEDIA_BYTES: positiveInteger.default(230_686_720),
  MAX_TEMP_BYTES: positiveInteger.default(1_073_741_824),
  MAX_QUEUED_REQUESTS: nonNegativeInteger.default(20),
  LOG_LEVEL: z.string().min(1).default("info"),
  DOCS_ENABLED: z.enum(["true", "false"]).default("false")
}).superRefine((config, ctx) => {
  const constraints = [
    config.LINGJING_API_KEY !== "change-me",
    config.LINGJING_API_KEY.length >= 16,
    config.LINGJING_MAX_CONCURRENCY >= 1 && config.LINGJING_MAX_CONCURRENCY <= 5,
    config.ASSET_DISCOVERY_TIMEOUT_MS > config.TASK_POLL_INTERVAL_MS,
    config.UNKNOWN_CAPACITY_HOLD_MS > config.TASK_POLL_INTERVAL_MS,
    config.IMAGE_WAIT_TIMEOUT_MS > config.TASK_POLL_INTERVAL_MS,
    config.VIDEO_WAIT_TIMEOUT_MS > config.TASK_POLL_INTERVAL_MS,
    config.JSON_BODY_LIMIT_BYTES >= 16_384,
    config.MAX_REQUEST_MEDIA_BYTES >= config.MAX_VIDEO_BYTES,
    config.MAX_TEMP_BYTES >= config.MAX_REQUEST_MEDIA_BYTES,
    config.MAX_QUEUED_REQUESTS >= 0 && config.MAX_QUEUED_REQUESTS <= 100
  ];

  if (!constraints.every(Boolean)) {
    ctx.addIssue({
      code: "custom",
      message: "Invalid configuration constraints"
    });
  }
});

export function parseConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): AppConfig {
  const config = configSchema.parse(env);
  return {
    host: config.HOST,
    port: config.PORT,
    apiKey: config.LINGJING_API_KEY,
    sessionMode: config.SESSION_MODE,
    storageStatePath: config.LINGJING_STORAGE_STATE,
    cookieFilePath: config.LINGJING_COOKIE_FILE,
    sessionProfilePath: config.LINGJING_SESSION_PROFILE,
    dbPath: config.DB_PATH,
    maxConcurrency: config.LINGJING_MAX_CONCURRENCY,
    modelCacheTtlMs: config.MODEL_CACHE_TTL_MS,
    assetDiscoveryTimeoutMs: config.ASSET_DISCOVERY_TIMEOUT_MS,
    unknownCapacityHoldMs: config.UNKNOWN_CAPACITY_HOLD_MS,
    taskPollIntervalMs: config.TASK_POLL_INTERVAL_MS,
    imageWaitTimeoutMs: config.IMAGE_WAIT_TIMEOUT_MS,
    videoWaitTimeoutMs: config.VIDEO_WAIT_TIMEOUT_MS,
    maxImageBytes: config.MAX_IMAGE_BYTES,
    maxVideoBytes: config.MAX_VIDEO_BYTES,
    jsonBodyLimitBytes: config.JSON_BODY_LIMIT_BYTES,
    maxRequestMediaBytes: config.MAX_REQUEST_MEDIA_BYTES,
    maxTempBytes: config.MAX_TEMP_BYTES,
    maxQueuedRequests: config.MAX_QUEUED_REQUESTS,
    logLevel: config.LOG_LEVEL,
    docsEnabled: config.DOCS_ENABLED === "true"
  };
}
