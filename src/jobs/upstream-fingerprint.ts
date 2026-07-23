import { createHash } from "node:crypto";

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

interface CanonicalParam {
  idx: string;
  values: CanonicalValue;
  filePath?: CanonicalValue;
}

interface CanonicalPayload {
  apiId: string;
  refId: string;
  params: CanonicalParam[];
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function canonicalize(value: unknown): CanonicalValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Upstream fingerprint contains a non-finite number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const item = record(value);
  if (item !== null) {
    const output: { [key: string]: CanonicalValue } = {};
    for (const key of Object.keys(item).sort()) {
      if (item[key] !== undefined) output[key] = canonicalize(item[key]);
    }
    return output;
  }
  throw new TypeError("Upstream fingerprint values must be JSON-compatible");
}

function identifier(value: unknown, field: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number")
    || String(value).trim().length === 0
  ) {
    throw new TypeError(`Upstream fingerprint requires ${field}`);
  }
  return String(value).trim();
}

function compareIdx(left: CanonicalParam, right: CanonicalParam): number {
  const leftNumber = Number(left.idx);
  const rightNumber = Number(right.idx);
  const leftNumeric = Number.isFinite(leftNumber);
  const rightNumeric = Number.isFinite(rightNumber);
  if (leftNumeric && rightNumeric && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left.idx.localeCompare(right.idx);
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`${label} must contain valid JSON`);
  }
}

function payloadRecord(value: unknown, label: string): Record<string, unknown> {
  let parsed = parseJson(value, label);
  let item = record(parsed);
  if (item === null) throw new TypeError(`${label} must be an object`);

  for (const key of ["reqParam", "requestParam", "payload"]) {
    if (item.apiId === undefined && item[key] !== undefined) {
      parsed = parseJson(item[key], label);
      item = record(parsed);
      if (item === null) throw new TypeError(`${label} must be an object`);
      break;
    }
  }
  return item;
}

function canonicalPayload(value: unknown, label: string): CanonicalPayload {
  const item = payloadRecord(value, label);
  if (!Array.isArray(item.params)) {
    throw new TypeError("Upstream fingerprint requires params");
  }
  const params = item.params.map((value): CanonicalParam => {
    const param = record(value);
    if (param === null) {
      throw new TypeError("Upstream fingerprint params must be objects");
    }
    if (param.values === undefined) {
      throw new TypeError("Upstream fingerprint params require values");
    }
    const output: CanonicalParam = {
      idx: identifier(param.idx, "params.idx"),
      values: canonicalize(param.values)
    };
    if (param.filePath !== undefined) {
      output.filePath = canonicalize(param.filePath);
    }
    return output;
  }).sort(compareIdx);

  return {
    apiId: identifier(item.apiId, "apiId"),
    refId: identifier(item.refId, "refId"),
    params
  };
}

function hash(value: CanonicalPayload): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export function fingerprintUpstreamPayload(payload: unknown): string {
  return hash(canonicalPayload(payload, "upstream payload"));
}

export function fingerprintAssetReqParam(reqParam: unknown): string {
  return hash(canonicalPayload(reqParam, "asset reqParam"));
}
