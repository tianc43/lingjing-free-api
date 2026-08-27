import { errors } from "../errors.js";
import type { NormalizedModel } from "../models/types.js";
import type { LingjingTransport } from "./types.js";
import { buildFormulaKey, buildPriceQuery } from "./price-query.js";
import { LingjingPriceService } from "./price-service.js";
import type { PriceQuery } from "./price-service.js";

export interface ModelPriceQuote {
  points: number;
  priceQueryResult?: {
    priceQueryRequest: PriceQuery;
  };
}

export async function quoteModelPrice(
  model: NormalizedModel,
  values: Record<string, unknown>,
  transport: Pick<LingjingTransport, "read">
): Promise<ModelPriceQuote> {
  const service = new LingjingPriceService(transport);
  if (model.priceQuerySchema?.strategy === "formula") {
    const formulaKey = buildFormulaKey(model, values);
    if (formulaKey === null) throw errors.upstream();
    const quote = await service.calculateFormula(formulaKey);
    return { points: quote.points };
  }
  const query = buildPriceQuery(model, values);
  if (query === null) throw errors.upstream();
  const quote = await service.calculate(query);
  return {
    points: quote.points,
    priceQueryResult: { priceQueryRequest: query }
  };
}
