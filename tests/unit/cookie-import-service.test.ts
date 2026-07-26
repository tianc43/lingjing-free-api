import { readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieImportService } from "../../src/accounts/cookie-import-service.js";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import { parseConfig } from "../../src/config.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const filesystem = vi.hoisted(() => ({ failRemove: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (...arguments_: Parameters<typeof actual.rm>) => {
      if (filesystem.failRemove) {
        return Promise.reject(new Error("fixture session cleanup failure"));
      }
      return actual.rm(...arguments_);
    }
  };
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  filesystem.failRemove = false;
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

async function fixture(sessionMode: "browser-state" | "cookie-file" = "browser-state") {
  const directory = await mkdtemp(join(tmpdir(), "lingjing-cookie-import-"));
  temporaryDirectories.push(directory);
  const config = parseConfig({
    LINGJING_API_KEY: "fixture-local-secret-with-sufficient-length",
    DATA_DIRECTORY: join(directory, "data"),
    SESSION_MODE: sessionMode
  });
  const store = new SqliteStore(":memory:");
  const accounts = new SqliteAccountRepository(store);
  const runtimes = { refresh: vi.fn(() => Promise.resolve(null)) };
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
  return { accounts, config, describeAccount, importer, runtimes, store };
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

  it("rolls back a newly persisted account after runtime refresh fails", async () => {
    const { accounts, config, importer, runtimes, store } = await fixture();
    runtimes.refresh.mockRejectedValueOnce(new Error("upstream refresh failure"));

    try {
      await expect(importer.import(validInput)).rejects.toThrow("upstream refresh failure");
      expect(accounts.list().map((account) => account.name))
        .not.toContain("Primary subscription");
      await expect(readdir(join(config.dataDirectory, "accounts"))).resolves.toEqual([]);
    } finally {
      store.close();
    }
  });

  it("keeps the original failure and removes the account when session cleanup fails", async () => {
    const { accounts, importer, runtimes, store } = await fixture();
    runtimes.refresh.mockRejectedValueOnce(new Error("upstream refresh failure"));
    filesystem.failRemove = true;

    try {
      await expect(importer.import(validInput)).rejects.toThrow("upstream refresh failure");
      expect(accounts.list().map((account) => account.name))
        .not.toContain("Primary subscription");
    } finally {
      store.close();
    }
  });

  it("keeps the original failure after database cleanup fails", async () => {
    const { accounts, config, describeAccount, runtimes, store } = await fixture();
    const removeUnbound = vi.fn(() => {
      throw new Error("fixture database cleanup failure");
    });
    const importer = new CookieImportService({
      accounts: {
        create: accounts.create.bind(accounts),
        findById: accounts.findById.bind(accounts),
        recordObservation: accounts.recordObservation.bind(accounts),
        removeUnbound,
        update: accounts.update.bind(accounts)
      },
      config,
      runtimes,
      describeAccount
    });
    runtimes.refresh.mockRejectedValueOnce(new Error("upstream refresh failure"));

    try {
      await expect(importer.import(validInput)).rejects.toThrow("upstream refresh failure");
      expect(removeUnbound).toHaveBeenCalledTimes(1);
      await expect(readdir(join(config.dataDirectory, "accounts"))).resolves.toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rejects cookie-file mode before validating or creating an account", async () => {
    const { accounts, config, describeAccount, importer, store } = await fixture("cookie-file");

    try {
      await expect(importer.import(validInput)).rejects.toThrow("Cookie imports require browser-state sessions");
      expect(describeAccount).not.toHaveBeenCalled();
      expect(accounts.list().map((account) => account.name))
        .not.toContain("Primary subscription");
      await expect(readdir(join(config.dataDirectory, "accounts"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      store.close();
    }
  });
});
