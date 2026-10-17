import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { MAX_BODY_CHARS, sanitize } from "./redaction.js";

export interface CallContext {
  traceId: string; parentId: string | null; jobId: string | null;
  stream?: { format: "sse"; events: { event: string; data: unknown }[]; omitted_events: number; chars: number; error?: unknown };
}
export const callContext = new AsyncLocalStorage<CallContext>();

export function withCallJob<T>(jobId: string, work: () => T): T {
  const current = callContext.getStore();
  return callContext.run({ traceId: current?.traceId ?? randomUUID(), parentId: current?.parentId ?? null, jobId }, work);
}

export function bindCallJob(jobId: string): void {
  const current = callContext.getStore();
  if (current !== undefined) current.jobId = jobId;
}

// Called after a frame is written; never buffers or changes the actual stream.
export function observeCallStreamEvent(value: unknown, event = "message"): void {
  try {
    const context = callContext.getStore();
    if (!context) return;
    const stream = context.stream ??= { format: "sse", events: [], omitted_events: 0, chars: 0 };
    if (event === "error" && typeof value === "object" && value !== null && "error" in value) stream.error = value.error;
    const data = sanitize(value, 8192);
    const chars = JSON.stringify(data).length;
    if (stream.chars + chars > MAX_BODY_CHARS - 1024 || stream.events.length >= 100) { stream.omitted_events += 1; return; }
    stream.events.push({ event, data });
    stream.chars += chars;
  } catch { /* logging must not affect SSE delivery */ }
}

export function markCallStreamError(error: unknown): void {
  const context = callContext.getStore();
  if (!context) return;
  context.stream ??= { format: "sse", events: [], omitted_events: 0, chars: 0 };
  context.stream.error = error;
}
