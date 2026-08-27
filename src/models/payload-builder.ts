import { errors } from "../errors.js";
import type {
  BuiltPayload,
  NormalizedModel,
  NormalizedParameter
} from "./types.js";

function validate(parameter: NormalizedParameter, value: unknown): unknown {
  if (
    parameter.kind === "string"
    && (
      typeof value !== "string"
      || (parameter.required && value.trim().length === 0)
    )
  ) {
    throw errors.invalidRequest(
      `Expected non-empty string for ${parameter.key}`,
      parameter.key
    );
  }

  if (parameter.kind === "boolean" && typeof value !== "boolean") {
    throw errors.invalidRequest(
      `Expected boolean for ${parameter.key}`,
      parameter.key
    );
  }

  if (
    parameter.kind === "number"
    && (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw errors.invalidRequest(
      `Expected number for ${parameter.key}`,
      parameter.key
    );
  }

  if (
    parameter.kind === "number"
    && typeof value === "number"
    && (
      (parameter.minimum !== undefined && value < parameter.minimum)
      || (parameter.maximum !== undefined && value > parameter.maximum)
    )
  ) {
    throw errors.invalidRequest(
      `Value out of range for ${parameter.key}`,
      parameter.key
    );
  }

  if (
    parameter.kind === "enum"
    && (
      typeof value !== "string"
      || !parameter.options?.includes(value)
    )
  ) {
    throw errors.catalogChanged();
  }

  if (
    parameter.kind === "image-list"
    && (
      !Array.isArray(value)
      || !value.every((item) => typeof item === "string")
      || (parameter.required && value.length === 0)
      || (
        parameter.maxFiles !== undefined
        && value.length > parameter.maxFiles
      )
    )
  ) {
    throw errors.invalidRequest(
      `Invalid image list for ${parameter.key}`,
      parameter.key
    );
  }

  return value;
}

function derivePrice(
  schema: Record<string, unknown>,
  values: Record<string, unknown>
): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  for (const [output, source] of Object.entries(schema)) {
    if (typeof source !== "string" || !(source in values)) return undefined;
    result[output] = values[source];
  }
  return result;
}

export function buildPayload(input: {
  model: NormalizedModel;
  spaceId: number;
  values: Record<string, unknown>;
}): BuiltPayload {
  const allowed = new Set(
    input.model.parameters.map((parameter) => parameter.key)
  );
  for (const key of Object.keys(input.values)) {
    if (!allowed.has(key)) {
      throw errors.invalidRequest(`Unknown parameter ${key}`, key);
    }
  }

  const validated: Record<string, unknown> = {};
  const params: BuiltPayload["params"] = [];

  for (const parameter of input.model.parameters) {
    const provided = Object.hasOwn(input.values, parameter.key);
    const value=provided?input.values[parameter.key]:parameter.defaultValue;if(parameter.kind==="image-list"&&!parameter.required&&(value===""||value===null)){continue;}

    if (value === undefined) {
      if (parameter.required || provided) {
        throw errors.invalidRequest(
          `Missing required parameter ${parameter.key}`,
          parameter.key
        );
      }
      continue;
    }

    const checked = validate(parameter, value);
    validated[parameter.key] = checked;
    params.push(parameter.kind === "image-list"
      ? {
        idx: parameter.idx,
        name:input.model.sourceType==="image-to-video"?parameter.idx:parameter.displayName,
        values:input.model.sourceType==="image-to-video"?(checked as string[])[0]??"":checked,
        filePath:checked as string[]
      }
      : {
        idx: parameter.idx,
        name: parameter.displayName,
        values: checked
      });
  }

  const priceQueryResult = input.model.priceQuerySchema === null
    || typeof input.model.priceQuerySchema.priceQueryService === "string"
    ? undefined
    : derivePrice(input.model.priceQuerySchema, validated);

  return {
    apiId: input.model.apiId,
    params,
    refId: input.model.refId,
    spaceId: input.spaceId,
    ...(priceQueryResult === undefined ? {} : { priceQueryResult })
  };
}
