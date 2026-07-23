import { describe, expect, it } from "vitest";
import { AppError, errors } from "../../src/errors.js";

const cases = [
  ["authentication", errors.authentication, 401, "authentication_error", "invalid_api_key", "Invalid API key", null],
  ["login", errors.loginRequired, 503, "login_required", "lingjing_session_expired", "Lingjing login required", null],
  ["csrf", errors.csrfExpired, 503, "session_refresh_required", "lingjing_csrf_expired", "Lingjing session refresh required", null],
  ["permission", errors.permissionDenied, 403, "permission_denied", "lingjing_permission_denied", "Lingjing permission denied", null],
  ["catalog", errors.catalogChanged, 409, "invalid_request_error", "model_catalog_changed", "Lingjing model catalog changed", null],
  ["quota", errors.insufficientQuota, 429, "insufficient_quota", "lingjing_insufficient_points", "Insufficient Lingjing points", null],
  ["rate", errors.rateLimited, 429, "rate_limit_error", "lingjing_rate_limited", "Lingjing rate limited", null],
  ["unsafe media", errors.unsafeMedia, 400, "invalid_request_error", "unsafe_media_url", "Unsafe media URL", null],
  ["content policy", errors.contentPolicy, 400, "invalid_request_error", "content_policy_violation", "Content policy violation", null],
  ["idempotency", errors.idempotencyConflict, 409, "invalid_request_error", "idempotency_conflict", "Idempotency key reused with different input", null],
  ["upstream", errors.upstream, 502, "upstream_error", "lingjing_upstream_error", "Lingjing upstream request failed", null]
] as const;

describe("AppError factories", () => {
  it.each(cases)("serializes the %s error in the OpenAI shape", (_name, factory, statusCode, type, code, message, param) => {
    const error = factory();

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode, type, code, message, param });
    expect(error.toBody()).toEqual({ error: { message, type, param, code } });
  });

  it("preserves invalid-request message and parameter", () => {
    const error = errors.invalidRequest("Model is required", "model");

    expect(error).toMatchObject({
      statusCode: 400,
      type: "invalid_request_error",
      code: "invalid_request",
      message: "Model is required",
      param: "model"
    });
    expect(error.toBody()).toEqual({
      error: {
        message: "Model is required",
        type: "invalid_request_error",
        param: "model",
        code: "invalid_request"
      }
    });
  });
});
