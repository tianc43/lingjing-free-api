import { describe, expect, it } from "vitest";
import {
  normalizeJobResult,
  normalizeOutputUrl
} from "../../src/jobs/output-normalizer.js";
import type { LingjingAsset } from "../../src/jobs/assets.js";

function completedAsset(overrides: Partial<LingjingAsset> = {}): LingjingAsset {
  return {
    id: "asset-result",
    scene: "image-generation",
    modelCode: "model-v1",
    url: "https://media.example/fallback.png",
    waterUrl: null,
    watermarkUrl: null,
    imageUrl: null,
    videoUrl: null,
    frameUrl: null,
    createTime: 10_100,
    creationCode: "creation-fixture",
    status: 1,
    taskId: "fixture-task",
    taskResults: [],
    errMsg: null,
    reqParam: null,
    width: 2048,
    height: 2048,
    duration: null,
    fps: null,
    taskType: null,
    name: null,
    ...overrides
  };
}

describe("output normalization", () => {
  it("normalizes every image in taskResults", () => {
    const result = normalizeJobResult(completedAsset({
      taskResults: [
        {
          imageUrl: "https://media.example/one.png",
          width: 2048,
          height: 2048
        },
        {
          url: "https://media.example/two.png",
          width: 2048,
          height: 2048
        }
      ]
    }));

    expect(result?.outputs.map((item) => item.url)).toEqual([
      "https://media.example/one.png",
      "https://media.example/two.png"
    ]);
  });

  it("prefers clean media, then video or image fields, then watermarked fallback", () => {
    expect(normalizeOutputUrl({
      url: "https://media.example/clean.mp4",
      videoUrl: "https://media.example/video.mp4",
      imageUrl: "https://media.example/image.png",
      waterUrl: "https://media.example/water.mp4"
    })).toBe("https://media.example/clean.mp4");
    expect(normalizeOutputUrl({
      videoUrl: "https://media.example/video.mp4",
      imageUrl: "https://media.example/image.png",
      watermarkUrl: "https://media.example/water.mp4"
    })).toBe("https://media.example/video.mp4");
    expect(normalizeOutputUrl({
      waterUrl: "https://media.example/water.mp4"
    })).toBe("https://media.example/water.mp4");
  });

  it("splits comma fields only when every segment is an absolute HTTP(S) URL", () => {
    expect(normalizeJobResult(completedAsset({
      url: "https://media.example/one.png, https://media.example/two.png"
    }))?.outputs.map((item) => item.url)).toEqual([
      "https://media.example/one.png",
      "https://media.example/two.png"
    ]);
    expect(normalizeJobResult(completedAsset({
      url: "https://media.example/one.png, /relative.png",
      waterUrl: null
    }))).toBeNull();
  });

  it("returns no completed result when status one has no media", () => {
    expect(normalizeJobResult(completedAsset({
      url: null,
      taskResults: []
    }))).toBeNull();
  });

  it("drops unsafe and malformed URLs without throwing", () => {
    expect(normalizeOutputUrl({ url: "javascript:alert(1)" })).toBeNull();
    expect(normalizeOutputUrl({ url: { unexpected: true } })).toBeNull();
  });

  it("drops untrusted non-numeric output metadata", () => {
    const result = normalizeJobResult({
      taskResults: [{ url: "https://media.example/final.png" }],
      width: "2048" as never,
      height: { unsafe: true } as never,
      duration: Number.POSITIVE_INFINITY
    });

    expect(result?.outputs[0]).toMatchObject({
      width: null,
      height: null,
      duration: null
    });
  });
});
