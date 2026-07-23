import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Cookie, CookieJar } from "tough-cookie";
import { atomicWritePrivateJson } from "./atomic-write.js";
import type { AtomicWriter, SessionProvider, SessionSnapshot } from "./types.js";

const SESSION_ORIGIN = "https://lingjing.jdcloud.com/";

interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

interface StorageState {
  cookies: PlaywrightCookie[];
  origins: unknown[];
}

class AsyncMutex {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function asPath(path: string | URL): string {
  return path instanceof URL ? fileURLToPath(path) : path;
}

function storageStateFromJson(value: unknown): StorageState {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { cookies?: unknown }).cookies)) {
    throw new Error("Invalid Playwright storage-state file");
  }
  return value as StorageState;
}

function cookieToPlaywright(cookie: Cookie): PlaywrightCookie {
  const expires = cookie.expires instanceof Date && cookie.expires.getTime() > 0
    ? Math.floor(cookie.expires.getTime() / 1000)
    : -1;
  return {
    name: cookie.key,
    value: cookie.value,
    domain: cookie.domain ?? "lingjing.jdcloud.com",
    path: cookie.path ?? "/",
    expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite === "strict" ? "Strict" : cookie.sameSite === "lax" ? "Lax" : "None"
  };
}

export class StorageStateProvider implements SessionProvider {
  readonly mode = "browser-state" as const;
  private readonly sourcePath: string;
  private readonly profilePath: string;
  private readonly mutex = new AsyncMutex();
  private jar: CookieJar | null = null;
  private sourceMtimeMs: number | null = null;
  private csrfToken: string | null = null;
  private readonly changedCookies = new Set<string>();

  constructor(sourcePath: string | URL, profilePath: string | URL, private readonly atomicWriter: AtomicWriter = atomicWritePrivateJson) {
    this.sourcePath = asPath(sourcePath);
    this.profilePath = asPath(profilePath);
  }

  async load(): Promise<SessionSnapshot> {
    return this.mutex.run(async () => this.loadUnlocked());
  }

  async loadProfile(): Promise<{ originPin: string }> {
    const value: unknown = JSON.parse(await readFile(this.profilePath, "utf8"));
    const originPin = typeof value === "object" && value !== null ? (value as { originPin?: unknown }).originPin : undefined;
    if (typeof originPin !== "string" || originPin.trim().length === 0) {
      throw new Error("Invalid Lingjing session profile");
    }
    return { originPin };
  }

  async applySetCookies(url: URL, headers: string[]): Promise<void> {
    await this.mutex.run(async () => {
      const snapshot = await this.loadUnlocked();
      for (const header of headers) {
        const parsed = Cookie.parse(header);
        if (parsed === undefined) {
          continue;
        }
        const stored = await snapshot.jar.setCookie(parsed, url.toString());
        if (stored !== undefined) {
          this.changedCookies.add(`${stored.key}\u0000${stored.domain ?? ""}\u0000${stored.path ?? "/"}`);
        }
      }
      const state = storageStateFromJson(JSON.parse(await readFile(this.sourcePath, "utf8")) as unknown);
      const jarCookies = await snapshot.jar.getCookies(SESSION_ORIGIN);
      const byKey = new Map(jarCookies.map((cookie) => [`${cookie.key}\u0000${cookie.domain ?? ""}\u0000${cookie.path ?? "/"}`, cookie]));
      const written = new Set<string>();
      const cookies = state.cookies.map((cookie) => {
        const key = `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
        const jarCookie = byKey.get(key);
        if (jarCookie !== undefined && this.changedCookies.has(key)) {
          written.add(key);
          return cookieToPlaywright(jarCookie);
        }
        return cookie;
      });
      for (const key of this.changedCookies) {
        if (!written.has(key)) {
          const jarCookie = byKey.get(key);
          if (jarCookie !== undefined) {
            cookies.push(cookieToPlaywright(jarCookie));
          }
        }
      }
      await this.atomicWriter(this.sourcePath, { ...state, cookies });
      this.changedCookies.clear();
      this.sourceMtimeMs = (await stat(this.sourcePath)).mtimeMs;
      await this.updateCsrf(snapshot.jar);
    });
  }

  describe(): { mode: string; source: string; sourceMtimeMs: number | null; hasCsrf: boolean } {
    return { mode: this.mode, source: this.sourcePath.split(/[\\/]/u).at(-1) ?? this.sourcePath, sourceMtimeMs: this.sourceMtimeMs, hasCsrf: this.csrfToken !== null };
  }

  invalidate(): void {
    this.jar = null;
    this.sourceMtimeMs = null;
    this.csrfToken = null;
    this.changedCookies.clear();
  }

  private async loadUnlocked(): Promise<SessionSnapshot> {
    const currentMtimeMs = (await stat(this.sourcePath)).mtimeMs;
    if (this.jar === null || this.sourceMtimeMs !== currentMtimeMs) {
      const state = storageStateFromJson(JSON.parse(await readFile(this.sourcePath, "utf8")) as unknown);
      const jar = new CookieJar();
      for (const cookie of state.cookies) {
        const expiry = cookie.expires > 0 ? `; Expires=${new Date(cookie.expires * 1000).toUTCString()}` : "";
        const attributes = `${cookie.name}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${cookie.secure ? "Secure; " : ""}${cookie.httpOnly ? "HttpOnly; " : ""}SameSite=${cookie.sameSite}${expiry}`;
        await jar.setCookie(attributes, SESSION_ORIGIN);
      }
      this.jar = jar;
      this.sourceMtimeMs = currentMtimeMs;
      await this.updateCsrf(jar);
    }
    return { mode: this.mode, jar: this.jar, csrfToken: this.csrfToken, sourceMtimeMs: this.sourceMtimeMs };
  }

  private async updateCsrf(jar: CookieJar): Promise<void> {
    const csrfCookie = (await jar.getCookies(SESSION_ORIGIN)).find((cookie) => cookie.key === "csrfToken");
    this.csrfToken = csrfCookie?.value ?? null;
  }
}
