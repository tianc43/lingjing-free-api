import { describe, expect, it } from "vitest";
import { SqliteApiKeyRepository } from "../../src/api-keys/sqlite-api-key-repository.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";

describe("SQLite API key repository", () => {
  it("returns a managed key once and persists only a salted hash", () => {
    const store = new SqliteStore(":memory:");
    const keys = new SqliteApiKeyRepository(store);
    const created = keys.create("Dify");

    expect(created.secret).toMatch(/^ljk_[A-Za-z0-9_-]{43}$/u);
    expect(keys.list()[0]).toMatchObject({
      name: "Dify",
      keyPrefix: created.secret.slice(0, 12),
      enabled: true,
      revokedAt: null
    });
    expect(JSON.stringify(store.read((db) =>
      db.prepare("SELECT * FROM api_keys").get()
    ))).not.toContain(created.secret);
    expect(keys.verify(created.secret)).toBe(true);
    expect(keys.list()[0]?.lastUsedAt).toEqual(expect.any(Number));
    store.close();
  });

  it("rejects disabled, revoked, and unknown managed keys", () => {
    const store = new SqliteStore(":memory:");
    const keys = new SqliteApiKeyRepository(store);
    const created = keys.create("Automation");

    keys.setEnabled(created.record.id, false);
    expect(keys.verify(created.secret)).toBe(false);
    keys.setEnabled(created.record.id, true);
    keys.revoke(created.record.id);
    expect(keys.verify(created.secret)).toBe(false);
    expect(keys.verify("ljk_unknown")).toBe(false);
    expect(keys.list()[0]?.lastUsedAt).toBeNull();
    store.close();
  });
});
