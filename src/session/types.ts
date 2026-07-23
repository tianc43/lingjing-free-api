import type { CookieJar } from "tough-cookie";

export interface SessionSnapshot {
  mode: "browser-state" | "cookie-file";
  jar: CookieJar;
  csrfToken: string | null;
  sourceMtimeMs: number;
}

export interface SessionProvider {
  readonly mode: "browser-state" | "cookie-file";
  load(): Promise<SessionSnapshot>;
  loadProfile(): Promise<{ originPin: string }>;
  applySetCookies(url: URL, headers: string[]): Promise<void>;
  describe(): { mode: string; source: string; sourceMtimeMs: number | null; hasCsrf: boolean };
  invalidate(): void;
}

export type AtomicWriter = (targetPath: string, value: unknown) => Promise<void>;
