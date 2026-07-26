import { readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieImportService } from "../../src/accounts/cookie-import-service.js";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import { AccountRuntimeRegistry } from "../../src/accounts/runtime-registry.js";
import { parseConfig } from "../../src/config.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeTestDirectory(directory);
  }
});

const validInput = {
  account: {
    name: "Primary subscription",
    priority: 1,
    dailyPointLimit: 0,
    monthlyPointLimit: 0
  },
  cookies: {
    format: "header" as const,
    value: "csrfToken=fixture-csrf; pin=fixture%2Dpin; thor=fixture-auth"
  }
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "lingjing-cookie-import-"));
  temporaryDirectories.push(directory);
  const config = parseConfig({
    LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length",
    DATA_DIRECTORY: join(directory, "data")
  });
  const store = new SqliteStore(":memory:");
  const accounts = new SqliteAccountRepository(store);
  const runtimes = { refresh: vi.fn(() => Promise.resolve(null)) } as Pick<AccountRuntimeRegistry, "refresh">;
  const describeAccount = vi.fn(() => Promise.resolve({
    subject: "fixture-subject",
    spaceId: 0,
    membership: "premium",
    maxConcurrency: 2,
    pointsBalance: 120,
    couponBalance: 0,
    availableAmount: 0,
    totalBalance: 150,
    resourcePackages: []
  }));
  const importer = new CookieImportService({
    accounts,
    config,
    runtimes,
    describeAccount
  });
  return { accounts, config, describeAccount, importer, store };
}

describe("CookieImportService", () => {
  it("persists and enables only a session validated upstream", async () => {
    const { config, importer, store } = await fixture();

    try {
      const account = await importer.import(validInput);

      expect(account).toMatchObject({
        enabled: true,
        healthStatus: "ready",
        membership: "premium",
        pointsBalance: 120,
        totalBalance: 150
      });
      expect(JSON.stringify(account)).not.toContain("fixture-csrf");
      expect(JSON.stringify(account)).not.toContain("fixture-pin");
      await expect(readdir(join(config.dataDirectory, "accounts", account.id)))
        .resolves.toEqual(["session-profile.json", "storage-state.json"]);
    } finally {
      store.close();
    }
  });

  it("retains neither account nor session files after validation failure", async () => {
    const { accounts, config, describeAccount, importer, store } = await fixture();
    describeAccount.mockRejectedValueOnce(new Error("expired"));

    try {
      await expect(importer.import(validInput)).rejects.toThrow("expired");
      expect(accounts.list().map((account) => account.name))
        .not.toContain("Primary subscription");
      await expect(readdir(join(config.dataDirectory, "accounts"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      store.close();
    }
  });
});
