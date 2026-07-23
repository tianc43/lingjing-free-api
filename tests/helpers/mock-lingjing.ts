import { CookieJar } from "tough-cookie";
import { MockAgent } from "undici";
import type { SessionProvider, SessionSnapshot } from "../../src/session/types.js";

type HeaderValue = string | string[] | undefined;

function asHeaders(headers: Record<string, HeaderValue>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value ?? ""]));
}

export class MockSessionProvider implements SessionProvider {
  readonly mode: "browser-state" | "cookie-file";
  private readonly jar = new CookieJar();
  private csrfToken: string | null = null;

  constructor(mode: "browser-state" | "cookie-file", private readonly origin: URL) {
    this.mode = mode;
  }

  async seed(): Promise<void> {
    await this.jar.setCookie("csrfToken=fixture-csrf; Path=/", this.origin.toString());
    await this.jar.setCookie("session=fixture-session; Path=/", this.origin.toString());
    this.csrfToken = "fixture-csrf";
  }

  load(): Promise<SessionSnapshot> {
    return Promise.resolve({ mode: this.mode, jar: this.jar, csrfToken: this.csrfToken, sourceMtimeMs: 0 });
  }

  loadProfile(): Promise<{ originPin: string }> {
    return Promise.resolve({ originPin: this.origin.origin });
  }

  async applySetCookies(url: URL, headers: string[]): Promise<void> {
    for (const header of headers) await this.jar.setCookie(header, url.toString());
    this.csrfToken = (await this.jar.getCookies(this.origin.toString())).find((cookie) => cookie.key === "csrfToken")?.value ?? null;
  }

  describe(): { mode: string; source: string; sourceMtimeMs: number | null; hasCsrf: boolean } {
    return { mode: this.mode, source: "fixture", sourceMtimeMs: 0, hasCsrf: this.csrfToken !== null };
  }

  invalidate(): void {}
}

export class MockLingjing {
  readonly dispatcher = new MockAgent();
  readonly baseUrl = new URL("https://lingjing.test");
  readonly objectUrl = new URL("https://object-storage.example");
  lastHeaders: Record<string, string> = {};
  lastQuery: Record<string, string> = {};
  objectStorageHeaders: Record<string, string> = {};
  private readonly counts = new Map<string, number>();
  private readFailures = 0;
  private setCookie: string | null = null;
  private disconnectNextSubmit = false;

  constructor() {
    this.dispatcher.disableNetConnect();
    const api = this.dispatcher.get(this.baseUrl.origin);
    api.intercept({ path: /./u, method: "GET" }).reply((options) => this.reply(options)).persist();
    api.intercept({ path: /./u, method: "POST" }).reply((options) => this.reply(options)).persist();
    this.dispatcher.get(this.objectUrl.origin).intercept({ path: "/signed-part", method: "PUT" }).reply((options) => {
      this.objectStorageHeaders = asHeaders(options.headers as Record<string, HeaderValue>);
      return { statusCode: 200, data: "" };
    }).persist();
  }

  createSession(mode: "browser-state" | "cookie-file"): MockSessionProvider {
    return new MockSessionProvider(mode, this.baseUrl);
  }

  failReads(count: number): void { this.readFailures = count; }
  disconnectSubmit(): void { this.disconnectNextSubmit = true; }
  respondWithSetCookie(value: string): void { this.setCookie = value; }
  count(path: string): number { return this.counts.get(path) ?? 0; }

  private reply(options: { path: string; method: string; headers?: unknown }): { statusCode: number; data: string; responseOptions?: { headers: Record<string, string> } } {
    const url = new URL(options.path, this.baseUrl);
    const count = (this.counts.get(url.pathname) ?? 0) + 1;
    this.counts.set(url.pathname, count);
    this.lastHeaders = asHeaders(options.headers as Record<string, HeaderValue>);
    this.lastQuery = Object.fromEntries(url.searchParams.entries());
    if (options.method === "GET" && this.readFailures > 0) {
      this.readFailures -= 1;
      return { statusCode: 503, data: JSON.stringify({ error: { code: 503, message: "upstream" }, result: null }) };
    }
    if (options.method === "POST" && this.disconnectNextSubmit) {
      this.disconnectNextSubmit = false;
      throw new Error("socket reset");
    }
    const responseOptions = this.setCookie === null ? undefined : { headers: { "set-cookie": this.setCookie } };
    this.setCookie = null;
    return { statusCode: 200, data: JSON.stringify({ requestId: "fixture", error: null, result: { ok: true } }), ...(responseOptions === undefined ? {} : { responseOptions }) };
  }
}
