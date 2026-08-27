import { describe, expect, it } from "vitest";
import { LingjingPriceService } from "../../src/lingjing/price-service.js";

const query = {
  enablePriceQuery: true as const,
  priceQueryService: "sd2",
  params: {}
};

describe("Lingjing price parsing", () => {
  it("converts the observed discounted platform currency to displayed points", async () => {
    const service = new LingjingPriceService({
      read: <T>() => Promise.resolve({
        result: {
          unitPrice: 0.924048,
          totalPrice: 0.924048,
          discountedTotalPrice: 0.92,
          quantity: 40.176
        }
      } as T)
    });

    expect((await service.calculate(query)).points).toBe(92);
  });

  it("rejects legacy point-shaped responses instead of double converting them", async () => {
    const service = new LingjingPriceService({
      read: <T>() => Promise.resolve({ result: { totalPoints: "92" } } as T)
    });

    await expect(service.calculate(query)).rejects.toThrow(/no point quote/u);
  });

  it("does not mistake unrelated numeric fields for a quote", async () => {
    const service = new LingjingPriceService({
      read: <T>() => Promise.resolve({ result: { quantity: 40.176 } } as T)
    });

    await expect(service.calculate(query)).rejects.toThrow(/no point quote/u);
  });

  it("falls back to totalPrice and rounds only after point conversion", async () => {
    const service = new LingjingPriceService({
      read: <T>() => Promise.resolve({ result: { totalPrice: "2.305" } } as T)
    });

    expect((await service.calculate(query)).points).toBe(231);
  });

  it("prefers a nested discounted total over an outer total", async () => {
    const service = new LingjingPriceService({
      read: <T>() => Promise.resolve({
        totalPrice: 1,
        result: { discountedTotalPrice: 0.92 }
      } as T)
    });

    expect((await service.calculate(query)).points).toBe(92);
  });

  it("rejects an unverified generic price field", async () => {
    const service = new LingjingPriceService({
      read: <T>() => Promise.resolve({ result: { price: 0.92 } } as T)
    });

    await expect(service.calculate(query)).rejects.toThrow(/no point quote/u);
  });
});
