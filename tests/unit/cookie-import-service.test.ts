import { readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CookieImportRollbackError,
  CookieImportService
} from "../../src/accounts/cookie-import-service.js";
import type { AccountRuntimeRegistry } from "../../src/accounts/runtime-registry.js";
import { SqliteAccountRepository } from "../../src/accounts/sqlite-account-repository.js";
import { parseConfig } from "../../src/config.js";
import { SqliteStore } from "../../src/persistence/sqlite-store.js";
import { removeTestDirectory } from "../helpers/cleanup.js";

const filesystem = vi.hoisted(() => ({
  events: [] as string[],
  failRemove: false,
  removeCalls: 0
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (...arguments_: Parameters<typeof actual.rm>) => {
      filesystem.removeCalls += 1;
      filesystem.events.push("session");
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
  filesystem.removeCalls = 0;
  filesystem.events = [];
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
  const runtimes = {
    refresh: vi.fn<Pick<AccountRuntimeRegistry, "refresh">["refresh"]>(
      () => Promise.resolve({
        record: { healthStatus: "ready" }
      } as Awaited<ReturnType<AccountRuntimeRegistry["refresh"]>>)
    )
  };
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

  it("rolls back when runtime refresh returns no runtime", async () => {
    const { accounts, config, importer, runtimes, store } = await fixture();
    runtimes.refresh.mockResolvedValueOnce(null);

    try {
      await expect(importer.import(validInput)).rejects.toThrow("Imported account runtime is not ready");
      expect(accounts.list().map((account) => account.name))
        .not.toContain("Primary subscription");
      await expect(readdir(join(config.dataDirectory, "accounts"))).resolves.toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rolls back when runtime refresh returns a non-ready runtime", async () => {
    const { accounts, config, importer, runtimes, store } = await fixture();
    runtimes.refresh.mockResolvedValueOnce({
      record: { healthStatus: "unhealthy" }
    } as Awaited<ReturnType<AccountRuntimeRegistry["refresh"]>>);

    try {
      await expect(importer.import(validInput)).rejects.toThrow("Imported account runtime is not ready");
      expect(accounts.list().map((account) => account.name))
        .not.toContain("Primary subscription");
      await expect(readdir(join(config.dataDirectory, "accounts"))).resolves.toEqual([]);
    } finally {
      store.close();
    }
  });

  it("keeps a disabled account tombstone and does not delete its row when session cleanup fails", async () => {
    const { accounts, config, importer, runtimes, store } = await fixture();
    const removeUnbound = vi.spyOn(accounts, "removeUnbound");
    runtimes.refresh.mockRejectedValueOnce(new Error("upstream refresh failure"));
    filesystem.failRemove = true;

    try {
      const failure = await importer.import(validInput).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CookieImportRollbackError);
      expect(failure).toMatchObject({
        code: "cookie_import_rollback_incomplete",
        message: "Cookie import failed and rollback was incomplete"
      });
      expect(JSON.stringify(failure)).not.toContain("fixture-csrf");
      expect(JSON.stringify(failure)).not.toContain("accounts");
      expect(removeUnbound).not.toHaveBeenCalled();
      expect(accounts.list()).toContainEqual(
        expect.objectContaining({
          name: "Primary subscription",
          enabled: false
        })
      );
      await expect(readdir(join(config.dataDirectory, "accounts")))
        .resolves.toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("removes the session before row cleanup and keeps the disabled row when row cleanup fails", async () => {
    const { accounts, config, describeAccount, runtimes, store } = await fixture();
    const removeUnbound = vi.fn(() => {
      filesystem.events.push("row");
      throw new Error("fixture database cleanup failure");
    });
    const update = vi.fn<SqliteAccountRepository["update"]>((id, patch) => {
      if (patch.enabled === false) filesystem.events.push("disable");
      return accounts.update(id, patch);
    });
    const importer = new CookieImportService({
      accounts: {
        create: accounts.create.bind(accounts),
        findById: accounts.findById.bind(accounts),
        recordObservation: accounts.recordObservation.bind(accounts),
        removeUnbound,
        update
      },
      config,
      runtimes,
      describeAccount
    });
    runtimes.refresh.mockRejectedValueOnce(new Error("upstream refresh failure"));

    try {
      const failure = await importer.import(validInput).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CookieImportRollbackError);
      expect(failure).toMatchObject({
        code: "cookie_import_rollback_incomplete",
        message: "Cookie import failed and rollback was incomplete"
      });
      expect(filesystem.events).toEqual(["disable", "session", "row"]);
      expect(removeUnbound).toHaveBeenCalledTimes(1);
      expect(filesystem.removeCalls).toBe(1);
      await expect(readdir(join(config.dataDirectory, "accounts"))).resolves.toEqual([]);
      expect(accounts.list()).toContainEqual(
        expect.objectContaining({
          name: "Primary subscription",
          enabled: false
        })
      );
    } finally {
      store.close();
    }
  });

  it("does not remove the session or row when disabling the account fails", async () => {
    const { accounts, config, describeAccount, runtimes, store } = await fixture();
    const removeUnbound = vi.fn(() => {
      filesystem.events.push("row");
      accounts.removeUnbound("unreachable");
    });
    const update = vi.fn<SqliteAccountRepository["update"]>((id, patch) => {
      if (patch.enabled === false) {
        filesystem.events.push("disable");
        throw new Error("fixture disable failure C:\\private\\session");
      }
      return accounts.update(id, patch);
    });
    const importer = new CookieImportService({
      accounts: {
        create: accounts.create.bind(accounts),
        findById: accounts.findById.bind(accounts),
        recordObservation: accounts.recordObservation.bind(accounts),
        removeUnbound,
        update
      },
      config,
      runtimes,
      describeAccount
    });
    runtimes.refresh.mockRejectedValueOnce(new Error("upstream refresh failure"));

    try {
      const failure = await importer.import(validInput).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CookieImportRollbackError);
      expect(failure).toMatchObject({
        code: "cookie_import_rollback_incomplete",
        message: "Cookie import failed and rollback was incomplete"
      });
      expect(JSON.stringify(failure)).not.toContain("private");
      expect(filesystem.events).toEqual(["disable"]);
      expect(filesystem.removeCalls).toBe(0);
      expect(removeUnbound).not.toHaveBeenCalled();
      expect(accounts.list()).toContainEqual(
        expect.objectContaining({
          name: "Primary subscription",
          enabled: true
        })
      );
      const account = accounts.list().find(
        (candidate) => candidate.name === "Primary subscription"
      );
      if (account === undefined) throw new Error("Expected retained account");
      await expect(readdir(join(config.dataDirectory, "accounts", account.id)))
        .resolves.toEqual(["session-profile.json", "storage-state.json"]);
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
