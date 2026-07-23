import { createReadStream } from "node:fs";
import { chmod, open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { errors } from "../errors.js";
import type {
  PreparedMedia,
  TempBudget,
  TempBudgetLease
} from "./types.js";

interface TempFileCommonOptions {
  filename: string;
  contentType: string;
  tempDirectory: string;
  tempBudget: TempBudget;
  requestBudget: TempBudget;
}

export type BufferTempFileOptions = TempFileCommonOptions;

export interface StreamTempFileOptions extends TempFileCommonOptions {
  maxBytes: number;
  declaredSize?: number;
}

function safeFilename(filename: string): string {
  const leaf = basename(filename)
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^[.-]+/u, "")
    .slice(0, 160);
  const extension = extname(leaf).slice(0, 20);
  const stem = basename(leaf, extension).slice(0, 100) || "media";
  return `${stem}-${randomUUID()}${extension.toLowerCase()}`;
}

function reserveBoth(
  tempBudget: TempBudget,
  requestBudget: TempBudget,
  initialBytes: number
): [TempBudgetLease, TempBudgetLease] {
  const tempLease = tempBudget.reserve(initialBytes);
  try {
    return [tempLease, requestBudget.reserve(initialBytes)];
  } catch (cause) {
    tempLease.release();
    throw cause;
  }
}

function growBoth(
  leases: [TempBudgetLease, TempBudgetLease],
  previousBytes: number,
  nextBytes: number
): void {
  leases[0].growTo(nextBytes);
  try {
    leases[1].growTo(nextBytes);
  } catch (cause) {
    leases[0].growTo(previousBytes);
    throw cause;
  }
}

function preparedFile(
  path: string,
  filename: string,
  contentType: string,
  size: number,
  leases: [TempBudgetLease, TempBudgetLease]
): PreparedMedia {
  let disposal: Promise<void> | undefined;
  return {
    filename,
    contentType,
    size,
    openRead(start?: number, endInclusive?: number): NodeJS.ReadableStream {
      if (
        start !== undefined
        && (!Number.isSafeInteger(start) || start < 0 || start >= size)
      ) {
        throw new RangeError("Invalid media range start");
      }
      if (
        endInclusive !== undefined
        && (
          !Number.isSafeInteger(endInclusive)
          || endInclusive < (start ?? 0)
          || endInclusive >= size
        )
      ) {
        throw new RangeError("Invalid media range end");
      }
      return createReadStream(path, {
        ...(start === undefined ? {} : { start }),
        ...(endInclusive === undefined ? {} : { end: endInclusive })
      });
    },
    dispose(): Promise<void> {
      disposal ??= rm(path, { force: true }).finally(() => {
        leases[0].release();
        leases[1].release();
      });
      return disposal;
    }
  };
}

async function privateTempFile(
  options: TempFileCommonOptions
): Promise<{
  handle: Awaited<ReturnType<typeof open>>;
  path: string;
  filename: string;
}> {
  const filename = safeFilename(options.filename);
  const path = join(options.tempDirectory, filename);
  const handle = await open(path, "wx", 0o600);
  await chmod(path, 0o600);
  return { handle, path, filename };
}

export async function createPreparedTempFileFromBuffer(
  data: Buffer,
  options: BufferTempFileOptions
): Promise<PreparedMedia> {
  const leases = reserveBoth(
    options.tempBudget,
    options.requestBudget,
    data.byteLength
  );
  let temporary:
    | Awaited<ReturnType<typeof privateTempFile>>
    | undefined;
  try {
    temporary = await privateTempFile(options);
    await temporary.handle.writeFile(data);
    await temporary.handle.close();
    return preparedFile(
      temporary.path,
      temporary.filename,
      options.contentType,
      data.byteLength,
      leases
    );
  } catch (cause) {
    await temporary?.handle.close().catch(() => undefined);
    if (temporary !== undefined) {
      await rm(temporary.path, { force: true }).catch(() => undefined);
    }
    leases[0].release();
    leases[1].release();
    throw cause;
  }
}

export async function createPreparedTempFileFromStream(
  stream: NodeJS.ReadableStream,
  options: StreamTempFileOptions
): Promise<PreparedMedia> {
  const declaredSize = options.declaredSize ?? 0;
  if (
    !Number.isSafeInteger(options.maxBytes)
    || options.maxBytes < 0
    || !Number.isSafeInteger(declaredSize)
    || declaredSize < 0
  ) {
    throw new TypeError("Media byte limits must be non-negative safe integers");
  }
  if (declaredSize > options.maxBytes) {
    throw errors.invalidRequest("Media exceeds the configured size limit");
  }

  const leases = reserveBoth(
    options.tempBudget,
    options.requestBudget,
    declaredSize
  );
  let temporary:
    | Awaited<ReturnType<typeof privateTempFile>>
    | undefined;
  let bytesWritten = 0;
  try {
    temporary = await privateTempFile(options);
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value as Uint8Array | string);
      const nextBytes = bytesWritten + chunk.byteLength;
      if (!Number.isSafeInteger(nextBytes) || nextBytes > options.maxBytes) {
        throw errors.invalidRequest("Media exceeds the configured size limit");
      }
      if (nextBytes > declaredSize) {
        growBoth(leases, Math.max(bytesWritten, declaredSize), nextBytes);
      }
      await temporary.handle.writeFile(chunk);
      bytesWritten = nextBytes;
    }
    if (bytesWritten < declaredSize) {
      growBoth(leases, declaredSize, bytesWritten);
    }
    await temporary.handle.close();
    return preparedFile(
      temporary.path,
      temporary.filename,
      options.contentType,
      bytesWritten,
      leases
    );
  } catch (cause) {
    await temporary?.handle.close().catch(() => undefined);
    if (temporary !== undefined) {
      await rm(temporary.path, { force: true }).catch(() => undefined);
    }
    leases[0].release();
    leases[1].release();
    throw cause;
  }
}
