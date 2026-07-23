import { createHash } from "node:crypto";

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export interface RequestFingerprintInput {
  model: string;
  parameters: Record<string, unknown>;
  inputContentHashes: readonly string[];
}

function canonicalize(value: unknown): CanonicalValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Fingerprint values must contain only finite numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Fingerprint values must be plain JSON-compatible objects");
    }
    const output: { [key: string]: CanonicalValue } = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        output[key] = canonicalize(item);
      }
    }
    return output;
  }
  throw new TypeError("Fingerprint values must be JSON-compatible");
}

function fingerprint(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function hashIdempotencyKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createRequestFingerprint(input: RequestFingerprintInput): string {
  return fingerprint({
    model: input.model,
    parameters: input.parameters,
    inputContentHashes: [...input.inputContentHashes]
  });
}

export function createUpstreamFingerprint(payload: unknown): string {
  return fingerprint(payload);
}
