import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AddressResolver } from "../../src/media/address-policy.js";
import type { LingjingTransport } from "../../src/lingjing/types.js";
import type { NormalizedModel } from "../../src/models/types.js";
import {
  assertSufficientLiveBalance,
  createSubmitCountingTransport,
  liveTestEnabled,
  liveVideoTestEnabled,
  reportLiveBalanceDelta,
  reportLiveJob,
  reportLiveSelection,
  selectLiveGeneration,
  validateLiveOutputUrl
} from "../live/live-helpers.js";

function model(
  overrides: Partial<NormalizedModel> = {}
): NormalizedModel {
  return {
    id: "fixture-model-id",
    apiId: "fixture-api-id",
    alias: "fixture-model",
    displayName: "Fixture Model",
    sourceType: "image-generation",
    modelCode: "fixture-model-code",
    refId: "fixture-ref",
    sceneCode: "fixture-scene",
    expectedAssetScene: "fixture-asset-scene",
    uploadStrategy: "general",
    priceQuerySchema: null,
    parameters: [{
      idx: "1",
      key: "prompt",
      displayName: "Prompt",
      required: true,
      kind: "string"
    }],
    pricing: { price: { amount: 7, unit: "points" } },
    rawRevision: "fixture-revision",
    ...overrides
  };
}

const publicResolver: AddressResolver = () => Promise.resolve([{
  address: "93.184.216.34",
  family: 4
}]);

