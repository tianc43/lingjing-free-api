import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GenerationHandle,
  GenerationRequest
} from "../../src/generation/types.js";
import {
  createRequestMediaBudget
} from "../../src/api/multipart.js";
import type { JobOutput, JobRecord } from "../../src/jobs/types.js";
import type {
  PreparedMedia,
  TempBudget
} from "../../src/media/types.js";
import {
  authorizedInject,
  createTestApp,
  imageModel,
  type TestApp
} from "../helpers/test-app.js";

const fixturePng = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

const fixtureOutputs: JobOutput[] = [
  {
    url: "https://media.example/result-one.png",
    posterUrl: null,
    width: 2048,
    height: 2048,
    duration: null,
    format: "png"
  },
  {
    url: "https://media.example/result-two.png",
    posterUrl: null,
    width: 1024,
    height: 1024,
    duration: null,
    format: "png"
  }
];

function job(
  status: JobRecord["status"],
  outputs: JobOutput[] = fixtureOutputs.slice(0, 1),
  errorCode: string | null = null
): JobRecord {
  const now = Date.now();
  return {
    id: "job_1234567890abcdef",
    kind: "image",
    sourceType: "image-generation",
    model: "fixture-image",
    apiId: "707",
    modelCode: "private-model-code",
    expectedAssetScene: "private-asset-scene",
    requestFingerprint: "a".repeat(64),
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
    result: status === "completed" ? { outputs } : null,
    createdAt: now,
    updatedAt: now
  };
}

function handle(
  initial: JobRecord,
  waited: JobRecord = initial,
  onWait?: (timeoutMs: number, signal?: AbortSignal) => void
): GenerationHandle {
  return {
    job: initial,
    wait: (timeoutMs, signal) => {
      onWait?.(timeoutMs, signal);
      return Promise.resolve(waited);
    }
  };
}

function prepared(
  value: Buffer,
  contentType = "image/png",
  declaredSize = value.byteLength
): PreparedMedia {
  return {
    filename: "fixture.png",
    contentType,
    size: declaredSize,
    openRead: () => Readable.from(value),
    dispose: vi.fn(() => Promise.resolve())
  };
}

function unlimitedBudget(): TempBudget {
  return {
    reserve: () => ({
      growTo: () => undefined,
      release: () => undefined
    }),
    usedBytes: () => 0
  };
}

function multipartBody(fields: Record<string, string>, files: Array<{
  field?: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}>): { boundary: string; body: Buffer } {
  const boundary = "----lingjing-real-multipart-boundary";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      "utf8"
    ));
  }
  for (const [index, file] of files.entries()) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? "image"}"; filename="${file.filename ?? `fixture-${String(index)}.png`}"\r\nContent-Type: ${file.contentType ?? "image/png"}\r\n\r\n`,
      "utf8"
    ));
    chunks.push(file.data, Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { boundary, body: Buffer.concat(chunks) };
}

