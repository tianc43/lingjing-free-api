import { mapUpstreamError } from "./error-map.js";

export interface Envelope<T> {
  error?: { code?: unknown; message?: unknown } | null;
  result?: T;
}

export function unwrapEnvelope<T>(value: Envelope<T>, statusCode?: number): T;
export function unwrapEnvelope(value: unknown, statusCode?: number): unknown;
export function unwrapEnvelope(value: unknown, statusCode?: number): unknown {
  if (statusCode !== undefined && statusCode >= 500) {
    throw mapUpstreamError(undefined, statusCode);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw mapUpstreamError(undefined, statusCode);
  }
  const envelope = value as Envelope<unknown>;
  if (envelope.error !== null && envelope.error !== undefined) {
    throw mapUpstreamError(envelope.error, statusCode);
  }
  return envelope.result;
}
