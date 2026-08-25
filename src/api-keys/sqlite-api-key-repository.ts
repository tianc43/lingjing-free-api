import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { SqliteStore } from "../persistence/sqlite-store.js";
import type {
  ApiKeyPrincipal,
  ApiKeyRecord,
  ApiKeyScope,
  CreatedApiKey
} from "./types.js";

interface ApiKeyRow {
  id: string;
  user_id: string;
  project_id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  scopes_json: string;
  enabled: number;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const SELECT_COLUMNS = `
  id, user_id, project_id, name, key_prefix, key_hash, scopes_json, enabled,
  expires_at, created_at, updated_at, last_used_at, revoked_at
`;

const API_KEY_SCOPES: ReadonlySet<string> = new Set([
  "models:read",
  "video:create",
  "video:read",
  "image:create",
  "image:read"
]);

function scopesFromJson(value: string): ApiKeyScope[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some(
    (scope) => typeof scope !== "string" || !API_KEY_SCOPES.has(scope)
  )) {
    throw new Error("API key has invalid scopes");
  }
  return [...new Set(parsed)] as ApiKeyScope[];
}

function apiKeyFromRow(row: ApiKeyRow): ApiKeyRecord {
  if (row.enabled !== 0 && row.enabled !== 1) {
    throw new Error(`API key ${row.id} has an invalid enabled value`);
  }
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: scopesFromJson(row.scopes_json),
    enabled: row.enabled === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at
  };
}

function assertName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("API key name must be a non-empty string");
  }
}

function assertBoolean(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new TypeError("API key enabled must be a boolean");
  }
}

function hashSecret(secret: string, salt: Buffer): string {
  return `scrypt$${salt.toString("base64url")}$${scryptSync(secret, salt, 32).toString("base64url")}`;
}

function matchesSecret(secret: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const saltValue = parts[1];
  const digestValue = parts[2];
  if (saltValue === undefined || digestValue === undefined) return false;
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(digestValue, "base64url");
    const actual = scryptSync(secret, salt, 32);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export class SqliteApiKeyRepository {
  constructor(private readonly store: SqliteStore) {}

  create(name: string, options: {
    userId?: string;
    projectId?: string;
    scopes?: readonly ApiKeyScope[];
    expiresAt?: number | null;
  } = {}): CreatedApiKey {
    assertName(name);
    const scopes = options.scopes ?? [
      "models:read",
      "video:create",
      "video:read",
      "image:create",
      "image:read"
    ];
    if (scopes.some((scope) => !API_KEY_SCOPES.has(scope))) {
      throw new TypeError("API key scopes are invalid");
    }
    return this.store.immediate((database) => {
      const userId = options.userId ?? "usr_legacy";
      const projectId = options.projectId ?? "prj_legacy";
      const active = database.prepare(`
        SELECT 1 AS active FROM projects p JOIN users u ON u.id = p.user_id
        WHERE p.id = ? AND p.user_id = ?
          AND p.status = 'active' AND u.status = 'active'
      `).get(projectId, userId);
      if (active === undefined) throw new Error("Active user project was not found");
      const secret = `ljk_${randomBytes(32).toString("base64url")}`;
      const keyPrefix = secret.slice(0, 12);
      const id = `key_${randomBytes(12).toString("hex")}`;
      const now = Date.now();
      database.prepare(`
        INSERT INTO api_keys (
          id, user_id, project_id, name, key_prefix, key_hash, scopes_json,
          enabled, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        id,
        userId,
        projectId,
        name,
        keyPrefix,
        hashSecret(secret, randomBytes(16)),
        JSON.stringify([...new Set(scopes)]),
        options.expiresAt ?? null,
        now,
        now
      );
      const row = this.findRow(database, id);
      if (row === undefined) throw new Error("Created API key could not be read");
      return { record: apiKeyFromRow(row), secret };
    });
  }

  list(): ApiKeyRecord[] {
    return this.store.read((database) => database.prepare(`
      SELECT ${SELECT_COLUMNS} FROM api_keys ORDER BY created_at ASC, id ASC
    `).all().map((row) => apiKeyFromRow(row as ApiKeyRow)));
  }

  setEnabled(id: string, enabled: boolean): ApiKeyRecord {
    assertBoolean(enabled);
    return this.store.immediate((database) => {
      const result = database.prepare(
        "UPDATE api_keys SET enabled = ?, updated_at = ? WHERE id = ?"
      ).run(enabled ? 1 : 0, Date.now(), id);
      if (result.changes !== 1) throw new Error(`API key ${id} was not found`);
      const row = this.findRow(database, id);
      if (row === undefined) throw new Error(`API key ${id} could not be read`);
      return apiKeyFromRow(row);
    });
  }

  revoke(id: string): void {
    this.store.immediate((database) => {
      const now = Date.now();
      const result = database.prepare(
        "UPDATE api_keys SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL"
      ).run(now, now, id);
      if (result.changes !== 1) throw new Error(`API key ${id} was not found or already revoked`);
    });
  }

  authenticate(token: string): ApiKeyPrincipal | null {
    const keyPrefix = token.slice(0, 12);
    return this.store.immediate((database) => {
      const row = database.prepare(`
        SELECT ${SELECT_COLUMNS} FROM api_keys WHERE key_prefix = ?
      `).get(keyPrefix) as ApiKeyRow | undefined;
      const now = Date.now();
      const identityActive = row === undefined ? undefined : database.prepare(`
        SELECT 1 AS active
        FROM projects p JOIN users u ON u.id = p.user_id
        WHERE p.id = ? AND p.user_id = ?
          AND p.status = 'active' AND u.status = 'active'
      `).get(row.project_id, row.user_id);
      if (
        row === undefined
        || identityActive === undefined
        || row.enabled !== 1
        || row.revoked_at !== null
        || (row.expires_at !== null && row.expires_at <= now)
      ) return null;
      if (!matchesSecret(token, row.key_hash)) return null;
      database.prepare(
        "UPDATE api_keys SET last_used_at = ?, updated_at = ? WHERE id = ?"
      ).run(now, now, row.id);
      return {
        userId: row.user_id,
        projectId: row.project_id,
        apiKeyId: row.id,
        scopes: scopesFromJson(row.scopes_json),
        legacy: false
      };
    });
  }

  verify(token: string): boolean {
    return this.authenticate(token) !== null;
  }

  private findRow(database: Database.Database, id: string): ApiKeyRow | undefined {
    return database.prepare(`
      SELECT ${SELECT_COLUMNS} FROM api_keys WHERE id = ?
    `).get(id) as ApiKeyRow | undefined;
  }
}
