import type {
  NormalizedModel,
  NormalizedPriceField,
  NormalizedPriceSelector
} from "../models/types.js";
import type { PriceQuery } from "./price-service.js";

const BILLABLE_TYPES = new Set(["1", "2", "3", "4", "5", "6", "7"]);

function scalar(value: unknown): string | number | boolean | null {
  return typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    ? value
    : null;
}

function selectorValue(
  selectors: readonly NormalizedPriceSelector[] | undefined,
  value: string | number | boolean
): string | null {
  const selected = selectors?.find((candidate) =>
    candidate.matches.includes(String(value))
  );
  return selected?.shortName ?? null;
}

function fieldValue(
  field: NormalizedPriceField,
  value: unknown
): string | number | boolean | null {
  const direct = scalar(value);
  if (direct !== null) {
    return field.key === "model_name"
      ? selectorValue(field.selectors, direct)
      : String(direct);
  }
  if (field.billingItemType === "4" && Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string");
    return items.length === 0 ? null : items.join(",");
  }
  return null;
}

function service(schema: NormalizedModel["priceQuerySchema"]): string | null {
  const candidate = schema?.priceQueryService
    ?? schema?.["service"]
    ?? schema?.["serviceName"];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate
    : null;
}

export function buildPriceQuery(
  model: NormalizedModel,
  values: Record<string, unknown>
): PriceQuery | null {
  const schema = model.priceQuerySchema;
  if (schema?.strategy === "formula") return null;
  const priceQueryService = service(schema);
  if (schema === null || priceQueryService === null) return null;

  const params: Record<string, string | number | boolean> = {};
  if (schema.shortVender !== undefined) params.shortVender = schema.shortVender;
  if (schema.shortSenceCode !== undefined) {
    params.shortSenceCode = schema.shortSenceCode;
  }

  const fields = schema.fields?.filter((field) =>
    BILLABLE_TYPES.has(field.billingItemType)
  );
  if (fields === undefined || fields.length === 0) return null;
  for (const field of fields) {
    const parameter = model.parameters.find((item) => item.key === field.key);
    const value = values[field.key] ?? parameter?.defaultValue;
    const normalized = fieldValue(field, value);
    if (
      normalized === null
      && (field.key === "model_name" || parameter?.required === true)
    ) {
      return null;
    }
    if (normalized !== null) params[field.key] = normalized;
  }

  return {
    enablePriceQuery: true,
    priceQueryService,
    params
  };
}

function fieldOrder(left: NormalizedPriceField, right: NormalizedPriceField): number {
  const leftIndex = left.index ?? left.key;
  const rightIndex = right.index ?? right.key;
  const leftNumber = Number(leftIndex);
  const rightNumber = Number(rightIndex);
  const leftNumeric = leftIndex.trim().length > 0 && Number.isFinite(leftNumber);
  const rightNumeric = rightIndex.trim().length > 0 && Number.isFinite(rightNumber);
  if (leftNumeric && rightNumeric) return leftNumber - rightNumber;
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return leftIndex.localeCompare(rightIndex);
}

export function buildFormulaKey(
  model: NormalizedModel,
  values: Record<string, unknown>
): string | null {
  const schema = model.priceQuerySchema;
  if (
    schema?.strategy !== "formula"
    || schema.shortVender === undefined
    || schema.shortSenceCode === undefined
  ) {
    return null;
  }
  const fields = schema.fields?.slice().sort(fieldOrder);
  if (fields === undefined || fields.length === 0) return null;
  const parts = [schema.shortVender, schema.shortSenceCode];
  for (const field of fields) {
    if (field.billingItemType !== "1") return null;
    const parameter = model.parameters.find((item) => item.key === field.key);
    const value = scalar(values[field.key] ?? parameter?.defaultValue);
    if (value === null) return null;
    const shortName = selectorValue(field.selectors, value);
    if (shortName === null) return null;
    parts.push(shortName);
  }
  return parts.join(".");
}
