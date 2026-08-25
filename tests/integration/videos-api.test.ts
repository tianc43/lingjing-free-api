import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GenerationHandle,
  GenerationRequest
} from "../../src/generation/types.js";
import type { JobOutput, JobRecord } from "../../src/jobs/types.js";
import type {
  PreparedMedia,
  TempBudget
} from "../../src/media/types.js";
import {
  authorizedInject,
  createTestApp,
  videoModel,
  type TestApp
} from "../helpers/test-app.js";

const videoOutput: JobOutput = {
  url: "https://media.example/result.mp4",
  posterUrl: "https://media.example/poster.jpg",
  width: 1920,
  height: 1080,
  duration: 5,
  format: "mp4"
};

function unlimitedBudget(): TempBudget {
  return {
    reserve: () => ({
      growTo: () => undefined,
      release: () => undefined
    }),
    usedBytes: () => 0
  };
}

function videoMultipartBody(
  fields: Array<[string, string]> = [
    ["model", "fixture-video"],
    ["prompt", "fixture prompt"],
    ["mode", "image-to-video"]
  ]
): { boundary: string; body: Buffer } {
  const boundary = "----lingjing-video-multipart-boundary";
  const chunks = fields.map(([name, value]) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    "utf8"
  ));
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="frame.png"\r\nContent-Type: image/png\r\n\r\n`,
    "utf8"
  ));
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return { boundary, body: Buffer.concat(chunks) };
}

function videoJob(
  status: JobRecord["status"],
  outputs: JobOutput[] = [videoOutput],
  errorCode: string | null = null
): JobRecord {
  const now = Date.now();
  return {
    id: "job_abcdef1234567890",
    kind: "video",
    sourceType: "text-to-video",
    model: "fixture-video",
    apiId: "808",
    modelCode: "private-model-code",
    expectedAssetScene: "private-asset-scene",
    requestFingerprint: "b".repeat(64),
    idempotencyKeyHash: null,
    spaceId: 91_001,
    accountId: "legacy",
    quotedPoints: 0,
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

describe("video generation API", () => {
  let fixture: TestApp;
  let requests: GenerationRequest[];
  let initialJob: JobRecord;
  let finalJob: JobRecord;
  let waitedTimeout: number | undefined;

  beforeEach(async () => {
    requests = [];
    waitedTimeout = undefined;
    initialJob = videoJob("completed");
    finalJob = initialJob;
    fixture = await createTestApp({
      catalog: {
        list: () => Promise.resolve([videoModel]),
        resolve: (_model, sourceType) => Promise.resolve({
          ...videoModel,
          sourceType,
          parameters: [
            {
              idx: "1",
              key: "prompt",
              displayName: "Prompt",
              required: true,
              kind: "string"
            },
            {
              idx: "2",
              key: "model",
              displayName: "Model",
              required: true,
              kind: "enum",
              options: ["fixture-video"]
            },
            {
              idx: "3",
              key: "duration",
              displayName: "Duration",
              required: false,
              kind: "number",
              minimum: 3,
              maximum: 10
            },
            {
              idx: "4",
              key: "resolution",
              displayName: "Resolution",
              required: false,
              kind: "enum",
              options: ["720p", "1080p"]
            },
            {
              idx: "5",
              key: "ratio",
              displayName: "Ratio",
              required: false,
              kind: "enum",
              options: ["16:9", "9:16"]
            },
            ...(
              sourceType === "image-to-video"
                ? [{
                    idx: "6",
                    key: "image",
                    displayName: "Image",
                    required: true,
                    kind: "image-list" as const,
                    maxFiles: 1
                  }]
                : []
            )
          ]
        })
      },
      coordinator: {
        create: vi.fn((request: GenerationRequest) => {
          requests.push(request);
          return Promise.resolve(handle(
            initialJob,
            finalJob,
            (timeoutMs) => {
              waitedTimeout = timeoutMs;
            }
          ));
        }),
        resume: vi.fn(),
        resolveUnknown: vi.fn(() => {
          throw new Error("Unexpected unknown resolution");
        }),
        stopPollers: vi.fn()
      },
      media: {
        createRequestBudget: unlimitedBudget,
        prepareStream: async (
          stream: NodeJS.ReadableStream,
          options: {
            filename: string;
            contentType: string;
          }
        ): Promise<PreparedMedia> => {
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk as unknown as Uint8Array));
          }
          const data = Buffer.concat(chunks);
          return {
            filename: options.filename,
            contentType: options.contentType,
            size: data.byteLength,
            openRead: () => Readable.from(data),
            dispose: vi.fn(() => Promise.resolve())
          };
        },
        fetchOutput: () => Promise.reject(
          new Error("Video presentation does not fetch media")
        )
      }
    });
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("returns an extension-style waited text-to-video result", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      payload: {
        model: "fixture-video",
        prompt: "fixture prompt",
        mode: "text-to-video",
        duration: 5,
        resolution: "1080p",
        ratio: "16:9"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const body = response.json<{
      created: number;
      job_id: string;
      data: Array<{
        url: string;
        poster_url: string | null;
        duration: number | null;
      }>;
    }>();
    expect(typeof body.created).toBe("number");
    expect(body.job_id).toMatch(/^job_/u);
    expect(body).toMatchObject({
      data: [{
        url: "https://media.example/result.mp4",
        poster_url: "https://media.example/poster.jpg",
        duration: 5
      }]
    });
    expect(requests).toEqual([{
      principal: {
        userId: "usr_legacy",
        projectId: "prj_legacy",
        apiKeyId: "key_legacy_environment"
      },
      kind: "video",
      sourceType: "text-to-video",
      model: "fixture-video",
      values: {
        model: "fixture-video",
        prompt: "fixture prompt",
        duration: 5,
        resolution: "1080p",
        ratio: "16:9"
      },
      media: [],
      idempotencyKey: null
    }]);
    expect(waitedTimeout).toBe(
      fixture.dependencies.config.videoWaitTimeoutMs
    );
  });

  it("persists the authenticated managed key principal on video requests", async () => {
    const createdKey = fixture.dependencies.apiKeys.create("Video owner");
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/videos",
      headers: { ["authorization"]: `Bearer ${createdKey.secret}` },
      payload: {
        model: "fixture-video",
        prompt: "fixture prompt",
        mode: "text-to-video"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(requests.at(-1)?.principal).toEqual({
      userId: createdKey.record.userId,
      projectId: createdKey.record.projectId,
      apiKeyId: createdKey.record.id
    });
  });

  it("rejects video creation when the managed key lacks video:create", async () => {
    const restrictedKey = fixture.dependencies.apiKeys.create("Read only video", {
      scopes: ["models:read", "video:read"]
    });
    const response = await fixture.app.inject({
      method: "POST",
      url: "/v1/videos",
      headers: { ["authorization"]: `Bearer ${restrictedKey.secret}` },
      payload: {
        model: "fixture-video",
        prompt: "fixture prompt",
        mode: "text-to-video"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "api_scope_denied" } });
  });

  it("defaults the canonical video endpoint to asynchronous 202", async () => {
    initialJob = videoJob("processing");
    finalJob = initialJob;
    const response = await authorizedInject(fixture.app, { method:"POST",url:"/v1/videos",payload:{model:"fixture-video",prompt:"fixture",mode:"text-to-video"} });
    expect(response.statusCode).toBe(202);
  });

  it("lists, reads and cancels project-owned queued videos", async () => {
    const queued = fixture.repository.createOrGet({kind:"video",sourceType:"text-to-video",model:"fixture-video",apiId:"a",modelCode:null,expectedAssetScene:"video",requestFingerprint:"f".repeat(64),idempotencyKeyHash:null,spaceId:1}).job;
    const listed=await authorizedInject(fixture.app,{method:"GET",url:"/v1/videos?limit=10"});expect(listed.statusCode).toBe(200);expect(listed.json<{data:Array<{id:string}>}>().data.map((item)=>item.id)).toContain(queued.id);
    expect((await authorizedInject(fixture.app,{method:"GET",url:`/v1/videos/${queued.id}`})).statusCode).toBe(200);
    const cancelled=await authorizedInject(fixture.app,{method:"POST",url:`/v1/videos/${queued.id}/cancel`});expect(cancelled.statusCode).toBe(200);expect(cancelled.json()).toMatchObject({status:"failed",error:{code:"cancelled_before_submit"}});
  });

  it("accepts the executable video API alias", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos",
      payload: {
        model: "fixture-video",
        prompt: "fixture prompt",
        mode: "text-to-video"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: [{ url: videoOutput.url }]
    });
    expect(requests).toHaveLength(1);
  });

  it("passes a model-specific mode parameter without changing the source type", async () => {
    const resolve = fixture.dependencies.catalog.resolve.bind(
      fixture.dependencies.catalog
    );
    fixture.dependencies.catalog.resolve = async (value, sourceType) => {
      const current = await resolve(value, sourceType);
      return {
        ...current,
        parameters: [
          ...current.parameters,
          {
            idx: "8",
            key: "mode",
            displayName: "生成模式",
            required: true,
            kind: "enum",
            defaultValue: "std",
            options: ["std", "pro"]
          }
        ]
      };
    };

    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos",
      payload: {
        model: "fixture-video",
        prompt: "fixture prompt",
        mode: "text-to-video",
        parameters: { mode: "std" }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(requests[0]).toMatchObject({
      sourceType: "text-to-video",
      values: { mode: "std" }
    });
  });

  it("uses the upstream default for a model parameter instead of the public alias", async () => {
    const resolve = fixture.dependencies.catalog.resolve.bind(
      fixture.dependencies.catalog
    );
    fixture.dependencies.catalog.resolve = async (value, sourceType) => {
      const current = await resolve(value, sourceType);
      return {
        ...current,
        parameters: current.parameters.map((parameter) => (
          parameter.key === "model"
            ? {
                ...parameter,
                defaultValue: "fixture-upstream-video-model",
                options: ["fixture-upstream-video-model"]
              }
            : parameter
        ))
      };
    };

    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      payload: {
        model: "fixture-video",
        prompt: "fixture prompt",
        mode: "text-to-video"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(requests[0]?.values.model).toBe(
      "fixture-upstream-video-model"
    );
  });

  it("accepts parameters.mode when the resolved model declares a mode parameter", async () => {
    const resolve = fixture.dependencies.catalog.resolve.bind(
      fixture.dependencies.catalog
    );
    fixture.dependencies.catalog.resolve = async (value, sourceType) => {
      const current = await resolve(value, sourceType);
      return {
        ...current,
        parameters: [
          ...current.parameters,
          {
            idx: "7",
            key: "mode",
            displayName: "Quality mode",
            required: true,
            kind: "enum",
            defaultValue: "std",
            options: ["std", "pro", "4k"]
          }
        ]
      };
    };

    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      payload: {
        model: "fixture-video",
        prompt: "fixture prompt",
        mode: "text-to-video",
        parameters: { mode: "pro" }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(requests[0]?.sourceType).toBe("text-to-video");
    expect(requests[0]?.values.mode).toBe("pro");
  });

  it("accepts exactly the string duration options declared by the resolved model", async () => {
    const webDurationOptions = Array.from(
      { length: 13 },
      (_, index) => String(index + 3)
    );
    const resolve = fixture.dependencies.catalog.resolve.bind(
      fixture.dependencies.catalog
    );
    fixture.dependencies.catalog.resolve = async (value, sourceType) => {
      const current = await resolve(value, sourceType);
      return {
        ...current,
        parameters: current.parameters.map((parameter) => {
          if (parameter.key !== "duration") return parameter;
          const duration = { ...parameter };
          delete duration.minimum;
          delete duration.maximum;
          return {
            ...duration,
            kind: "enum" as const,
            defaultValue: "5",
            options: webDurationOptions
          };
        })
      };
    };

    for (const duration of webDurationOptions) {
      const response = await authorizedInject(fixture.app, {
        method: "POST",
        url: "/v1/videos/generations",
        payload: {
          model: "fixture-video",
          prompt: "fixture prompt",
          mode: "text-to-video",
          parameters: { duration }
        }
      });
      expect(response.statusCode).toBe(200);
    }

    const invalid = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      payload: {
        model: "fixture-video",
        prompt: "fixture prompt",
        mode: "text-to-video",
        parameters: { duration: "not-in-web-catalog" }
      }
    });

    expect(invalid.statusCode).toBe(400);
    expect(requests.map((request) => request.values.duration)).toEqual(
      webDurationOptions
    );
  });

  it("requires mode and an input image for image-to-video", async () => {
    for (const payload of [
      {
        model: "fixture-video",
        prompt: "fixture"
      },
      {
        model: "fixture-video",
        prompt: "fixture",
        mode: "image-to-video"
      }
    ]) {
      const response = await authorizedInject(fixture.app, {
        method: "POST",
        url: "/v1/videos/generations",
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it("rejects unavailable persistent input asset IDs without creating a job", async()=>{const before=requests.length;const response=await authorizedInject(fixture.app,{method:"POST",url:"/v1/videos",payload:{model:"fixture-video",prompt:"fixture",mode:"image-to-video",input_asset_ids:["missing"]}});expect(response.statusCode).toBe(400);expect(requests).toHaveLength(before);});

  it("maps image-to-video input URLs into image media", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      payload: {
        model: "fixture-video",
        prompt: "fixture",
        mode: "image-to-video",
        input_images: ["https://input.example/frame.png"]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(requests).toEqual([{
      principal: {
        userId: "usr_legacy",
        projectId: "prj_legacy",
        apiKeyId: "key_legacy_environment"
      },
      kind: "video",
      sourceType: "image-to-video",
      model: "fixture-video",
      values: {
        model: "fixture-video",
        prompt: "fixture"
      },
      media: [{
        kind: "image",
        source: {
          type: "url",
          value: "https://input.example/frame.png"
        }
      }],
      idempotencyKey: null
    }]);
  });

  it("accepts a real multipart image for image-to-video without buffering it in the route", async () => {
    const multipart = videoMultipartBody();
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      headers: {
        "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(200);
    const media = requests[0]?.media[0];
    expect(media?.source.type).toBe("prepared");
    expect(requests).toEqual([{
      principal: {
        userId: "usr_legacy",
        projectId: "prj_legacy",
        apiKeyId: "key_legacy_environment"
      },
      kind: "video",
      sourceType: "image-to-video",
      model: "fixture-video",
      values: {
        model: "fixture-video",
        prompt: "fixture prompt"
      },
      media: media === undefined ? [] : [media],
      idempotencyKey: null
    }]);
  });

  it("disposes parsed multipart media when body validation rejects", async () => {
    const dispose = vi.fn(() => Promise.resolve());
    fixture.dependencies.media.prepareStream = async (
      stream,
      options
    ) => {
      for await (const chunk of stream) void chunk;
      return {
        filename: options.filename,
        contentType: options.contentType,
        size: 4,
        openRead: () => Readable.from(Buffer.from([1, 2, 3, 4])),
        dispose
      };
    };
    const multipart = videoMultipartBody([
      ["model", "fixture-video"],
      ["prompt", "fixture prompt"]
    ]);

    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      headers: {
        "content-type": `multipart/form-data; boundary=${multipart.boundary}`
      },
      payload: multipart.body
    });

    expect(response.statusCode).toBe(400);
    expect(dispose).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(0);
  });

  it("validates duration and resolution against the resolved model", async () => {
    for (const field of [
      { duration: 11 },
      { resolution: "4k" }
    ]) {
      const response = await authorizedInject(fixture.app, {
        method: "POST",
        url: "/v1/videos/generations",
        payload: {
          model: "fixture-video",
          prompt: "fixture",
          mode: "text-to-video",
          ...field
        }
      });
      expect(response.statusCode).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it("rejects ambiguous duration controls", async () => {
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      payload: {
        model: "fixture-video",
        prompt: "fixture",
        mode: "text-to-video",
        duration: 5,
        parameters: { duration: 6 }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("returns 202 immediately for async after the job is recoverable", async () => {
    initialJob = videoJob("discovering", []);
    finalJob = initialJob;
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      payload: {
        model: "fixture-video",
        prompt: "fixture",
        mode: "text-to-video",
        response_mode: "async"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(
      `/v1/tasks/${initialJob.id}`
    );
    expect(response.json()).toMatchObject({
      id: initialJob.id,
      status: "discovering"
    });
    expect(waitedTimeout).toBeUndefined();
  });

  it("returns 202 with Location when the wait times out non-terminal", async () => {
    initialJob = videoJob("processing", []);
    finalJob = initialJob;
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      payload: {
        model: "fixture-video",
        prompt: "fixture",
        mode: "text-to-video",
        response_mode: "wait"
      }
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(
      `/v1/tasks/${initialJob.id}`
    );
    expect(response.json()).toMatchObject({
      id: initialJob.id,
      status: "processing"
    });
  });

  it("returns every normalized video output", async () => {
    const second = {
      ...videoOutput,
      url: "https://media.example/result-two.mp4",
      posterUrl: null,
      duration: 8
    };
    finalJob = videoJob("completed", [videoOutput, second]);
    initialJob = finalJob;
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      payload: {
        model: "fixture-video",
        prompt: "fixture",
        mode: "text-to-video"
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      data: Array<{
        url: string;
        poster_url: string | null;
        duration: number | null;
      }>;
    }>();
    expect(body.data).toHaveLength(2);
    expect(body.data[1]).toMatchObject({
      url: second.url,
      poster_url: null,
      duration: 8
    });
  });

  it("rejects unknown fields and control-field collisions", async () => {
    for (const payload of [
      {
        model: "fixture-video",
        prompt: "fixture",
        mode: "text-to-video",
        unknown: "field"
      },
      {
        model: "fixture-video",
        prompt: "fixture",
        mode: "text-to-video",
        parameters: { mode: "image-to-video" }
      },
      {
        model: "fixture-video",
        prompt: "fixture",
        mode: "text-to-video",
        parameters: { input_images: ["https://override.example/a.png"] }
      }
    ]) {
      const response = await authorizedInject(fixture.app, {
        method: "POST",
        url: "/v1/videos/generations",
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it("maps a terminal failed job into an OpenAI-style error", async () => {
    initialJob = videoJob("failed", [], "lingjing_task_failed");
    finalJob = initialJob;
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/videos/generations",
      payload: {
        model: "fixture-video",
        prompt: "fixture",
        mode: "text-to-video"
      }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: "lingjing_task_failed" }
    });
  });

  it("documents both protected video API paths and response modes", async () => {
    for (const url of ["/v1/videos/generations", "/v1/videos"]) {
      expect((await fixture.app.inject({
        method: "POST",
        url,
        payload: {
          model: "fixture-video",
          prompt: "private",
          mode: "text-to-video"
        }
      })).statusCode).toBe(401);
    }

    const response = await authorizedInject(fixture.app, {
      method: "GET",
      url: "/openapi.json"
    });
    const specification = response.json<{
      paths: Record<string, {
        post?: {
          security?: unknown[];
          parameters?: Array<{
            name?: string;
            in?: string;
            required?: boolean;
            schema?: Record<string, unknown>;
          }>;
          requestBody?: {
            content?: Record<string, {
              schema?: {
                anyOf?: unknown;
                type?: string;
                required?: string[];
                additionalProperties?: boolean;
                properties?: Record<string, {
                  enum?: string[];
                  format?: string;
                  items?: Record<string, unknown>;
                }>;
              };
            }>;
          };
          responses?: Record<string, unknown>;
        };
      }>;
    }>();
    for (const path of ["/v1/videos/generations", "/v1/videos"]) {
      expect(specification.paths[path]?.post?.security).toEqual([
        { bearerAuth: [] }
      ]);
      expect(
        specification.paths[path]?.post?.requestBody
      ).toBeDefined();
      const multipartSchema = specification.paths[path]?.post
        ?.requestBody?.content?.["multipart/form-data"]?.schema;
      expect(multipartSchema?.type).toBe("object");
      expect(multipartSchema?.required).toEqual([
        "model", "prompt", "mode"
      ]);
      expect(multipartSchema?.properties?.image).toMatchObject({
        type: "string",
        format: "binary"
      });
      expect(multipartSchema?.properties?.input_images).toMatchObject({
        type: "array"
      });
      const jsonSchema = specification.paths[path]?.post
        ?.requestBody?.content?.["application/json"]?.schema;
      expect(jsonSchema?.anyOf).toBeUndefined();
      expect(jsonSchema?.type).toBe("object");
      expect(jsonSchema?.additionalProperties).toBe(false);
      expect(jsonSchema?.required).toEqual(["model", "prompt", "mode"]);
      expect(
        jsonSchema?.properties?.response_mode?.enum
      ).toEqual(["wait", "async"]);
      expect(jsonSchema?.properties?.mode?.enum).toEqual([
        "text-to-video",
        "image-to-video"
      ]);
      const idempotency = specification.paths[path]?.post
        ?.parameters?.find((parameter) =>
          parameter.name === "idempotency-key"
        );
      expect(idempotency).toEqual({
        name: "idempotency-key",
        in: "header",
        required: false,
        schema: {
          type: "string",
          minLength: 8,
          maxLength: 200
        }
      });
      const responses = specification.paths[path]?.post?.responses;
      expect(responses).toBeDefined();
      expect(Object.hasOwn(responses ?? {}, "200")).toBe(true);
      expect(Object.hasOwn(responses ?? {}, "202")).toBe(true);
    }
  });
});
