import { createHash } from "node:crypto";
import type {
  NormalizedModel,
  NormalizedParameter,
  NormalizedPriceField,
  SourceType
} from "./types.js";

type ObjectRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is ObjectRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  const result = asString(value);
  return result !== undefined && result.trim().length > 0
    ? result
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function selectorKeys(raw: ObjectRecord): unknown[] {
  if (!Array.isArray(raw.selectorValues)) return [];
  return raw.selectorValues
    .filter(isPlainObject)
    .map((item) => item.key);
}

function priceSelectorString(value: unknown): string | undefined {
  return typeof value === "boolean" ? String(value) : asString(value);
}

function normalizePriceField(raw: ObjectRecord): NormalizedPriceField | null {
  const key = asString(raw.fieldName) ?? asString(raw.index);
  const billingItemType = asString(raw.billingItemType);
  if (key === undefined || billingItemType === undefined) return null;
  const index = asString(raw.index) ?? key;
  if (!["1", "2", "3", "4", "5", "6", "7"].includes(billingItemType)) {
    return null;
  }
  const selectors = Array.isArray(raw.selectorValues)
    ? raw.selectorValues.filter(isPlainObject).map((selector) => {
      const matches = [
        selector.key,
        selector.exKey,
        selector.value,
        selector.backendValue
      ].map(priceSelectorString).filter(
        (value): value is string => value !== undefined
      );
      const shortName = nonEmptyString(selector.shortName);
      return {
        matches: [...new Set(matches)],
        ...(shortName === undefined ? {} : { shortName })
      };
    }).filter((selector) => selector.matches.length > 0)
    : [];
  return {
    index,
    key,
    billingItemType,
    ...(selectors.length === 0 ? {} : { selectors })
  };
}

