import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { errors, sanitizeError } from "../errors.js";
import type { PreparedMedia, UploadedMaterial } from "../media/types.js";
import type {
  LingjingTransport,
  SignedUploadResponse
} from "../lingjing/types.js";
import { initializedUploadId } from "../lingjing/error-map.js";
import type { InitUploadResult, UploadService } from "./types.js";

const UPLOAD_TIMEOUT_MS = 30_000;
const MAX_PART_CONCURRENCY = 3;

type ObjectRecord = Record<string, unknown>;

export type UploadTransport = Pick<
  LingjingTransport,
  "uploadApi" | "putSigned"
>;

export interface LingjingUploadServiceOptions {
  uploadStrategy: "general" | "materials";
}

interface UploadContext {
  sceneCode: string;
  modelCode: string;
  spaceId: number;
}

function isPlainObject(value: unknown): value is ObjectRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null
    ? null
    : typeof value === "string"
      ? value
      : undefined;
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function validSignedUrl(value: unknown): string | undefined {
  const candidate = nonEmptyString(value);
  if (candidate === undefined) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function potentialUploadId(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  if (isPlainObject(value.single)) {
    return nonEmptyString(value.single.uploadId);
  }
  if (isPlainObject(value.multipart)) {
    return nonEmptyString(value.multipart.uploadId);
  }
  return undefined;
}

function normalizeInit(value: unknown, mediaSize: number): InitUploadResult {
  if (!isPlainObject(value)) throw errors.upstream();
  const hasSingle = "single" in value;
  const hasMultipart = "multipart" in value;
  if (hasSingle === hasMultipart) throw errors.upstream();

  if (hasSingle) {
    if (!isPlainObject(value.single)) throw errors.upstream();
    const uploadId = nonEmptyString(value.single.uploadId);
    const uploadUrl = validSignedUrl(value.single.uploadUrl);
    if (uploadId === undefined || uploadUrl === undefined) {
      throw errors.upstream();
    }
    return { uploadType: "single", uploadId, uploadUrl };
  }

  if (!isPlainObject(value.multipart)) throw errors.upstream();
  const uploadId = nonEmptyString(value.multipart.uploadId);
  const totalParts = value.multipart.totalParts;
  if (
    uploadId === undefined
    || !safeInteger(totalParts)
    || totalParts <= 0
    || !Array.isArray(value.multipart.parts)
    || value.multipart.parts.length !== totalParts
  ) {
    throw errors.upstream();
  }

  const parts: Extract<
    InitUploadResult,
    { uploadType: "multipart" }
  >["parts"] = [];
  let expectedStart = 0;
  for (const rawPart of value.multipart.parts) {
    if (!isPlainObject(rawPart)) throw errors.upstream();
    const partNumber = rawPart.partNumber;
    const byteStart = rawPart.byteStart;
    const byteEndInclusive = rawPart.byteEndInclusive;
    const uploadUrl = validSignedUrl(rawPart.uploadUrl);
    if (
      !safeInteger(partNumber)
      || partNumber !== parts.length + 1
      || !safeInteger(byteStart)
      || byteStart !== expectedStart
      || !safeInteger(byteEndInclusive)
      || byteEndInclusive < byteStart
      || byteEndInclusive >= mediaSize
      || uploadUrl === undefined
    ) {
      throw errors.upstream();
    }
    parts.push({
      partNumber,
      byteStart,
      byteEndInclusive,
      uploadUrl
    });
    expectedStart = byteEndInclusive + 1;
  }
  if (expectedStart !== mediaSize) throw errors.upstream();
  return {
    uploadType: "multipart",
    uploadId,
    totalParts,
    parts
  };
}

function ensureSuccessfulPut(response: SignedUploadResponse): void {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw errors.upstream();
  }
}

function normalizeMaterial(value:unknown):UploadedMaterial{if(!isPlainObject(value))throw errors.upstream();const nested=isPlainObject(value.result)?value.result:value,result=isPlainObject(nested.result)?nested.result:nested;const filePath=nonEmptyString(result.filePath)??nonEmptyString(result.url)??nonEmptyString(result.result);const frameUrl=nullableString(result.frameUrl);
  if (filePath === undefined || frameUrl === undefined) {
    throw errors.upstream();
  }
  const vendor = nonEmptyString(result.vendor)
    ?? nonEmptyString(result.vender)
    ?? null;
  return {
    value: filePath,
    filePath,
    frameUrl,
    vendor
  };
}

function multipartBody(
  media: PreparedMedia,
  context: UploadContext,
  boundary: string
): NodeJS.ReadableStream {
  const escapedFilename = media.filename
    .replace(/[\r\n"]/gu, "_")
    .slice(0, 180);
  const fields = [
    ["sceneCode", context.sceneCode],
    ["modelCode", context.modelCode],
    ["spaceId", String(context.spaceId)]
  ] as const;

  async function* chunks(): AsyncGenerator<Buffer> {
    for (const [name, value] of fields) {
      yield Buffer.from(
        `--${boundary}\r\n`
        + `Content-Disposition: form-data; name="${name}"\r\n\r\n`
        + `${value}\r\n`
      );
    }
    yield Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${escapedFilename}"\r\n`
      + `Content-Type: ${media.contentType}\r\n\r\n`
    );
    for await (const chunk of media.openRead()) {
      yield Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array | string);
    }
    yield Buffer.from(`\r\n--${boundary}--\r\n`);
  }

  return Readable.from(chunks());
}

