import { CookieJar } from "tough-cookie";
import { errors as undiciErrors, MockAgent, type Dispatcher } from "undici";
import type { SessionProvider, SessionSnapshot } from "../../src/session/types.js";

type HeaderValue = string | string[] | undefined;

function asHeaders(headers: Record<string, HeaderValue>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value ?? ""]));
}

export class MockSessionProvider implements SessionProvider {
  readonly mode: "browser-state" | "cookie-file";
  private readonly jar = new CookieJar();
  private csrfToken: string | null = null;
  private refreshToken: string | null = null;
  private profileOriginPin: string;
  loadCount = 0;
  invalidateCount = 0;
  refreshCount = 0;
  applySetCookiesCount = 0;

  constructor(mode: "browser-state" | "cookie-file", private readonly origin: URL) {
    this.mode = mode;
    this.profileOriginPin = origin.origin;
  }

  async seed(): Promise<void> {
    await this.jar.setCookie("csrfToken=fixture-csrf; Path=/", this.origin.toString());
    await this.jar.setCookie("session=fixture-session; Path=/", this.origin.toString());
    this.csrfToken = "fixture-csrf";
  }

  async load(): Promise<SessionSnapshot> {
    this.loadCount += 1;
    if (this.refreshToken !== null) {
      const token = this.refreshToken;
      this.refreshToken = null;
      await this.jar.setCookie(`csrfToken=${token}; Path=/`, this.origin.toString());
      await this.jar.setCookie("session=refreshed-session; Path=/", this.origin.toString());
      this.csrfToken = token;
      this.refreshCount += 1;
    }
    return { mode: this.mode, jar: this.jar, csrfToken: this.csrfToken, sourceMtimeMs: 0 };
  }

  loadProfile(): Promise<{ originPin: string }> {
    return Promise.resolve({ originPin: this.profileOriginPin });
  }

  setProfileOriginPin(originPin: string): void {
    this.profileOriginPin = originPin;
  }

  async applySetCookies(url: URL, headers: string[]): Promise<void> {
    this.applySetCookiesCount += 1;
    for (const header of headers) await this.jar.setCookie(header, url.toString());
    this.csrfToken = (await this.jar.getCookies(this.origin.toString())).find((cookie) => cookie.key === "csrfToken")?.value ?? null;
  }

  refreshOnInvalidate(csrfToken: string): void {
    this.refreshToken = csrfToken;
  }

  async cookieString(): Promise<string> {
    return this.jar.getCookieString(this.origin.toString());
  }

  describe(): { mode: string; source: string; sourceMtimeMs: number | null; hasCsrf: boolean } {
    return { mode: this.mode, source: "fixture", sourceMtimeMs: 0, hasCsrf: this.csrfToken !== null };
  }

  invalidate(): void {
    this.invalidateCount += 1;
  }
}

export class MockLingjing {
  readonly dispatcher = new MockAgent();
  readonly recordingDispatcher: Dispatcher;
  readonly timeoutDispatcher: Dispatcher;
  readonly baseUrl = new URL("https://lingjing.test");
  readonly objectUrl = new URL("https://object-storage.example");
  lastHeaders: Record<string, string> = {};
  lastQuery: Record<string, string> = {};
  objectStorageHeaders: Record<string, string> = {};
  lastMaxRedirections: number | undefined;
  lastSubmitHeadersTimeout: number | null | undefined;
  private readonly counts = new Map<string, number>();
  private readonly requestHeaders = new Map<string, Record<string, string>[]>();
  private readonly requestMethods = new Map<string, string[]>();
  private readonly requestTargets = new Map<string, string[]>();
  private readonly resultsByPath = new Map<string, unknown>();
  private readFailures = 0;
  private csrfReadFailures = 0;
  private setCookie: string | null = null;
  private disconnectNextSubmit = false;
  private malformedNextResponse = false;
  private csrfNextResponse = false;
  private nextResult: unknown = { ok: true };
  private signedStatusCode = 200;
  private signedHeaders: Record<string, string | string[]> = {};

