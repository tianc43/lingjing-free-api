import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

const REDACTED = "[REDACTED]";
const secretKeys = new Set([
  "authorization", "cookie", "set-cookie", "csrf", "csrftoken", "x-csrf-token", "originpin", "storagestate"
]);
const promptKeys = new Set(["prompt", "negative_prompt", "system_prompt", "text", "content"]);
const mediaKeys = new Set(["input_images", "images", "media", "video", "videos"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    if (value.startsWith("/")) {
      const url = new URL(value, "http://localhost");
      return url.pathname;
    }
    return value;
  }
}

export function redactForLog(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactForLog);
  }
  if (!isRecord(value)) {
    return typeof value === "string" ? safeUrl(value) : value;
  }

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    const normalizedKey = key.toLowerCase();
    if (secretKeys.has(normalizedKey) || normalizedKey === "cause") {
      return [key, REDACTED];
    }
    if (promptKeys.has(normalizedKey) && typeof entry === "string") {
      return [key, `[TEXT length=${String(entry.length)}]`];
    }
    if (mediaKeys.has(normalizedKey) && Array.isArray(entry)) {
      return [key, `[MEDIA count=${String(entry.length)}]`];
    }
    return [key, redactForLog(entry)];
  }));
}

function requestSerializer(request: unknown): Record<string, unknown> {
  if (!isRecord(request)) {
    return {};
  }
  const url = typeof request.url === "string" ? safeUrl(request.url) : undefined;
  return {
    ...(typeof request.method === "string" ? { method: request.method } : {}),
    ...(url === undefined ? {} : { pathname: new URL(url, "http://localhost").pathname })
  };
}

function responseSerializer(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || typeof response.statusCode !== "number") {
    return {};
  }
  return { statusCode: response.statusCode };
}

function errorSerializer(error: unknown): Record<string, unknown> {
  if (!isRecord(error)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  if (typeof error.code === "string") {
    result.code = error.code;
  }
  if (process.env.NODE_ENV === "development" && typeof error.stack === "string") {
    result.stack = REDACTED;
  }
  return result;
}

const loggerOptions: LoggerOptions = {
  formatters: {
    log: (object) => {
      const redacted = redactForLog(object);
      return isRecord(redacted) ? redacted : {};
    }
  },
  redact: {
    paths: [
      "req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie",
      "csrfToken", "originPin", "prompt", "input_images", "storageState",
      "*.csrfToken", "*.originPin", "*.prompt", "*.input_images", "*.storageState",
      "cause", "*.cause", "*.*.cause"
    ],
    censor: REDACTED
  },
  serializers: {
    req: requestSerializer,
    res: responseSerializer,
    err: errorSerializer
  }
};

export function createLogger(level = "info", destination?: DestinationStream): Logger {
  const options = { ...loggerOptions, level };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export const logger = createLogger();
