import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Cookie, CookieJar } from "tough-cookie";
import type { SessionProvider, SessionSnapshot } from "./types.js";

const SESSION_ORIGIN = "https://lingjing.jdcloud.com/";

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

export class CookieFileProvider implements SessionProvider {
  readonly mode = "cookie-file" as const;
  private readonly sourcePath: string;
  private readonly profilePath: string;
  private readonly mutex = new AsyncMutex();
  private jar: CookieJar | null = null;
  private sourceMtimeMs: number | null = null;
  private csrfToken: string | null = null;
  private readonly origin: URL;

  constructor(sourcePath: string | URL, profilePath: string | URL, origin: URL = new URL(SESSION_ORIGIN)) {
    this.sourcePath = asPath(sourcePath);
    this.profilePath = asPath(profilePath);
    this.origin = origin;
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
        const cookie = Cookie.parse(header);
        if (cookie !== undefined) {
          await snapshot.jar.setCookie(cookie, url.toString());
        }
      }
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
  }

  private async updateCsrf(jar: CookieJar): Promise<void> {
    const csrfCookie = (await jar.getCookies(this.origin.toString())).find((cookie) => cookie.key === "csrfToken");
    this.csrfToken = csrfCookie?.value ?? null;
  }

  private async loadUnlocked(): Promise<SessionSnapshot> {
    const currentMtimeMs = (await stat(this.sourcePath)).mtimeMs;
    if (this.jar === null || this.sourceMtimeMs !== currentMtimeMs) {
      const header = (await readFile(this.sourcePath, "utf8")).trim();
      const jar = new CookieJar();
      for (const pair of header.split(";")) {
        const cookie = Cookie.parse(pair.trim());
        if (cookie !== undefined) {
          await jar.setCookie(cookie, this.origin.toString());
        }
      }
      this.jar = jar;
      this.sourceMtimeMs = currentMtimeMs;
      await this.updateCsrf(jar);
    }
    return { mode: this.mode, jar: this.jar, csrfToken: this.csrfToken, sourceMtimeMs: this.sourceMtimeMs };
  }
}
