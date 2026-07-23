import { createHash } from "node:crypto";
import type {
  NormalizedModel,
  NormalizedParameter,
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

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
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
  const displayName = asString(raw.fieldName4View)
    ?? asString(style.name)
    ?? key;
  const type = asString(style.type)?.toLowerCase();
  const options = Array.isArray(style.options)
    ? style.options.filter((item): item is string => typeof item === "string")
    : undefined;
  const kind: NormalizedParameter["kind"] = type === "image-list"
    || type === "image"
    ? "image-list"
    : type === "switch" || type === "boolean"
      ? "boolean"
      : options !== undefined
        ? "enum"
        : type === "number"
          || optionalNumber(raw.minimum) !== undefined
          || optionalNumber(raw.maximum) !== undefined
          ? "number"
          : "string";
  const result: NormalizedParameter = {
    idx: String(raw.index),
    key,
    displayName,
    required: raw.required === true,
    kind
  };

  if ("defaultValue" in raw) result.defaultValue = raw.defaultValue;
  const minimum = optionalNumber(raw.minimum);
  if (minimum !== undefined) result.minimum = minimum;
  const maximum = optionalNumber(raw.maximum);
  if (maximum !== undefined) result.maximum = maximum;
  if (options !== undefined) result.options = options;
  const maxFiles = optionalNumber(style.maxFiles);
  if (maxFiles !== undefined) result.maxFiles = maxFiles;

  return result;
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

    const displayName = asString(raw.modelName)
      ?? asString(raw.name)
      ?? apiId;
    const parameters = Array.isArray(raw.parameters)
      ? raw.parameters.filter(isPlainObject).map(normalizeParameter)
      : [];
    const priceQuerySchema = isPlainObject(raw.priceQuerySchema)
      ? raw.priceQuerySchema
      : null;

    return {
      id: asString(raw.id) ?? apiId,
      apiId,
      alias: alias(displayName),
      displayName,
      sourceType,
      modelCode: asString(raw.modelCode) ?? null,
      refId: asString(raw.refId) ?? apiId,
      sceneCode: asString(raw.sceneCode) ?? asString(raw.scene) ?? sourceType,
      expectedAssetScene: asString(raw.assetScene)
        ?? asString(raw.scene)
        ?? sourceType,
      uploadStrategy: raw.uploadStrategy === "materials"
        || raw.materialUpload === true
        ? "materials"
        : "general",
      priceQuerySchema,
      parameters,
      pricing: raw.pricing ?? null,
      rawRevision: createHash("sha256")
        .update(stableJson(raw))
        .digest("hex")
    };
  });
}
