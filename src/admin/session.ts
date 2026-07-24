import {
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1_000;

export interface AdminSession {
  id: string;
  readonly csrfToken: string;
  expiresAt: number;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretEquals(
  expectedDigest: Buffer,
  candidate: string | undefined
): boolean {
  return timingSafeEqual(expectedDigest, digest(candidate ?? ""));
}

function createSession(expiresAt: number): AdminSession {
  const session = { expiresAt } as AdminSession;
  Object.defineProperties(session, {
    id: {
      enumerable: false,
      value: randomBytes(32).toString("base64url")
    },
    csrfToken: {
      enumerable: false,
      value: randomBytes(32).toString("base64url")
    }
  });
  return session;
}

export class AdminSessionStore {
  readonly #passwordDigest: Buffer;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #sessions = new Map<string, AdminSession>();

  constructor(options: {
    password: string;
    ttlMs?: number;
    now?: () => number;
  }) {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new RangeError("Admin session TTL must be positive");
    }
    this.#passwordDigest = digest(options.password);
    this.#ttlMs = ttlMs;
    this.#now = options.now ?? Date.now;
  }

  login(password: string): AdminSession | null {
    this.#pruneExpired();
    if (!secretEquals(this.#passwordDigest, password)) return null;
    const session = createSession(this.#now() + this.#ttlMs);
    this.#sessions.set(session.id, session);
    return session;
  }

  authenticate(sessionId: string | undefined): AdminSession | null {
    this.#pruneExpired();
    if (sessionId === undefined) return null;
    return this.#sessions.get(sessionId) ?? null;
  }

  logout(sessionId: string | undefined): void {
    if (sessionId !== undefined) this.#sessions.delete(sessionId);
  }

  assertCsrf(session: AdminSession, token: string | undefined): void {
    if (!secretEquals(digest(session.csrfToken), token)) {
      throw new Error("Invalid administrator CSRF token");
    }
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
  }
}
