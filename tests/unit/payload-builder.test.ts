import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeModels } from "../../src/models/normalize.js";
import { buildPayload } from "../../src/models/payload-builder.js";

const fixture: unknown = JSON.parse(readFileSync(new URL("../fixtures/models/image-generation.json", import.meta.url), "utf8"));
const normalizedImageModel = normalizeModels("image-generation", fixture).at(0);
if (normalizedImageModel === undefined) throw new Error("fixture is malformed");

describe("buildPayload", () => {
  it("uses dynamic idx, display names, converted values and uploaded paths", () => {
    expect(buildPayload({ model: normalizedImageModel, spaceId: 0, values: { prompt: "fixture prompt", size: "2048x2048", taskNum: 1, image: ["upload/path/a.png"] } })).toEqual({
      apiId: "707", params: [{ idx: "1", name: "参考图", values: ["upload/path/a.png"], filePath: ["upload/path/a.png"] }, { idx: "2", name: "提示词", values: "fixture prompt" }, { idx: "3", name: "尺寸", values: "2048x2048" }, { idx: "4", name: "联网搜索", values: false }, { idx: "5", name: "生成数量", values: 1 }], refId: "707", spaceId: 0, priceQueryResult: { taskNum: 1 }
    });
  });
  it("rejects unknown parameters and stale enum values", () => {
    expect.assertions(2);
    try { buildPayload({ model: normalizedImageModel, spaceId: 0, values: { prompt: "x", unsupported: true } }); } catch (cause) { expect(cause).toMatchObject({ code: "invalid_request" }); }
    try { buildPayload({ model: normalizedImageModel, spaceId: 0, values: { prompt: "x", size: "stale-size" } }); } catch (cause) { expect(cause).toMatchObject({ code: "model_catalog_changed" }); }
  });
});
