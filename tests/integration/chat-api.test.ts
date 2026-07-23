import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GenerationHandle,
  GenerationRequest
} from "../../src/generation/types.js";
import type { JobOutput, JobRecord } from "../../src/jobs/types.js";
import type {
  NormalizedModel,
  SourceType
} from "../../src/models/types.js";
import {
  authorizedInject,
  createTestApp,
  imageModel,
  videoModel,
  type TestApp
} from "../helpers/test-app.js";

const imageOutput: JobOutput = {
  url: "https://media.example/result.png",
  posterUrl: null,
  width: 1024,
  height: 1024,
  duration: null,
  format: "png"
};

function job(
  kind: "image" | "video",
  outputs: JobOutput[],
  status: JobRecord["status"] = "completed"
): JobRecord {
  const now = Date.now();
  return {
    id: "job_abcdef1234567890",
    kind,
    sourceType: kind === "image" ? "image-generation" : "text-to-video",
    model: kind === "image" ? "fixture-image" : "fixture-video",
    apiId: kind === "image" ? "707" : "808",
    modelCode: "private-model-code",
    expectedAssetScene: "private-asset-scene",
    requestFingerprint: "c".repeat(64),
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
    errorCode: status === "failed" ? "content_policy_violation" : null,
    result: status === "completed" ? { outputs } : null,
    createdAt: now,
    updatedAt: now
  };
}

function handle(value: JobRecord): GenerationHandle {
  return {
    job: value,
    wait: () => Promise.resolve(value)
  };
}

function modelFor(
  base: NormalizedModel,
  sourceType: SourceType,
  parameters: NormalizedModel["parameters"]
): NormalizedModel {
  return { ...base, sourceType, parameters };
}

