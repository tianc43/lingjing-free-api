import type { FastifyRequest } from "fastify";
import type {
  MultipartFile,
  MultipartValue
} from "@fastify/multipart";
import { AppError, errors } from "../errors.js";
import { createTempBudget } from "../media/temp-budget.js";
import type { MediaInput, PreparedMedia } from "../media/types.js";
import type {
  TempBudget,
  TempBudgetLease
} from "../media/types.js";
import type { AppDependencies } from "./types.js";

const MAX_IMAGE_FILES = 14;
const IMAGE_FIELDS = new Set(["image", "input_images", "input_images[]"]);
const IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);
const MULTIPART_LIMIT_CODES = new Set([
  "FST_FILES_LIMIT",
  "FST_PARTS_LIMIT",
  "FST_REQ_FILE_TOO_LARGE"
]);

export interface ParsedGenerationBody {
  body: Record<string, unknown>;
  media: MediaInput[];
}

function requestTooLarge(cause: unknown): never {
  if (
    cause instanceof AppError
    && cause.code === "temporary_storage_exhausted"
  ) {
    throw new AppError(
      413,
      "invalid_request_error",
      "request_too_large",
      "Multipart request exceeds the configured media limit"
    );
  }
  throw cause;
}

export function createRequestMediaBudget(maxBytes: number): TempBudget {
  const budget = createTempBudget(maxBytes);
  return {
    reserve(initialBytes: number): TempBudgetLease {
      let lease: TempBudgetLease;
      try {
        lease = budget.reserve(initialBytes);
      } catch (cause) {
        requestTooLarge(cause);
      }
      return {
        growTo(bytes: number): void {
          try {
            lease.growTo(bytes);
          } catch (cause) {
            requestTooLarge(cause);
          }
        },
        release: () => {
          lease.release();
        }
      };
    },
    usedBytes: () => budget.usedBytes()
  };
}

function multipartCode(cause: unknown): string | null {
  if (
    typeof cause !== "object"
    || cause === null
    || !("code" in cause)
    || typeof cause.code !== "string"
  ) {
    return null;
  }
  return cause.code;
}

function normalizeFields(
  fields: Map<string, string[]>
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [name, values] of fields) {
    if (values.length !== 1 && name !== "input_images") {
      throw errors.invalidRequest(`Duplicate multipart field ${name}`, name);
    }
    if (name === "input_images") {
      body[name] = values.flatMap((value) => {
        if (!value.trim().startsWith("[")) return [value];
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          throw errors.invalidRequest("Invalid input_images JSON", name);
        }
        if (
          !Array.isArray(parsed)
          || !parsed.every((item) => typeof item === "string")
        ) {
          throw errors.invalidRequest("Invalid input_images JSON", name);
        }
        return parsed;
      });
      continue;
    }
    const value = values[0] as string;
    if (name === "n" || name === "duration") {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
        throw errors.invalidRequest(`Invalid numeric field ${name}`, name);
      }
      body[name] = Number(value);
      continue;
    }
    if (name === "parameters") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw errors.invalidRequest("Invalid parameters JSON", name);
      }
      if (
        typeof parsed !== "object"
        || parsed === null
        || Array.isArray(parsed)
      ) {
        throw errors.invalidRequest("Invalid parameters JSON", name);
      }
      body[name] = parsed;
      continue;
    }
    body[name] = value;
  }
  return body;
}

async function discard(part: MultipartFile): Promise<void> {
  for await (const chunk of part.file) {
    void chunk;
    // Drain rejected parts so the multipart parser can terminate cleanly.
  }
}

async function prepareFile(
  part: MultipartFile,
  dependencies: AppDependencies,
  requestBudget: ReturnType<
    AppDependencies["media"]["createRequestBudget"]
  >
): Promise<PreparedMedia> {
  if (!IMAGE_FIELDS.has(part.fieldname)) {
    await discard(part);
    throw errors.invalidRequest(
      `Unsupported multipart file field ${part.fieldname}`,
      part.fieldname
    );
  }
  const contentType = part.mimetype.toLowerCase();
  if (!IMAGE_MIME_TYPES.has(contentType)) {
    await discard(part);
    throw errors.invalidRequest("Unsupported image MIME type", part.fieldname);
  }
  const media = await dependencies.media.prepareStream(part.file, {
    filename: part.filename,
    contentType,
    maxBytes: dependencies.config.maxImageBytes,
    requestBudget
  });
  if (part.file.truncated) {
    await media.dispose();
    throw new AppError(
      413,
      "invalid_request_error",
      "request_too_large",
      "Multipart image exceeds the configured size limit",
      part.fieldname
    );
  }
  return media;
}

function fieldValue(part: MultipartValue): string {
  return typeof part.value === "string"
    ? part.value
    : String(part.value);
}

export async function parseGenerationMultipart(
  request: FastifyRequest,
  dependencies: AppDependencies
): Promise<ParsedGenerationBody> {
  if (!request.isMultipart()) {
    throw errors.invalidRequest("Expected multipart request");
  }
  const fields = new Map<string, string[]>();
  const prepared: PreparedMedia[] = [];
  const requestBudget = dependencies.media.createRequestBudget();

  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (prepared.length >= MAX_IMAGE_FILES) {
          await discard(part);
          throw errors.invalidRequest(
            "Too many multipart image files",
            part.fieldname
          );
        }
        prepared.push(await prepareFile(
          part,
          dependencies,
          requestBudget
        ));
      } else {
        const values = fields.get(part.fieldname) ?? [];
        values.push(fieldValue(part));
        fields.set(part.fieldname, values);
      }
    }
    return {
      body: normalizeFields(fields),
      media: prepared.map((media) => ({
        kind: "image",
        source: { type: "prepared", media }
      }))
    };
  } catch (cause) {
    await Promise.allSettled(prepared.map((media) => media.dispose()));
    if (cause instanceof AppError) throw cause;
    const code = multipartCode(cause);
    if (code !== null && MULTIPART_LIMIT_CODES.has(code)) {
      throw new AppError(
        413,
        "invalid_request_error",
        "request_too_large",
        "Multipart request exceeds the configured limit"
      );
    }
    throw cause;
  }
}
