import { quoteModelPrice } from "./model-price.js";
import type { PriceQuery } from "./price-service.js";
import type { RuntimeLookup } from "./postgres-account-transport-resolver.js";

export interface VideoQuoteInput {
  modelId: string;
  mode: "text-to-video" | "image-to-video";
  parameters: Record<string, unknown>;
  accountId: string;
}

export interface VideoQuoteResult {
  points: number;
  priceQueryResult?: {
    priceQueryRequest: PriceQuery;
  };
}

export class PostgresVideoQuoteResolver {
  constructor(private readonly runtimes: RuntimeLookup) {}

  async quote(input: VideoQuoteInput): Promise<VideoQuoteResult> {
    const runtime = this.runtimes.listEnabled().find(
      (item) => item.record.id === input.accountId
    );
    if (runtime === undefined) {
      throw new Error("Bound account runtime unavailable");
    }
    const model = await runtime.catalog.resolve(
      input.modelId,
      input.mode,
      true
    );
    return await quoteModelPrice(model, input.parameters, runtime.transport);
  }
}
