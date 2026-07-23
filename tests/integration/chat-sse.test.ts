import { request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errors } from "../../src/errors.js";
import type { GenerationHandle } from "../../src/generation/types.js";
import type { JobRecord } from "../../src/jobs/types.js";
import { SseWriter } from "../../src/api/sse.js";
import {
  authorizedInject,
  createTestApp,
  imageModel,
  type TestApp
} from "../helpers/test-app.js";

interface ParsedData {
  id?: string;
  created?: number;
  model?: string;
  object?: string;
  choices?: Array<{
    delta: { role?: string; content?: string };
    finish_reason?: string | null;
  }>;
  error?: { code?: string; message?: string };
  job_id?: string;
  status?: string;
  elapsed_seconds?: number;
}

interface ParsedEvent {
  event?: string;
  data?: ParsedData;
  rawData: string;
}

function parseEvents(raw: string): ParsedEvent[] {
  return raw.split("\n\n").filter(Boolean).map((frame) => {
    const lines = frame.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))
      ?.slice("event: ".length);
    const rawData = lines
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .join("\n");
    return {
      ...(event === undefined ? {} : { event }),
      rawData,
      ...(rawData === "[DONE]" ? {} : {
        data: JSON.parse(rawData) as ParsedData
      })
    };
  });
}

function currentJob(
  status: JobRecord["status"],
  errorCode: string | null = null
): JobRecord {
  const now = Date.now();
  return {
    id: "job_abcdef1234567890",
    kind: "image",
    sourceType: "image-generation",
    model: "fixture-image",
    apiId: "707",
    modelCode: "private-model-code",
    expectedAssetScene: "private-asset-scene",
    requestFingerprint: "d".repeat(64),
    idempotencyKeyHash: null,
    spaceId: 91_001,
    status,
    creationCode: null,
    upstreamTaskId: null,
    upstreamFingerprint: null,
    submittedAt: now,
    discoveredAt: now,
    completedAt: status === "completed" ? now : null,
    failedAt: status === "failed" ? now : null,
    unknownHoldUntil: null,
    errorCode,
    result: status === "completed"
      ? {
          outputs: [{
            url: "https://media.example/result.png",
            posterUrl: null,
            width: 1024,
            height: 1024,
            duration: null,
            format: "png"
          }]
        }
      : null,
    createdAt: now,
    updatedAt: now
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("SseWriter", () => {
  it("frames one JSON data line per event and emits DONE exactly once", async () => {
    let raw = "";
    const output = new Writable({
      write(chunk, _encoding, callback) {
        raw += String(chunk);
        callback();
      }
    });
    const writer = new SseWriter(output);

    await writer.event({ line: "one\ntwo" }, "progress");
    await writer.done();
    await writer.done();

    expect(raw).toBe(
      "event: progress\ndata: {\"line\":\"one\\ntwo\"}\n\n"
      + "data: [DONE]\n\n"
    );
  });

  it("waits for drain when the writable applies backpressure", async () => {
    let writes = 0;
    const output = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        writes += 1;
        setTimeout(callback, 20);
      }
    });
    const writer = new SseWriter(output);
    let settled = false;
    const pending = writer.event({ ok: true }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    await pending;
    expect(writes).toBe(1);
  });
});

