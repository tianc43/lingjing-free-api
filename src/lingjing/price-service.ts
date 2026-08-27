import type { LingjingTransport } from "./types.js";

export interface PriceQuery {
  enablePriceQuery: true;
  priceQueryService: string;
  params: Record<string, string | number | boolean>;
}

export interface PriceQuote {
  points: number;
  raw: unknown;
}

const CURRENCY_FIELDS = ["discountedTotalPrice", "totalPrice"];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function containers(value: unknown): Record<string, unknown>[] {
  const root = record(value);
  if (root === null) return [];
  const result = record(root.result);
  const data = record(root.data);
  const resultData = record(result?.data);
  return [root, result, data, resultData].filter(
    (item): item is Record<string, unknown> => item !== null
  );
}

function displayedPoints(value: unknown): number | null {
  const rows = containers(value);
  for (const field of CURRENCY_FIELDS) {
    for (const row of rows) {
      const amount = nonNegativeNumber(row[field]);
      if (amount !== null) return Math.round(amount * 100);
    }
  }
  return null;
}

export class LingjingPriceService {
  constructor(
    private readonly transport: Pick<LingjingTransport, "read">
  ) {}

  async calculate(query: PriceQuery): Promise<PriceQuote> {
    const raw = await this.transport.read<unknown>(
      "/joycreator/AIModelApiConsole/calculatePrice",
      { method: "POST", body: query }
    );
    const points = displayedPoints(raw);
    if (points === null) {
      throw new Error("Lingjing price response has no point quote");
    }
    return { points, raw };
  }
}
