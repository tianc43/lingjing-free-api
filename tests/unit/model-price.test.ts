import { describe, expect, it } from "vitest";
import { quoteModelPrice } from "../../src/lingjing/model-price.js";
import type { NormalizedModel } from "../../src/models/types.js";

const formulaModel: NormalizedModel = {
  id: "751",
  apiId: "751",
  alias: "seedance-1-5-pro",
  displayName: "Seedance-1.5-pro",
  sourceType: "image-to-video",
  modelCode: "Doubao-Seedance-1.5-pro",
  refId: "751",
  sceneCode: "image-to-video",
  expectedAssetScene: "image-to-video",
  uploadStrategy: "materials",
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
  ],
  pricing: null,
  rawRevision: "formula"
};

describe("model price strategy", () => {
  it("quotes formula-priced models without a submission priceQueryResult", async () => {
    let path: string | undefined;
    const quote = await quoteModelPrice(formulaModel, {}, {
      read: <T>(nextPath: string) => {
        path = nextPath;
        return Promise.resolve({
          result: { totalPrice: 0.32, discountedTotalPrice: 0.32 }
        } as T);
      }
    });

    expect(path).toBe("/openApi/billingprice/calculateTotalPriceV2");
    expect(quote).toEqual({ points: 32 });
  });
});