describe("chat completions SSE", () => {
  let fixture: TestApp;
  let nextHandle: GenerationHandle;
  let createError: Error | null;
  let createCalls: number;
  let stopPollerCalls: number;

  beforeEach(async () => {
    createError = null;
    createCalls = 0;
    stopPollerCalls = 0;
    nextHandle = {
      job: currentJob("completed"),
      wait: () => Promise.resolve(currentJob("completed"))
    };
    fixture = await createTestApp({
      catalog: {
        list: vi.fn((sourceType) => Promise.resolve(
          sourceType === "image-generation" ? [imageModel] : []
        )),
        resolve: vi.fn(() => Promise.resolve(imageModel))
      },
      coordinator: {
        create: vi.fn(() => {
          createCalls += 1;
          if (createError !== null) return Promise.reject(createError);
          return Promise.resolve(nextHandle);
        }),
        resume: vi.fn(),
        stopPollers: vi.fn(() => {
          stopPollerCalls += 1;
        })
      }
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fixture.close();
  });

  it("sends role first, progress, content, stop, and one DONE using correct headers", async () => {
    let now = Date.parse("2026-07-23T00:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const waits = [
      currentJob("processing"),
      currentJob("completed")
    ];
    nextHandle = {
      job: currentJob("processing"),
      wait: vi.fn(() => {
        now += 15_000;
        return Promise.resolve(waits.shift() ?? currentJob("completed"));
      })
    };

    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fixture-image",
        messages: [{ role: "user", content: "draw" }],
        stream: true
      }
    });
    const events = parseEvents(response.body);

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    expect(events[0]?.data).toMatchObject({
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" } }]
    });
    expect(events.some((event) => event.event === "progress")).toBe(true);
    expect(events.at(-3)?.data?.choices?.[0]?.delta.content)
      .toContain("https://media.example/result.png");
    expect(events.at(-2)?.data).toMatchObject({
      choices: [{ delta: {}, finish_reason: "stop" }]
    });
    const chunks = events
      .filter((event) => event.data?.object === "chat.completion.chunk")
      .map((event) => event.data);
    expect(chunks.map((event) => ({
      id: event?.id,
      created: event?.created,
      model: event?.model
    }))).toEqual([
      {
        id: "chatcmpl-abcdef1234567890",
        created: Date.parse("2026-07-23T00:00:00.000Z") / 1000,
        model: imageModel.id
      },
      {
        id: "chatcmpl-abcdef1234567890",
        created: Date.parse("2026-07-23T00:00:00.000Z") / 1000,
        model: imageModel.id
      },
      {
        id: "chatcmpl-abcdef1234567890",
        created: Date.parse("2026-07-23T00:00:00.000Z") / 1000,
        model: imageModel.id
      }
    ]);
    expect(events.at(-1)?.rawData).toBe("[DONE]");
    expect(events.filter((event) => event.rawData === "[DONE]")).toHaveLength(1);
    const progress = events.find((event) => event.event === "progress")?.data;
    expect(progress).toMatchObject({
        job_id: "job_abcdef1234567890",
        status: "processing"
      });
    expect(typeof progress?.elapsed_seconds).toBe("number");
  });

  it("returns a normal pre-header error but an event:error after headers", async () => {
    createError = errors.contentPolicy();
    const beforeHeaders = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fixture-image",
        messages: [{ role: "user", content: "blocked" }],
        stream: true
      }
    });
    expect(beforeHeaders.statusCode).toBe(400);
    expect(beforeHeaders.headers["content-type"]).toContain("application/json");
    expect(beforeHeaders.json()).toMatchObject({
      error: { code: "content_policy_violation" }
    });

    createError = null;
    nextHandle = {
      job: currentJob("processing"),
      wait: () => Promise.resolve(
        currentJob("failed", "content_policy_violation")
      )
    };
    const afterHeaders = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fixture-image",
        messages: [{ role: "user", content: "blocked later" }],
        stream: true
      }
    });
    const events = parseEvents(afterHeaders.body);
    expect(afterHeaders.statusCode).toBe(200);
    expect(events.some((event) =>
      event.event === "error"
      && event.data?.error?.code === "content_policy_violation"
    )).toBe(true);
    expect(events.at(-1)?.rawData).toBe("[DONE]");
  });

  it("turns wait timeouts and thrown unknown errors into safe SSE errors", async () => {
    fixture.dependencies.config.imageWaitTimeoutMs = 1;
    nextHandle = {
      job: currentJob("processing"),
      wait: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return currentJob("processing");
      })
    };
    const timeout = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fixture-image",
        messages: [{ role: "user", content: "slow" }],
        stream: true
      }
    });
    const timeoutEvents = parseEvents(timeout.body);
    expect(timeoutEvents.at(-2)).toMatchObject({
      event: "error",
      data: { error: { code: "generation_timeout" } }
    });
    expect(timeoutEvents.at(-1)?.rawData).toBe("[DONE]");

    nextHandle = {
      job: currentJob("processing"),
      wait: () => Promise.reject(
        new Error("private https://private.example/output?token=secret")
      )
    };
    const unknown = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fixture-image",
        messages: [{ role: "user", content: "explode" }],
        stream: true
      }
    });
    expect(parseEvents(unknown.body).at(-2)).toMatchObject({
      event: "error",
      data: {
        error: {
          code: "lingjing_upstream_error",
          message: "Lingjing upstream request failed"
        }
      }
    });
  });

  it("delivers the first raw chunk before completion and preserves multiline framing", async () => {
    const completion = deferred<JobRecord>();
    nextHandle = {
      job: currentJob("processing"),
      wait: () => completion.promise
    };
    const address = await fixture.app.listen({
      host: "127.0.0.1",
      port: 0
    });
    const firstChunk = deferred<string>();
    let raw = "";
    const responseDone = deferred<undefined>();
    const request = httpRequest(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer downstream-secret",
        "content-type": "application/json"
      }
    }, (response) => {
      response.setEncoding("utf8");
      response.once("data", (chunk: string) => {
        firstChunk.resolve(chunk);
      });
      response.on("data", (chunk: string) => {
        raw += chunk;
      });
      response.on("end", () => {
        responseDone.resolve(undefined);
      });
    });
    request.end(JSON.stringify({
      model: "fixture-image",
      messages: [{ role: "user", content: "raw chunks" }],
      stream: true
    }));

    const initial = await firstChunk.promise;
    expect(initial).toContain("\"role\":\"assistant\"");
    expect(raw).not.toContain("[DONE]");
    completion.resolve(currentJob("completed"));
    await responseDone.promise;

    const events = parseEvents(raw);
    expect(events.at(-1)?.rawData).toBe("[DONE]");
    expect(raw).toMatch(/\n\ndata: /u);
  });

  it("aborts only the disconnected wait listener and leaves the durable job untouched", async () => {
    const waitAborted = deferred<undefined>();
    nextHandle = {
      job: currentJob("processing"),
      wait: (_timeoutMs, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          waitAborted.resolve(undefined);
          reject(signal.reason instanceof Error
            ? signal.reason
            : new Error("wait aborted"));
        }, { once: true });
      })
    };
    const address = await fixture.app.listen({
      host: "127.0.0.1",
      port: 0
    });
    const request = httpRequest(`${address}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer downstream-secret",
        "content-type": "application/json"
      }
    }, (response) => {
      response.once("data", () => {
        response.destroy();
      });
    });
    request.end(JSON.stringify({
      model: "fixture-image",
      messages: [{ role: "user", content: "disconnect" }],
      stream: true
    }));

    await waitAborted.promise;
    expect(createCalls).toBe(1);
    expect(stopPollerCalls).toBe(0);
  });
});
