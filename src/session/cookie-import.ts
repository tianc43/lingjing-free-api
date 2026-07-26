import { Cookie, CookieJar, domainMatch, pathMatch } from "tough-cookie";
import type { SessionProvider, SessionSnapshot } from "./types.js";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_COOKIES = 200;
const SESSION_ORIGIN = new URL("https://lingjing.jdcloud.com/");
const ALLOWED_DOMAINS = new Set(["lingjing.jdcloud.com", ".jdcloud.com", ".jd.com", ".jdpay.com"]);

export interface CookieImportInput {
  format: "header" | "json";
  value: string;
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface StorageState {
  cookies: PlaywrightCookie[];
  origins: unknown[];
}

interface ParsedImport {
  cookies: PlaywrightCookie[];
  csrfToken: string;
  originPin: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCookieLimit(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("Cookie input is too large");
  }
}

function normalizeSameSite(value: unknown): PlaywrightCookie["sameSite"] {
  if (value === undefined) {
    return undefined;
  }
  if (value === "Strict" || value === "Lax" || value === "None") {
    return value;
  }
  throw new Error("Invalid browser cookie JSON");
}

function normalizeJsonCookie(value: unknown): PlaywrightCookie {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0 || typeof value.value !== "string" ||
    typeof value.domain !== "string" || typeof value.path !== "string" || !value.path.startsWith("/")) {
    throw new Error("Invalid browser cookie JSON");
  }
  const domain = value.domain.toLowerCase();
  if (!ALLOWED_DOMAINS.has(domain)) {
    throw new Error("Unsupported cookie domain");
  }
  if (value.expires !== undefined && (typeof value.expires !== "number" || !Number.isFinite(value.expires))) {
    throw new Error("Invalid browser cookie JSON");
  }
  if (value.httpOnly !== undefined && typeof value.httpOnly !== "boolean") {
    throw new Error("Invalid browser cookie JSON");
  }
  if (value.secure !== undefined && typeof value.secure !== "boolean") {
    throw new Error("Invalid browser cookie JSON");
  }
  const sameSite = normalizeSameSite(value.sameSite);
  return {
    name: value.name,
    value: value.value,
    domain,
    path: value.path,
    expires: typeof value.expires === "number" ? value.expires : -1,
    httpOnly: value.httpOnly === true,
    secure: value.secure === true,
    ...(sameSite === undefined ? {} : { sameSite })
  };
}

function parseHeaderCookies(value: string): PlaywrightCookie[] {
  if (value.trim().length === 0) {
    throw new Error("Invalid Cookie header");
  }
  const cookies = value.split(";").map((pair) => {
    const parsed = Cookie.parse(pair.trim());
    if (parsed === undefined || parsed.key.length === 0) {
      throw new Error("Invalid Cookie header");
    }
    return {
      name: parsed.key,
      value: parsed.value,
      domain: SESSION_ORIGIN.hostname,
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true
    };
  });
  return cookies;
}

function parseJsonCookies(value: string): PlaywrightCookie[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Invalid browser cookie JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid browser cookie JSON");
  }
  return parsed.map(normalizeJsonCookie);
}

function domainMatchesLingjing(cookie: PlaywrightCookie): boolean {
  return domainMatch(SESSION_ORIGIN.hostname, cookie.domain.replace(/^\./u, "")) === true;
}

function pathMatchesLingjing(cookie: PlaywrightCookie): boolean {
  return pathMatch(SESSION_ORIGIN.pathname, cookie.path);
}

