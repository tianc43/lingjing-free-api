import type { LingjingAsset } from "./assets.js";
import type { JobOutput, JobResult } from "./types.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function absoluteHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:")
      && url.username === ""
      && url.password === ""
    )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function urlSegments(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  const segments = value.split(",").map((item) => item.trim());
  const urls = segments.map((item) => absoluteHttpUrl(item));
  return urls.every((item): item is string => item !== null) ? urls : [];
}

function preferredUrls(value: unknown): string[] {
  const item = record(value);
  if (item === null) return [];
  for (const key of [
    "url",
    "videoUrl",
    "imageUrl",
    "waterUrl",
    "watermarkUrl"
  ]) {
    const urls = urlSegments(item[key]);
    if (urls.length > 0) return urls;
  }
  return [];
}

export function normalizeOutputUrl(value: unknown): string | null {
  return preferredUrls(value)[0] ?? null;
}

function outputFor(
  value: unknown,
  url: string,
  fallback: Partial<LingjingAsset>
): JobOutput {
  const item = record(value) ?? {};
  const poster = urlSegments(item.frameUrl ?? item.posterUrl)[0]
    ?? urlSegments(fallback.frameUrl)[0]
    ?? null;
  return {
    url,
    posterUrl: poster,
    width: finiteNumber(item.width) ?? finiteNumber(fallback.width),
    height: finiteNumber(item.height) ?? finiteNumber(fallback.height),
    duration: finiteNumber(item.duration) ?? finiteNumber(fallback.duration),
    format: null
  };
}

function taskResultRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  const item = record(value);
  if (item === null) return [];
  for (const key of ["results", "list", "items"]) {
    if (Array.isArray(item[key])) return item[key];
  }
  return [];
}

export function normalizeJobResult(
  asset: Partial<LingjingAsset>
): JobResult | null {
  const outputs: JobOutput[] = [];
  for (const row of taskResultRows(asset.taskResults)) {
    for (const url of preferredUrls(row)) {
      outputs.push(outputFor(row, url, asset));
    }
  }
  if (outputs.length === 0) {
    for (const url of preferredUrls(asset)) {
      outputs.push(outputFor(asset, url, asset));
    }
  }
  return outputs.length === 0 ? null : { outputs };
}