describe("image generation API", () => {
  let fixture: TestApp;
  let requests: GenerationRequest[];
  let outputFetches: string[];
  let finalJob: JobRecord;
  let initialJob: JobRecord;
  let waitedSignal: AbortSignal | undefined;

  beforeEach(async () => {
    requests = [];
    outputFetches = [];
    finalJob = job("completed");
    initialJob = finalJob;
    const media = {
      createRequestBudget: unlimitedBudget,
      prepareStream: async (
        stream: NodeJS.ReadableStream,
        options: {
          filename: string;
          contentType: string;
          maxBytes: number;
          requestBudget: TempBudget;
        }
      ): Promise<PreparedMedia> => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          const value = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk as unknown as Uint8Array);
          size += value.byteLength;
          if (size > options.maxBytes) throw new Error("file too large");
          chunks.push(value);
        }
        return prepared(
          Buffer.concat(chunks),
          options.contentType,
          size
        );
      },
      fetchOutput: (
        url: URL
      ): Promise<PreparedMedia> => {
        outputFetches.push(url.toString());
        return Promise.resolve(prepared(Buffer.from(
          url.pathname.includes("two") ? "two" : "one",
          "utf8"
        )));
      }
    };
    fixture = await createTestApp({
      catalog: {
        list: () => Promise.resolve([imageModel]),
        resolve: () => Promise.resolve({
          ...imageModel,
          parameters: [
            ...imageModel.parameters,
            {
              idx: "2",
              key: "image",
              displayName: "Image",
              required: false,
              kind: "image-list",
              maxFiles: 14
            },
            {
              idx: "3",
              key: "taskNum",
              displayName: "Count",
              required: false,
              kind: "number",
              minimum: 1,
              maximum: 14
            }
          ]
        })
      },
      coordinator: {
        create: vi.fn((request: GenerationRequest) => {
          requests.push(request);
          return Promise.resolve(handle(
            initialJob,
            finalJob,
            (_timeoutMs, signal) => {
              waitedSignal = signal;
            }
          ));
        }),
        resume: vi.fn(),
        stopPollers: vi.fn()
      },
      media
    } as never);
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("returns an OpenAI-style waited image result", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      headers: { "idempotency-key": "image-request-1" },
      payload: {
        model: "fixture-image",
        prompt: "fixture prompt",
        response_mode: "wait",
        response_format: "url"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{
      created: number;
      job_id: string;
      data: Array<{ url: string }>;
    }>();
    expect(typeof body.created).toBe("number");
    expect(body.job_id).toMatch(/^job_/u);
    expect(body).toMatchObject({
      data: [{ url: "https://media.example/result-one.png" }]
    });
    expect(requests[0]).toMatchObject({
      kind: "image",
      sourceType: "image-generation",
      model: "fixture-image",
      idempotencyKey: "image-request-1",
      values: { prompt: "fixture prompt" }
    });
  });

  it("returns 202 with a queryable recoverable job for async mode", async () => {
    initialJob = job("processing", []);
    finalJob = initialJob;

    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      payload: {
        model: "fixture-image",
        prompt: "fixture prompt",
        response_mode: "async"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(
      `/v1/tasks/${initialJob.id}`
    );
    expect(response.json()).toMatchObject({
      id: initialJob.id,
      object: "lingjing.task",
      status: "processing"
    });
  });

  it("accepts a real multipart boundary and streams image parts into PreparedMedia", async () => {
    const multipart = multipartBody({
      model: "fixture-image",
      prompt: "fixture prompt"
    }, [{ data: fixturePng }]);

    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      headers: {
        "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(200);
    expect(requests[0]?.media).toHaveLength(1);
    expect(requests[0]?.media[0]?.source.type).toBe("prepared");
  });

  it("returns every normalized image when n is greater than one", async () => {
    finalJob = job("completed", fixtureOutputs);
    initialJob = finalJob;
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      payload: {
        model: "fixture-image",
        prompt: "fixture prompt",
        n: 2
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: unknown[] }>().data).toHaveLength(2);
    expect(requests[0]?.values).toMatchObject({
      prompt: "fixture prompt",
      taskNum: 2
    });
  });

  it("returns bounded base64 for every final output when requested", async () => {
    finalJob = job("completed", fixtureOutputs);
    initialJob = finalJob;
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      payload: {
        model: "fixture-image",
        prompt: "fixture prompt",
        n: 2,
        response_format: "b64_json"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{
      data: Array<{ b64_json: string }>;
    }>().data).toEqual([
      { b64_json: Buffer.from("one").toString("base64") },
      { b64_json: Buffer.from("two").toString("base64") }
    ]);
    expect(outputFetches).toEqual(fixtureOutputs.map((item) => item.url));
  });

  it("never presentation-fetches an arbitrary input URL", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      payload: {
        model: "fixture-image",
        prompt: "fixture prompt",
        input_images: ["https://input.example/private.png"],
        response_format: "url"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(outputFetches).toEqual([]);
    expect(requests[0]?.media).toEqual([{
      kind: "image",
      source: {
        type: "url",
        value: "https://input.example/private.png"
      }
    }]);
  });

  it("rejects an oversized fetched output before opening it", async () => {
    const dispose = vi.fn(() => Promise.resolve());
    const openRead = vi.fn(() => Readable.from(Buffer.from("oversized")));
    (fixture.dependencies as never as {
      media: { fetchOutput: () => Promise<PreparedMedia> };
    }).media.fetchOutput = () => Promise.resolve({
      filename: "large.png",
      contentType: "image/png",
      size: fixture.dependencies.config.maxImageBytes + 1,
      openRead,
      dispose
    });

    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      payload: {
        model: "fixture-image",
        prompt: "fixture prompt",
        response_format: "b64_json"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(openRead).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects an unsafe final output URL before fetching it", async () => {
    finalJob = job("completed", [{
      ...fixtureOutputs[0] as JobOutput,
      url: "http://127.0.0.1/private.png"
    }]);
    initialJob = finalJob;
    (fixture.dependencies as never as {
      media: { fetchOutput: () => Promise<PreparedMedia> };
    }).media.fetchOutput = () => Promise.reject(new Error("must not call"));

    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      payload: {
        model: "fixture-image",
        prompt: "fixture prompt",
        response_format: "b64_json"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "unsafe_media_url" }
    });
  });

  it("rejects unknown top-level fields and response-control collisions", async () => {
    for (const payload of [
      {
        model: "fixture-image",
        prompt: "fixture",
        surprise: true
      },
      {
        model: "fixture-image",
        prompt: "fixture",
        parameters: { response_mode: "async" }
      },
      {
        model: "fixture-image",
        prompt: "fixture",
        parameters: { prompt: "override" }
      }
    ]) {
      const response = await authorizedInject(fixture.app, {
        method: "POST",
        url: "/v1/images/generations",
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it("requires supplied idempotency keys to contain 8 to 200 characters", async () => {
    for (const key of ["short", "x".repeat(201)]) {
      const response = await authorizedInject(fixture.app, {
        method: "POST",
        url: "/v1/images/generations",
        headers: { "idempotency-key": key },
        payload: {
          model: "fixture-image",
          prompt: "fixture prompt"
        }
      });
      expect(response.statusCode).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it("preserves idempotency conflicts from the durable coordinator", async () => {
    fixture.dependencies.coordinator.create = vi.fn()
      .mockResolvedValueOnce(handle(finalJob))
      .mockRejectedValueOnce(
        new (await import("../../src/errors.js")).AppError(
          409,
          "invalid_request_error",
          "idempotency_conflict",
          "Idempotency key reused with different input"
        )
      );
    const headers = { "idempotency-key": "same-image-key" };
    const first = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      headers,
      payload: { model: "fixture-image", prompt: "first" }
    });
    const conflict = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      headers,
      payload: { model: "fixture-image", prompt: "different" }
    });

    expect(first.statusCode).toBe(200);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "idempotency_conflict" }
    });
  });

  it("does not pass the HTTP request abort signal into the worker wait", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      payload: {
        model: "fixture-image",
        prompt: "fixture prompt",
        response_mode: "wait"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(waitedSignal).toBeUndefined();
  });

  it("returns failed jobs through the shared mapped error envelope", async () => {
    finalJob = job("failed", [], "lingjing_task_failed");
    initialJob = finalJob;
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      payload: {
        model: "fixture-image",
        prompt: "fixture prompt"
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      error: { code: "lingjing_task_failed" }
    });
  });

  it("limits multipart image count, file size, aggregate size, and MIME type", async () => {
    const baseFields = {
      model: "fixture-image",
      prompt: "fixture prompt"
    };
    const cases = [
      multipartBody(baseFields, Array.from({ length: 15 }, () => ({
        data: fixturePng
      }))),
      multipartBody(baseFields, [{
        data: Buffer.alloc(17),
        contentType: "image/svg+xml"
      }])
    ];
    for (const multipart of cases) {
      const response = await authorizedInject(fixture.app, {
        method: "POST",
        url: "/v1/images/generations",
        headers: {
          "content-type": `multipart/form-data; boundary=${multipart.boundary}`
        },
        payload: multipart.body
      });
      expect([400, 413]).toContain(response.statusCode);
    }
  });

  it("rejects multipart aggregate bytes with a request-too-large error", async () => {
    fixture.dependencies.media.createRequestBudget = () =>
      createRequestMediaBudget(12);
    fixture.dependencies.media.prepareStream = async (stream, options) => {
      const lease = options.requestBudget.reserve(0);
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of stream) {
          const value = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk as unknown as Uint8Array);
          size += value.byteLength;
          lease.growTo(size);
          chunks.push(value);
        }
        const item = prepared(
          Buffer.concat(chunks),
          options.contentType,
          size
        );
        item.dispose = vi.fn(() => {
          lease.release();
          return Promise.resolve();
        });
        return item;
      } catch (cause) {
        lease.release();
        throw cause;
      }
    };
    const multipart = multipartBody({
      model: "fixture-image",
      prompt: "fixture prompt"
    }, [
      { data: Buffer.alloc(8) },
      { data: Buffer.alloc(8) }
    ]);

    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/images/generations",
      headers: {
        "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: "request_too_large" }
    });
    expect(requests).toHaveLength(0);
  });
});
