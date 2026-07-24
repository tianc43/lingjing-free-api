import type { NormalizedModel } from "../models/types.js";

const POINT_UNITS = new Set([
  "point",
  "points",
  "credit",
  "credits",
  "灵感值"
]);
const FIXED_BILLING_TYPES = new Set([
  "fixed",
  "once",
  "total",
  "task",
  "per_task",
  "per-task"
]);
const PRICE_FIELDS = ["points", "credits", "amount", "cost", "price"];

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function pointUnit(value: unknown): boolean {
  return typeof value === "string" && POINT_UNITS.has(value.trim().toLowerCase());
}

function fixedQuote(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const billingType = record.billingType ?? record.billing_type;
  if (
    billingType !== undefined
    && (typeof billingType !== "string" || !FIXED_BILLING_TYPES.has(billingType.trim().toLowerCase()))
  ) {
    return null;
  }
  if (
    record.billingType !== undefined
    && record.billing_type !== undefined
    && record.billingType !== record.billing_type
  ) {
    return null;
  }
  if (
    record.unit !== undefined
    && record.currency !== undefined
    && record.unit !== record.currency
  ) {
    return null;
  }
  if ((record.unit !== undefined && !pointUnit(record.unit)) || (record.currency !== undefined && !pointUnit(record.currency))) {
    return null;
  }
  if (Object.hasOwn(record, "rate")) return null;

  const fields = PRICE_FIELDS.filter((field) => Object.hasOwn(record, field));
  if (fields.length !== 1) return null;
  const field = fields[0];
  if (field === undefined) return null;
  if (field === "cost" || field === "price") {
    return fixedQuote(record[field]);
  }
  if (field === "amount" && !pointUnit(record.unit ?? record.currency)) return null;
  return finiteNonNegative(record[field]);
}

function parameterQuote(schema: unknown, values: Record<string, unknown>): number | null {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return null;
  }
  const entries = Object.values(schema as Record<string, unknown>);
  if (entries.length !== 1) return null;
  const entry = entries[0];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.source !== "string" || record.source.length === 0) return null;
  const selected = values[record.source];
  if (
    typeof selected !== "string"
    && typeof selected !== "number"
    && typeof selected !== "boolean"
  ) return null;
  if (typeof record.prices !== "object" || record.prices === null || Array.isArray(record.prices)) return null;
  const price = (record.prices as Record<string, unknown>)[String(selected)];
  return finiteNonNegative(price);
}

export function quotedPoints(
  model: NormalizedModel,
  values: Record<string, unknown>
): number | null {
  if (model.pricing !== null) return fixedQuote(model.pricing);
  return parameterQuote(model.priceQuerySchema, values);
}
