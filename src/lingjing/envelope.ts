import { extractUpstreamDiagnostics, mapUpstreamEnvelope, upstreamBusinessFailed, type UpstreamDiagnostics } from "./error-map.js";

const responseDiagnosticStore = new WeakMap<object, UpstreamDiagnostics>();
export function responseDiagnostics(value: unknown): UpstreamDiagnostics | undefined {
  return typeof value === "object" && value !== null ? responseDiagnosticStore.get(value) : undefined;
}

export interface Envelope<T> {
  error?: { code?: unknown; message?: unknown } | null;
  result?: T;
}

export function unwrapEnvelope<T>(value: Envelope<T>, statusCode?: number): T;
export function unwrapEnvelope(value: unknown, statusCode?: number): unknown;
export function unwrapEnvelope(value: unknown, statusCode?: number): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw mapUpstreamEnvelope(value, statusCode);
  }
  const envelope = value as Envelope<unknown>;
  if (statusCode !== undefined && (statusCode < 200 || statusCode >= 300)) {
    throw mapUpstreamEnvelope(value, statusCode);
  }
  if (upstreamBusinessFailed(value)) {
    throw mapUpstreamEnvelope(value, statusCode);
  }
  const diagnostics = extractUpstreamDiagnostics(value, statusCode);
  if (typeof envelope.result === "object" && envelope.result !== null && diagnostics !== undefined) responseDiagnosticStore.set(envelope.result, diagnostics);
  return envelope.result;
}
