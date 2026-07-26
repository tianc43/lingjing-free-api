export class AppError extends Error {
  readonly statusCode: number;
  readonly type: string;
  readonly code: string;
  readonly param: string | null;

  constructor(statusCode: number, type: string, code: string, message: string, param?: string | null) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.type = type;
    this.code = code;
    this.param = param ?? null;
  }

  toBody(): { error: { message: string; type: string; param: string | null; code: string } } {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param,
        code: this.code
      }
    };
  }
}

const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'<>]+/giu;

function stripUrlSecrets(value: string): string {
  return value.replace(ABSOLUTE_URL, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      const secretStart = candidate.search(/[?#]/u);
      return secretStart === -1
        ? candidate
        : candidate.slice(0, secretStart);
    }
  });
}

export function sanitizeError(
  cause: unknown,
  fallback: AppError
): Error {
  if (cause instanceof AppError) return cause;
  if (!(cause instanceof Error)) return fallback;
  cause.message = stripUrlSecrets(cause.message);
  if (cause.stack !== undefined) {
    cause.stack = stripUrlSecrets(cause.stack);
  }
  return cause;
}

export const errors = {
  authentication: () => new AppError(401, "authentication_error", "invalid_api_key", "Invalid API key"),
  adminAuthentication: () => new AppError(401, "authentication_error", "admin_authentication_required", "Administrator authentication required"),
  adminCsrf: () => new AppError(403, "permission_denied", "invalid_csrf_token", "Invalid administrator CSRF token"),
  adminConflict: () => new AppError(409, "invalid_request_error", "admin_state_conflict", "Administrator action conflicts with current state"),
  accountNameConflict: () => new AppError(409, "invalid_request_error", "account_name_conflict", "Account name already exists", "name"),
  apiKeyNameConflict: () => new AppError(409, "invalid_request_error", "api_key_name_conflict", "API key name already exists", "name"),
  apiKeyNotFound: () => new AppError(404, "invalid_request_error", "api_key_not_found", "API key not found", "id"),
  accountNotFound: () => new AppError(404, "invalid_request_error", "account_not_found", "Account not found", "id"),
  adminJobNotFound: () => new AppError(404, "invalid_request_error", "job_not_found", "Job not found", "id"),
  loginRequired: () => new AppError(503, "login_required", "lingjing_session_expired", "Lingjing login required"),
  csrfExpired: () => new AppError(503, "session_refresh_required", "lingjing_csrf_expired", "Lingjing session refresh required"),
  invalidImportedSession: () => new AppError(401, "authentication_error", "invalid_imported_session", "Imported session is invalid"),
  importValidationTimeout: () => new AppError(504, "upstream_error", "import_validation_timeout", "Imported session validation timed out"),
  permissionDenied: () => new AppError(403, "permission_denied", "lingjing_permission_denied", "Lingjing permission denied"),
  invalidRequest: (message: string, param: string | null = null) => new AppError(400, "invalid_request_error", "invalid_request", message, param),
  catalogChanged: () => new AppError(409, "invalid_request_error", "model_catalog_changed", "Lingjing model catalog changed"),
  insufficientQuota: () => new AppError(429, "insufficient_quota", "lingjing_insufficient_points", "Insufficient Lingjing points"),
  rateLimited: () => new AppError(429, "rate_limit_error", "lingjing_rate_limited", "Lingjing rate limited"),
  unsafeMedia: () => new AppError(400, "invalid_request_error", "unsafe_media_url", "Unsafe media URL"),
  temporaryStorageExhausted: () => new AppError(503, "server_error", "temporary_storage_exhausted", "Temporary media storage exhausted"),
  contentPolicy: () => new AppError(400, "invalid_request_error", "content_policy_violation", "Content policy violation"),
  idempotencyConflict: () => new AppError(409, "invalid_request_error", "idempotency_conflict", "Idempotency key reused with different input"),
  noEligibleAccount: () => new AppError(429, "rate_limit_error", "lingjing_no_eligible_account", "No eligible Lingjing account is available"),
  capacityExhausted: () => new AppError(429, "rate_limit_error", "lingjing_capacity_exhausted", "Lingjing generation capacity is temporarily exhausted"),
  upstream: () => new AppError(502, "upstream_error", "lingjing_upstream_error", "Lingjing upstream request failed")
};
