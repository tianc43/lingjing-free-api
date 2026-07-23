import type { FastifyInstance } from "fastify";
import type { FastifyReply } from "fastify";
import { ZodError } from "zod";
import { AppError, errors } from "../errors.js";

interface FastifyValidationError {
  validation?: unknown;
}

function validationParam(error: FastifyValidationError): string | null {
  if (!Array.isArray(error.validation)) return null;
  const first: unknown = error.validation[0];
  if (
    typeof first !== "object"
    || first === null
    || !("instancePath" in first)
    || typeof first.instancePath !== "string"
  ) {
    return null;
  }
  const path = first.instancePath.replace(/^\//u, "").replaceAll("/", ".");
  return path.length === 0 ? null : path;
}

function requestError(cause: unknown): AppError | null {
  if (cause instanceof ZodError) {
    const first = cause.issues[0];
    const param = first?.path.map(String).join(".") || null;
    return errors.invalidRequest("Invalid request", param);
  }
  if (
    typeof cause === "object"
    && cause !== null
    && "validation" in cause
  ) {
    return errors.invalidRequest(
      "Invalid request",
      validationParam(cause)
    );
  }
  if (
    typeof cause === "object"
    && cause !== null
    && "code" in cause
    && cause.code === "FST_ERR_CTP_INVALID_JSON_BODY"
  ) {
    return errors.invalidRequest("Invalid request");
  }
  if (
    typeof cause === "object"
    && cause !== null
    && "code" in cause
    && cause.code === "FST_ERR_CTP_BODY_TOO_LARGE"
  ) {
    return new AppError(
      413,
      "invalid_request_error",
      "request_too_large",
      "Request body too large"
    );
  }
  return null;
}

function sendError(
  reply: FastifyReply,
  error: AppError
): FastifyReply {
  return reply
    .header("Cache-Control", "no-store")
    .code(error.statusCode)
    .send(error.toBody());
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((cause, _request, reply) => {
    if (cause instanceof AppError) {
      return sendError(reply, cause);
    }
    const invalid = requestError(cause);
    if (invalid !== null) {
      return sendError(reply, invalid);
    }

    // Never serialize an unknown error, its stack, or its cause chain.
    app.log.error(
      {
        error_code: typeof cause === "object"
          && cause !== null
          && "code" in cause
          && typeof cause.code === "string"
          ? cause.code
          : "unknown_upstream_error"
      },
      "request failed"
    );
    return sendError(reply, errors.upstream());
  });
}
