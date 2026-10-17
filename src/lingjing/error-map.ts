import { AppError, errors } from "../errors.js";

interface UpstreamError {
  code?: unknown;
  message?: unknown;
}

export interface UpstreamDiagnostics {
  httpStatusCode?: number;
  businessCode?: string;
  message?: string;
  requestId?: string;
  taskCode?: string;
  taskStatus?: string;
  vendor?: { code?: string; errorCode?: string; message?: string };
}

export interface UpstreamObservation extends UpstreamDiagnostics {
  checkedAt: number;
  state: "verified" | "unavailable";
}

export interface PublicUpstreamDiagnostics {
  http_status?: number | undefined; business_code?: string | undefined; message?: string | undefined; request_id?: string | undefined;
  task_code?: string | undefined; task_status?: string | undefined;
  vendor?: { code?: string | undefined; error_code?: string | undefined; message?: string | undefined } | undefined;
  checked_at?: number | undefined; state?: "verified" | "unavailable" | undefined;
}

export function presentUpstreamDiagnostics(value: UpstreamDiagnostics | UpstreamObservation): PublicUpstreamDiagnostics {
  return {
    ...(value.httpStatusCode === undefined ? {} : { http_status: value.httpStatusCode }),
    ...(value.businessCode === undefined ? {} : { business_code: value.businessCode }),
    ...(value.message === undefined ? {} : { message: value.message }),
    ...(value.requestId === undefined ? {} : { request_id: value.requestId }),
    ...(value.taskCode === undefined ? {} : { task_code: value.taskCode }),
    ...(value.taskStatus === undefined ? {} : { task_status: value.taskStatus }),
    ...(value.vendor === undefined ? {} : { vendor: {
      ...(value.vendor.code === undefined ? {} : { code: value.vendor.code }),
      ...(value.vendor.errorCode === undefined ? {} : { error_code: value.vendor.errorCode }),
      ...(value.vendor.message === undefined ? {} : { message: value.vendor.message })
    } }),
    ...("checkedAt" in value ? { checked_at: value.checkedAt, state: value.state } : {})
  };
}

const upstreamDiagnosticStore = new WeakMap<Error, UpstreamDiagnostics>();
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/giu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const SENSITIVE_ASSIGNMENT_PATTERN = /\b(prompt|negative_prompt|text|content|csrf|pin|origin[_-]?pin|sign|[a-z0-9_-]*(?:authorization|cookie|token|secret|session|api[_-]?key|password|passwd|credential|access[_-]?key|signature)[a-z0-9_-]*)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;,]+)/giu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
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
    .replace(JWT_PATTERN, "[REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(/\s+/gu, " ")
    .trim();
  if (sanitized.length === 0) return undefined;
  return sanitized.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH - 1)}…`;
}

export function upstreamDiagnostics(cause: unknown): UpstreamDiagnostics | undefined {
  return cause instanceof Error ? upstreamDiagnosticStore.get(cause) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

// Only inspect documented envelope/task branches. Never copy raw payloads, headers or URLs.
function diagnosticBranches(value: unknown): Record<string, unknown>[] {
  const root = record(value);
  if (root === undefined) return [];
  const branches = [root];
  for (let index = 0; index < branches.length && index < 12; index += 1) {
    const branch = branches[index];
    if (branch === undefined) continue;
    for (const key of ["result", "data", "task", "taskInfo"]) {
      const nested = record(branch[key]);
      if (nested !== undefined && !branches.includes(nested)) branches.push(nested);
    }
  }
  return branches.slice(0, 12);
}

export function upstreamBusinessFailed(value: unknown): boolean {
  const root = record(value);
  if (root?.error !== undefined && root.error !== null) return true;
  return diagnosticBranches(value).some(branch => branch.success === false || branch.error === "TASK_RUN_FAILED");
}

export function extractUpstreamDiagnostics(value: unknown, statusCode?: number): UpstreamDiagnostics | undefined {
  const branches = diagnosticBranches(value);
  const root = branches[0];
  const error = record(root?.error);
  const diagnostics: UpstreamDiagnostics = {};
  if (Number.isInteger(statusCode) && statusCode !== undefined && statusCode >= 100 && statusCode <= 599) diagnostics.httpStatusCode = statusCode;
  const code = safeBusinessCode(error?.code);
  const message = safeDiagnosticMessage(error?.message);
  const requestId = safeBusinessCode(root?.requestId);
  if (code !== undefined) diagnostics.businessCode = code;
  if (message !== undefined) diagnostics.message = message;
  if (requestId !== undefined) diagnostics.requestId = requestId;
  for (const branch of branches) {
    const taskCode = safeBusinessCode(branch.error);
    if (taskCode !== undefined && diagnostics.taskCode === undefined) diagnostics.taskCode = taskCode;
    const taskStatus = safeBusinessCode(branch.status);
    if (taskStatus !== undefined && diagnostics.taskStatus === undefined) diagnostics.taskStatus = taskStatus;
    if (diagnostics.message === undefined) {
      const taskMessage = safeDiagnosticMessage(branch.errMsg ?? branch.errorMessage ?? branch.failReason);
      if (taskMessage !== undefined) diagnostics.message = taskMessage;
    }
    const origin = record(branch.originError);
    if (origin === undefined || diagnostics.vendor !== undefined) continue;
    const vendorCode = safeBusinessCode(origin.venderCode ?? origin.vendorCode);
    const vendorError = safeBusinessCode(origin.errCode);
    const vendorMessage = safeDiagnosticMessage(origin.errDesc);
    const vendor: NonNullable<UpstreamDiagnostics["vendor"]> = {};
    if (vendorCode !== undefined) vendor.code = vendorCode;
    if (vendorError !== undefined) vendor.errorCode = vendorError;
    if (vendorMessage !== undefined) vendor.message = vendorMessage;
    if (Object.keys(vendor).length > 0) diagnostics.vendor = vendor;
  }
  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

export function mapUpstreamEnvelope(value: unknown, statusCode?: number): AppError {
  const root = record(value);
  const mapped = mapUpstreamError(record(root?.error), statusCode);
  const diagnostics = extractUpstreamDiagnostics(value, statusCode);
  if (diagnostics !== undefined) {
    upstreamDiagnosticStore.set(mapped, diagnostics);
    mapped.context = { upstream: presentUpstreamDiagnostics(diagnostics) };
  }
  return mapped;
}

export class SubmitAmbiguousError extends AppError {
  constructor(diagnostics?: UpstreamDiagnostics) {
    super(502, "upstream_error", "lingjing_submit_ambiguous", "Lingjing submit outcome is unknown");
    this.name = "SubmitAmbiguousError";
    if (diagnostics !== undefined) upstreamDiagnosticStore.set(this, diagnostics);
  }
}

export class TransportUncertainError extends Error {
  constructor(diagnostics?: UpstreamDiagnostics) {
    super("Lingjing transport response could not be verified");
    this.name = "TransportUncertainError";
    if (diagnostics !== undefined) upstreamDiagnosticStore.set(this, diagnostics);
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
  if (Object.keys(diagnostics).length > 0) {
    upstreamDiagnosticStore.set(mapped, diagnostics);
    mapped.context = { upstream: presentUpstreamDiagnostics(diagnostics) };
  }
  return mapped;
}

export function isTransportUncertain(cause: unknown): boolean {
  return !(cause instanceof AppError);
}
