import { describe, expect, it } from "vitest";
import { PostgresVideoQuoteResolver } from "../../src/lingjing/postgres-quote-resolver.js";

describe("Postgres video quote resolver", () => {
  it("passes every billing parameter through the shared live builder", async () => {
    let body: unknown;
    const runtime = {
      record: { id: "a" },
      catalog: {
        resolve: () => Promise.resolve({
          parameters: [
            { key: "model_name", defaultValue: "Doubao-Seedance-2.0-mini" },
            { key: "duration", defaultValue: "5" },
            { key: "mode", defaultValue: "720p" },
            { key: "aspect_ratio", defaultValue: "16:9" },
            { key: "generate_audio", defaultValue: true }
          ],
          priceQuerySchema: {
            priceQueryService: "sd2",
            shortVender: "byte",
            shortSenceCode: "t2v",
            fields: [
              {
                key: "model_name",
                billingItemType: "1",
                selectors: [{
                  matches: ["Doubao-Seedance-2.0-mini"],
                  shortName: "sd2mini"
                }]
              },
              { key: "duration", billingItemType: "5" },
              { key: "mode", billingItemType: "1" },
              { key: "aspect_ratio", billingItemType: "5" }
            ]
          }
        })
      },
      transport: {
        read: <T>(_path: string, init?: { body?: unknown }) => {
          body = init?.body;
          return Promise.resolve({
            result: { totalPrice: 0.924048, discountedTotalPrice: 0.92 }
          } as T);
        }
      }
    };
    const resolver = new PostgresVideoQuoteResolver({
      listEnabled: () => [runtime] as never
    });

    expect(await resolver.quote({
      modelId: "758",
      mode: "text-to-video",
      accountId: "a",
      parameters: {
        duration: "4",
        mode: "480p",
        aspect_ratio: "16:9",
        generate_audio: false
      }
    })).toEqual({
      points: 92,
      priceQueryResult: {
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
      }
    });
    expect(body).toEqual({
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
});