function required(value: unknown): boolean {
  return value === true
    || (
      typeof value === "string"
      && value.trim().toUpperCase() === "TRUE"
    );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

function alias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function normalizeParameter(raw: ObjectRecord): NormalizedParameter {
  const style = isPlainObject(raw.style) ? raw.style : {};
  const key = asString(raw.fieldName) ?? String(raw.index);
  const displayName = nonEmptyString(raw.fieldName4View)
    ?? nonEmptyString(style.name)
    ?? key;
  const styleOptions = Array.isArray(style.options)
    ? style.options.filter((item): item is string => typeof item === "string")
    : undefined;
  const keys = selectorKeys(raw);
  const selectorOptions = keys.length > 0
    && keys.every((item): item is string => typeof item === "string")
    ? keys
    : undefined;
  const options = styleOptions ?? selectorOptions;
  const type = [
    asString(style.type),
    asString(raw.fieldType),
    asString(raw.componentType)
  ].filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();
  const numericKeys = keys.filter(
    (item): item is number => typeof item === "number" && Number.isFinite(item)
  );
  const kind: NormalizedParameter["kind"] = type.includes("image")
    || type.includes("picfileupload")
    || type.includes("image-list")
    ? "image-list"
    : options !== undefined
      ? "enum"
      : type.includes("boolean") || type.includes("switch")
        ? "boolean"
        : type.includes("number")
          || type.includes("int")
          || type.includes("long")
          || type.includes("double")
          || type.includes("float")
          || numericKeys.length > 0
          || optionalNumber(raw.minimum) !== undefined
          || optionalNumber(raw.maximum) !== undefined
          ? "number"
          : "string";
  const result: NormalizedParameter = {
    idx: String(raw.index),
    key,
    displayName,
    required: required(raw.required),
    kind
  };

  if (
    "defaultValue" in raw
    && raw.defaultValue !== null
    && raw.defaultValue !== undefined
  ) {
    result.defaultValue = raw.defaultValue;
  }
  const minimum = optionalNumber(raw.minimum)
    ?? optionalNumber(style.min)
    ?? (
      numericKeys.length > 0 ? Math.min(...numericKeys) : undefined
    );
  if (minimum !== undefined) result.minimum = minimum;
  const maximum = optionalNumber(raw.maximum)
    ?? optionalNumber(style.max)
    ?? (
      numericKeys.length > 0 ? Math.max(...numericKeys) : undefined
    );
  if (maximum !== undefined) result.maximum = maximum;
  if (options !== undefined) result.options = options;
  const maxFiles = optionalNumber(style.maxFiles)
    ?? (kind === "image-list" ? optionalNumber(style.max) : undefined);
  if (maxFiles !== undefined) result.maxFiles = maxFiles;

  return result;
}

function fixedPricing(raw: ObjectRecord): unknown {
  if (raw.pricing !== undefined) return raw.pricing;
  const explicitlyFixed = raw.enablePriceQuery === false
    || (
      typeof raw.enablePriceQuery === "string"
      && raw.enablePriceQuery.trim().toLowerCase() === "false"
    );
  const points = typeof raw.price === "number"
    ? raw.price
    : typeof raw.price === "string" && raw.price.trim().length > 0
      ? Number(raw.price)
      : Number.NaN;
  return explicitlyFixed && Number.isFinite(points) && points >= 0
    ? {
        billingType: "fixed",
        unit: "points",
        points
      }
    : null;
}

function modelRows(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (!isPlainObject(response)) return [response];
  if (Array.isArray(response.result)) return response.result;
  if (isPlainObject(response.result)) return [response.result];
  return [response];
}

export function normalizeModels(
  sourceType: SourceType,
  response: unknown
): NormalizedModel[] {
  return modelRows(response).filter(isPlainObject).map((raw) => {
    const apiId = asString(raw.apiId);
    if (apiId === undefined) throw new Error("Model lacks apiId");

    const displayName = nonEmptyString(raw.modelName)
      ?? nonEmptyString(raw.aiModelName)
      ?? nonEmptyString(raw.apiName)
      ?? nonEmptyString(raw.name)
      ?? apiId;
    const parameterRows = Array.isArray(raw.parameters)
      ? raw.parameters
      : Array.isArray(raw.parametersMeta)
        ? raw.parametersMeta
        : [];
    const parameters = parameterRows
      .filter(isPlainObject)
      .map(normalizeParameter);
    const modelParameter = parameters.find(
      (parameter) => parameter.key === "model"
    );
    const modelCode=nonEmptyString(raw.modelCode)??(sourceType==="image-to-video"?apiId:undefined)??nonEmptyString(raw.venderCode)??nonEmptyString(modelParameter?.defaultValue);
    const sceneCode=nonEmptyString(raw.sceneCode)??nonEmptyString(raw.scene)??(sourceType==="image-to-video"?sourceType:undefined)??nonEmptyString(raw.shortSenceCode)??sourceType;
    const expectedAssetScene = nonEmptyString(raw.assetScene)
      ?? nonEmptyString(raw.scene)
      ?? nonEmptyString(raw.shortSenceCode)
      ?? sourceType;
    const rawPrice = isPlainObject(raw.priceQuerySchema)
      ? raw.priceQuerySchema
      : null;
    const priceService = nonEmptyString(raw.priceQueryService)
      ?? nonEmptyString(raw.priceService)
      ?? nonEmptyString(rawPrice?.priceQueryService);
    const priceParams = isPlainObject(raw.priceQueryParams)
      ? raw.priceQueryParams
      : isPlainObject(rawPrice?.params)
        ? rawPrice.params
        : null;
    const priceFields = parameterRows
      .filter(isPlainObject)
      .map(normalizePriceField)
      .filter((field): field is NormalizedPriceField => field !== null);
    const shortVender = nonEmptyString(raw.shortVender);
    const shortSenceCode = nonEmptyString(
      raw.shortSenceCode ?? raw.shortSceneCode
    );
    const priceQuerySchema = rawPrice === null && priceService === undefined
      ? null
      : {
          ...(rawPrice ?? {}),
          ...(priceService === undefined
            ? {}
            : {
                priceQueryService: priceService,
                strategy: raw.enablePriceQuery === false
                  || (
                    typeof raw.enablePriceQuery === "string"
                    && raw.enablePriceQuery.trim().toLowerCase() === "false"
                  )
                  ? "formula" as const
                  : "calculate" as const
              }),
          ...(shortVender === undefined ? {} : { shortVender }),
          ...(shortSenceCode === undefined ? {} : { shortSenceCode }),
          ...(priceFields.length === 0 ? {} : { fields: priceFields }),
          ...(priceParams === null
            ? {}
            : {
                params: Object.fromEntries(
                  Object.entries(priceParams).filter(
                    (entry): entry is [string, string | number | boolean] =>
                      typeof entry[1] === "string"
                      || typeof entry[1] === "number"
                      || typeof entry[1] === "boolean"
                  )
                )
              })
        };

    return {
      id: asString(raw.id) ?? apiId,
      apiId,
      alias: alias(displayName),
      displayName,
      sourceType,
      modelCode: modelCode ?? null,
      refId: asString(raw.refId) ?? apiId,
      sceneCode,
      expectedAssetScene,
      uploadStrategy:raw.uploadStrategy==="materials"||raw.materialUpload===true||sourceType==="image-to-video"?"materials":"general",
      priceQuerySchema,
      parameters,
      pricing: priceService === undefined ? fixedPricing(raw) : null,
      rawRevision: createHash("sha256")
        .update(stableJson(raw))
        .digest("hex")
    };
  });
}