function extractCredentials(cookies: PlaywrightCookie[]): ParsedImport {
  if (cookies.length > MAX_COOKIES) {
    throw new Error("Too many cookies");
  }
  const csrfCookies = cookies.filter((cookie) => cookie.name === "csrfToken");
  if (csrfCookies.length === 0) {
    throw new Error("Lingjing csrfToken cookie is required");
  }
  if (csrfCookies.length > 1) {
    throw new Error("Duplicate Lingjing csrfToken cookie");
  }
  const csrfCookie = csrfCookies[0];
  if (csrfCookie === undefined || !domainMatchesLingjing(csrfCookie) || !pathMatchesLingjing(csrfCookie) || csrfCookie.value.length === 0) {
    throw new Error("Lingjing csrfToken cookie is required");
  }
  const pins = cookies.filter((cookie) => cookie.name === "pin").map((cookie) => {
    try {
      return decodeURIComponent(cookie.value);
    } catch {
      throw new Error("Invalid Lingjing pin cookie");
    }
  });
  if (pins.length === 0 || pins[0] === undefined || pins[0].trim().length === 0) {
    throw new Error("Lingjing pin cookie is required");
  }
  if (pins.some((pin) => pin !== pins[0])) {
    throw new Error("Conflicting Lingjing pin cookies");
  }
  return { cookies, csrfToken: csrfCookie.value, originPin: pins[0] };
}

function cookieForJar(cookie: PlaywrightCookie): string {
  const domain = cookie.domain.replace(/^\./u, "");
  const attributes = [
    `${cookie.name}=${cookie.value}`,
    ...(cookie.domain.startsWith(".") ? [`Domain=${domain}`] : []),
    `Path=${cookie.path}`,
    ...(cookie.secure ? ["Secure"] : []),
    ...(cookie.httpOnly ? ["HttpOnly"] : []),
    ...(cookie.sameSite === undefined ? [] : [`SameSite=${cookie.sameSite}`]),
    ...(cookie.expires > 0 ? [`Expires=${new Date(cookie.expires * 1000).toUTCString()}`] : [])
  ];
  return attributes.join("; ");
}

function createJar(cookies: PlaywrightCookie[]): CookieJar {
  const jar = new CookieJar();
  for (const cookie of cookies) {
    const host = cookie.domain.replace(/^\./u, "");
    jar.setCookieSync(cookieForJar(cookie), `https://${host}${cookie.path}`);
  }
  return jar;
}

class CookieImportSessionProvider implements SessionProvider {
  readonly mode = "browser-state" as const;
  private jar: CookieJar;
  private csrfToken: string | null;

  constructor(cookies: PlaywrightCookie[], private readonly originPin: string, csrfToken: string) {
    this.jar = createJar(cookies);
    this.csrfToken = csrfToken;
  }

  async load(): Promise<SessionSnapshot> {
    return { mode: this.mode, jar: this.jar, csrfToken: this.csrfToken, sourceMtimeMs: 0 };
  }

  async loadProfile(): Promise<{ originPin: string }> {
    return { originPin: this.originPin };
  }

  async applySetCookies(url: URL, headers: string[]): Promise<void> {
    for (const header of headers) {
      const cookie = Cookie.parse(header);
      if (cookie !== undefined) {
        this.jar.setCookieSync(cookie, url.toString());
      }
    }
    const csrfCookie = (await this.jar.getCookies(SESSION_ORIGIN.toString())).find((cookie) => cookie.key === "csrfToken");
    this.csrfToken = csrfCookie?.value ?? null;
  }

  describe(): { mode: string; source: string; sourceMtimeMs: number | null; hasCsrf: boolean } {
    return { mode: this.mode, source: "cookie-import", sourceMtimeMs: null, hasCsrf: this.csrfToken !== null };
  }

  invalidate(): void {
    this.jar = new CookieJar();
    this.csrfToken = null;
  }
}

export function parseCookieImport(input: CookieImportInput): { storageState: StorageState; originPin: string; session: SessionProvider } {
  requireCookieLimit(input.value);
  const cookies = input.format === "header" ? parseHeaderCookies(input.value) : parseJsonCookies(input.value);
  const parsed = extractCredentials(cookies);
  const storageState = { cookies: parsed.cookies, origins: [] };
  return {
    storageState,
    originPin: parsed.originPin,
    session: new CookieImportSessionProvider(parsed.cookies, parsed.originPin, parsed.csrfToken)
  };
}