describe("chat completions API", () => {
  let fixture: TestApp;
  let requests: GenerationRequest[];
  let models: Record<string, NormalizedModel[]>;
  let finalJob: JobRecord;

  beforeEach(async () => {
    requests = [];
    finalJob = job("image", [imageOutput]);
    const image = modelFor(imageModel, "image-generation", [
      {
        idx: "1",
        key: "prompt",
        displayName: "Prompt",
        required: true,
        kind: "string"
      },
      {
        idx: "2",
        key: "style",
        displayName: "Style",
        required: false,
        kind: "enum",
        options: ["photo", "anime"]
      }
    ]);
    const textVideo = modelFor(videoModel, "text-to-video", [
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
      }
    ]);
    const imageVideo = modelFor(videoModel, "image-to-video", [
      ...textVideo.parameters,
      {
        idx: "4",
        key: "image",
        displayName: "Image",
        required: true,
        kind: "image-list",
        maxFiles: 1
      }
    ]);
    models = {
      "image-generation": [image],
      "text-to-video": [textVideo],
      "image-to-video": [imageVideo]
    };
    fixture = await createTestApp({
      catalog: {
        list: vi.fn((sourceType: SourceType) =>
          Promise.resolve(models[sourceType] ?? [])
        ),
        resolve: vi.fn((value: string, sourceType: SourceType) => {
          const matches = (models[sourceType] ?? []).filter(
            (model) => model.apiId === value || model.alias === value
          );
          return matches.length === 1
            ? Promise.resolve(matches[0] as NormalizedModel)
            : Promise.reject(new Error("unexpected resolve"));
        })
      },
      coordinator: {
        create: vi.fn((request: GenerationRequest) => {
          requests.push(request);
          return Promise.resolve(handle(finalJob));
        }),
        resume: vi.fn(),
        stopPollers: vi.fn()
      }
    });
  });

  afterEach(async () => {
    await fixture.close();
  });

  it("returns a standard non-stream chat completion with every image output", async () => {
    finalJob = job("image", [
      imageOutput,
      { ...imageOutput, url: "https://media.example/result-two.png" }
    ]);
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fixture-image",
        messages: [
          { role: "system", content: "do not include this" },
          { role: "user", content: "draw a fox" }
        ],
        parameters: { style: "photo" }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      id: "chatcmpl-abcdef1234567890",
      object: "chat.completion",
      model: imageModel.id,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: [
            "![generated image](https://media.example/result.png)",
            "![generated image](https://media.example/result-two.png)"
          ].join("\n")
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    });
    expect(requests).toEqual([{
      kind: "image",
      sourceType: "image-generation",
      model: "707",
      values: {
        style: "photo",
        prompt: "draw a fox"
      },
      media: [],
      idempotencyKey: null
    }]);
  });

  it("selects image-to-video when a video model receives image_url blocks", async () => {
    finalJob = job("video", [{
      ...imageOutput,
      url: "https://media.example/result.mp4",
      duration: 5,
      format: "mp4"
    }]);
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fixture-video",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "animate this" },
            {
              type: "image_url",
              image_url: { url: "https://media.example/input.png" }
            }
          ]
        }],
        parameters: { duration: 5 }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [{
        message: {
          content: "[generated video](https://media.example/result.mp4)"
        }
      }]
    });
    expect(requests).toEqual([{
      kind: "video",
      sourceType: "image-to-video",
      model: "808",
      values: {
        duration: 5,
        prompt: "animate this",
        model: "fixture-video"
      },
      media: [{
        kind: "image",
        source: {
          type: "url",
          value: "https://media.example/input.png"
        }
      }],
      idempotencyKey: null
    }]);
  });

  it("uses the upstream default for a chat model parameter instead of the public alias", async () => {
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
    finalJob = job("video", [{
      ...imageOutput,
      url: "https://media.example/result.mp4",
      duration: 5,
      format: "mp4"
    }]);

    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fixture-video",
        messages: [{ role: "user", content: "make it move" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(requests[0]?.values.model).toBe(
      "fixture-upstream-video-model"
    );
  });

  it("selects text-to-video without images and validates dynamic values", async () => {
    finalJob = job("video", [{
      ...imageOutput,
      url: "https://media.example/result.mp4",
      duration: 5,
      format: "mp4"
    }]);
    const response = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fixture-video",
        messages: [{ role: "user", content: "make it move" }],
        parameters: { duration: 11 }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it("rejects cross-catalog ambiguity and invalid chat input before creating a job", async () => {
    models["text-to-video"] = [
      models["text-to-video"]?.[0] as NormalizedModel,
      {
        ...(models["text-to-video"]?.[0] as NormalizedModel),
        apiId: "809"
      }
    ];
    const ambiguous = await authorizedInject(fixture.app, {
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fixture-video",
        messages: [{ role: "user", content: "ambiguous" }]
      }
    });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json()).toMatchObject({
      error: { code: "model_catalog_changed" }
    });

    for (const payload of [
      {
        model: "fixture-image",
        messages: [{ role: "system", content: "system only" }]
      },
      {
        model: "fixture-image",
        messages: [{
          role: "user",
          content: [{
            type: "image_url",
            image_url: { url: "not-a-url" }
          }]
        }]
      },
      {
        model: "fixture-image",
        messages: [{ role: "user", content: "valid" }],
        unexpected: true
      },
      {
        model: "fixture-image",
        messages: [{ role: "user", content: "valid" }],
        parameters: { prompt: "hidden override" }
      },
      {
        model: "fixture-image",
        messages: [{ role: "user", content: "valid" }],
        parameters: { model: "hidden override" }
      }
    ]) {
      const response = await authorizedInject(fixture.app, {
        method: "POST",
        url: "/v1/chat/completions",
        payload
      });
      expect(response.statusCode).toBe(400);
    }
    expect(requests).toHaveLength(0);
  });

  it("keeps auth, rate-limit, no-store, and protected OpenAPI behavior", async () => {
    const unauthorized = await fixture.app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "fixture-image",
        messages: [{ role: "user", content: "private" }]
      }
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.headers["cache-control"]).toBe("no-store");

    const specification = (await authorizedInject(fixture.app, {
      method: "GET",
      url: "/openapi.json"
    })).json<{
      paths: Record<string, {
        post?: {
          security?: unknown[];
          requestBody?: { content?: Record<string, unknown> };
          responses?: Record<string, {
            content?: Record<string, unknown>;
          }>;
        };
      }>;
    }>();
    expect(specification.paths["/v1/chat/completions"]?.post).toMatchObject({
      security: [{ bearerAuth: [] }]
    });
    expect(
      specification.paths["/v1/chat/completions"]?.post
        ?.requestBody?.content?.["application/json"]
    ).toBeDefined();
    const responseContent = specification.paths["/v1/chat/completions"]
      ?.post?.responses?.["200"]?.content;
    expect(Object.keys(responseContent ?? {}).sort()).toEqual([
      "application/json",
      "text/event-stream"
    ]);
  });
});
