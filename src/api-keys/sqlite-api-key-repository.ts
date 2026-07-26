import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { SqliteStore } from "../persistence/sqlite-store.js";
import type { ApiKeyRecord, CreatedApiKey } from "./types.js";

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const SELECT_COLUMNS = `
  id, name, key_prefix, key_hash, enabled, created_at, updated_at,
  last_used_at, revoked_at
`;

function apiKeyFromRow(row: ApiKeyRow): ApiKeyRecord {
  if (row.enabled !== 0 && row.enabled !== 1) {
    throw new Error(`API key ${row.id} has an invalid enabled value`);
  }
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    enabled: row.enabled === 1,
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

  create(name: string): CreatedApiKey {
    assertName(name);
    return this.store.immediate((database) => {
      const secret = `ljk_${randomBytes(32).toString("base64url")}`;
      const keyPrefix = secret.slice(0, 12);
      const id = `key_${randomBytes(12).toString("hex")}`;
      const now = Date.now();
      database.prepare(`
        INSERT INTO api_keys (
          id, name, key_prefix, key_hash, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(id, name, keyPrefix, hashSecret(secret, randomBytes(16)), now, now);
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

  verify(token: string): boolean {
    const keyPrefix = token.slice(0, 12);
    return this.store.immediate((database) => {
      const row = database.prepare(`
        SELECT ${SELECT_COLUMNS} FROM api_keys WHERE key_prefix = ?
      `).get(keyPrefix) as ApiKeyRow | undefined;
      if (row === undefined || row.enabled !== 1 || row.revoked_at !== null) return false;
      if (!matchesSecret(token, row.key_hash)) return false;
      database.prepare(
        "UPDATE api_keys SET last_used_at = ?, updated_at = ? WHERE id = ?"
      ).run(Date.now(), Date.now(), row.id);
      return true;
    });
  }

  private findRow(database: Database.Database, id: string): ApiKeyRow | undefined {
    return database.prepare(`
      SELECT ${SELECT_COLUMNS} FROM api_keys WHERE id = ?
    `).get(id) as ApiKeyRow | undefined;
  }
}
