import { describe, expect, it, vi } from "vitest";
import { LingjingPriceService } from "../../src/lingjing/price-service.js";

describe("Lingjing price contract", () => {
  it("uses the observed endpoint and converts platform currency to points", async () => {
    const observed = vi.fn();
    const read = <T>(path: string, init?: unknown) => {
      observed(path, init);
      return Promise.resolve({
        result: { totalPrice: 0.324, discountedTotalPrice: 0.32 }
      } as T);
    };
    const service = new LingjingPriceService({ read });
    const body = {
      enablePriceQuery: true as const,
      priceQueryService: "wan3",
      params: {
        shortVender: "ali",
        shortSenceCode: "i2v",
        model_name: "wan3",
        duration: "5",
        resolution: "1080P"
      }
    };

    expect((await service.calculate(body)).points).toBe(32);
    expect(observed).toHaveBeenCalledWith(
      "/joycreator/AIModelApiConsole/calculatePrice",
      { method: "POST", body }
    );
  });
});
