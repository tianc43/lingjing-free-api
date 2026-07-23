import { isIP } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError, errors } from "../../errors.js";
import type { GenerationHandle } from "../../generation/types.js";
import type { JobRecord } from "../../jobs/types.js";
import { assertPublicHttpTarget } from "../../media/address-policy.js";
import type { MediaInput, PreparedMedia } from "../../media/types.js";
import type {
  NormalizedModel,
  NormalizedParameter
} from "../../models/types.js";
import { presentTask } from "../presenters.js";
import { idempotencyKeySchema } from "../schemas/generation.js";

export const IMAGE_CONTROL_FIELDS = new Set([
  "model",
  "prompt",
  "n",
  "size",
  "response_format",
  "response_mode",
  "input_images",
  "parameters"
]);

export const VIDEO_CONTROL_FIELDS = new Set([
  "model",
  "prompt",
  "mode",
  "duration",
  "resolution",
  "ratio",
  "input_images",
  "response_mode",
  "parameters"
]);

export function noStore(reply: FastifyReply): FastifyReply {
  return reply.header("Cache-Control", "no-store");
}

export function idempotencyKey(request: FastifyRequest): string | null {
  const value = request.headers["idempotency-key"];
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw errors.invalidRequest(
      "Idempotency-Key must be a single string",
      "Idempotency-Key"
    );
  }
  const result = idempotencyKeySchema.safeParse(value);
  if (!result.success) {
    throw errors.invalidRequest(
      "Idempotency-Key must contain 8 to 200 characters",
      "Idempotency-Key"
    );
  }
  return result.data;
}

export function assertNoControlCollisions(
  parameters: Record<string, unknown> | undefined,
  reserved: ReadonlySet<string>
): void {
  if (parameters === undefined) return;
  for (const key of Object.keys(parameters)) {
    if (reserved.has(key)) {
      throw errors.invalidRequest(
        `parameters cannot override control field ${key}`,
        `parameters.${key}`
      );
    }
  }
}

export function mediaFromStrings(values: readonly string[]): MediaInput[] {
  return values.map((value) => ({
    kind: "image",
    source: value.startsWith("data:")
      ? { type: "data-uri", value }
      : { type: "url", value }
  }));
}

function imageParameter(
  model: NormalizedModel
): NormalizedParameter | undefined {
  const matches = model.parameters.filter(
    (parameter) => parameter.kind === "image-list"
  );
  if (matches.length > 1) throw errors.catalogChanged();
  return matches[0];
}

export function validateMediaCount(
  model: NormalizedModel,
  count: number
): void {
  const parameter = imageParameter(model);
  if (parameter === undefined) {
    if (count > 0) {
      throw errors.invalidRequest("Model does not accept input images", "input_images");
    }
    return;
  }
  if (parameter.required && count === 0) {
    throw errors.invalidRequest("Model requires input images", "input_images");
  }
  if (parameter.maxFiles !== undefined && count > parameter.maxFiles) {
    throw errors.invalidRequest("Too many input images", "input_images");
  }
}

function invalidParameter(
  parameter: NormalizedParameter,
  message: string
): never {
  throw errors.invalidRequest(message, parameter.key);
}

function validateValue(
  parameter: NormalizedParameter,
  value: unknown
): void {
  if (
    parameter.kind === "string"
    && (
      typeof value !== "string"
      || (parameter.required && value.trim().length === 0)
    )
  ) {
    invalidParameter(parameter, `Invalid value for ${parameter.key}`);
  }
  if (
    parameter.kind === "boolean"
    && typeof value !== "boolean"
  ) {
    invalidParameter(parameter, `Invalid value for ${parameter.key}`);
  }
  if (
    parameter.kind === "number"
    && (
      typeof value !== "number"
      || !Number.isFinite(value)
      || (
        parameter.minimum !== undefined
        && value < parameter.minimum
      )
      || (
        parameter.maximum !== undefined
        && value > parameter.maximum
      )
    )
  ) {
    invalidParameter(parameter, `Invalid value for ${parameter.key}`);
  }
  if (
    parameter.kind === "enum"
    && (
      typeof value !== "string"
      || parameter.options?.includes(value) !== true
    )
  ) {
    invalidParameter(parameter, `Invalid value for ${parameter.key}`);
  }
}