export class LingjingUploadService implements UploadService {
  constructor(
    private readonly transport: UploadTransport,
    private readonly options: LingjingUploadServiceOptions
  ) {}

  async upload(
    media: PreparedMedia,
    context: UploadContext
  ): Promise<UploadedMaterial> {
    let failed = false;
    try {
      return this.options.uploadStrategy === "materials"
        ? await this.uploadMaterials(media, context)
        : await this.uploadGeneral(media, context);
    } catch (cause) {
      failed = true;
      throw sanitizeError(cause, errors.upstream());
    } finally {
      const disposal = media.dispose();
      if (failed) {
        await disposal.catch(() => undefined);
      } else {
        await disposal;
      }
    }
  }

  private async uploadMaterials(
    media: PreparedMedia,
    context: UploadContext
  ): Promise<UploadedMaterial> {
    const boundary = `lingjing-${randomUUID()}`;
    const result = await this.transport.uploadApi<unknown>(
      "/joycreator/AIModelApiConsole/uploadMaterials",
      {
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`
        },
        body: multipartBody(media, context, boundary),
        timeoutMs: UPLOAD_TIMEOUT_MS
      }
    );
    return normalizeMaterial(result);
  }

  private async uploadGeneral(
    media: PreparedMedia,
    context: UploadContext
  ): Promise<UploadedMaterial> {
    let uploadId: string | undefined;
    try {
      const rawInit = await this.transport.uploadApi<unknown>(
        "/joycreator/upload/init",
        {
          method: "POST",
          body: JSON.stringify({
            fileName: media.filename,
            fileSize: media.size,
            contentType: media.contentType,
            sceneCode: context.sceneCode,
            modelCode: context.modelCode,
            spaceId: context.spaceId
          }),
          timeoutMs: UPLOAD_TIMEOUT_MS
        }
      );
      uploadId = potentialUploadId(rawInit);
      const initialized = normalizeInit(rawInit, media.size);
      uploadId = initialized.uploadId;

      if (initialized.uploadType === "single") {
        const response = await this.transport.putSigned(
          new URL(initialized.uploadUrl),
          {
            method: "PUT",
            headers: {
              "content-type": media.contentType,
              "content-length": String(media.size)
            },
            body: media.openRead(),
            timeoutMs: UPLOAD_TIMEOUT_MS
          }
        );
        ensureSuccessfulPut(response);
      } else {
        await this.putParts(media, initialized);
      }

      const completed = await this.transport.uploadApi<unknown>(
        "/joycreator/upload/complete",
        {
          method: "POST",
          body: JSON.stringify({
            uploadId: initialized.uploadId,
            spaceId: context.spaceId
          }),
          timeoutMs: UPLOAD_TIMEOUT_MS
        }
      );
      return normalizeMaterial(completed);
    } catch (cause) {
      uploadId ??= initializedUploadId(cause);
      const original = sanitizeError(cause, errors.upstream());
      if (uploadId !== undefined) {
        await this.cancel(uploadId).catch(() => undefined);
      }
      throw original;
    }
  }

  private async putParts(
    media: PreparedMedia,
    initialized: Extract<InitUploadResult, { uploadType: "multipart" }>
  ): Promise<void> {
    let nextPartIndex = 0;
    let firstFailure: unknown;

    const worker = async (): Promise<void> => {
      while (firstFailure === undefined) {
        const part = initialized.parts[nextPartIndex];
        nextPartIndex += 1;
        if (part === undefined) return;
        try {
          const response = await this.transport.putSigned(
            new URL(part.uploadUrl),
            {
              method: "PUT",
              headers: {
                "content-type": media.contentType,
                "content-length": String(
                  part.byteEndInclusive - part.byteStart + 1
                )
              },
              body: media.openRead(
                part.byteStart,
                part.byteEndInclusive
              ),
              timeoutMs: UPLOAD_TIMEOUT_MS
            }
          );
          ensureSuccessfulPut(response);
        } catch (cause) {
          firstFailure ??= cause;
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(MAX_PART_CONCURRENCY, initialized.parts.length) },
        () => worker()
      )
    );
    if (firstFailure instanceof Error) throw firstFailure;
    if (firstFailure !== undefined) throw errors.upstream();
  }

  private async cancel(uploadId: string): Promise<void> {
    await this.transport.uploadApi(
      "/joycreator/upload/cancel",
      {
        method: "POST",
        body: JSON.stringify({ uploadId }),
        timeoutMs: UPLOAD_TIMEOUT_MS
      }
    );
  }
}
