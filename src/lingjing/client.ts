import { request, type Dispatcher } from "undici";
import { AppError } from "../errors.js";
import { type Envelope, unwrapEnvelope } from "./envelope.js";
import { SubmitAmbiguousError, TransportUncertainError, isTransportUncertain, mapUpstreamError } from "./error-map.js";
import type { LingjingClientOptions, LingjingTransport, ReadRequest, SignedUploadResponse, UploadRequest } from "./types.js";

const DEFAULT_BASE_URL = new URL("https://lingjing.jdcloud.com");
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_READ_RETRIES = 2;
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "x-csrf-token", "origin", "referer"]);

function setCookieValues(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function headerRecord(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  return Object.fromEntries(Object.entries(headers));
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class LingjingClient implements LingjingTransport {
  private readonly baseUrl: URL;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: LingjingClientOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.dispatcher = options.dispatcher;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async read<T>(path: string, init: ReadRequest = {}): Promise<T> {
    let csrfRefreshed = false;
    for (let attempt = 0; attempt <= MAX_READ_RETRIES; attempt += 1) {
      try {
        return await this.perform<T>(path, {
          method: init.method ?? "GET",
          ...(init.body === undefined ? {} : { body: init.body }),
          ...(init.query === undefined ? {} : { query: init.query }),
          ...(init.timeoutMs === undefined ? {} : { timeoutMs: init.timeoutMs }),
          timestamp: true
        });
      } catch (cause) {
        const csrfFailure = cause instanceof AppError && cause.code === "lingjing_csrf_expired";
        if (csrfFailure && !csrfRefreshed) {
          csrfRefreshed = true;
          this.options.session.invalidate();
          await this.options.session.load();
        }
        if (attempt === MAX_READ_RETRIES || !this.isRetryableReadFailure(cause)) throw cause;
        await this.sleep(Math.floor(Math.random() * 1501));
      }
    }
    throw new TransportUncertainError();
  }

  async submitOnce<T>(path: string, body: unknown): Promise<T> {
    let requestWritten = false;
    try {
      requestWritten = true;
      return await this.perform<T>(path, { method: "POST", body });
    } catch (cause) {
      if (requestWritten && isTransportUncertain(cause)) throw new SubmitAmbiguousError();
      throw cause;
    }
  }

  async uploadApi<T>(path: string, init: UploadRequest): Promise<T> {
    return this.perform<T>(path, { method: init.method, body: init.body, ...(init.headers === undefined ? {} : { headers: init.headers }), timeoutMs: init.timeoutMs });
  }

  async putSigned(url: URL, init: UploadRequest): Promise<SignedUploadResponse> {
    if (url.protocol !== "https:") throw new Error("Signed upload URL must use HTTPS");
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
    const response = await request(url, {
      method: init.method,
      headers,
      body: init.body as never,
      ...(this.dispatcher === undefined ? {} : { dispatcher: this.dispatcher }),
      headersTimeout: init.timeoutMs,
      bodyTimeout: init.timeoutMs
    });
    await response.body.dump();
    return { statusCode: response.statusCode, headers: headerRecord(response.headers) };
  }

  private async perform<T>(path: string, init: { method: "GET" | "POST" | "PUT"; body?: unknown; query?: ReadRequest["query"]; headers?: Record<string, string>; timeoutMs?: number; timestamp?: boolean }): Promise<T> {
    const url = this.trustedUrl(path, init.query, init.timestamp);
    const snapshot = await this.options.session.load();
    const cookie = await snapshot.jar.getCookieString(url.toString());
    const headers: Record<string, string> = { Accept: "application/json", ...(init.headers ?? {}) };
    if (cookie.length > 0) headers.Cookie = cookie;
    if (snapshot.csrfToken !== null) headers["x-csrf-token"] = snapshot.csrfToken;
    const jsonBody = init.body !== undefined && !(typeof init.body === "string" || Buffer.isBuffer(init.body) || init.body instanceof Uint8Array || init.body instanceof FormData);
    if (jsonBody) headers["content-type"] ??= "application/json";
    const payload = jsonBody ? JSON.stringify(init.body) : init.body;
    let response;
    try {
      response = await request(url, { method: init.method, headers, ...(payload === undefined ? {} : { body: payload as never }), ...(this.dispatcher === undefined ? {} : { dispatcher: this.dispatcher }), headersTimeout: init.timeoutMs ?? DEFAULT_TIMEOUT_MS, bodyTimeout: init.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    } catch {
      throw new TransportUncertainError();
    }
    await this.options.session.applySetCookies(url, setCookieValues(response.headers["set-cookie"]));
    let value: unknown;
    try {
      value = JSON.parse(await response.body.text()) as unknown;
    } catch {
      throw new TransportUncertainError();
    }
    if (response.statusCode >= 500 && (typeof value !== "object" || value === null)) throw mapUpstreamError(undefined, response.statusCode);
    return unwrapEnvelope<T>(value as Envelope<T>, response.statusCode);
  }

  private trustedUrl(path: string, query: ReadRequest["query"], timestamp: boolean | undefined): URL {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Lingjing paths must be origin-relative");
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) throw new Error("Lingjing paths must resolve to the configured origin");
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    if (timestamp) url.searchParams.set("_t", String(Date.now()));
    return url;
  }

  private isRetryableReadFailure(cause: unknown): boolean {
    if (cause instanceof TransportUncertainError) return true;
    return cause instanceof AppError && (cause.code === "lingjing_upstream_error" || cause.code === "lingjing_csrf_expired" || cause.code === "lingjing_rate_limited");
  }
}