export function validateDynamicValues(
  model: NormalizedModel,
  values: Record<string, unknown>
): void {
  const parameters = new Map(
    model.parameters
      .filter((parameter) => parameter.kind !== "image-list")
      .map((parameter) => [parameter.key, parameter])
  );
  for (const key of Object.keys(values)) {
    if (!parameters.has(key)) {
      throw errors.invalidRequest(`Unknown parameter ${key}`, key);
    }
  }
  for (const parameter of parameters.values()) {
    const provided = Object.hasOwn(values, parameter.key);
    const value = provided
      ? values[parameter.key]
      : parameter.defaultValue;
    if (value === undefined) {
      if (parameter.required) {
        invalidParameter(
          parameter,
          `Missing required parameter ${parameter.key}`
        );
      }
      continue;
    }
    validateValue(parameter, value);
  }
}

export function setIfSupported(
  values: Record<string, unknown>,
  model: NormalizedModel,
  candidates: readonly string[],
  value: unknown
): void {
  if (value === undefined) return;
  const parameter = model.parameters.find(
    (item) =>
      item.kind !== "image-list"
      && candidates.includes(item.key)
  );
  if (parameter !== undefined) values[parameter.key] = value;
}

export function setModelIfSupported(
  values: Record<string, unknown>,
  model: NormalizedModel
): void {
  const parameter = model.parameters.find(
    (item) => item.kind !== "image-list" && item.key === "model"
  );
  if (parameter !== undefined) {
    values[parameter.key] = parameter.defaultValue ?? model.alias;
  }
}

export async function disposeMedia(media: readonly MediaInput[]): Promise<void> {
  await Promise.allSettled(media.flatMap((input) =>
    input.source.type === "prepared"
      ? [input.source.media.dispose()]
      : []
  ));
}

export function pending(
  reply: FastifyReply,
  job: JobRecord
): FastifyReply {
  return noStore(reply)
    .header("Location", `/v1/tasks/${job.id}`)
    .code(202)
    .send(presentTask(job));
}

function safeFailureCode(value: string | null): string {
  return value !== null && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : "lingjing_generation_failed";
}

export function throwFailed(job: JobRecord): never {
  throw new AppError(
    502,
    "upstream_error",
    safeFailureCode(job.errorCode),
    "Lingjing generation failed"
  );
}

export async function waitedJob(
  handle: GenerationHandle,
  responseMode: "wait" | "async",
  timeoutMs: number
): Promise<JobRecord | null> {
  if (responseMode === "async") return null;
  // The request lifecycle never owns or cancels the durable worker.
  return handle.wait(timeoutMs);
}

function outputUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw errors.unsafeMedia();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.hostname.toLowerCase() === "localhost"
  ) {
    throw errors.unsafeMedia();
  }
  return url;
}

export async function safeOutputUrl(value: string): Promise<URL> {
  const url = outputUrl(value);
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (isIP(hostname) !== 0) {
    await assertPublicHttpTarget(url);
  }
  return url;
}

export async function readBoundedBase64(
  media: PreparedMedia,
  maxBytes: number
): Promise<string> {
  try {
    if (media.size > maxBytes) {
      throw errors.invalidRequest("Generated image exceeds the configured size limit");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of media.openRead()) {
      const value = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array | string);
      size += value.byteLength;
      if (!Number.isSafeInteger(size) || size > maxBytes) {
        throw errors.invalidRequest(
          "Generated image exceeds the configured size limit"
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString("base64");
  } finally {
    await media.dispose();
  }
}
