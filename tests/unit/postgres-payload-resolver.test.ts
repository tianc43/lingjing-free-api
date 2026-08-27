import { describe, expect, it } from "vitest";
import { PostgresLingjingPayloadResolver } from "../../src/lingjing/postgres-payload-resolver.js";

describe("Postgres Lingjing payload resolver", () => {
  it("preserves the persisted live price request in the submit payload", async () => {
    const priceQueryResult = {
      priceQueryRequest: {
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
      }
    };
    const resolver = new PostgresLingjingPayloadResolver(
      {
        payload: () => Promise.resolve({
          apiId: "758",
          prompt: "clouds",
          priceQueryResult
        })
      } as never,
      { resolve: () => Promise.resolve([]) } as never,
      { upload: () => Promise.reject(new Error("upload should not run")) }
    );

    await expect(resolver.payload("job")).resolves.toMatchObject({
      apiId: "758",
      priceQueryResult,
      inputImages: []
    });
  });
});
