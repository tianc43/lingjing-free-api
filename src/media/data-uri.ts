import { errors } from "../errors.js";
import type { PreparedMedia, TempBudget } from "./types.js";
import { createPreparedTempFileFromBuffer } from "./temp-files.js";

export interface PrepareDataUriOptions {
  kind: "image" | "video";
  maxBytes: number;
  tempDirectory: string;
  tempBudget: TempBudget;
  requestBudget: TempBudget;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm"
};

function decodedBase64Size(value: string): number {
  if (
    value.length === 0
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    throw errors.invalidRequest("Invalid base64 media data");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export async function prepareDataUri(
  value: string,
  options: PrepareDataUriOptions
): Promise<PreparedMedia> {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw errors.invalidRequest("Media data URI must be base64 encoded");
  }
  const contentType = match[1].toLowerCase();
  if (
    !/^(?:image|video)\/[a-z0-9][a-z0-9.+-]*$/u.test(contentType)
    || !contentType.startsWith(`${options.kind}/`)
  ) {
    throw errors.invalidRequest("Unsupported media data URI content type");
  }

  const size = decodedBase64Size(match[2]);
  if (size > options.maxBytes) {
    throw errors.invalidRequest("Media exceeds the configured size limit");
  }

  const extension = EXTENSIONS[contentType]
    ?? `.${contentType.split("/")[1]?.replace(/[^a-z0-9]+/gu, "").slice(0, 12) || "bin"}`;
  const data = Buffer.from(match[2], "base64");
  if (data.byteLength !== size) {
    throw errors.invalidRequest("Invalid base64 media data");
  }

  return createPreparedTempFileFromBuffer(data, {
    filename: `media${extension}`,
    contentType,
    tempDirectory: options.tempDirectory,
    tempBudget: options.tempBudget,
    requestBudget: options.requestBudget
  });
}
