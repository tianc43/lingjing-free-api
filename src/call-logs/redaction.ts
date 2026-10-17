import { Readable } from "node:stream";

export const MAX_BODY_CHARS = 32_768;
const SECRET_KEY = /authorization|cookie|csrf|password|passwd|secret|token|signature|credential|api[-_]?key|session|^sign$|access[-_]?key|^pin$|origin[-_]?pin/iu;

function safeUrl(value: string): string {
  return value.replace(/https?:\/\/[^\s"<>]+/giu, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      // All URL query values may carry temporary access credentials.
      for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[REDACTED]");
      url.hash = "";
      return url.toString();
    } catch { return "[INVALID URL]"; }
  });
}

export function sanitize(value: unknown, limit = MAX_BODY_CHARS): unknown {
  const seen = new WeakSet();
  let budget = limit * 2;
  const walk = (item: unknown, depth: number): unknown => {
    if (budget <= 0 || depth > 12) return "[CONTENT LIMIT]";
    if (typeof item === "string") {
      budget -= Math.min(item.length, limit);
      if (/^data:[^,]*;base64,/iu.test(item)) return "[BASE64 OMITTED]";
      let text = item;
      if (/^\s*[{[]/u.test(text)) {
        try { return walk(JSON.parse(text) as unknown, depth + 1); } catch { /* ordinary text */ }
      }
      text = safeUrl(text).replace(/\bBearer\s+[^\s,;"}]+/giu, "Bearer [REDACTED]");
      text = text.replace(/\b(cookie|set-cookie|csrf(?:token)?|pin|password|api[-_]?key|token|signature)\s*[:=]\s*[^\s,;"}]+/giu, "$1=[REDACTED]");
      // Opaque binary strings are never useful as call metadata.
      text = text.replace(/[A-Za-z0-9+/]{256,}={0,2}/gu, "[BASE64 OMITTED]");
      return text.length > limit ? { __truncated: true, preview: text.slice(0, limit), original_chars: text.length } : text;
    }
    if (item === undefined || item === null) return null;
    if (typeof item === "number" || typeof item === "boolean") return item;
    if (Buffer.isBuffer(item) || item instanceof Uint8Array) return { __omitted: "binary", bytes: item.byteLength };
    if (item instanceof Readable || item instanceof FormData || (typeof item === "object" && "pipe" in item)) return "[STREAM/BINARY OMITTED]";
    if (typeof item !== "object") return typeof item === "bigint" ? item.toString() : "[UNSUPPORTED VALUE]";
    if (seen.has(item)) return "[CIRCULAR]";
    seen.add(item);
    if (Array.isArray(item)) return item.slice(0, 200).map((entry) => walk(entry, depth + 1));
    return Object.fromEntries(Object.entries(item).slice(0, 200).map(([key, entry]) => {
      budget -= key.length;
      return [key, SECRET_KEY.test(key) ? "[REDACTED]" : walk(entry, depth + 1)];
    }));
  };
  const result = walk(value, 0);
  const serialized = JSON.stringify(result);
  return serialized.length > limit
    ? { __truncated: true, preview: serialized.slice(0, limit), original_chars: serialized.length }
    : result;
}

export function sanitizedPath(path: string): string {
  const url = new URL(path, "http://local");
  return path.startsWith("http") ? `${url.origin}${url.pathname}` : url.pathname;
}
