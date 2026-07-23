import { AppError, errors } from "../errors.js";

interface UpstreamError {
  code?: unknown;
  message?: unknown;
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

export function mapUpstreamError(error: UpstreamError | null | undefined, statusCode?: number): AppError {
  const code = (typeof error?.code === "string" || typeof error?.code === "number" ? String(error.code) : "").toUpperCase();
  const message = (typeof error?.message === "string" ? error.message : "").toUpperCase();
  const text = `${code} ${message}`;
  if (text.includes("USER_NOT_LOGIN") || code === "406") return errors.loginRequired();
  if (text.includes("CSRF")) return errors.csrfExpired();
  if (text.includes("QUOTA") || text.includes("POINT")) return errors.insufficientQuota();
  if (text.includes("AUDIT") || text.includes("CONTENT")) return errors.contentPolicy();
  if (text.includes("RATE") || statusCode === 429) return errors.rateLimited();
  if (text.includes("PERMISSION") || statusCode === 403) return errors.permissionDenied();
  return errors.upstream();
}

export function isTransportUncertain(cause: unknown): boolean {
  return !(cause instanceof AppError);
}
