import { describe, expect, it } from "vitest";
import { buildFormulaKey, buildPriceQuery } from "../../src/lingjing/price-query.js";
import type { NormalizedModel } from "../../src/models/types.js";

const model = {
  id: "758",
  apiId: "758",
  alias: "seedance-2-0-mini",
  displayName: "Seedance 2.0 mini",
  sourceType: "text-to-video",
  modelCode: "Doubao-Seedance-2.0-mini",
  refId: "758",
  sceneCode: "text-to-video",
  expectedAssetScene: "text-to-video",
  uploadStrategy: "general",
  priceQuerySchema: {
    priceQueryService: "sd2",
    shortVender: "byte",
    shortSenceCode: "t2v",
    fields: [
      {
        key: "model_name",
        billingItemType: "1",
        selectors: [{ matches: ["Doubao-Seedance-2.0-mini"], shortName: "sd2mini" }]
      },
      { key: "duration", billingItemType: "5" },
      { key: "mode", billingItemType: "1" },
      { key: "aspect_ratio", billingItemType: "5" }
    ]
  },
  parameters: [
    { idx: "1", key: "model_name", displayName: "模型", required: true, kind: "enum", defaultValue: "Doubao-Seedance-2.0-mini", options: ["Doubao-Seedance-2.0-mini"] },
    { idx: "2", key: "duration", displayName: "时长", required: true, kind: "enum", defaultValue: "5", options: ["4", "5"] },
    { idx: "3", key: "mode", displayName: "分辨率", required: true, kind: "enum", defaultValue: "720p", options: ["480p", "720p"] },
    { idx: "4", key: "aspect_ratio", displayName: "画幅", required: true, kind: "enum", defaultValue: "16:9", options: ["16:9", "9:16"] },
    { idx: "5", key: "generate_audio", displayName: "生成音频", required: true, kind: "boolean", defaultValue: true }
  ],
  pricing: null,
  rawRevision: "fixture"
} satisfies NormalizedModel;

describe("Lingjing live price query", () => {
  it("matches the current console billing parameters and omits non-billable fields", () => {
    expect(buildPriceQuery(model, {
      duration: "4",
      mode: "480p",
      aspect_ratio: "16:9",
      generate_audio: false
    })).toEqual({
      enablePriceQuery: true,
      priceQueryService: "sd2",
      params: {
        shortVender: "byte",
        shortSenceCode: "t2v",
        model_name: "sd2mini",
        duration: "4",
        mode: "480p",
        aspect_ratio: "16:9"
      }
    });
  });

  it("fails closed when model_name has no current shortName mapping", () => {
    expect(buildPriceQuery(model, {
      model_name: "unknown-model",
      duration: "4",
      mode: "480p",
      aspect_ratio: "16:9"
    })).toBeNull();
  });

  it("does not fall back to sending every model parameter", () => {
    expect(buildPriceQuery({
      ...model,
      priceQuerySchema: {
        priceQueryService: "sd2",
        shortVender: "byte",
        shortSenceCode: "t2v"
      }
    }, { generate_audio: true })).toBeNull();
  });

  it("fails closed when a required billing field has no selected or default value", () => {
    expect(buildPriceQuery({
      ...model,
      parameters: model.parameters.map((parameter) =>
        parameter.key === "duration"
          ? { ...parameter, defaultValue: undefined }
          : parameter
      )
    }, {
      mode: "480p",
      aspect_ratio: "16:9"
    })).toBeNull();
  });

  it("builds the current fixed-formula key for non-query video models", () => {
    expect(buildFormulaKey({
      ...model,
      priceQuerySchema: {
        strategy: "formula",
        priceQueryService: "123service",
        shortVender: "byte",
        shortSenceCode: "t2v",
        fields: [
          { index: "2", key: "model_name", billingItemType: "1", selectors: [{ matches: ["Doubao-Seedance-1.5-pro"], shortName: "sda15p" }] },
          { index: "3", key: "duration", billingItemType: "1", selectors: [{ matches: ["5"], shortName: "5s" }] },
          { index: "4", key: "mode", billingItemType: "1", selectors: [{ matches: ["480p"], shortName: "480p" }] },
          { index: "6", key: "generate_audio", billingItemType: "1", selectors: [{ matches: ["false"], shortName: "F" }] }
        ]
      },
      parameters: [
        { idx: "2", key: "model_name", displayName: "模型", required: true, kind: "enum", defaultValue: "Doubao-Seedance-1.5-pro", options: ["Doubao-Seedance-1.5-pro"] },
        { idx: "3", key: "duration", displayName: "时长", required: true, kind: "enum", defaultValue: "5", options: ["5"] },
        { idx: "4", key: "mode", displayName: "清晰度", required: true, kind: "enum", defaultValue: "480p", options: ["480p"] },
        { idx: "6", key: "generate_audio", displayName: "音频", required: true, kind: "boolean", defaultValue: false }
      ]
    }, {})).toBe("byte.t2v.sda15p.5s.480p.F");
  });
});