  constructor() {
    this.dispatcher.disableNetConnect();
    this.recordingDispatcher = this.dispatcher.compose((dispatch) => (options, handler) => {
      this.lastMaxRedirections = (options as Dispatcher.RequestOptions & { maxRedirections?: number }).maxRedirections;
      return dispatch(options, handler);
    });
    this.timeoutDispatcher = this.dispatcher.compose((dispatch) => (options, handler) => {
      const url = new URL(options.path, this.baseUrl);
      if (options.method !== "POST" || url.pathname !== "/submit-timeout") return dispatch(options, handler);
      this.counts.set(url.pathname, (this.counts.get(url.pathname) ?? 0) + 1);
      this.lastHeaders = asHeaders(options.headers as Record<string, HeaderValue>);
      this.requestHeaders.set(url.pathname, [...(this.requestHeaders.get(url.pathname) ?? []), this.lastHeaders]);
      this.lastSubmitHeadersTimeout = options.headersTimeout;
      let aborted = false;
      let paused = false;
      let reason: Error | null = null;
      const controller: Dispatcher.DispatchController = {
        get aborted() { return aborted; },
        get paused() { return paused; },
        get reason() { return reason; },
        abort(error) { aborted = true; reason = error; },
        pause() { paused = true; },
        resume() { paused = false; }
      };
      handler.onRequestStart?.(controller, null);
      if (handler.onResponseError === undefined) throw new Error("Timeout dispatcher requires an error handler");
      setTimeout(() => {
        handler.onResponseError?.(controller, new undiciErrors.HeadersTimeoutError());
      }, options.headersTimeout ?? 0);
      return true;
    });
    const api = this.dispatcher.get(this.baseUrl.origin);
    api.intercept({ path: /./u, method: "GET" }).reply((options) => this.reply(options)).persist();
    api.intercept({ path: /./u, method: "POST" }).reply((options) => this.reply(options)).persist();
    const objectStorage = this.dispatcher.get(this.objectUrl.origin);
    objectStorage.intercept({ path: "/timeout-part", method: "PUT" }).reply((options) => {
      const path = new URL(options.path, this.objectUrl).pathname;
      this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
      this.objectStorageHeaders = asHeaders(options.headers as Record<string, HeaderValue>);
      return { statusCode: 200, data: "" };
    }).delay(50);
    objectStorage.intercept({ path: /./u, method: "PUT" }).reply((options) => {
      const path = new URL(options.path, this.objectUrl).pathname;
      this.counts.set(path, (this.counts.get(path) ?? 0) + 1);
      this.objectStorageHeaders = asHeaders(options.headers as Record<string, HeaderValue>);
      if (path === "/redirect-part") {
        return {
          statusCode: 302,
          data: "",
          responseOptions: { headers: { location: `${this.objectUrl.origin}/redirect-target` } }
        };
      }
      return {
        statusCode: this.signedStatusCode,
        data: "",
        responseOptions: { headers: this.signedHeaders }
      };
    }).persist();
  }

  createSession(mode: "browser-state" | "cookie-file"): MockSessionProvider {
    return new MockSessionProvider(mode, this.baseUrl);
  }

  failReads(count: number): void { this.readFailures = count; }
  failCsrfReads(count: number): void { this.csrfReadFailures = count; }
  disconnectSubmit(): void { this.disconnectNextSubmit = true; }
  respondWithMalformedJson(): void { this.malformedNextResponse = true; }
  respondWithCsrfError(): void { this.csrfNextResponse = true; }
  respondWithSetCookie(value: string): void { this.setCookie = value; }
  respondWithResult(value: unknown): void { this.nextResult = value; }
  respondToPath(path: string, value: unknown): void {
    this.resultsByPath.set(path, value);
  }
  respondToSignedUpload(statusCode: number, headers: Record<string, string | string[]> = {}): void {
    this.signedStatusCode = statusCode;
    this.signedHeaders = headers;
  }
  count(path: string): number { return this.counts.get(path) ?? 0; }
  headersFor(path: string): Record<string, string>[] { return this.requestHeaders.get(path) ?? []; }
  methodsFor(path: string): string[] { return this.requestMethods.get(path) ?? []; }
  targetsFor(path: string): string[] { return this.requestTargets.get(path) ?? []; }

  private reply(options: { path: string; method: string; headers?: unknown }): { statusCode: number; data: string; responseOptions?: { headers: Record<string, string | string[]> } } {
    const url = new URL(options.path, this.baseUrl);
    const count = (this.counts.get(url.pathname) ?? 0) + 1;
    this.counts.set(url.pathname, count);
    this.requestMethods.set(
      url.pathname,
      [...(this.requestMethods.get(url.pathname) ?? []), options.method]
    );
    this.requestTargets.set(
      url.pathname,
      [...(this.requestTargets.get(url.pathname) ?? []), options.path]
    );
    this.lastHeaders = asHeaders(options.headers as Record<string, HeaderValue>);
    this.requestHeaders.set(url.pathname, [...(this.requestHeaders.get(url.pathname) ?? []), this.lastHeaders]);
    this.lastQuery = Object.fromEntries(url.searchParams.entries());
    if (options.method === "GET" && this.readFailures > 0) {
      this.readFailures -= 1;
      return { statusCode: 503, data: JSON.stringify({ error: { code: 503, message: "upstream" }, result: null }) };
    }
    if (options.method === "GET" && this.csrfReadFailures > 0) {
      this.csrfReadFailures -= 1;
      return { statusCode: 400, data: JSON.stringify({ error: { code: "CSRF", message: "expired" }, result: null }) };
    }
    if (options.method === "POST" && this.disconnectNextSubmit) {
      this.disconnectNextSubmit = false;
      throw new Error("socket reset");
    }
    const responseOptions = this.setCookie === null ? undefined : { headers: { "set-cookie": this.setCookie } };
    this.setCookie = null;
    if (this.malformedNextResponse) {
      this.malformedNextResponse = false;
      return { statusCode: 200, data: "{malformed", ...(responseOptions === undefined ? {} : { responseOptions }) };
    }
    if (this.csrfNextResponse) {
      this.csrfNextResponse = false;
      return {
        statusCode: 400,
        data: JSON.stringify({ error: { code: "CSRF", message: "expired" }, result: null }),
        ...(responseOptions === undefined ? {} : { responseOptions })
      };
    }
    const hasPathResult = this.resultsByPath.has(url.pathname);
    const result = hasPathResult
      ? this.resultsByPath.get(url.pathname)
      : this.nextResult;
    if (!hasPathResult) this.nextResult = { ok: true };
    return { statusCode: 200, data: JSON.stringify({ requestId: "fixture", error: null, result }), ...(responseOptions === undefined ? {} : { responseOptions }) };
  }
}
