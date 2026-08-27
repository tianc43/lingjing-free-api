import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteSignInAttemptRepository } from "../../src/accounts/sign-in-repositories.js";
import { PostgresSignInRepository } from "../../src/accounts/sign-in-repositories.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLite sign-in attempt repository", () => {
  it("allows one attempt per account, activity, and Shanghai day across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-sign-in-"));
    directories.push(directory);
    const path = join(directory, "jobs.sqlite");
    const firstStore = new SqliteStore(path);
    const first = new SqliteSignInAttemptRepository(firstStore, () => 100);

    await expect(first.claim("legacy", "ACT1", "2026-08-27"))
      .resolves.toBe(true);
    await expect(first.claim("legacy", "ACT1", "2026-08-27"))
      .resolves.toBe(false);
    firstStore.close();

    const secondStore = new SqliteStore(path);
    const second = new SqliteSignInAttemptRepository(secondStore, () => 200);
    await expect(second.claim("legacy", "ACT1", "2026-08-27"))
      .resolves.toBe(false);
    await expect(second.claim("legacy", "ACT1", "2026-08-28"))
      .resolves.toBe(true);
    secondStore.close();
  });
});

describe("PostgreSQL sign-in repository", () => {
  it("claims a shared daily attempt only when the insert wins", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });
    const repository = new PostgresSignInRepository({ query } as never, () => 100);

    await expect(repository.claim("a", "ACT1", "2026-08-27"))
      .resolves.toBe(true);
    await expect(repository.claim("a", "ACT1", "2026-08-27"))
      .resolves.toBe(false);
  });

  it("reads shared run and per-account state for any web instance", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          running: false,
          last_started_at: "100",
          last_finished_at: "200"
        }]
      })
      .mockResolvedValueOnce({
        rows: [{
          account_id: "a",
          status: "already_signed",
          current_frequency: 2,
          checked_at: "200"
        }]
      });
    const now = Date.parse("2026-08-27T15:30:00Z");
    const repository = new PostgresSignInRepository({ query } as never, () => now);

    await expect(repository.status()).resolves.toMatchObject({
      enabled: true,
      running: false,
      nextCheckAt: Date.parse("2026-08-27T16:00:00Z"),
      lastRunStartedAt: 100,
      lastRunFinishedAt: 200,
      accounts: [{
        accountId: "a",
        status: "already_signed",
        currentFrequency: 2,
        checkedAt: 200
      }]
    });
  });
});
