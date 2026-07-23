import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeModels } from "../../src/models/normalize.js";
import { buildPayload } from "../../src/models/payload-builder.js";
import type { NormalizedModel, SourceType } from "../../src/models/types.js";

function normalizedFixture(
  name: string,
  sourceType: SourceType
): NormalizedModel {
  const fixture: unknown = JSON.parse(
    readFileSync(new URL(`../fixtures/models/${name}.json`, import.meta.url), "utf8")
  );
  const model = normalizeModels(sourceType, fixture).at(0);
  if (model === undefined) throw new Error("fixture is malformed");
  return model;
}

const imageModel = normalizedFixture("image-generation", "image-generation");
const textVideoModel = normalizedFixture("text-to-video", "text-to-video");
const imageVideoModel = normalizedFixture("image-to-video", "image-to-video");

function expectAppError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (cause) {
    expect(cause).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("buildPayload", () => {
  it("builds the image-generation fixture payload exactly", () => {
    expect(buildPayload({
      model: imageModel,
      spaceId: 0,
      values: {
        prompt: "fixture prompt",
        size: "2048x2048",
        taskNum: 1,
        image: ["upload/path/a.png"]
      }
    })).toEqual({
      apiId: "707",
      params: [
        {
          idx: "1",
          name: "参考图",
          values: ["upload/path/a.png"],
          filePath: ["upload/path/a.png"]
        },
        {
          idx: "2",
          name: "提示词",
          values: "fixture prompt"
        },
        {
          idx: "3",
          name: "尺寸",
          values: "2048x2048"
        },
        {
          idx: "4",
          name: "联网搜索",
          values: false
        },
        {
          idx: "5",
          name: "生成数量",
          values: 1
        }
      ],
      refId: "fixture-image-ref",
      spaceId: 0,
      priceQueryResult: { taskNum: 1 }
    });
  });

  it("builds the text-to-video fixture payload exactly", () => {
    expect(buildPayload({
      model: textVideoModel,
      spaceId: 0,
      values: {
        prompt: "fixture prompt",
        model: "fixture-motion",
        duration: 3,
        resolution: "720p",
        ratio: "16:9",
        watermark: false,
        seed: 1
      }
    })).toEqual({
      apiId: "fake-text-video-1",
      params: [
        { idx: "1", name: "提示词", values: "fixture prompt" },
        { idx: "2", name: "模型", values: "fixture-motion" },
        { idx: "3", name: "时长", values: 3 },
        { idx: "4", name: "分辨率", values: "720p" },
        { idx: "5", name: "比例", values: "16:9" },
        { idx: "6", name: "水印", values: false },
        { idx: "7", name: "随机种子", values: 1 }
      ],
      refId: "fixture-text-video-ref",
      spaceId: 0,
      priceQueryResult: {
        duration: 3,
        resolution: "720p"
      }
    });
  });

  it("builds all image-to-video fields and omits an underivable price", () => {
    expect(buildPayload({
      model: imageVideoModel,
      spaceId: 0,
      values: {
        image: ["fixture/path.png"],
        prompt: "fixture prompt",
        model: "fixture-image-motion",
        duration: 3,
        resolution: "720p",
        ratio: "16:9",
        watermark: false,
        seed: 1
      }
    })).toEqual({
      apiId: "fake-image-video-1",
      params: [
        {
          idx: "1",
          name: "首帧图",
          values: ["fixture/path.png"],
          filePath: ["fixture/path.png"]
        },
        { idx: "2", name: "提示词", values: "fixture prompt" },
        { idx: "3", name: "模型", values: "fixture-image-motion" },
        { idx: "4", name: "时长", values: 3 },
        { idx: "5", name: "分辨率", values: "720p" },
        { idx: "6", name: "比例", values: "16:9" },
        { idx: "7", name: "水印", values: false },
        { idx: "8", name: "随机种子", values: 1 }
      ],
      refId: "fixture-image-video-ref",
      spaceId: 0
    });
  });

  it("omits priceQueryResult when not every price field can be derived", () => {
    const payload = buildPayload({
      model: imageModel,
      spaceId: 0,
      values: { prompt: "fixture prompt" }
    });

    expect(payload).not.toHaveProperty("priceQueryResult");
  });

  it("rejects unknown parameters and stale enum values", () => {
    expectAppError(() => buildPayload({
      model: imageModel,
      spaceId: 0,
      values: {
        prompt: "x",
        unsupported: true
      }
    }), "invalid_request");

    expectAppError(() => buildPayload({
      model: imageModel,
      spaceId: 0,
      values: {
        prompt: "x",
        size: "stale-size"
      }
    }), "model_catalog_changed");
  });

  it.each([
    ["empty required prompt", imageModel, { prompt: "" }],
    ["explicit undefined prompt", imageModel, { prompt: undefined }],
    ["invalid boolean", imageModel, { prompt: "x", webSearch: "false" }],
    ["non-finite number", imageModel, { prompt: "x", taskNum: Number.NaN }],
    ["out-of-range number", imageModel, { prompt: "x", taskNum: 5 }],
    [
      "empty required image list",
      imageVideoModel,
      { image: [], prompt: "x", model: "fixture-image-motion" }
    ],
    [
      "missing required model name",
      imageVideoModel,
      { image: ["fixture/path.png"], prompt: "x" }
    ],
    [
      "too many images",
      imageVideoModel,
      {
        image: ["fixture/path-a.png", "fixture/path-b.png"],
        prompt: "x",
        model: "fixture-image-motion"
      }
    ]
  ])("rejects %s", (_name, model, values) => {
    expectAppError(() => buildPayload({
      model,
      spaceId: 0,
      values
    }), "invalid_request");
  });
});