describe("live acceptance safety helpers", () => {
  it("enables live and video suites only for the exact explicit flags", () => {
    expect(liveTestEnabled({})).toBe(false);
    expect(liveTestEnabled({ LIVE_TEST: "true" })).toBe(false);
    expect(liveTestEnabled({ LIVE_TEST: "1" })).toBe(true);

    expect(liveVideoTestEnabled({
      LIVE_TEST: "1",
      LIVE_VIDEO_TEST: "0"
    })).toBe(false);
    expect(liveVideoTestEnabled({
      LIVE_TEST: "0",
      LIVE_VIDEO_TEST: "1"
    })).toBe(false);
    expect(liveVideoTestEnabled({
      LIVE_TEST: "1",
      LIVE_VIDEO_TEST: "1"
    })).toBe(true);
  });

  it("keeps ordinary tests from collecting the opt-in live directory", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    ) as { scripts?: Record<string, unknown> };
    const liveConfigUrl = new URL(
      "../../vitest.live.config.ts",
      import.meta.url
    );
    const ordinaryConfig = readFileSync(
      new URL("../../vitest.config.ts", import.meta.url),
      "utf8"
    );

    expect(packageJson.scripts?.test).toContain(
      "--exclude tests/live/**"
    );
    expect(ordinaryConfig).toContain("tests/live/**");
    expect(packageJson.scripts?.["test:live"]).toBe(
      "vitest run --config vitest.live.config.ts"
    );
    expect(existsSync(liveConfigUrl)).toBe(true);
    if (!existsSync(liveConfigUrl)) return;
    const liveConfig = readFileSync(liveConfigUrl, "utf8");
    expect(liveConfig).toContain("tests/live/**/*.live.test.ts");
  });

  it("counts only real generation submissions while delegating transport", async () => {
    const submitOnce = vi.fn();
    const delegate: LingjingTransport = {
      read<T>(): Promise<T> {
        return Promise.resolve({ ok: true } as T);
      },
      submitOnce<T>(): Promise<T> {
        submitOnce();
        return Promise.resolve({ accepted: true } as T);
      },
      uploadApi<T>(): Promise<T> {
        return Promise.resolve({ uploaded: true } as T);
      },
      putSigned: () => Promise.resolve({
        statusCode: 200,
        headers: {}
      })
    };
    const counted = createSubmitCountingTransport(delegate);

    await counted.transport.read("/fixture-read");
    await counted.transport.uploadApi("/fixture-upload", {
      method: "POST",
      body: "fixture-body",
      timeoutMs: 1_000
    });
    await counted.transport.putSigned(
      new URL("https://uploads.example.test/fixture"),
      {
        method: "PUT",
        body: "fixture-body",
        timeoutMs: 1_000
      }
    );
    await counted.transport.submitOnce("/fixture-submit", {
      prompt: "fixture-prompt"
    });

    expect(counted.submitCount()).toBe(1);
    expect(submitOnce).toHaveBeenCalledTimes(1);
  });

  it("selects a compatible image model and derives required values dynamically", () => {
    const requiresImage = model({
      alias: "fixture-reference-only",
      parameters: [{
        idx: "1",
        key: "image",
        displayName: "Image",
        required: true,
        kind: "image-list",
        maxFiles: 1
      }]
    });
    const compatible = model({
      parameters: [
        {
          idx: "1",
          key: "prompt",
          displayName: "Prompt",
          required: true,
          kind: "string"
        },
        {
          idx: "0",
          key: "model",
          displayName: "Model",
          required: true,
          kind: "enum",
          defaultValue: "fixture-upstream-model",
          options: ["fixture-upstream-model"]
        },
        {
          idx: "2",
          key: "size",
          displayName: "Size",
          required: true,
          kind: "enum",
          options: ["1024x1024"]
        },
        {
          idx: "3",
          key: "taskNum",
          displayName: "Count",
          required: true,
          kind: "number",
          minimum: 1,
          maximum: 4
        },
        {
          idx: "4",
          key: "style",
          displayName: "Style",
          required: true,
          kind: "enum",
          options: ["general"]
        }
      ]
    });

    const selected = selectLiveGeneration(
      [requiresImage, compatible],
      "image",
      "fixture-safe-image-request"
    );

    expect(selected.model).toBe(compatible);
    expect(selected.estimatedDebit).toBe(7);
    expect(selected.request).toEqual({
      model: "fixture-model",
      prompt: "fixture-safe-image-request",
      n: 1,
      size: "1024x1024",
      response_format: "url",
      response_mode: "wait",
      parameters: { style: "general" }
    });
  });

  it("derives a safe text-to-video request from the selected live schema", () => {
    const selected = selectLiveGeneration([
      model({
        sourceType: "text-to-video",
        alias: "fixture-video",
        displayName: "Fixture Video",
        pricing: { points: 12 },
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
            defaultValue: "fixture-upstream-video-model",
            options: ["fixture-upstream-video-model"]
          },
          {
            idx: "3",
            key: "duration",
            displayName: "Duration",
            required: true,
            kind: "number",
            minimum: 3,
            maximum: 10
          },
          {
            idx: "4",
            key: "resolution",
            displayName: "Resolution",
            required: true,
            kind: "enum",
            options: ["720p", "1080p"]
          },
          {
            idx: "5",
            key: "mode",
            displayName: "Mode",
            required: true,
            kind: "enum",
            defaultValue: "normal",
            options: ["normal"]
          },
          {
            idx: "6",
            key: "watermark",
            displayName: "Watermark",
            required: true,
            kind: "boolean"
          }
        ]
      })
    ], "video", "fixture-safe-video-request");

    expect(selected.estimatedDebit).toBe(12);
    expect(selected.request).toEqual({
      model: "fixture-video",
      prompt: "fixture-safe-video-request",
      mode: "text-to-video",
      duration: 3,
      resolution: "720p",
      response_mode: "wait",
      parameters: { watermark: false }
    });
  });

  it("leaves defaulted video controls to the current catalog schema", () => {
    const selected = selectLiveGeneration([
      model({
        sourceType: "text-to-video",
        alias: "fixture-defaulted-video",
        pricing: { points: 13 },
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
            key: "duration",
            displayName: "Duration",
            required: true,
            kind: "enum",
            defaultValue: "5",
            options: ["5", "10"]
          },
          {
            idx: "3",
            key: "mode",
            displayName: "Mode",
            required: true,
            kind: "enum",
            defaultValue: "normal",
            options: ["normal"]
          }
        ]
      })
    ], "video", "fixture-safe-defaulted-video-request");

    expect(selected.request).toEqual({
      model: "fixture-defaulted-video",
      prompt: "fixture-safe-defaulted-video-request",
      mode: "text-to-video",
      response_mode: "wait"
    });
  });

  it("fails safely before submission when the selected debit exceeds balance", () => {
    expect(() => {
      assertSufficientLiveBalance(6, 7);
    }).toThrow(
      "Live balance is insufficient for the selected model"
    );
    expect(() => {
      assertSufficientLiveBalance(7, 7);
    }).not.toThrow();
  });

  it("rejects ambiguous currency amounts and rate pricing before submission", () => {
    for (const pricing of [
      { price: { amount: 7, unit: "USD" } },
      { points: 7, unit: "USD" },
      { rate: { points: 7, unit: "points" } },
      {
        billingType: "total",
        billing_type: "per_second",
        points: 7
      },
      {
        points: 7,
        rate: { points: 7, unit: "points" }
      },
      {
        points: 7,
        price: { amount: 7, unit: "points" }
      },
      {
        price: {
          amount: 7,
          unit: "points",
          billingType: "per_second"
        }
      }
    ]) {
      expect(() => {
        selectLiveGeneration([
          model({ pricing })
        ], "image", "fixture-safe-image-request");
      }).toThrow(
        "No current live model has compatible parameters and quoted pricing"
      );
    }
  });

  it("requires an explicit fixed total when pricing depends on parameters", () => {
    expect(() => {
      selectLiveGeneration([
        model({
          priceQuerySchema: { taskNum: "taskNum" },
          pricing: { points: 7 }
        })
      ], "image", "fixture-safe-image-request");
    }).toThrow(
      "No current live model has compatible parameters and quoted pricing"
    );

    const selected = selectLiveGeneration([
      model({
        priceQuerySchema: { taskNum: "taskNum" },
        pricing: {
          billingType: "total",
          points: 7,
          unit: "points"
        }
      })
    ], "image", "fixture-safe-image-request");
    expect(selected.estimatedDebit).toBe(7);
  });

  it("writes only the approved live acceptance fields", () => {
    const output: string[] = [];
    const write = (line: string): void => {
      output.push(line);
    };
    const jobId = `job_${"a".repeat(32)}`;

    reportLiveSelection({
      model: model({
        displayName: "Fixture\n\u0085\u202e\u2066Model"
      }),
      estimatedDebit: 7,
      request: {}
    }, write);
    reportLiveJob(jobId, "completed", write);
    reportLiveBalanceDelta(-7, write);

    expect(output.map((line) => JSON.parse(line) as unknown)).toEqual([
      { model_display_name: "Fixture Model" },
      { estimated_cost: "7 points" },
      { job_id: jobId },
      { status: "completed" },
      { balance_delta: -7 }
    ]);
  });

  it("uses HEAD first and a bounded GET fallback without exposing the URL", async () => {
    const fetchHead = vi.fn((
      _input: string | URL | Request,
      _init?: RequestInit
    ) => {
      void _input;
      void _init;
      return Promise.resolve(new Response(null, {
        status: 200,
        headers: { "content-type": "image/png" }
      }));
    });
    await expect(validateLiveOutputUrl(
      "https://media.example.test/fixture.png",
      "image",
      { fetch: fetchHead, resolver: publicResolver }
    )).resolves.toBeUndefined();
    expect(fetchHead).toHaveBeenCalledTimes(1);
    expect(fetchHead.mock.calls[0]?.[1]).toMatchObject({ method: "HEAD" });

    const fetchFallback = vi.fn((
      _input: string | URL | Request,
      _init?: RequestInit
    ) => {
      void _input;
      void _init;
      return Promise.resolve(new Response(null, { status: 500 }));
    })
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(
        new Uint8Array([1, 2, 3]),
        {
          status: 206,
          headers: { "content-type": "video/mp4" }
        }
      ));
    await expect(validateLiveOutputUrl(
      "https://media.example.test/fixture.mp4",
      "video",
      { fetch: fetchFallback, resolver: publicResolver }
    )).resolves.toBeUndefined();
    expect(fetchFallback).toHaveBeenCalledTimes(2);
    expect(fetchFallback.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      headers: { Range: "bytes=0-65535" }
    });
  });

  it("rejects plaintext and private output targets before any request", async () => {
    const unsafeFetch = vi.fn((
      _input: string | URL | Request,
      _init?: RequestInit
    ) => {
      void _input;
      void _init;
      return Promise.resolve(new Response(null, {
        status: 200,
        headers: { "content-type": "image/png" }
      }));
    });

    await expect(validateLiveOutputUrl(
      "http://media.example.test/fixture.png",
      "image",
      { fetch: unsafeFetch, resolver: publicResolver }
    )).rejects.toThrow("Live output URL validation failed");
    await expect(validateLiveOutputUrl(
      "https://192.168.1.20/fixture.png",
      "image",
      { fetch: unsafeFetch, resolver: publicResolver }
    )).rejects.toThrow("Live output URL validation failed");
    expect(unsafeFetch).not.toHaveBeenCalled();
  });
});
