import { AppError, errors } from "../errors.js";

interface UpstreamError {
  code?: unknown;
  message?: unknown;
}

export interface UpstreamDiagnostics {
  httpStatusCode?: number;
  businessCode?: string;
  message?: string;
}

const upstreamDiagnosticStore = new WeakMap<AppError, UpstreamDiagnostics>();
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/giu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const SENSITIVE_ASSIGNMENT_PATTERN = /\b(prompt|negative_prompt|text|content|authorization|cookie|csrf|csrftoken|token|secret|session|api[_-]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/giu;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 240;

function safeBusinessCode(value: unknown): string | undefined {
  if (!(typeof value === "string" || typeof value === "number")) return undefined;
  const candidate = String(value).trim();
  if (candidate.length === 0 || !/^[A-Za-z0-9_.:-]+$/u.test(candidate)) return undefined;
  return candidate.slice(0, 80);
}

function safeDiagnosticMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  }).join("");
  const sanitized = withoutControls
    .replace(URL_PATTERN, "[URL]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(/\s+/gu, " ")
    .trim();
  if (sanitized.length === 0) return undefined;
  return sanitized.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH - 1)}…`;
}

export function upstreamDiagnostics(cause: unknown): UpstreamDiagnostics | undefined {
  return cause instanceof AppError ? upstreamDiagnosticStore.get(cause) : undefined;
}

export class SubmitAmbiguousError extends AppError {
  constructor() {
    super(502, "upstream_error", "lingjing_submit_ambiguous", "Lingjing submit outcome is unknown");
    this.name = "SubmitAmbiguousError";
  }
}

export class TransportUncertainError extends Error {
  constructor() {
    super("Lingjing transport response could not be verified");
    this.name = "TransportUncertainError";
  }
}

const INITIALIZED_UPLOAD_ID = "initializedUploadId";

export function markInitializedUploadError(
  cause: unknown,
  uploadId: string
): Error {
  const error = cause instanceof Error ? cause : errors.upstream();
  Object.defineProperty(error, INITIALIZED_UPLOAD_ID, {
    value: uploadId,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return error;
}

export function initializedUploadId(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const value: unknown = Reflect.get(cause, INITIALIZED_UPLOAD_ID);
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

export function mapUpstreamError(error: UpstreamError | null | undefined, statusCode?: number): AppError {
  const code = (typeof error?.code === "string" || typeof error?.code === "number" ? String(error.code) : "").toUpperCase();
  const message = (typeof error?.message === "string" ? error.message : "").toUpperCase();
  const text = `${code} ${message}`;
  let mapped: AppError;
  if (text.includes("USER_NOT_LOGIN") || code === "406") mapped = errors.loginRequired();
  else if (text.includes("CSRF")) mapped = errors.csrfExpired();
  else if (text.includes("QUOTA") || text.includes("POINT")) mapped = errors.insufficientQuota();
  else if (text.includes("AUDIT") || text.includes("CONTENT")) mapped = errors.contentPolicy();
  else if (text.includes("RATE") || statusCode === 429) mapped = errors.rateLimited();
  else if (text.includes("PERMISSION") || statusCode === 403) mapped = errors.permissionDenied();
  else mapped = errors.upstream();

  const businessCode = safeBusinessCode(error?.code);
  const diagnosticMessage = safeDiagnosticMessage(error?.message);
  const diagnostics: UpstreamDiagnostics = {
    ...(statusCode === undefined ? {} : { httpStatusCode: statusCode }),
    ...(businessCode === undefined ? {} : { businessCode }),
    ...(diagnosticMessage === undefined ? {} : { message: diagnosticMessage })
  };
  if (Object.keys(diagnostics).length > 0) upstreamDiagnosticStore.set(mapped, diagnostics);
  return mapped;
}

export function isTransportUncertain(cause: unknown): boolean {
  return !(cause instanceof AppError);
}
