import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ReadRequest } from "../../src/lingjing/types.js";
import { CatalogService } from "../../src/models/catalog.js";
import { normalizeModels } from "../../src/models/normalize.js";

type RawModel = Record<string, unknown> & {
  apiId: string | number;
  parameters: Array<Record<string, unknown>>;
};

interface FixtureEnvelope {
  result: RawModel[];
}

function readFixture(name: string): FixtureEnvelope {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/models/${name}.json`, import.meta.url), "utf8")
  ) as FixtureEnvelope;
}

function onlyRaw(fixture: FixtureEnvelope): RawModel {
  const raw = fixture.result.at(0);
  if (raw === undefined) throw new Error("fixture is malformed");
  return raw;
}

function transportReturning(
  listed: unknown,
  refreshed: unknown = listed,
  calls: Array<{ path: string; init?: ReadRequest }> = []
) {
  return {
    read<T>(path: string, init?: ReadRequest): Promise<T> {
      calls.push({ path, ...(init === undefined ? {} : { init }) });
      return Promise.resolve(
        (path.endsWith("/getByApiId") ? refreshed : listed) as T
      );
    }
  };
}

const imageFixture = readFixture("image-generation");
const textVideoFixture = readFixture("text-to-video");
const imageVideoFixture = readFixture("image-to-video");

describe("dynamic model normalization", () => {
  it("normalizes the image-generation fixture exactly", () => {
    const models = normalizeModels("image-generation", imageFixture);
    expect(models[0]?.rawRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(models).toEqual([
      {
        id: "707",
        apiId: "707",
        alias: "fixture-seedream-5-0-lite",
        displayName: "fixture-seedream-5-0-lite",
        sourceType: "image-generation",
        modelCode: "fixture-image-model",
        refId: "fixture-image-ref",
        sceneCode: "fixture-image-scene",
        expectedAssetScene: "fixture-image-asset",
        uploadStrategy: "general",
        priceQuerySchema: { taskNum: "taskNum" },
        parameters: [
          {
            idx: "1",
            key: "image",
            displayName: "参考图",
            required: false,
            kind: "image-list",
            maxFiles: 2
          },
          {
            idx: "2",
            key: "prompt",
            displayName: "提示词",
            required: true,
            kind: "string"
          },
          {
            idx: "3",
            key: "size",
            displayName: "尺寸",
            required: false,
            kind: "enum",
            defaultValue: "1024x1024",
            options: ["1024x1024", "2048x2048"]
          },
          {
            idx: "4",
            key: "webSearch",
            displayName: "联网搜索",
            required: false,
            kind: "boolean",
            defaultValue: false
          },
          {
            idx: "5",
            key: "taskNum",
            displayName: "生成数量",
            required: false,
            kind: "number",
            minimum: 1,
            maximum: 4
          }
        ],
        pricing: { unit: "fixture-points" },
        rawRevision: models[0]?.rawRevision
      }
    ]);
  });

  it("normalizes the text-to-video fixture exactly", () => {
    const models = normalizeModels("text-to-video", textVideoFixture);
    expect(models[0]?.rawRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(models).toEqual([
      {
        id: "fake-text-video-1",
        apiId: "fake-text-video-1",
        alias: "fixture-motion",
        displayName: "fixture-motion",
        sourceType: "text-to-video",
        modelCode: "fixture-text-video-model",
        refId: "fixture-text-video-ref",
        sceneCode: "fixture-video-scene",
        expectedAssetScene: "fixture-video-asset",
        uploadStrategy: "materials",
        priceQuerySchema: {
          duration: "duration",
          resolution: "resolution"
        },
        parameters: [
          {
            idx: "1",
            key: "prompt",
            displayName: "提示词",
            required: true,
            kind: "string"
          },
          {
            idx: "2",
            key: "model",
            displayName: "模型",
            required: true,
            kind: "enum",
            options: ["fixture-motion"]
          },
          {
            idx: "3",
            key: "duration",
            displayName: "时长",
            required: false,
            kind: "number",
            minimum: 3,
            maximum: 10
          },
          {
            idx: "4",
            key: "resolution",
            displayName: "分辨率",
            required: false,
            kind: "enum",
            options: ["720p", "1080p"]
          },
          {
            idx: "5",
            key: "ratio",
            displayName: "比例",
            required: false,
            kind: "enum",
            options: ["16:9", "9:16"]
          },
          {
            idx: "6",
            key: "watermark",
            displayName: "水印",
            required: false,
            kind: "boolean"
          },
          {
            idx: "7",
            key: "seed",
            displayName: "随机种子",
            required: false,
            kind: "number"
          }
        ],
        pricing: { unit: "fixture-video-points" },
        rawRevision: models[0]?.rawRevision
      }
    ]);
  });

  it("normalizes the image-to-video fixture exactly", () => {
    const models = normalizeModels("image-to-video", imageVideoFixture);
    expect(models[0]?.rawRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(models).toEqual([
      {
        id: "fake-image-video-1",
        apiId: "fake-image-video-1",
        alias: "fixture-image-motion",
        displayName: "fixture-image-motion",
        sourceType: "image-to-video",
        modelCode: "fixture-image-video-model",
        refId: "fixture-image-video-ref",
        sceneCode: "fixture-image-video-scene",
        expectedAssetScene: "fixture-image-video-asset",
        uploadStrategy: "materials",
        priceQuerySchema: { taskNum: "taskNum" },
        parameters: [
          {
            idx: "1",
            key: "image",
            displayName: "首帧图",
            required: true,
            kind: "image-list",
            maxFiles: 1
          },
          {
            idx: "2",
            key: "prompt",
            displayName: "提示词",
            required: true,
            kind: "string"
          },
          {
            idx: "3",
            key: "model",
            displayName: "模型",
            required: true,
            kind: "enum",
            options: ["fixture-image-motion"]
          },
          {
            idx: "4",
            key: "duration",
            displayName: "时长",
            required: false,
            kind: "number",
            minimum: 3,
            maximum: 10
          },
          {
            idx: "5",
            key: "resolution",
            displayName: "分辨率",
            required: false,
            kind: "enum",
            options: ["720p", "1080p"]
          },
          {
            idx: "6",
            key: "ratio",
            displayName: "比例",
            required: false,
            kind: "enum",
            options: ["16:9", "9:16"]
          },
          {
            idx: "7",
            key: "watermark",
            displayName: "水印",
            required: false,
            kind: "boolean"
          },
          {
            idx: "8",
            key: "seed",
            displayName: "随机种子",
            required: false,
            kind: "number"
          }
        ],
        pricing: { unit: "fixture-image-video-points" },
        rawRevision: models[0]?.rawRevision
      }
    ]);
  });

  it("changes rawRevision when the upstream schema changes", () => {
    const first = normalizeModels("image-generation", imageFixture);
    const changed = structuredClone(imageFixture);
    const changedParameter = onlyRaw(changed).parameters.at(0);
    if (changedParameter === undefined) throw new Error("fixture is malformed");
    changedParameter.required = true;

    expect(first[0]?.rawRevision).not.toBe(
      normalizeModels("image-generation", changed)[0]?.rawRevision
    );
  });

  it("uses fieldName as the request key and Chinese metadata only as display text", () => {
    const prompt = normalizeModels("image-generation", imageFixture)[0]
      ?.parameters.find((item) => item.idx === "2");

    expect(prompt).toMatchObject({
      key: "prompt",
      displayName: "提示词"
    });
  });

  it("treats a switch with string options as an enum", () => {
    const sound = normalizeModels("text-to-video", [{
      apiId: "567",
      aiModelName: "Kling 3.0 Omni",
      parametersMeta: [{
        index: "1",
        fieldName: "sound",
        required: false,
        fieldType: "boolean",
        componentType: "switch",
        defaultValue: "on",
        selectorValues: [
          { key: "on", value: "开启" },
          { key: "off", value: "关闭" }
        ]
      }]
    }])[0]?.parameters[0];

    expect(sound).toMatchObject({
      key: "sound",
      kind: "enum",
      defaultValue: "on",
      options: ["on", "off"]
    });
  });

  it("keeps current live billing metadata and does not expose a dynamic video price as fixed", () => {
    const model = normalizeModels("text-to-video", [{
      apiId: "758",
      aiModelName: "Seedance 2.0 mini",
      price: 15,
      enablePriceQuery: true,
      priceQueryService: "sd2",
      shortVender: "byte",
      shortSenceCode: "t2v",
      parametersMeta: [{
        index: "1",
        fieldName: "model_name",
        required: true,
        componentType: "selector",
        defaultValue: "Doubao-Seedance-2.0-mini",
        billingItemType: "1",
        selectorValues: [{
          key: "Doubao-Seedance-2.0-mini",
          value: "Seedance 2.0 mini",
          shortName: "sd2mini"
        }]
      }, {
        index: "2",
        fieldName: "duration",
        required: true,
        componentType: "selector",
        defaultValue: "5",
        billingItemType: "5",
        selectorValues: [{ key: "4", value: "4s", shortName: "4s" }]
      }]
    }])[0];

    expect(model?.pricing).toBeNull();
    expect(model?.priceQuerySchema).toMatchObject({
      strategy: "calculate",
      priceQueryService: "sd2",
      shortVender: "byte",
      shortSenceCode: "t2v",
      fields: [
        {
          key: "model_name",
          billingItemType: "1",
          selectors: [{
            matches: ["Doubao-Seedance-2.0-mini", "Seedance 2.0 mini"],
            shortName: "sd2mini"
          }]
        },
        { key: "duration", billingItemType: "5" }
      ]
    });
  });

  it("routes enablePriceQuery=false video models through formula pricing", () => {
    const model = normalizeModels("image-to-video", [{
      apiId: "751",
      aiModelName: "Seedance-1.5-pro",
      price: "13.00",
      enablePriceQuery: false,
      priceQueryService: "123service",
      shortVender: "byte",
      shortSenceCode: "t2v",
      parametersMeta: [{
        index: "2",
        fieldName: "model_name",
        required: true,
        componentType: "selector",
        defaultValue: "Doubao-Seedance-1.5-pro",
        billingItemType: "1",
        selectorValues: [{
          key: "Doubao-Seedance-1.5-pro",
          value: "Seedance-1.5-pro",
          shortName: "sda15p"
        }]
      }, {
        index: "6",
        fieldName: "generate_audio",
        required: true,
        componentType: "booleanSelector",
        defaultValue: false,
        billingItemType: "1",
        selectorValues: [{
          key: false,
          value: "关",
          shortName: "F"
        }]
      }]
    }])[0];

    expect(model?.pricing).toBeNull();
    expect(model?.priceQuerySchema).toMatchObject({
      strategy: "formula",
      shortVender: "byte",
      shortSenceCode: "t2v",
      fields: [
        {
          index: "2",
          key: "model_name",
          billingItemType: "1"
        },
        {
          index: "6",
          key: "generate_audio",
          billingItemType: "1",
          selectors: [{ matches: ["false", "关"], shortName: "F" }]
        }
      ]
    });
  });

  it("normalizes the current console detail metadata without guessing billing", () => {
    const models = normalizeModels("image-generation", [{
      apiId: "707",
      aiModelName: "Seedream 5.0 Lite",
      shortSenceCode: "ig",
      price: "13.00",
      enablePriceQuery: false,
      parametersMeta: [
        {
          index: "1",
          fieldName: "image",
          required: "FALSE",
          fieldType: "stringArray",
          componentType: "multiPicFileUpload",
          defaultValue: null,
          style: { min: 0, max: 14 }
        },
        {
          index: "2",
          fieldName: "prompt",
          required: "TRUE",
          fieldType: "string",
          componentType: "prompts",
          defaultValue: ""
        },
        {
          index: "0",
          fieldName: "model",
          fieldName4View: "模型",
          required: "TRUE",
          fieldType: "string",
          componentType: "selector",
          defaultValue: "fixture-model-code",
          selectorValues: [
            { key: "fixture-model-code", value: "Fixture model" }
          ]
        },
        {
          index: "3",
          fieldName: "size",
          fieldName4View: "尺寸",
          required: "FALSE",
          fieldType: "string",
          componentType: "selector",
          defaultValue: "2048x2048",
          selectorValues: [
            { key: "2048x2048", value: "1:1" },
            { key: "2560x1440", value: "16:9" }
          ]
        },
        {
          index: "4",
          fieldName: "type",
          fieldName4View: "联网搜索",
          required: "FALSE",
          fieldType: "boolean",
          componentType: "booleanSelector",
          defaultValue: true
        },
        {
          index: "5",
          fieldName: "taskNum",
          fieldName4View: "生成数量",
          required: "TRUE",
          fieldType: "int",
          componentType: "selector",
          defaultValue: 1,
          selectorValues: [
            { key: 1, value: "1张" },
            { key: 4, value: "4张" }
          ]
        }
      ]
    }]);

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      apiId: "707",
      alias: "seedream-5-0-lite",
      displayName: "Seedream 5.0 Lite",
      modelCode: "fixture-model-code",
      sceneCode: "ig",
      expectedAssetScene: "ig",
      priceQuerySchema: null,
      pricing: {
        billingType: "fixed",
        unit: "points",
        points: 13
      },
      parameters: [
        {
          idx: "1",
          key: "image",
          displayName: "image",
          required: false,
          kind: "image-list",
          maxFiles: 14
        },
        {
          idx: "2",
          key: "prompt",
          displayName: "prompt",
          required: true,
          kind: "string",
          defaultValue: ""
        },
        {
          idx: "0",
          key: "model",
          displayName: "模型",
          required: true,
          kind: "enum",
          defaultValue: "fixture-model-code",
          options: ["fixture-model-code"]
        },
        {
          idx: "3",
          key: "size",
          displayName: "尺寸",
          required: false,
          kind: "enum",
          defaultValue: "2048x2048",
          options: ["2048x2048", "2560x1440"]
        },
        {
          idx: "4",
          key: "type",
          displayName: "联网搜索",
          required: false,
          kind: "boolean",
          defaultValue: true
        },
        {
          idx: "5",
          key: "taskNum",
          displayName: "生成数量",
          required: true,
          kind: "number",
          defaultValue: 1,
          minimum: 1,
          maximum: 4
        }
      ]
    });
  });
});

describe("CatalogService", () => {
  it("coalesces in-flight catalog reads", async () => {
    let completeRead: ((value: unknown) => void) | undefined;
    const calls: string[] = [];
    const pendingRead = new Promise<unknown>((resolve) => {
      completeRead = resolve;
    });
    const service = new CatalogService({
      read<T>(path: string): Promise<T> {
        calls.push(path);
        return pendingRead as Promise<T>;
      }
    }, 60_000);

    const first = service.list("image-generation");
    const second = service.list("image-generation");

    expect(calls).toEqual([
      "/joycreator/AIModelApiConsole/getBySourceType"
    ]);
    completeRead?.(imageFixture);
    await expect(Promise.all([first, second])).resolves.toEqual([
      normalizeModels("image-generation", imageFixture),
      normalizeModels("image-generation", imageFixture)
    ]);
  });

  it("expands the live console summary wrapper through getByApiId", async () => {
    const first = structuredClone(onlyRaw(imageFixture));
    const second = {
      ...structuredClone(first),
      apiId: "fixture-second-api",
      id: "fixture-second-api",
      modelName: "fixture-second-model"
    };
    const calls: Array<{ path: string; init?: ReadRequest }> = [];
    const service = new CatalogService({
      read<T>(path: string, init?: ReadRequest): Promise<T> {
        calls.push({ path, ...(init === undefined ? {} : { init }) });
        if (path.endsWith("/getBySourceType")) {
          return Promise.resolve({
            result: {
              apiList: [
                { apiId: first.apiId },
                { apiId: second.apiId }
              ]
            }
          } as T);
        }
        const apiId = (init?.body as { apiId?: unknown } | undefined)?.apiId;
        const selectedAIModel = apiId === second.apiId ? second : first;
        return Promise.resolve({
          result: { selectedAIModel }
        } as T);
      }
    }, 60_000);

    const models = await service.list("image-generation");

    expect(models.map((model) => model.apiId)).toEqual([
      String(first.apiId),
      second.apiId
    ]);
    expect(models.map((model) => model.displayName)).toEqual([
      "fixture-seedream-5-0-lite",
      "fixture-second-model"
    ]);
    expect(calls).toEqual([
      {
        path: "/joycreator/AIModelApiConsole/getBySourceType",
        init: {
          method: "POST",
          body: { sourceType: "image-generation" }
        }
      },
      {
        path: "/joycreator/AIModelApiConsole/getByApiId",
        init: {
          method: "POST",
          body: { apiId: String(first.apiId) }
        }
      },
      {
        path: "/joycreator/AIModelApiConsole/getByApiId",
        init: {
          method: "POST",
          body: { apiId: second.apiId }
        }
      }
    ]);
  });

  it("accepts a charged refresh from the live console detail wrapper", async () => {
    const raw = structuredClone(onlyRaw(imageFixture));
    const service = new CatalogService({
      read<T>(path: string): Promise<T> {
        if (path.endsWith("/getBySourceType")) {
          return Promise.resolve({
            result: {
              apiList: [{ apiId: raw.apiId }]
            }
          } as T);
        }
        return Promise.resolve({
          result: { selectedAIModel: raw }
        } as T);
      }
    }, 60_000);

    await service.list("image-generation");

    await expect(
      service.resolve(
        "fixture-seedream-5-0-lite",
        "image-generation",
        true
      )
    ).resolves.toMatchObject({
      apiId: "707",
      alias: "fixture-seedream-5-0-lite"
    });
  });

  it("fetches again after the source cache TTL expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
      const calls: Array<{ path: string; init?: ReadRequest }> = [];
      const service = new CatalogService(
        transportReturning(imageFixture, imageFixture, calls),
        1_000
      );

      await service.list("image-generation");
      vi.advanceTimersByTime(1_001);
      await service.list("image-generation");

      expect(calls).toHaveLength(2);
      expect(calls).toEqual([
        {
          path: "/joycreator/AIModelApiConsole/getBySourceType",
          init: {
            method: "POST",
            body: { sourceType: "image-generation" }
          }
        },
        {
          path: "/joycreator/AIModelApiConsole/getBySourceType",
          init: {
            method: "POST",
            body: { sourceType: "image-generation" }
          }
        }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves an exact apiId before a different model whose alias is the same text", async () => {
    const collision = structuredClone(imageFixture);
    collision.result.push({
      ...onlyRaw(collision),
      apiId: "fixture-other-api",
      id: "fixture-other-api",
      modelName: "707"
    });
    const service = new CatalogService(
      transportReturning(collision),
      60_000
    );

    await expect(service.resolve("707", "image-generation")).resolves
      .toMatchObject({
        apiId: "707",
        alias: "fixture-seedream-5-0-lite"
      });
  });

  it("rejects an ambiguous normalized alias", async () => {
    const duplicate = structuredClone(imageFixture);
    duplicate.result.push({
      ...onlyRaw(duplicate),
      apiId: "fixture-other-api",
      id: "fixture-other-api"
    });
    const service = new CatalogService(
      transportReturning(duplicate),
      60_000
    );

    await expect(
      service.resolve("fixture-seedream-5-0-lite", "image-generation")
    ).rejects.toMatchObject({ code: "model_catalog_changed" });
  });

  it("forces getByApiId with POST and replaces the cached model before revision rejection", async () => {
    const refreshed = structuredClone(imageFixture);
    const changedParameter = onlyRaw(refreshed).parameters.at(0);
    if (changedParameter === undefined) throw new Error("fixture is malformed");
    changedParameter.required = true;
    const calls: Array<{ path: string; init?: ReadRequest }> = [];
    const service = new CatalogService(
      transportReturning(imageFixture, refreshed, calls),
      60_000
    );

    await service.list("image-generation");
    await expect(
      service.resolve("707", "image-generation", true)
    ).rejects.toMatchObject({ code: "model_catalog_changed" });

    expect(calls.at(-1)).toEqual({
      path: "/joycreator/AIModelApiConsole/getByApiId",
      init: {
        method: "POST",
        body: { apiId: "707" }
      }
    });
    const cached = await service.resolve("707", "image-generation");
    expect(
      cached.parameters.find((parameter) => parameter.idx === "1")
    ).toMatchObject({ required: true });
  });

  it("accepts a charged materials refresh with complete raw metadata", async () => {
    const service = new CatalogService(
      transportReturning(textVideoFixture),
      60_000
    );

    await expect(
      service.resolve("fake-text-video-1", "text-to-video", true)
    ).resolves.toMatchObject({
      apiId: "fake-text-video-1",
      uploadStrategy: "materials"
    });
  });

  it("accepts explicit materials metadata whose value equals sourceType", async () => {
    const explicit = structuredClone(textVideoFixture);
    const raw = onlyRaw(explicit);
    raw.scene = "text-to-video";
    raw.assetScene = "text-to-video";
    const service = new CatalogService(
      transportReturning(explicit),
      60_000
    );

    await expect(
      service.resolve("fake-text-video-1", "text-to-video", true)
    ).resolves.toMatchObject({
      sceneCode: "text-to-video",
      expectedAssetScene: "text-to-video"
    });
  });

  it.each([
    ["missing modelCode", (raw: RawModel) => { delete raw.modelCode; }],
    ["empty modelCode", (raw: RawModel) => { raw.modelCode = "  "; }],
    ["missing scene", (raw: RawModel) => { delete raw.scene; delete raw.sceneCode; }],
    ["empty scene", (raw: RawModel) => { raw.scene = "  "; }],
    ["missing assetScene", (raw: RawModel) => { delete raw.assetScene; }],
    ["empty assetScene", (raw: RawModel) => { raw.assetScene = "  "; }]
  ])("rejects a charged materials refresh with %s in the raw object", async (_name, mutate) => {
    const invalid = structuredClone(textVideoFixture);
    mutate(onlyRaw(invalid));
    const service = new CatalogService(
      transportReturning(invalid),
      60_000
    );

    await expect(
      service.resolve("fake-text-video-1", "text-to-video", true)
    ).rejects.toMatchObject({ code: "model_catalog_changed" });
  });

  it("does not require materials-only raw metadata for a general upload strategy", async () => {
    const general = structuredClone(imageFixture);
    const raw = onlyRaw(general);
    delete raw.modelCode;
    delete raw.sceneCode;
    delete raw.scene;
    delete raw.assetScene;
    const service = new CatalogService(
      transportReturning(general),
      60_000
    );

    await expect(
      service.resolve("707", "image-generation", true)
    ).resolves.toMatchObject({
      apiId: "707",
      uploadStrategy: "general"
    });
  });
});
