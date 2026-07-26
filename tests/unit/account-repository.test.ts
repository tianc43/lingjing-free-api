import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import type {
  CreateAccountInput,
  UpdateAccountInput
} from "../../src/accounts/types.js";
import { SqliteJobRepository } from "../../src/jobs/sqlite-repository.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const temporaryDirectories: string[] = [];

function createVersionOneDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "lingjing-accounts-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "jobs.sqlite");
  const database = new Database(path);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1);
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source_type TEXT NOT NULL,
      model TEXT NOT NULL,
      api_id TEXT NOT NULL,
      model_code TEXT,
      expected_asset_scene TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      idempotency_key_hash TEXT,
      space_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      creation_code TEXT,
      upstream_task_id TEXT,
      upstream_fingerprint TEXT,
      submitted_at INTEGER,
      discovered_at INTEGER,
      completed_at INTEGER,
      failed_at INTEGER,
      unknown_hold_until INTEGER,
      error_code TEXT,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE job_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  database.prepare(`
    INSERT INTO jobs (
      id, kind, source_type, model, api_id, model_code,
      expected_asset_scene, request_fingerprint, idempotency_key_hash,
      space_id, status, created_at, updated_at
    ) VALUES (
      'job_existing', 'image', 'image-generation', 'fixture', '707', NULL,
      'image', ?, NULL, 0, 'queued', 1, 1
    )
  `).run("a".repeat(64));
  database.prepare(`
    INSERT INTO jobs (
      id, kind, source_type, model, api_id, model_code,
      expected_asset_scene, request_fingerprint, idempotency_key_hash,
      space_id, status, created_at, updated_at
    ) VALUES (
      'job_failed', 'image', 'image-generation', 'fixture', '707', NULL,
      'image', ?, NULL, 0, 'failed', 2, 2
    )
  `).run("b".repeat(64));
  database.prepare(`
    INSERT INTO jobs (
      id, kind, source_type, model, api_id, model_code,
      expected_asset_scene, request_fingerprint, idempotency_key_hash,
      space_id, status, created_at, updated_at
    ) VALUES (
      'job_submitted', 'image', 'image-generation', 'fixture', '707', NULL,
      'image', ?, NULL, 0, 'submitting', 3, 3
    )
  `).run("c".repeat(64));
  database.close();
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeTestDirectory(directory);
  }
});

describe("SqliteAccountRepository", () => {
  it("migrates version one jobs and creates the legacy account idempotently", () => {
    const store = new SqliteStore(createVersionOneDatabase());
    const accounts = new SqliteAccountRepository(store);
    const jobs = new SqliteJobRepository(store);

    try {
      expect(accounts.ensureLegacyAccount("data/auth")).toMatchObject({
        id: "legacy",
        name: "Legacy account",
        enabled: true,
        authDirectory: "data/auth",
        dailyPointLimit: 0,
        monthlyPointLimit: 0
      });
      expect(accounts.ensureLegacyAccount("data/ignored").authDirectory).toBe("data/auth");
      expect(store.read((database) => database.prepare(`
        SELECT id, account_id, quoted_points, quote_known
        FROM jobs ORDER BY id
      `).all())).toEqual([
        {
          id: "job_existing",
          account_id: "legacy",
          quoted_points: 0,
          quote_known: 0
        },
        {
          id: "job_failed",
          account_id: "legacy",
          quoted_points: 0,
          quote_known: 0
        },
        {
          id: "job_submitted",
          account_id: "legacy",
          quoted_points: 0,
          quote_known: 0
        }
      ]);
      expect(jobs.findById("job_existing")?.quotedPoints).toBeNull();
      expect(store.read((database) => database.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations"
      ).get())).toEqual({ version: 5 });
      expect(store.read((database) => database.prepare(`
        SELECT job_id, state, quoted_points
        FROM budget_entries ORDER BY job_id
      `).all())).toEqual([
        { job_id: "job_existing", state: "reserved", quoted_points: 0 },
        { job_id: "job_failed", state: "released", quoted_points: 0 },
        { job_id: "job_submitted", state: "charged", quoted_points: 0 }
      ]);
    } finally {
      store.close();
    }
  });

  it("creates validated accounts in generated auth directories", () => {
    const store = new SqliteStore(":memory:");
    const accounts = new SqliteAccountRepository(store);
    const account = accounts.create({
      name: "Backup",
      priority: 20,
      dailyPointLimit: 100,
      monthlyPointLimit: 1000
    });

    expect(account).toMatchObject({
      name: "Backup",
      enabled: false,
      priority: 20,
      dailyPointLimit: 100,
      monthlyPointLimit: 1000
    });
    expect(account.id).toMatch(/^acct_[0-9a-f]{24}$/u);
    expect(account.authDirectory).toBe(`data/accounts/${account.id}`);
    expect(accounts.findById(account.id)).toEqual(account);
    expect(accounts.list()).toContainEqual(account);
    store.close();
  });

  it("removes only unbound accounts", () => {
    const store = new SqliteStore(":memory:");
    const accounts = new SqliteAccountRepository(store);
    const unbound = accounts.create({ name: "Unbound", priority: 0, dailyPointLimit: 0, monthlyPointLimit: 0 });
    const bound = accounts.create({ name: "Bound", priority: 1, dailyPointLimit: 0, monthlyPointLimit: 0 });
    store.immediate((database) => {
      database.prepare(`
        INSERT INTO jobs (
          id, kind, source_type, model, api_id, expected_asset_scene,
          request_fingerprint, space_id, status, account_id, quoted_points,
          quote_known, created_at, updated_at
        ) VALUES (?, 'image', 'image-generation', 'fixture', '707', 'image', ?, 0, 'queued', ?, 0, 1, 1, 1)
      `).run("job_bound", "d".repeat(64), bound.id);
    });

    accounts.removeUnbound(unbound.id);
    accounts.removeUnbound(bound.id);

    expect(accounts.findById(unbound.id)).toBeNull();
    expect(accounts.findById(bound.id)).not.toBeNull();
    store.close();
  });

  it("rejects duplicate names and invalid account limits", () => {
    const store = new SqliteStore(":memory:");
    const accounts = new SqliteAccountRepository(store);
    const input = {
      name: "Backup",
      priority: 20,
      dailyPointLimit: 100,
      monthlyPointLimit: 1000
    };
    const account = accounts.create(input);

    expect(() => accounts.create(input)).toThrow();
    expect(() => accounts.create({ ...input, name: "Negative", dailyPointLimit: -1 })).toThrow();
    expect(() => accounts.create({ ...input, name: "Fractional", monthlyPointLimit: 1.5 })).toThrow();
    expect(() => accounts.update(account.id, { priority: 1.5 })).toThrow();
    expect(() => accounts.update(account.id, { priority: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    store.close();
  });

  it("exposes no caller-controlled auth directory fields", () => {
    expectTypeOf<CreateAccountInput>().not.toHaveProperty("authDirectory");
    expectTypeOf<UpdateAccountInput>().not.toHaveProperty("authDirectory");
  });
});
